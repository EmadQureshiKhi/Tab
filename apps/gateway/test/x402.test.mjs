/**
 * x402 on the served surface.
 *
 * Three things are checked and none of them touches the network: the `402` a
 * credit refusal produces carries the x402 offer beside its untouched
 * `Tab-Charge-*` block; a request carrying `PAYMENT-SIGNATURE` is verified,
 * delivered, settled and never metered; and `/hub/<prefix>/*` pays an x402
 * upstream with the operator's key and meters the Agent for the price plus
 * the margin, refusing before paying when the simulated delivery says the
 * Agent has no headroom.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, Interface, Wallet, verifyTypedData } from "ethers";

import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  X402_HEADER,
  chainIdOfNetwork,
  createX402Client,
  decodePaymentSignature,
  encodePaymentRequired,
  readPaymentRequired,
  readPaymentResponse,
} from "@tabai/sdk";

import { createApp, ISSUED_AT_HEADER, SIGNATURE_HEADER } from "../dist/server.js";
import { meteringDigest } from "../dist/authorisation.js";
import { loadX402Config, parseHubUpstreams, readCollectionAddress, readEip712Domain } from "../dist/x402.js";

const OPERATOR = new Wallet(`0x${"11".repeat(32)}`);
const AGENT_KEY = new Wallet(`0x${"33".repeat(32)}`);
const AGENT = AGENT_KEY.address.toLowerCase();
const ASSET = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const COLLECTION = "0xc011ec7000000000000000000000000000000003";
const SERVICE = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const TOOL = `0x${"33".repeat(32)}`;
const NOW = 1_788_700_000_000;

const asset = { chainId: 10143n, address: ASSET, decimals: 6, symbol: "USDC" };

const limitExceeded = (requested, headroom) => ({
  category: "LIMIT",
  code: "LIMIT_EXCEEDED",
  message: "over the Credit Limit",
  retryable: false,
  details: { disposition: "refuse-request", requested: String(requested), headroom: String(headroom) },
});

/** A TabBook whose deliveries either land or refuse, and which records both real and simulated ones. */
function tabBook({ events = [], refuse, simulateRefuse } = {}) {
  const receipt = (delivery) => ({ charged: delivery.expectedUnitPrice * BigInt(delivery.units), openAfter: 10_000n, headroomAfter: 4_740_000n, recordedAt: NOW });
  return {
    events,
    recordDelivery: async (delivery) => {
      events.push(["metered", delivery]);
      if (refuse !== undefined) return { ok: false, error: refuse };
      return { ok: true, value: receipt(delivery) };
    },
    openTabOf: async () => ({ ok: true, value: 10_000n }),
    simulateDelivery: async (delivery) => {
      events.push(["simulated", delivery]);
      if (simulateRefuse !== undefined) return { ok: false, error: simulateRefuse };
      return { ok: true, value: receipt(delivery) };
    },
    creditLimit: async () => ({ ok: true, value: 4_750_000n }),
  };
}

function recover(payload) {
  const chainId = chainIdOfNetwork(payload.accepted.network).value;
  const { authorization, signature } = payload.payload;
  return verifyTypedData(
    { name: payload.accepted.extra.name, version: payload.accepted.extra.version, chainId, verifyingContract: payload.accepted.asset },
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
    signature,
  );
}

/** A facilitator that recovers the signer itself. */
function facilitator({ settleAs } = {}) {
  const calls = [];
  return {
    calls,
    async verify(payload, requirements) {
      calls.push("verify");
      const payer = recover(payload);
      const valid = payer.toLowerCase() === payload.payload.authorization.from.toLowerCase() && payload.payload.authorization.value === requirements.amount && payload.payload.authorization.to.toLowerCase() === requirements.payTo.toLowerCase();
      return valid ? { isValid: true, payer } : { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
    },
    async settle(payload, requirements) {
      calls.push("settle");
      return settleAs ?? { success: true, transaction: `0x${"ee".repeat(32)}`, network: requirements.network, payer: recover(payload), amount: requirements.amount };
    },
    async getSupported() {
      return { kinds: [], extensions: [], signers: {} };
    },
  };
}

const baseOptions = (over = {}) => ({
  serviceId: SERVICE,
  asset,
  operator: OPERATOR.address,
  priceOf: () => ({ tool: TOOL, unitPrice: 10_000n }),
  now: () => NOW,
  ...over,
});

async function operatorHeaders(path, method = "POST", tool = TOOL) {
  const claim = { method, path, agent: AGENT, tool, units: 1, issuedAt: NOW };
  const signature = await OPERATOR.signMessage(meteringDigest(claim));
  return { [SIGNATURE_HEADER]: signature, [ISSUED_AT_HEADER]: String(NOW), "Tab-Agent": AGENT };
}

// ---------------------------------------------------------------- the offer on a 402

test("a LimitExceeded 402 keeps every Tab-Charge header and adds the x402 offer for the same charge", async () => {
  const app = createApp(
    baseOptions({
      tabBook: tabBook({ refuse: limitExceeded(10_000, 500) }),
      x402: { facilitator: facilitator(), payTo: COLLECTION },
    }),
  );
  const response = await app.request("/meter/quote", { method: "POST", headers: await operatorHeaders("/meter/quote") });
  assert.equal(response.status, 402);

  // The credit decision, unchanged.
  assert.equal(response.headers.get("Tab-Charge-Amount"), "10000");
  assert.equal(response.headers.get("Tab-Headroom"), "500");
  assert.equal(response.headers.get("Tab-Open-Tab"), "10000");
  assert.equal(response.headers.get("Tab-Charge-Asset"), `10143:${ASSET}`);
  const body = await response.json();
  assert.equal(body.error.code, "LIMIT_EXCEEDED");
  assert.equal(body.requiredBaseUnits, "10000");

  // The offer beside it.
  const offer = readPaymentRequired(response.headers);
  assert.equal(offer.ok, true);
  assert.equal(offer.value.x402Version, 2);
  assert.equal(offer.value.accepts.length, 1);
  const [accepted] = offer.value.accepts;
  assert.equal(accepted.scheme, "exact");
  assert.equal(accepted.network, "eip155:10143");
  assert.equal(accepted.amount, "10000");
  assert.equal(accepted.asset, ASSET);
  assert.equal(accepted.payTo, COLLECTION);
  assert.equal(accepted.maxTimeoutSeconds, 300);
  assert.deepEqual(accepted.extra, { name: "USDC", version: "2" });
  assert.match(offer.value.resource.url, /\/meter\/quote$/);
});

test("without x402 configured the 402 carries no offer, and an operator-signed request is decided on credit alone", async () => {
  const book = tabBook({ refuse: limitExceeded(10_000, 500) });
  const app = createApp(baseOptions({ tabBook: book }));
  const response = await app.request("/meter/quote", { method: "POST", headers: await operatorHeaders("/meter/quote") });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get(X402_HEADER.paymentRequired), null);
});

// ---------------------------------------------------------------- the prepaid path

test("a request carrying PAYMENT-SIGNATURE is verified, delivered, settled, and never metered", async () => {
  const book = tabBook();
  const gate = facilitator();
  const delivered = [];
  const app = createApp(
    baseOptions({
      tabBook: book,
      x402: { facilitator: gate, payTo: COLLECTION },
      deliver: (path) => {
        delivered.push(path);
        return new Response(JSON.stringify({ quote: 42 }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  );

  // First, the credit refusal that carries the offer.
  const refused = await app.request("/meter/quote", { method: "POST", headers: await operatorHeaders("/meter/quote") });
  assert.equal(refused.status, 200, "this Agent has headroom, so the call is on credit");
  assert.equal(book.events.filter(([what]) => what === "metered").length, 1);

  // Now the Agent chooses to prepay. The x402 client signs the offer a 402 would carry.
  const client = createX402Client({ signer: AGENT_KEY, chainId: 10143n, fetchImpl: (url, init) => app.request(url, init) });
  const offer = { x402Version: 2, resource: { url: "http://localhost/meter/quote" }, accepts: [{ scheme: "exact", network: "eip155:10143", amount: "10000", asset: ASSET, payTo: COLLECTION, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }] };
  const paid = await client.pay("http://localhost/meter/quote", { method: "POST", headers: await operatorHeaders("/meter/quote") }, offer);
  assert.equal(paid.ok, true, paid.ok ? "" : paid.error.message);
  assert.equal(paid.value.response.status, 200);
  assert.deepEqual(await paid.value.response.json(), { quote: 42 });

  assert.deepEqual(gate.calls, ["verify", "settle"], "verify before the work, settle after it");
  assert.equal(delivered.length, 2);
  assert.equal(book.events.filter(([what]) => what === "metered").length, 1, "the prepaid call was not metered");
  assert.equal(paid.value.response.headers.get("Tab-Charge-Amount"), null, "no charge block: nothing is owed");

  const settlement = readPaymentResponse(paid.value.response.headers);
  assert.equal(settlement.ok, true);
  assert.equal(settlement.value.success, true);
  assert.equal(settlement.value.transaction, `0x${"ee".repeat(32)}`);
  assert.equal(paid.value.payment.txHash, `0x${"ee".repeat(32)}`);
  assert.equal(paid.value.payment.payer, AGENT);
});

test("a payment that does not verify is answered 402 with the reason, and nothing is delivered or metered", async () => {
  const book = tabBook();
  const gate = facilitator();
  let delivered = 0;
  const app = createApp(
    baseOptions({
      tabBook: book,
      x402: { facilitator: gate, payTo: COLLECTION },
      deliver: () => {
        delivered += 1;
        return new Response("{}", { status: 200 });
      },
    }),
  );
  // Signed for the wrong amount: the server's requirement says 10000.
  const client = createX402Client({ signer: AGENT_KEY, fetchImpl: (url, init) => app.request(url, init) });
  const cheap = { x402Version: 2, resource: { url: "http://localhost/meter/quote" }, accepts: [{ scheme: "exact", network: "eip155:10143", amount: "1", asset: ASSET, payTo: COLLECTION, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }] };
  const result = await client.pay("http://localhost/meter/quote", { method: "POST", headers: await operatorHeaders("/meter/quote") }, cheap);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "X402_PAYMENT_REJECTED");
  assert.match(result.error.message, /amount 1 is not 10000/);
  assert.equal(delivered, 0);
  assert.deepEqual(gate.calls, [], "a mismatched payload never reaches the facilitator");
  assert.equal(book.events.length, 0);

  const malformed = await app.request("/meter/quote", { method: "POST", headers: { ...(await operatorHeaders("/meter/quote")), [X402_HEADER.paymentSignature]: "%%%" } });
  assert.equal(malformed.status, 400, "malformed payment data is a 400 by the transport specification");
});

test("a settlement the facilitator refuses after delivery is a 402 carrying the failed PAYMENT-RESPONSE", async () => {
  const app = createApp(
    baseOptions({
      tabBook: tabBook(),
      x402: { facilitator: facilitator({ settleAs: { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:10143" } }), payTo: COLLECTION },
    }),
  );
  const client = createX402Client({ signer: AGENT_KEY, fetchImpl: (url, init) => app.request(url, init) });
  const offer = { x402Version: 2, resource: { url: "http://localhost/meter/quote" }, accepts: [{ scheme: "exact", network: "eip155:10143", amount: "10000", asset: ASSET, payTo: COLLECTION, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }] };
  const result = await client.pay("http://localhost/meter/quote", { method: "POST", headers: await operatorHeaders("/meter/quote") }, offer);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "X402_PAYMENT_REJECTED");
  assert.equal(result.error.details.reason, "insufficient_funds");
});

test("a prepaid request carries its own payment, so it needs no metering signature", async () => {
  // The whole point of the offer on a 402 is that a caller with no account and
  // no credit can pay for one call. Such a caller can produce neither the
  // operator's signature nor an Agent's, so requiring one would make the offer
  // unusable by everyone it is for.
  const book = tabBook();
  const app = createApp(baseOptions({ tabBook: book, x402: { facilitator: facilitator(), payTo: COLLECTION } }));
  const client = createX402Client({ signer: AGENT_KEY, chainId: 10143n, fetchImpl: (url, init) => app.request(url, init) });
  const offer = { x402Version: 2, resource: { url: "http://localhost/meter/quote" }, accepts: [{ scheme: "exact", network: "eip155:10143", amount: "10000", asset: ASSET, payTo: COLLECTION, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }] };
  // No Tab-Operator-Signature and no Tab-Agent-Signature: only the payment.
  const paid = await client.pay("http://localhost/meter/quote", { method: "POST" }, offer);
  assert.equal(paid.ok, true, paid.ok ? "" : paid.error.message);
  assert.equal(paid.value.response.status, 200);
  assert.equal(book.events.filter(([what]) => what === "metered").length, 0, "nothing was metered: the call was paid in full");

  // A payment that does not verify delivers nothing, unsigned or not.
  const bogus = await app.request("/meter/quote", {
    method: "POST",
    headers: { [X402_HEADER.paymentSignature]: "eyJ4NDAyVmVyc2lvbiI6Mn0=" },
  });
  assert.equal(bogus.status >= 400, true);
  assert.equal(book.events.length, 0);

  // The header buys no exemption on a route with no price: there is nothing to
  // pay for, so the ordinary rule applies and the request is refused.
  const unpriced = createApp(
    baseOptions({ tabBook: book, priceOf: () => undefined, x402: { facilitator: facilitator(), payTo: COLLECTION } }),
  );
  const free = await unpriced.request("/meter/quote", {
    method: "POST",
    headers: { [X402_HEADER.paymentSignature]: "eyJ4NDAyVmVyc2lvbiI6Mn0=" },
  });
  assert.equal(free.status, 403);
  assert.equal((await free.json()).error.code, "METERING_SIGNATURE_ABSENT");
});

// ---------------------------------------------------------------- the fronted upstream

/** An x402 upstream that answers 402 without a signature and 200 with the operator's. */
function upstream({ amount = "50000", payer = OPERATOR.address } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const offer = { x402Version: 2, resource: { url }, accepts: [{ scheme: "exact", network: "eip155:10143", amount, asset: ASSET, payTo: "0x0000000000000000000000000000000000000abc", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }] };
    const signature = init.headers[X402_HEADER.paymentSignature];
    if (signature === undefined) return new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodePaymentRequired(offer).value } });
    const payload = decodePaymentSignature(signature).value;
    if (recover(payload).toLowerCase() !== payer.toLowerCase()) return new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodePaymentRequired(offer).value } });
    return new Response(JSON.stringify({ whales: 3 }), {
      status: 200,
      headers: { "content-type": "application/json", [X402_HEADER.paymentResponse]: Buffer.from(JSON.stringify({ success: true, transaction: `0x${"dd".repeat(32)}`, network: "eip155:10143" })).toString("base64") },
    });
  };
  return { calls, fetchImpl };
}

const hubOptions = (fetchImpl, over = {}) => ({
  upstreams: [{ prefix: "nansen", url: "https://api.nansen.ai/api/v1", tool: "nansen.query", marginBps: 1_000n, ...over }],
  signer: OPERATOR,
  fetchImpl,
  nowSeconds: () => Math.floor(NOW / 1000),
});

test("/hub/:prefix/* pays the upstream with the operator's key and meters the Agent for the price plus the margin", async () => {
  const book = tabBook();
  const up = upstream({ amount: "50000" });
  const app = createApp(baseOptions({ tabBook: book, x402: { facilitator: facilitator(), payTo: COLLECTION }, hub: hubOptions(up.fetchImpl) }));
  const toolKey = `0x${Buffer.from("nansen.query").toString("hex").padEnd(64, "0")}`;

  const response = await app.request("/hub/nansen/smart-money?chain=monad", {
    method: "POST",
    headers: { ...(await operatorHeaders("/hub/nansen/smart-money", "POST", toolKey)), "content-type": "application/json" },
    body: '{"q":1}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { whales: 3 });

  assert.equal(up.calls.length, 2, "the probe, then the paid call");
  assert.equal(up.calls[0].url, "https://api.nansen.ai/api/v1/smart-money?chain=monad", "the mount is stripped and the query kept");
  const forwarded = new Headers(up.calls[1].init.headers);
  assert.equal(forwarded.get("Tab-Agent"), null, "Tab identity stays on this side of the hop");
  assert.equal(forwarded.get(SIGNATURE_HEADER), null);
  assert.equal(forwarded.get("content-type"), "application/json");

  // 50000 upstream plus ten percent, simulated before paying and metered after.
  const simulated = book.events.filter(([what]) => what === "simulated");
  const metered = book.events.filter(([what]) => what === "metered");
  assert.equal(simulated.length, 1);
  // The amount rides in the unit count at one base unit a unit, because a
  // fronted price is not known until the upstream answers.
  assert.equal(simulated[0][1].units, 55_000);
  assert.equal(simulated[0][1].expectedUnitPrice, 1n);
  assert.equal(simulated[0][1].agent, AGENT);
  assert.equal(metered.length, 1);
  assert.equal(metered[0][1].units, 55_000);
  assert.equal(metered[0][1].expectedUnitPrice, 1n);
  assert.equal(metered[0][1].tool, toolKey);
  assert.equal(response.headers.get("Tab-Charge-Amount"), "55000");
  assert.equal(response.headers.get("Tab-Charge-Tool"), toolKey);
});

test("/hub/:prefix/* meters the Agent when the upstream is paid on another chain", async () => {
  // The API Hub takes Mainnet USDC only, so the live mount carries `payOn` and
  // the paying side differs from the metering side. The charge must still land
  // on the Agent's tab: a Service that fronts an upstream and bills nobody is
  // giving its own money away, which is the one outcome buy-now-pay-later
  // cannot have.
  const MAINNET_USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const offer = {
      x402Version: 2,
      resource: { url },
      accepts: [{ scheme: "exact", network: "eip155:143", amount: "1000", asset: MAINNET_USDC, payTo: "0x0000000000000000000000000000000000000abc", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
    };
    if (init.headers[X402_HEADER.paymentSignature] === undefined) {
      return new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodePaymentRequired(offer).value } });
    }
    return new Response(JSON.stringify({ chains: 3 }), {
      status: 200,
      headers: { "content-type": "application/json", [X402_HEADER.paymentResponse]: Buffer.from(JSON.stringify({ success: true, transaction: `0x${"dd".repeat(32)}`, network: "eip155:143" })).toString("base64") },
    });
  };

  const book = tabBook();
  const app = createApp(
    baseOptions({
      tabBook: book,
      x402: { facilitator: facilitator(), payTo: COLLECTION },
      hub: hubOptions(fetchImpl, { payOn: { chainId: 143n, asset: MAINNET_USDC } }),
    }),
  );
  const toolKey = `0x${Buffer.from("nansen.query").toString("hex").padEnd(64, "0")}`;
  const response = await app.request("/hub/nansen/run", {
    method: "POST",
    headers: { ...(await operatorHeaders("/hub/nansen/run", "POST", toolKey)), "content-type": "application/json" },
    body: '{"q":1}',
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls.length, 2, "the probe, then the paid call");

  const metered = book.events.filter(([what]) => what === "metered");
  assert.equal(metered.length, 1, "the fronted call was metered");
  // 1000 upstream base units plus the mount's 10% margin, in the Service's Asset.
  assert.equal(metered[0][1].units, 1_100);
  assert.equal(metered[0][1].expectedUnitPrice, 1n);
  assert.equal(response.headers.get("Tab-Charge-Amount"), "1100");
});

test("/hub/:prefix/* refuses an Agent with no headroom before the upstream is paid, and offers x402 on that 402", async () => {
  const book = tabBook({ simulateRefuse: limitExceeded(55_000, 0) });
  const up = upstream();
  const app = createApp(baseOptions({ tabBook: book, x402: { facilitator: facilitator(), payTo: COLLECTION }, hub: hubOptions(up.fetchImpl) }));
  const toolKey = `0x${Buffer.from("nansen.query").toString("hex").padEnd(64, "0")}`;
  const response = await app.request("/hub/nansen/smart-money", { method: "GET", headers: await operatorHeaders("/hub/nansen/smart-money", "GET", toolKey) });
  assert.equal(response.status, 402);
  assert.equal(up.calls.length, 1, "the probe only; the operator never signed");
  assert.equal(book.events.filter(([what]) => what === "metered").length, 0);
  const body = await response.json();
  assert.equal(body.error.code, "LIMIT_EXCEEDED");
  const offer = readPaymentRequired(response.headers);
  assert.equal(offer.ok, true);
  assert.equal(offer.value.accepts[0].amount, "55000", "the offer is for the fronted price, margin included");
  assert.equal(offer.value.accepts[0].payTo, COLLECTION);
});

test("/hub/:prefix/* refuses a call it cannot bill for, and pays the upstream nothing", async () => {
  // An unpriced fronted tool is the Service's own fault, and on a metered route
  // the Service would eat it. Here the next step spends the Service's money on
  // an upstream, so a Service that cannot bill must not buy.
  const book = tabBook({
    simulateRefuse: {
      category: "NOT_FOUND",
      code: "UNKNOWN_TOOL",
      message: "the simulated delivery was refused: UnknownTool(...)",
      retryable: false,
    },
  });
  const up = upstream({ amount: "50000" });
  const app = createApp(baseOptions({ tabBook: book, x402: { facilitator: facilitator(), payTo: COLLECTION }, hub: hubOptions(up.fetchImpl) }));
  const toolKey = `0x${Buffer.from("nansen.query").toString("hex").padEnd(64, "0")}`;

  const response = await app.request("/hub/nansen/smart-money", {
    method: "POST",
    headers: { ...(await operatorHeaders("/hub/nansen/smart-money", "POST", toolKey)), "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status >= 400, true, await response.text());
  assert.equal(up.calls.length, 1, "the probe only: nothing was paid for");
  assert.equal(book.events.filter(([what]) => what === "metered").length, 0);
});

test("/hub/:prefix/* with signatures off still refuses a caller that names no Agent, before paying", async () => {
  const book = tabBook();
  const up = upstream();
  const app = createApp(baseOptions({ tabBook: book, requireSignature: false, hub: hubOptions(up.fetchImpl) }));
  const response = await app.request("/hub/nansen/smart-money", { method: "GET" });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, "AGENT_UNIDENTIFIED");
  assert.equal(up.calls.length, 1, "the probe only");
  assert.equal(book.events.length, 0);
});

test("/hub/:prefix/* needs the operator's signature over the hub tool", async () => {
  const book = tabBook();
  const up = upstream();
  const app = createApp(baseOptions({ tabBook: book, hub: hubOptions(up.fetchImpl) }));
  const unsigned = await app.request("/hub/nansen/smart-money", { method: "GET" });
  assert.equal(unsigned.status, 403);
  const wrongTool = await app.request("/hub/nansen/smart-money", { method: "GET", headers: await operatorHeaders("/hub/nansen/smart-money", "GET", TOOL) });
  assert.equal(wrongTool.status, 403, "a signature over another tool does not open the hub route");
  assert.equal(up.calls.length, 0);
  const unknown = await app.request("/hub/other/x", { method: "GET" });
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------- configuration

test("the x402 configuration defaults on, names the Monad facilitator, and validates what it is given", () => {
  const defaults = loadX402Config({});
  assert.equal(defaults.ok, true);
  assert.equal(defaults.value.enabled, true);
  assert.equal(defaults.value.facilitatorUrl, "https://x402-facilitator.molandak.org");
  assert.equal(defaults.value.collectionFallback, undefined);
  assert.deepEqual(defaults.value.hubUpstreams, []);

  const off = loadX402Config({ X402_ENABLED: "false" });
  assert.equal(off.value.enabled, false);
  assert.equal(loadX402Config({ X402_ENABLED: "maybe" }).ok, false);
  assert.equal(loadX402Config({ X402_FACILITATOR_URL: "not a url" }).ok, false);
  assert.equal(loadX402Config({ GATEWAY_COLLECTION_ADDRESS: "0x12" }).ok, false);
  assert.equal(loadX402Config({ GATEWAY_COLLECTION_ADDRESS: `0x${"0".repeat(40)}` }).ok, false);
  const withFallback = loadX402Config({ GATEWAY_COLLECTION_ADDRESS: COLLECTION.toUpperCase().replace("0X", "0x") });
  assert.equal(withFallback.value.collectionFallback, COLLECTION);
  assert.equal(loadX402Config({ GATEWAY_X402_PRIVATE_KEY: "0xREPLACE" }).value.x402Key, undefined, "a placeholder key is not a key");

  const upstreams = parseHubUpstreams(JSON.stringify([{ prefix: "/nansen/", url: "https://api.nansen.ai/api/v1/", tool: "nansen.query", marginBps: 250, maxUpstreamBaseUnits: "100000" }]));
  assert.equal(upstreams.ok, true);
  assert.deepEqual(upstreams.value, [{ prefix: "nansen", url: "https://api.nansen.ai/api/v1", tool: "nansen.query", marginBps: 250n, marginBaseUnits: 0n, maxUpstreamBaseUnits: 100_000n, unitBaseUnits: 1n, payOn: undefined }]);
  // The published unit price a fronted tool is metered against, one base unit
  // unless the Service published something coarser.
  assert.equal(parseHubUpstreams(JSON.stringify([{ prefix: "a", url: "https://x", tool: "t", unitBaseUnits: 100 }])).value[0].unitBaseUnits, 100n);
  assert.equal(parseHubUpstreams(JSON.stringify([{ prefix: "a", url: "https://x", tool: "t", unitBaseUnits: 0 }])).ok, false);
  const paidElsewhere = parseHubUpstreams(JSON.stringify([{ prefix: "apihub", url: "https://x402.monid.ai/v1", tool: "apihub.run", payOn: { chainId: 143, asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" } }]));
  assert.equal(paidElsewhere.ok, true);
  assert.deepEqual(paidElsewhere.value[0].payOn, { chainId: 143n, asset: "0x754704bc059f8c67012fed69bc8a327a5aafb603" });
  assert.equal(upstreams.value[0].payOn, undefined);
  assert.equal(parseHubUpstreams(JSON.stringify([{ prefix: "a", url: "https://x", tool: "t", payOn: { chainId: 0, asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" } }])).ok, false, "payOn without a chain");
  assert.equal(parseHubUpstreams(JSON.stringify([{ prefix: "a", url: "https://x", tool: "t", payOn: { chainId: 143, asset: "0x12" } }])).ok, false, "payOn without an asset");
  assert.equal(parseHubUpstreams("[{}]").ok, false);
  assert.equal(parseHubUpstreams("nope").ok, false);
  assert.equal(parseHubUpstreams(JSON.stringify([{ prefix: "a", url: "https://x", tool: "t" }, { prefix: "a", url: "https://y", tool: "t" }])).ok, false, "a repeated prefix");
  assert.equal(parseHubUpstreams(JSON.stringify([{ prefix: "a", url: "https://x", tool: "t".repeat(32) }])).ok, false, "a tool name that does not fit bytes32");
});

test("the Asset's EIP-712 domain is read from the token, by ERC-5267 first and name()/version() second", async () => {
  const abi = new Interface([
    "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
    "function name() view returns (string)",
    "function version() view returns (string)",
  ]);
  const selectorOf = (fragment) => abi.getFunction(fragment).selector;
  const coder = AbiCoder.defaultAbiCoder();

  // An OpenZeppelin token: answers eip712Domain() with the constructor's name and version.
  const modern = {
    call: async ({ data }) => {
      if (data.startsWith(selectorOf("eip712Domain"))) {
        return coder.encode(["bytes1", "string", "string", "uint256", "address", "bytes32", "uint256[]"], ["0x0f", "USDC", "2", 10143, ASSET, `0x${"0".repeat(64)}`, []]);
      }
      throw new Error("unknown selector");
    },
  };
  assert.deepEqual(await readEip712Domain(modern, ASSET), { name: "USDC", version: "2" });

  // Circle's FiatToken: no ERC-5267, but name() and version().
  const circle = {
    call: async ({ data }) => {
      if (data.startsWith(selectorOf("name"))) return coder.encode(["string"], ["USD Coin"]);
      if (data.startsWith(selectorOf("version"))) return coder.encode(["string"], ["2"]);
      throw new Error("execution reverted");
    },
  };
  assert.deepEqual(await readEip712Domain(circle, ASSET), { name: "USD Coin", version: "2" });

  // A token that answers neither is nothing, and the caller falls back by symbol.
  assert.equal(await readEip712Domain({ call: async () => { throw new Error("execution reverted"); } }, ASSET), undefined);
});

test("the Collection address is read from ServiceRegistry, and the zero address means the Asset is not accepted", async () => {
  const encoded = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const registry = `0x${"5e".repeat(20)}`;
  const calls = [];
  const provider = { call: async (transaction) => (calls.push(transaction), encoded(COLLECTION)) };
  const read = await readCollectionAddress(provider, registry, SERVICE, ASSET);
  assert.equal(read.ok, true);
  assert.equal(read.value, COLLECTION);
  assert.equal(calls[0].to, registry);
  assert.match(calls[0].data, /^0x[0-9a-f]{8}/);

  const zero = await readCollectionAddress({ call: async () => encoded(`0x${"0".repeat(40)}`) }, registry, SERVICE, ASSET);
  assert.equal(zero.ok, true);
  assert.equal(zero.value, undefined);

  const down = await readCollectionAddress({ call: async () => { throw new Error("rpc down"); } }, registry, SERVICE, ASSET);
  assert.equal(down.ok, false);
  assert.equal(down.error.code, "COLLECTION_UNREADABLE");
});
