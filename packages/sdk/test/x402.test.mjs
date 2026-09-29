/**
 * x402 beside Tab: the wire format, the EIP-3009 signature, the prepaid
 * fallback in the 402 client and in `tab_call`, the server side through a fake
 * facilitator, the fronting proxy, and the API Hub manifest.
 *
 * Nothing here reaches the network or a chain. Every `fetch` is a recorder,
 * every facilitator a fake, and every signature is recovered with ethers'
 * `verifyTypedData` against the same domain and struct the exact EVM scheme
 * specifies, which is the check that the hand-rolled signing is the scheme's
 * signing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, verifyTypedData } from "ethers";

import { TAB_HEADER, createTab402Client } from "../dist/http/index.js";
import { tabPostPaid } from "../dist/server/index.js";
import { createTabToolset } from "../dist/mcp/index.js";
import {
  API_HUB_MANIFEST_URL,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  X402_HEADER,
  chainIdOfNetwork,
  createX402Client,
  createX402FrontedProxy,
  createX402UpstreamPricing,
  decodePaymentSignature,
  encodePaymentRequired,
  exactRequirementFor,
  fetchHubManifest,
  handlePrepaidRequest,
  matchAccepted,
  networkOf,
  paymentRequiredFor,
  readPaymentRequired,
  readPaymentResponse,
  resolveX402Signer,
  selectExactRequirement,
  settlePayment,
  signExactPayment,
  usdToBaseUnits,
  verifyPayment,
} from "../dist/x402/index.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const SIGNER = new Wallet(`0x${"11".repeat(32)}`);
const TESTNET_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const COLLECTION = "0x000000000000000000000000000000000000c011";
const AGENT = "0x00000000000000000000000000000000000a9e17";
const SERVICE_ID = `0x${"11".repeat(32)}`;
const TOOL = `0x${"22".repeat(32)}`;
const NONCE = `0x${"ab".repeat(32)}`;
const NOW_SECONDS = 1_790_000_000;

const requirement = (over = {}) => ({
  scheme: "exact",
  network: "eip155:10143",
  amount: "10000",
  asset: TESTNET_USDC,
  payTo: COLLECTION,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
  ...over,
});

const required = (accepts = [requirement()], over = {}) => ({
  x402Version: 2,
  resource: { url: "https://svc.example/meter/quote", description: "a quote", mimeType: "application/json" },
  accepts,
  ...over,
});

const encodedRequired = (accepts, over) => {
  const encoded = encodePaymentRequired(required(accepts, over));
  assert.equal(encoded.ok, true);
  return encoded.value;
};

/** Verifies an EIP-3009 payload the way a facilitator would, with ethers. */
function recover(payload) {
  const chainId = chainIdOfNetwork(payload.accepted.network);
  assert.equal(chainId.ok, true);
  const { authorization, signature } = payload.payload;
  return verifyTypedData(
    { name: payload.accepted.extra.name, version: payload.accepted.extra.version, chainId: chainId.value, verifyingContract: payload.accepted.asset },
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
    signature,
  );
}

/** A facilitator that recovers the signer itself and records what it was asked. */
function fakeFacilitator({ verifyAs, settleAs } = {}) {
  const calls = [];
  return {
    calls,
    async verify(payload, requirements) {
      calls.push(["verify", payload, requirements]);
      if (verifyAs !== undefined) return verifyAs;
      const payer = recover(payload);
      const valid =
        payload.payload.authorization.to.toLowerCase() === requirements.payTo.toLowerCase() &&
        payload.payload.authorization.value === requirements.amount &&
        payer.toLowerCase() === payload.payload.authorization.from.toLowerCase();
      return valid ? { isValid: true, payer } : { isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer };
    },
    async settle(payload, requirements) {
      calls.push(["settle", payload, requirements]);
      if (settleAs !== undefined) return settleAs;
      return { success: true, transaction: `0x${"cd".repeat(32)}`, network: requirements.network, payer: recover(payload), amount: requirements.amount };
    },
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:10143" }], extensions: [], signers: {} };
    },
  };
}

/** A `fetch` that answers from a script and remembers every call. */
function recordingFetch(script) {
  const calls = [];
  let index = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return typeof step === "function" ? step(url, init, calls.length) : step;
  };
  return { calls, impl };
}

// ---------------------------------------------------------------- wire

test("the CAIP-2 network round-trips an EVM chain id and refuses anything else", () => {
  assert.equal(networkOf(10143n), "eip155:10143");
  assert.equal(chainIdOfNetwork("eip155:143").value, 143n);
  const solana = chainIdOfNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(solana.ok, false);
  assert.equal(solana.error.code, "X402_NETWORK_UNSUPPORTED");
});

test("PAYMENT-REQUIRED decodes back to what was encoded, and a malformed header is a VALIDATION error", () => {
  const headers = new Headers({ [X402_HEADER.paymentRequired]: encodedRequired() });
  const read = readPaymentRequired(headers);
  assert.equal(read.ok, true);
  assert.deepEqual(read.value, required());

  const absent = readPaymentRequired(new Headers());
  assert.equal(absent.ok, true);
  assert.equal(absent.value, undefined);

  const broken = readPaymentRequired(new Headers({ [X402_HEADER.paymentRequired]: "not base64 json" }));
  assert.equal(broken.ok, false);
  assert.equal(broken.error.category, "VALIDATION");

  const wrongVersion = readPaymentRequired(new Headers({ [X402_HEADER.paymentRequired]: encodedRequired([requirement()], { x402Version: 1 }) }));
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.error.code, "X402_VERSION_UNSUPPORTED");
});

test("selectExactRequirement keeps the server's order and says why each option was passed over", () => {
  const base = requirement({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
  const upto = requirement({ scheme: "upto" });
  const permit2 = requirement({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } });
  const monad = requirement();

  const picked = selectExactRequirement(required([base, upto, permit2, monad]), { chainId: 10143n });
  assert.equal(picked.ok, true);
  assert.equal(picked.value, monad);

  const none = selectExactRequirement(required([base, upto, permit2]), { chainId: 10143n });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, "X402_NO_USABLE_REQUIREMENT");
  assert.match(none.error.message, /accepts\[0\] is on chain 8453/);
  assert.match(none.error.message, /accepts\[1\] uses scheme `upto`/);
  assert.match(none.error.message, /accepts\[2\] needs asset transfer method `permit2`/);

  const capped = selectExactRequirement(required([monad]), { maxAmount: 9_999n });
  assert.equal(capped.ok, false);
  assert.match(capped.error.message, /above the ceiling/);
});

// ---------------------------------------------------------------- signing

test("signExactPayment produces an EIP-3009 authorization that recovers to the signer", async () => {
  const signed = await signExactPayment({
    signer: SIGNER,
    required: required(),
    accepted: requirement(),
    now: () => NOW_SECONDS,
    nonce: () => NONCE,
  });
  assert.equal(signed.ok, true);
  const { payload, authorization } = signed.value;

  assert.equal(payload.x402Version, 2);
  assert.deepEqual(payload.resource, required().resource);
  assert.deepEqual(payload.accepted, requirement());
  assert.equal(authorization.from, SIGNER.address);
  assert.equal(authorization.to, COLLECTION);
  assert.equal(authorization.value, "10000");
  assert.equal(authorization.validAfter, "0");
  assert.equal(authorization.validBefore, String(NOW_SECONDS + 300));
  assert.equal(authorization.nonce, NONCE);
  assert.equal(recover(payload), SIGNER.address);

  // The header round-trips through `@x402/core`'s codec.
  const decoded = decodePaymentSignature(Buffer.from(JSON.stringify(payload)).toString("base64"));
  assert.equal(decoded.ok, true);
  assert.equal(recover(decoded.value), SIGNER.address);
});

test("a requirement without an EIP-712 domain cannot be signed, and the error names it", async () => {
  const signed = await signExactPayment({ signer: SIGNER, required: required(), accepted: requirement({ extra: {} }) });
  assert.equal(signed.ok, false);
  assert.equal(signed.error.code, "X402_DOMAIN_MISSING");
});

test("a signer factory may decline, may throw, and may hand back a signer", async () => {
  assert.deepEqual(await resolveX402Signer(undefined), { ok: true, value: undefined });
  assert.deepEqual(await resolveX402Signer(() => undefined), { ok: true, value: undefined });
  const produced = await resolveX402Signer(async () => SIGNER);
  assert.equal(produced.ok, true);
  assert.equal(produced.value, SIGNER);
  const threw = await resolveX402Signer(() => {
    throw new Error("no key here");
  });
  assert.equal(threw.ok, false);
  assert.equal(threw.error.code, "X402_SIGNER_FACTORY_FAILED");
  const bogus = await resolveX402Signer(() => ({ getAddress: async () => "0x" }));
  assert.equal(bogus.ok, false);
  assert.equal(bogus.error.code, "X402_SIGNER_INVALID");
});

// ---------------------------------------------------------------- x402 client

test("the x402 client pays a 402 once and reports the settlement the server returned", async () => {
  const settlement = { success: true, transaction: `0x${"ef".repeat(32)}`, network: "eip155:10143", payer: SIGNER.address };
  let seenPayment;
  const { calls, impl } = recordingFetch([
    new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodedRequired() } }),
    (url, init) => {
      const payload = decodePaymentSignature(init.headers[X402_HEADER.paymentSignature]);
      assert.equal(payload.ok, true);
      seenPayment = payload.value;
      return new Response(JSON.stringify({ quote: 42 }), {
        status: 200,
        headers: { [X402_HEADER.paymentResponse]: Buffer.from(JSON.stringify(settlement)).toString("base64") },
      });
    },
  ]);
  const client = createX402Client({ signer: SIGNER, fetchImpl: impl, chainId: 10143n, logger: silent, nowSeconds: () => NOW_SECONDS, nonce: () => NONCE });

  const result = await client.fetch("https://svc.example/meter/quote", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(result.ok, true);
  assert.equal(result.value.response.status, 200);
  assert.equal(calls.length, 2, "the first attempt, then exactly one paid repeat");
  assert.equal(calls[1].init.body, "{}", "the body is sent again");
  assert.equal(calls[1].init.headers["content-type"], "application/json", "the caller's headers survive");
  assert.equal(recover(seenPayment), SIGNER.address);

  const payment = result.value.payment;
  assert.equal(payment.txHash, settlement.transaction);
  assert.equal(payment.amount, 10_000n);
  assert.equal(payment.asset, TESTNET_USDC.toLowerCase());
  assert.equal(payment.payTo, COLLECTION.toLowerCase());
  assert.equal(payment.payer, SIGNER.address.toLowerCase());
  assert.equal(payment.chainId, 10143n);
  assert.deepEqual(client.payments(), [payment]);
});

test("a 402 that stands after the payment is a LIMIT error carrying the server's reason", async () => {
  const refusal = { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:10143" };
  const { calls, impl } = recordingFetch([
    new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodedRequired() } }),
    new Response("{}", { status: 402, headers: { [X402_HEADER.paymentResponse]: Buffer.from(JSON.stringify(refusal)).toString("base64") } }),
  ]);
  const client = createX402Client({ signer: SIGNER, fetchImpl: impl, logger: silent });
  const result = await client.fetch("https://svc.example/meter/quote", { headers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.category, "LIMIT");
  assert.equal(result.error.code, "X402_PAYMENT_REJECTED");
  assert.equal(result.error.details.reason, "insufficient_funds");
  assert.equal(calls.length, 2, "no third attempt");
});

test("the authorise hook runs before anything is signed and its refusal stops the payment", async () => {
  const { calls, impl } = recordingFetch([new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodedRequired() } })]);
  let asked;
  const client = createX402Client({
    signer: SIGNER,
    fetchImpl: impl,
    logger: silent,
    authorise: (accepted) => {
      asked = accepted;
      return { ok: false, error: { category: "LIMIT", code: "LIMIT_EXCEEDED", message: "no headroom", retryable: false } };
    },
  });
  const result = await client.fetch("https://svc.example/meter/quote", { headers: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "LIMIT_EXCEEDED");
  assert.equal(asked.amount, "10000");
  assert.equal(calls.length, 1, "nothing was sent after the refusal");
});

test("a 402 with no offer, or an offer on the wrong chain, is not paid", async () => {
  const noOffer = createX402Client({ signer: SIGNER, fetchImpl: recordingFetch([new Response("{}", { status: 402 })]).impl, logger: silent });
  const missing = await noOffer.fetch("https://svc.example/x", { headers: {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "X402_PAYMENT_REQUIRED_MISSING");

  const base = requirement({ network: "eip155:8453" });
  const wrongChain = createX402Client({
    signer: SIGNER,
    chainId: 10143n,
    fetchImpl: recordingFetch([new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodedRequired([base]) } })]).impl,
    logger: silent,
  });
  const unusable = await wrongChain.fetch("https://svc.example/x", { headers: {} });
  assert.equal(unusable.ok, false);
  assert.equal(unusable.error.code, "X402_NO_USABLE_REQUIREMENT");
});

// ---------------------------------------------------------------- the Tab 402 client's fallback

const tabChargeHeaders = () => ({
  [TAB_HEADER.chargeAmount]: "10000",
  [TAB_HEADER.chargeAsset]: `10143:${TESTNET_USDC.toLowerCase()}`,
  [TAB_HEADER.chargeService]: SERVICE_ID,
  [TAB_HEADER.chargeTool]: TOOL,
  [TAB_HEADER.openTab]: "40000",
  [TAB_HEADER.headroom]: "500",
});

test("the Tab 402 client takes the x402 offer only after the repeat, and only with a signer", async () => {
  const settlement = { success: true, transaction: `0x${"ef".repeat(32)}`, network: "eip155:10143" };
  const credit402 = () =>
    new Response("{}", { status: 402, headers: { ...tabChargeHeaders(), [X402_HEADER.paymentRequired]: encodedRequired() } });
  const paid200 = () =>
    new Response("{}", {
      status: 200,
      headers: { ...tabChargeHeaders(), [X402_HEADER.paymentResponse]: Buffer.from(JSON.stringify(settlement)).toString("base64") },
    });

  // Without a signer the standing 402 is the credit decision it always was.
  const keyless = recordingFetch([credit402(), credit402()]);
  const plain = createTab402Client({ baseUrl: "https://svc.example/", agent: AGENT, fetchImpl: keyless.impl, logger: silent });
  const refused = await plain.fetch("meter/quote", { method: "POST", body: "{}" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "LIMIT_EXCEEDED");
  assert.equal(keyless.calls.length, 2, "one repeat, and no payment attempt");
  assert.deepEqual(plain.payments(), []);

  // With a signer, the repeat still happens first, then the offer is taken once.
  const paying = recordingFetch([credit402(), credit402(), paid200()]);
  const receipts = [];
  const client = createTab402Client({
    baseUrl: "https://svc.example/",
    agent: AGENT,
    fetchImpl: paying.impl,
    logger: silent,
    x402: { signer: SIGNER, chainId: 10143n, onPayment: (receipt) => receipts.push(receipt) },
  });
  const paid = await client.fetch("meter/quote", { method: "POST", body: "{}" });
  assert.equal(paid.ok, true);
  assert.equal(paid.value.status, 200);
  assert.equal(paying.calls.length, 3, "attempt, repeat, paid attempt");
  assert.ok(paying.calls[2].init.headers[X402_HEADER.paymentSignature], "the third attempt carries the signature");
  assert.equal(paying.calls[2].init.headers[TAB_HEADER.agent], AGENT, "and still identifies the Agent");
  assert.equal(client.payments().length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(client.charges().filter((charge) => charge.outcome === "declined").length, 2, "both refusals were recorded");

  // A factory that declines leaves the refusal alone.
  const declining = recordingFetch([credit402()]);
  const declined = createTab402Client({
    baseUrl: "https://svc.example/",
    agent: AGENT,
    maxRetries: 0,
    fetchImpl: declining.impl,
    logger: silent,
    x402: { signer: () => undefined },
  });
  const stands = await declined.fetch("meter/quote", { method: "POST", body: "{}" });
  assert.equal(stands.ok, false);
  assert.equal(stands.error.code, "LIMIT_EXCEEDED");
  assert.equal(declining.calls.length, 1);
});

test("tab_call reports the x402 receipt when the prepaid fallback paid for the call", async () => {
  const settlement = { success: true, transaction: `0x${"ef".repeat(32)}`, network: "eip155:10143", payer: SIGNER.address };
  const { calls, impl } = recordingFetch([
    new Response("{}", { status: 402, headers: { ...tabChargeHeaders(), [X402_HEADER.paymentRequired]: encodedRequired() } }),
    new Response(JSON.stringify({ quote: "42" }), {
      status: 200,
      headers: {
        ...tabChargeHeaders(),
        "content-type": "application/json",
        [X402_HEADER.paymentResponse]: Buffer.from(JSON.stringify(settlement)).toString("base64"),
      },
    }),
  ]);
  let factoryCalls = 0;
  const toolset = createTabToolset({
    settings: {
      agent: AGENT,
      registryUrl: undefined,
      rpcUrl: undefined,
      chainId: 10143,
      explorerUrl: "https://testnet.monadvision.com",
      services: [{ serviceId: SERVICE_ID, name: "svc", endpoint: "https://svc.example/meter" }],
      strategyId: undefined,
      x402: () => {
        factoryCalls += 1;
        return SIGNER;
      },
      sources: {},
    },
    fetchImpl: impl,
    logger: silent,
    env: {},
  });

  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "quote", arguments: { q: 1 } });
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.deepEqual(output.result, { quote: "42" });
  assert.equal(factoryCalls, 1, "the factory ran once, at the moment of the offer");
  assert.equal(calls.length, 2);
  assert.equal(output.x402.txHash, settlement.transaction);
  assert.equal(output.x402.network, "eip155:10143");
  assert.equal(output.x402.amountBaseUnits, "10000");
  assert.equal(output.x402.asset, `10143:${TESTNET_USDC.toLowerCase()}`);
  assert.equal(output.x402.payTo, COLLECTION.toLowerCase());
  assert.equal(output.x402.payer, SIGNER.address.toLowerCase());
  assert.equal(output.x402.explorerUrl, `https://testnet.monadvision.com/tx/${settlement.transaction}`);
  assert.equal(output.charge.amountBaseUnits, "10000");
  assert.equal(output.tab.headroomBaseUnits, "500");
});

test("tab_call without an x402 factory still reports LIMIT_EXCEEDED on a 402 that carries an offer", async () => {
  const { impl } = recordingFetch([
    new Response("{}", { status: 402, headers: { ...tabChargeHeaders(), [X402_HEADER.paymentRequired]: encodedRequired() } }),
  ]);
  const toolset = createTabToolset({
    settings: {
      agent: AGENT,
      registryUrl: undefined,
      rpcUrl: undefined,
      chainId: 10143,
      explorerUrl: "https://testnet.monadvision.com",
      services: [{ serviceId: SERVICE_ID, name: "svc", endpoint: "https://svc.example/meter" }],
      strategyId: undefined,
      x402: undefined,
      sources: {},
    },
    fetchImpl: impl,
    logger: silent,
    env: {},
  });
  const output = await toolset.call({ serviceId: SERVICE_ID, tool: "quote" });
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "LIMIT_EXCEEDED");
  assert.equal(output.error.requiredBaseUnits, "10000");
  assert.equal(output.error.headroomBaseUnits, "500");
  assert.equal(output.x402, undefined);
});

// ---------------------------------------------------------------- server side

test("exactRequirementFor builds the requirement the facilitator needs, and refuses what it cannot sign", () => {
  const built = exactRequirementFor({ chainId: 10143n, asset: { address: TESTNET_USDC, symbol: "USDC" }, amount: 10_000n, payTo: COLLECTION });
  assert.equal(built.ok, true);
  assert.deepEqual(built.value, requirement());

  const unknownDomain = exactRequirementFor({ chainId: 10143n, asset: { address: TESTNET_USDC, symbol: "AUSD" }, amount: 1n, payTo: COLLECTION });
  assert.equal(unknownDomain.ok, false);
  assert.equal(unknownDomain.error.code, "X402_DOMAIN_MISSING");

  const withDomain = exactRequirementFor({
    chainId: 143n,
    asset: { address: TESTNET_USDC, symbol: "AUSD" },
    amount: 1n,
    payTo: COLLECTION,
    extra: { name: "Agora Dollar", version: "1" },
  });
  assert.equal(withDomain.ok, true);
  assert.equal(withDomain.value.network, "eip155:143");

  const zero = exactRequirementFor({ chainId: 10143n, asset: { address: TESTNET_USDC, symbol: "USDC" }, amount: 0n, payTo: COLLECTION });
  assert.equal(zero.ok, false);
});

test("verifyPayment and settlePayment turn the facilitator's refusals into LIMIT results", async () => {
  const signed = await signExactPayment({ signer: SIGNER, required: required(), accepted: requirement(), now: () => NOW_SECONDS });
  const accepting = fakeFacilitator();
  const verified = await verifyPayment(accepting, signed.value.payload, requirement());
  assert.equal(verified.ok, true);
  assert.equal(verified.value.payer, SIGNER.address);

  const refusing = fakeFacilitator({ verifyAs: { isValid: false, invalidReason: "insufficient_funds" } });
  const refused = await verifyPayment(refusing, signed.value.payload, requirement());
  assert.equal(refused.ok, false);
  assert.equal(refused.error.category, "LIMIT");
  assert.equal(refused.error.details.reason, "insufficient_funds");

  const pending = fakeFacilitator({ settleAs: { success: false, errorReason: "settlement_pending", transaction: `0x${"77".repeat(32)}`, network: "eip155:10143" } });
  const stuck = await settlePayment(pending, signed.value.payload, requirement());
  assert.equal(stuck.ok, false);
  assert.equal(stuck.error.category, "UNAVAILABLE");
  assert.equal(stuck.error.retryable, true);
  assert.equal(stuck.error.details.transaction, `0x${"77".repeat(32)}`);

  const throwing = { ...accepting, verify: async () => Object.assign(new Error("verify failed"), { invalidReason: "invalid_payload", statusCode: 400 }) };
  throwing.verify = async () => {
    throw Object.assign(new Error("verify failed"), { invalidReason: "invalid_payload", statusCode: 400 });
  };
  const thrown = await verifyPayment(throwing, signed.value.payload, requirement());
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error.code, "X402_VERIFY_REJECTED");
  assert.equal(thrown.error.details.reason, "invalid_payload");
});

test("matchAccepted refuses a payload signed for a different amount or recipient", () => {
  assert.equal(matchAccepted(requirement(), requirement()).ok, true);
  const cheaper = matchAccepted(requirement({ amount: "1" }), requirement());
  assert.equal(cheaper.ok, false);
  assert.match(cheaper.error.message, /amount 1 is not 10000/);
  const elsewhere = matchAccepted(requirement({ payTo: AGENT }), requirement());
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.error.message, /payTo/);
});

test("handlePrepaidRequest runs verify, deliver, settle, in that order, and settles nothing for a failed delivery", async () => {
  const signed = await signExactPayment({ signer: SIGNER, required: required(), accepted: requirement(), now: () => NOW_SECONDS });
  const events = [];
  const facilitator = fakeFacilitator();
  const outcome = await handlePrepaidRequest({
    facilitator: {
      ...facilitator,
      verify: async (...args) => {
        events.push("verify");
        return facilitator.verify(...args);
      },
      settle: async (...args) => {
        events.push("settle");
        return facilitator.settle(...args);
      },
    },
    payload: signed.value.payload,
    requirements: requirement(),
    resource: required().resource,
    deliver: () => {
      events.push("deliver");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    logger: silent,
  });
  assert.equal(outcome.kind, "paid");
  assert.deepEqual(events, ["verify", "deliver", "settle"]);
  const settlement = readPaymentResponse(outcome.response.headers);
  assert.equal(settlement.ok, true);
  assert.equal(settlement.value.success, true);
  assert.equal(settlement.value.transaction, `0x${"cd".repeat(32)}`);
  assert.equal(outcome.response.status, 200);

  const failing = fakeFacilitator();
  const notDelivered = await handlePrepaidRequest({
    facilitator: failing,
    payload: signed.value.payload,
    requirements: requirement(),
    resource: required().resource,
    deliver: () => new Response("upstream broke", { status: 502 }),
    logger: silent,
  });
  assert.equal(notDelivered.kind, "not-delivered");
  assert.equal(notDelivered.response.status, 502);
  assert.deepEqual(
    failing.calls.map(([what]) => what),
    ["verify"],
    "a failed delivery is verified and never settled",
  );
});

test("handlePrepaidRequest answers a bad signature with a 402 that re-states the requirement and the reason", async () => {
  const forged = await signExactPayment({ signer: new Wallet(`0x${"22".repeat(32)}`), required: required(), accepted: requirement(), now: () => NOW_SECONDS });
  // A payload whose `from` is one address and whose signature is another's.
  const payload = { ...forged.value.payload, payload: { ...forged.value.payload.payload, authorization: { ...forged.value.payload.payload.authorization, from: SIGNER.address } } };
  let delivered = false;
  const outcome = await handlePrepaidRequest({
    facilitator: fakeFacilitator(),
    payload,
    requirements: requirement(),
    resource: required().resource,
    deliver: () => {
      delivered = true;
      return new Response("{}", { status: 200 });
    },
    logger: silent,
  });
  assert.equal(outcome.kind, "rejected");
  assert.equal(delivered, false, "nothing is delivered on a payment that did not verify");
  assert.equal(outcome.response.status, 402);
  const offered = readPaymentRequired(outcome.response.headers);
  assert.equal(offered.ok, true);
  assert.deepEqual(offered.value.accepts, [requirement()]);
  assert.match(offered.value.error, /invalid_exact_evm_payload_signature/);

  const mismatched = await handlePrepaidRequest({
    facilitator: fakeFacilitator(),
    payload: { ...forged.value.payload, accepted: requirement({ amount: "1" }) },
    requirements: requirement(),
    resource: required().resource,
    deliver: () => new Response("{}", { status: 200 }),
    logger: silent,
  });
  assert.equal(mismatched.kind, "rejected");
  assert.equal(mismatched.error.code, "X402_ACCEPTED_MISMATCH");
});

test("a settlement the facilitator refuses after delivery is a 402 carrying the failed PAYMENT-RESPONSE", async () => {
  const signed = await signExactPayment({ signer: SIGNER, required: required(), accepted: requirement(), now: () => NOW_SECONDS });
  const outcome = await handlePrepaidRequest({
    facilitator: fakeFacilitator({ settleAs: { success: false, errorReason: "invalid_transaction_state", transaction: "", network: "eip155:10143" } }),
    payload: signed.value.payload,
    requirements: requirement(),
    resource: required().resource,
    deliver: () => new Response("{}", { status: 200 }),
    logger: silent,
  });
  assert.equal(outcome.kind, "settlement-failed");
  assert.equal(outcome.response.status, 402);
  const settlement = readPaymentResponse(outcome.response.headers);
  assert.equal(settlement.value.success, false);
  assert.equal(settlement.value.errorReason, "invalid_transaction_state");
});

// ---------------------------------------------------------------- the fronting proxy

const USDC_ASSET = { chainId: 10143n, address: TESTNET_USDC.toLowerCase(), decimals: 6, symbol: "USDC" };

function acceptingTabBook(calls = []) {
  return {
    async recordDelivery(delivery) {
      calls.push(delivery);
      return { ok: true, value: { charged: BigInt(delivery.units) * delivery.expectedUnitPrice, openAfter: 3_000_000n, headroomAfter: 2_000_000n, recordedAt: 1 } };
    },
    async openTabOf() {
      return { ok: true, value: 3_000_000n };
    },
  };
}

/** An x402 upstream: 402 without a signature, 200 with one that recovers to the operator. */
function x402Upstream({ amount = "10000", operator = SIGNER.address } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const signature = init.headers[X402_HEADER.paymentSignature];
    const offer = required([requirement({ amount, payTo: "0x000000000000000000000000000000000000c011" })], { resource: { url } });
    if (signature === undefined) {
      return new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodePaymentRequired(offer).value } });
    }
    const payload = decodePaymentSignature(signature).value;
    if (recover(payload).toLowerCase() !== operator.toLowerCase() || payload.payload.authorization.value !== amount) {
      return new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodePaymentRequired({ ...offer, error: "bad signature" }).value } });
    }
    const body = init.body === undefined ? null : Buffer.from(init.body).toString();
    return new Response(JSON.stringify({ paid: true, echo: body }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        [X402_HEADER.paymentResponse]: Buffer.from(JSON.stringify({ success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:10143", amount })).toString("base64"),
      },
    });
  };
  return { calls, fetchImpl };
}

test("the fronting proxy pays the upstream with the operator's key and meters the Agent for the price plus the margin", async () => {
  const upstream = x402Upstream({ amount: "10000" });
  const deliveries = [];
  const pricing = createX402UpstreamPricing({ tool: TOOL, margin: { bps: 500n, flatBaseUnits: 100n } });
  const plugin = tabPostPaid({ serviceId: SERVICE_ID, asset: USDC_ASSET, tabBook: acceptingTabBook(deliveries), priceOf: pricing.priceOf, logger: silent });
  const payments = [];
  const proxy = createX402FrontedProxy({
    upstream: "https://api.nansen.ai/api/v1",
    stripPrefix: "/hub/nansen",
    signer: SIGNER,
    asset: USDC_ASSET,
    pricing,
    metering: plugin,
    fetchImpl: upstream.fetchImpl,
    logger: silent,
    nowSeconds: () => NOW_SECONDS,
    onPayment: (receipt) => payments.push(receipt),
  });

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"q":"whales"}'));
      controller.close();
    },
  });
  const request = new Request("https://svc.example/hub/nansen/query?limit=5", {
    method: "POST",
    headers: { "content-type": "application/json", [TAB_HEADER.agent]: AGENT },
    body,
    duplex: "half",
  });
  const result = await proxy.proxy(request);

  assert.equal(result.kind, "delivered");
  assert.equal(result.response.status, 200);
  assert.deepEqual(await result.response.json(), { paid: true, echo: '{"q":"whales"}' });
  assert.equal(upstream.calls.length, 2, "the probe, then the paid call");
  assert.equal(upstream.calls[0].url, "https://api.nansen.ai/api/v1/query?limit=5", "the mount prefix is stripped");
  assert.equal(new Headers(upstream.calls[1].init.headers).get(TAB_HEADER.agent), AGENT, "the forwarded headers are the request's");

  // 10000 upstream + 5% + 100 flat = 10600, metered as one unit at that price.
  assert.equal(deliveries.length, 1);
  // The amount rides in the unit count, because a fronted price is not known
  // until the upstream answers and the chain refuses a unit price it does not
  // hold. One base unit a unit makes the charge exact.
  assert.equal(deliveries[0].expectedUnitPrice, 1n);
  assert.equal(deliveries[0].units, 10_600);
  assert.equal(deliveries[0].tool, TOOL);
  assert.equal(deliveries[0].agent, AGENT);
  assert.equal(result.response.headers.get(TAB_HEADER.chargeAmount), "10600");
  assert.equal(result.charge.amount, 10_600n);

  assert.equal(payments.length, 1);
  assert.equal(payments[0].amount, 10_000n);
  assert.equal(proxy.payments().length, 1);
  const charge = pricing.chargeOf(request);
  assert.equal(charge.upstreamAmount, 10_000n);
  assert.equal(charge.margin, 600n);
});

test("the fronting proxy refuses before paying when the preflight says the Agent has no headroom", async () => {
  const upstream = x402Upstream();
  const deliveries = [];
  const pricing = createX402UpstreamPricing({ tool: TOOL });
  const plugin = tabPostPaid({ serviceId: SERVICE_ID, asset: USDC_ASSET, tabBook: acceptingTabBook(deliveries), priceOf: pricing.priceOf, logger: silent });
  let quoted;
  const proxy = createX402FrontedProxy({
    upstream: "https://api.example/v1",
    signer: SIGNER,
    asset: USDC_ASSET,
    pricing,
    metering: plugin,
    fetchImpl: upstream.fetchImpl,
    logger: silent,
    preflight: (quote) => {
      quoted = quote;
      return {
        ok: false,
        error: { category: "LIMIT", code: "LIMIT_EXCEEDED", message: "no headroom", retryable: false, details: { requiredBaseUnits: "10000", headroomBaseUnits: "0" } },
      };
    },
  });
  const result = await proxy.proxy(new Request("https://svc.example/query", { headers: { [TAB_HEADER.agent]: AGENT } }));
  assert.equal(result.response.status, 402);
  assert.equal(upstream.calls.length, 1, "the probe only; the operator never signed");
  assert.equal(deliveries.length, 0, "nothing was metered");
  assert.equal(quoted.agent, AGENT);
  assert.equal(quoted.amount, 10_000n);
  assert.equal(quoted.upstreamAmount, 10_000n);
  const body = await result.response.json();
  assert.equal(body.error.code, "LIMIT_EXCEEDED");
});

test("an upstream that prices in another asset is not paid and the Agent is not metered", async () => {
  const upstream = x402Upstream();
  const deliveries = [];
  const pricing = createX402UpstreamPricing({ tool: TOOL });
  const plugin = tabPostPaid({ serviceId: SERVICE_ID, asset: { ...USDC_ASSET, address: "0x754704bc059f8c67012fed69bc8a327a5aafb603", chainId: 143n }, tabBook: acceptingTabBook(deliveries), priceOf: pricing.priceOf, logger: silent });
  const proxy = createX402FrontedProxy({
    upstream: "https://api.example/v1",
    signer: SIGNER,
    asset: { chainId: 143n, address: "0x754704bc059f8c67012fed69bc8a327a5aafb603" },
    pricing,
    metering: plugin,
    fetchImpl: upstream.fetchImpl,
    logger: silent,
  });
  const result = await proxy.proxy(new Request("https://svc.example/query", { headers: { [TAB_HEADER.agent]: AGENT } }));
  assert.equal(result.response.status, 400);
  const body = await result.response.json();
  assert.equal(body.error.code, "X402_NO_USABLE_REQUIREMENT");
  assert.equal(upstream.calls.length, 1);
  assert.equal(deliveries.length, 0);
});

test("an upstream paid on Monad Mainnet is paid there, by the payer named for it, and metered on the Service's own network", async () => {
  // The API Hub takes USDC on Monad Mainnet only. A Testnet Service fronting it
  // pays on 143 with a key funded there and meters the Agent in its own Testnet
  // Asset, base unit for base unit, which the Service states by fronting it.
  const MAINNET_USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";
  const PAYER = new Wallet(`0x${"33".repeat(32)}`);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const signature = init.headers[X402_HEADER.paymentSignature];
    const offer = required(
      [
        requirement({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000", payTo: "0x000000000000000000000000000000000000c011", extra: { name: "USD Coin", version: "2" } }),
        requirement({ network: "eip155:143", asset: MAINNET_USDC, amount: "1000", payTo: "0x000000000000000000000000000000000000c011" }),
      ],
      { resource: { url } },
    );
    if (signature === undefined) {
      return new Response("{}", { status: 402, headers: { [X402_HEADER.paymentRequired]: encodePaymentRequired(offer).value } });
    }
    const payload = decodePaymentSignature(signature).value;
    assert.equal(payload.accepted.network, "eip155:143", "the Mainnet option was taken");
    assert.equal(recover(payload).toLowerCase(), PAYER.address.toLowerCase(), "signed by the Mainnet payer, not the operator");
    return new Response(JSON.stringify({ paid: true }), {
      status: 200,
      headers: { "content-type": "application/json", [X402_HEADER.paymentResponse]: Buffer.from(JSON.stringify({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:143", amount: "1000" })).toString("base64") },
    });
  };

  const deliveries = [];
  const pricing = createX402UpstreamPricing({ tool: TOOL, margin: { bps: 500n } });
  const plugin = tabPostPaid({ serviceId: SERVICE_ID, asset: USDC_ASSET, tabBook: acceptingTabBook(deliveries), priceOf: pricing.priceOf, logger: silent });
  const proxy = createX402FrontedProxy({
    upstream: "https://x402.monid.ai/v1",
    stripPrefix: "/hub/apihub",
    signer: SIGNER,
    asset: USDC_ASSET,
    upstreamPayment: { chainId: 143n, asset: MAINNET_USDC, signer: PAYER },
    pricing,
    metering: plugin,
    fetchImpl,
    logger: silent,
    nowSeconds: () => NOW_SECONDS,
  });
  const result = await proxy.proxy(new Request("https://svc.example/hub/apihub/run", { method: "POST", body: "{}", headers: { [TAB_HEADER.agent]: AGENT, "content-type": "application/json" } }));
  assert.equal(result.response.status, 200);
  assert.equal(calls.length, 2, "the 402, then the paid repeat");
  assert.equal(deliveries.length, 1, "metered once, on the Service's own chain");
  assert.equal(deliveries[0].asset.address.toLowerCase(), USDC_ASSET.address, "in the Service's own Asset");
  assert.equal(deliveries[0].units, 1_050, "the upstream's base units plus the margin, one base unit a unit");
  assert.equal(deliveries[0].expectedUnitPrice, 1n);
  assert.equal(proxy.payments()[0].network, "eip155:143");
});

test("a coarser published unit rounds the charge up, and a charge past uint32 units is not priced", () => {
  const request = new Request("https://svc.example/q");
  const payment = { txHash: `0x${"11".repeat(32)}`, network: "eip155:10143", amount: 1_001n, asset: TESTNET_USDC, payTo: COLLECTION, payer: AGENT };

  // A Service that published 100 base units a unit is charged 11 units for a
  // 1001-unit call: rounded up, so its own rounding never leaves it short.
  const coarse = createX402UpstreamPricing({ tool: TOOL, unitBaseUnits: 100n });
  coarse.record(request, payment);
  assert.deepEqual(coarse.priceOf(request), { tool: TOOL, units: 11, unitPrice: 100n });

  // Exact by default.
  const exact = createX402UpstreamPricing({ tool: TOOL });
  exact.record(request, payment);
  assert.deepEqual(exact.priceOf(request), { tool: TOOL, units: 1001, unitPrice: 1n });

  // A charge that needs more units than uint32 holds is refused here rather
  // than reverting on chain after the upstream has been paid.
  const huge = createX402UpstreamPricing({ tool: TOOL });
  huge.record(request, { ...payment, amount: 5_000_000_000n });
  assert.equal(huge.priceOf(request), undefined);

  assert.throws(() => createX402UpstreamPricing({ tool: TOOL, unitBaseUnits: 0n }), /positive count/);
});

test("a free upstream endpoint is forwarded and not metered", async () => {
  const deliveries = [];
  const pricing = createX402UpstreamPricing({ tool: TOOL });
  const plugin = tabPostPaid({ serviceId: SERVICE_ID, asset: USDC_ASSET, tabBook: acceptingTabBook(deliveries), priceOf: pricing.priceOf, logger: silent });
  const proxy = createX402FrontedProxy({
    upstream: "https://api.example/v1",
    signer: SIGNER,
    asset: USDC_ASSET,
    pricing,
    metering: plugin,
    fetchImpl: async () => new Response("free", { status: 200 }),
    logger: silent,
  });
  const result = await proxy.proxy(new Request("https://svc.example/health", { headers: { [TAB_HEADER.agent]: AGENT } }));
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), "free");
  assert.equal(deliveries.length, 0);
  assert.equal(result.response.headers.get(TAB_HEADER.chargeAmount), null);
});

// ---------------------------------------------------------------- the API Hub manifest

test("the Hub manifest is read page by page into tools, with per-call prices in base units", async () => {
  const pages = {
    [`${API_HUB_MANIFEST_URL}?provider=weather-underground&limit=100`]: {
      items: [
        {
          supportedX402Networks: ["eip155:8453", "eip155:143"],
          provider: "weather-underground",
          providerDisplayName: "Weather Underground",
          endpoint: "/get_current_weather",
          displayName: "Current weather",
          displayDescription: "Conditions now.",
          price: { type: "PER_CALL", amount: { value: 0.01, currency: "USD" } },
          tags: ["verified"],
          categories: ["weather"],
        },
        {
          provider: "weather-underground",
          endpoint: "/get_history",
          displayName: "History",
          price: { type: "PER_RESULT", amount: { value: 0.0025, currency: "USD" } },
        },
      ],
      cursor: "page2",
      total: 3,
    },
    [`${API_HUB_MANIFEST_URL}?provider=weather-underground&limit=100&cursor=page2`]: {
      items: [{ provider: "weather-underground", endpoint: "/search_nearby_stations", price: { type: "PER_CALL", amount: { value: 0.0000001, currency: "USD" } } }],
      total: 3,
    },
  };
  const seen = [];
  const manifest = await fetchHubManifest({
    provider: "weather-underground",
    fetchImpl: async (url) => {
      seen.push(url);
      const page = pages[url];
      return { status: page === undefined ? 404 : 200, json: async () => page };
    },
  });
  assert.equal(manifest.ok, true, JSON.stringify(manifest));
  assert.equal(seen.length, 2);
  assert.equal(manifest.value.total, 3);
  assert.equal(manifest.value.endpoints.length, 3);
  const [current, history, stations] = manifest.value.endpoints;
  assert.equal(current.priceUsd, "0.01");
  assert.equal(current.priceBaseUnits, "10000");
  assert.deepEqual(current.networks, ["eip155:8453", "eip155:143"]);
  assert.equal(history.priceType, "PER_RESULT");
  assert.equal(history.priceBaseUnits, null, "a per-result price is a rate, not a quote");
  assert.equal(stations.priceBaseUnits, "1", "finer than six decimals rounds up, never down");

  assert.equal(usdToBaseUnits("0.05"), "50000");
  assert.equal(usdToBaseUnits("1"), "1000000");
  assert.equal(usdToBaseUnits("0.0000015"), "2");
  assert.equal(usdToBaseUnits("abc"), null);

  const refused = await fetchHubManifest({ provider: "nobody", fetchImpl: async () => ({ status: 404, json: async () => ({}) }) });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "HUB_MANIFEST_REFUSED");
  const bogus = await fetchHubManifest({ provider: "../etc", fetchImpl: async () => ({ status: 200, json: async () => ({}) }) });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.error.code, "HUB_PROVIDER_INVALID");
});

test("tab_discover lists a fronted provider's endpoints under the Service that fronts it", async () => {
  const registry = {
    async services() {
      return {
        ok: true,
        value: {
          services: [
            {
              serviceId: SERVICE_ID,
              acceptedAssets: [{ asset: TESTNET_USDC, collection: COLLECTION }],
              prices: [{ tool: TOOL, asset: TESTNET_USDC, baseUnits: "10000" }],
              bond: [],
              tier: { name: "permissionless" },
              settlementWindowSeconds: { value: 21600 },
              pendingChanges: [],
            },
          ],
        },
      };
    },
  };
  const toolset = createTabToolset({
    settings: {
      agent: AGENT,
      registryUrl: undefined,
      rpcUrl: undefined,
      chainId: 10143,
      explorerUrl: "https://testnet.monadvision.com",
      services: [{ serviceId: SERVICE_ID, name: "svc", endpoint: "https://svc.example", hub: { provider: "nansen", prefix: "nansen" } }],
      strategyId: undefined,
      x402: undefined,
      sources: {},
    },
    registry,
    hubFetch: async () => ({
      status: 200,
      json: async () => ({ items: [{ provider: "nansen", endpoint: "/query", displayName: "Query", price: { type: "PER_CALL", amount: { value: 0.05, currency: "USD" } } }], total: 1 }),
    }),
    logger: silent,
    env: {},
  });
  const output = await toolset.discover({});
  assert.equal(output.error, undefined);
  assert.equal(output.services.length, 1);
  const hub = output.services[0].hub;
  assert.equal(hub.provider, "nansen");
  assert.equal(hub.prefix, "nansen");
  assert.equal(hub.total, 1);
  assert.deepEqual(hub.endpoints, [{ endpoint: "/query", name: "Query", description: null, priceType: "PER_CALL", priceUsd: "0.05", priceBaseUnits: "50000", networks: [] }]);

  const failing = createTabToolset({
    settings: { ...(await Promise.resolve({ agent: AGENT, registryUrl: undefined, rpcUrl: undefined, chainId: 10143, explorerUrl: "x", strategyId: undefined, x402: undefined, sources: {} })), services: [{ serviceId: SERVICE_ID, endpoint: "https://svc.example", hub: { provider: "nansen" } }] },
    registry,
    hubFetch: async () => {
      throw new Error("offline");
    },
    logger: silent,
    env: {},
  });
  const degraded = await failing.discover({});
  assert.equal(degraded.services.length, 1, "a manifest that cannot be read does not hide the Service");
  assert.equal(degraded.services[0].hub.error.code, "HUB_MANIFEST_UNREACHABLE");
  assert.deepEqual(degraded.services[0].hub.endpoints, []);
});
