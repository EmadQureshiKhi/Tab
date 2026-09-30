/**
 * The Privy-backed Agent signer, against a Privy double.
 *
 * The double answers Privy's REST API with a local ethers Wallet, so every
 * signature it returns is real and recovery checks mean something. It also
 * evaluates the policy `buildPrivyAgentPolicy` produces, following Privy's
 * documented semantics (a DENY wins, an ALLOW needs every condition, no match
 * is a refusal, typed-data message conditions apply only on an exact types
 * match), so the tests show the Tab flows pass the policy and a transfer
 * elsewhere does not.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicKey, verify as verifyBytes } from "node:crypto";
import {
  Interface,
  Transaction,
  Wallet,
  getAddress,
  getBytes,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
  verifyTypedData,
} from "ethers";
import { PERMIT2_ADDRESS, PERMIT2_WITNESS_TRANSFER_FROM_TYPES, permit2Domain } from "@tabai/shared";
import {
  METERING_HEADER,
  PrivyError,
  agentSignedMetering,
  buildPrivyAgentPolicy,
  canonicalJson,
  createMonadStrategy,
  createPrivyAgentSigner,
  createPrivyAgentWallet,
  createRelayedMonadStrategy,
  generatePrivyAuthorizationKeyPair,
  meteringDigest,
  toolKeyOf,
} from "../dist/index.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const AGENT_KEY = `0x${"11".repeat(32)}`;
const OTHER_KEY = `0x${"22".repeat(32)}`;
const APP_ID = "cm0app00000000000000000001";
const APP_SECRET = "privy-app-secret-for-tests";
const WALLET_ID = "cm0wallet000000000000000001";
const POLICY_ID = "cm0policy000000000000000001";
const CHAIN_ID = 10143n;
const TAB_SETTLEMENT = "0x654Fac48185e4B71779eEc2457B1F24aEdf46717";
const TAB_BOOK = "0x87571030cCe27C84836bAfF85288eB1d85d908a4";
const MUSDC = "0x480209747417f5c830fDA188a9b9AcFa70Bc4083";
const USDC = { chainId: CHAIN_ID, address: MUSDC, decimals: 6, symbol: "mUSDC" };
const SERVICE_ID = "0x7461622e64656d6f000000000000000000000000000000000000000000000000";
const STRANGER = "0x000000000000000000000000000000000000dEaD";
const BASIC = `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64")}`;

const erc20 = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const policyFor = (overrides = {}) => {
  const built = buildPrivyAgentPolicy({
    chainId: CHAIN_ID,
    addresses: { tabSettlement: TAB_SETTLEMENT, tabBook: TAB_BOOK, assets: [MUSDC] },
    ...overrides,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error.message);
  return built.value;
};

// ------------------------------------------------------------ the policy engine double

const sameNumber = (left, right) => {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
};

function compare(operator, actual, expected) {
  if (actual === undefined || actual === null) return false;
  switch (operator) {
    case "eq":
      return String(actual) === String(expected) || sameNumber(actual, expected);
    case "in":
      return expected.some((candidate) => String(actual) === String(candidate));
    case "lte":
      return BigInt(actual) <= BigInt(expected);
    case "starts_with":
      return String(actual).startsWith(expected);
    default:
      throw new Error(`the double does not implement ${operator}`);
  }
}

function fieldOf(condition, body) {
  const params = body.params ?? {};
  switch (condition.field_source) {
    case "ethereum_transaction":
      return params.transaction?.[condition.field];
    case "ethereum_calldata": {
      const parsed = new Interface(condition.abi).parseTransaction({ data: params.transaction?.data ?? "0x" });
      if (parsed === null) return undefined;
      if (condition.field === "function_name") return parsed.name;
      const [fn, argument] = condition.field.split(".");
      return parsed.name === fn ? parsed.args[argument] : undefined;
    }
    case "ethereum_typed_data_domain":
      return params.typed_data?.domain?.[condition.field];
    case "ethereum_typed_data_message": {
      const typed = params.typed_data;
      if (typed === undefined) return undefined;
      if (typed.primary_type !== condition.typed_data.primary_type) return undefined;
      if (JSON.stringify(typed.types) !== JSON.stringify(condition.typed_data.types)) return undefined;
      return condition.field.split(".").reduce((node, key) => node?.[key], typed.message);
    }
    case "message":
      return condition.field === "content" ? params.message : undefined;
    default:
      throw new Error(`the double does not implement ${condition.field_source}`);
  }
}

/** Privy's documented evaluation: a DENY wins, an ALLOW needs all its conditions, nothing matching refuses. */
function evaluate(policy, body) {
  const rules = policy.rules.filter((rule) => rule.method === body.method || rule.method === "*");
  const matching = rules.filter((rule) => rule.conditions.every((condition) => compare(condition.operator, fieldOf(condition, body), condition.value)));
  if (matching.some((rule) => rule.action === "DENY")) return false;
  return matching.some((rule) => rule.action === "ALLOW");
}

// ------------------------------------------------------------ the Privy double

const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });

/**
 * A fake of `https://api.privy.io` for one wallet. `signWith` is the key the
 * enclave holds; `policy` is enforced on every RPC call when present.
 */
function privyDouble({ signWith = new Wallet(AGENT_KEY), address, policy, chainType = "ethereum", sentHash } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, method: init.method, headers: init.headers, rawBody: init.body, body });
    const path = new URL(url).pathname;
    if (init.method === "GET" && path === `/v1/wallets/${WALLET_ID}`) {
      return reply(200, {
        id: WALLET_ID,
        address: (address ?? signWith.address).toLowerCase(),
        chain_type: chainType,
        policy_ids: policy === undefined ? [] : [POLICY_ID],
        owner_id: "cm0owner00000000000000001",
        additional_signers: policy === undefined ? [] : [{ signer_id: "cm0signer0000000000000001", override_policy_ids: [POLICY_ID] }],
      });
    }
    if (init.method === "GET" && path === `/v1/policies/${POLICY_ID}`) return reply(200, { id: POLICY_ID, ...policy });
    if (init.method === "POST" && path === `/v1/wallets/${WALLET_ID}/rpc`) {
      if (policy !== undefined && !evaluate(policy, body)) {
        return reply(400, { error: "Policy violation: the request was denied by the wallet's policy", code: "policy_violation" });
      }
      switch (body.method) {
        case "personal_sign": {
          const message = body.params.encoding === "hex" ? getBytes(body.params.message) : body.params.message;
          return reply(200, { method: "personal_sign", data: { signature: await signWith.signMessage(message), encoding: "hex" } });
        }
        case "eth_signTypedData_v4": {
          const { domain, types, message } = body.params.typed_data;
          const { EIP712Domain: _domainType, ...rest } = types;
          return reply(200, { method: body.method, data: { signature: await signWith.signTypedData(domain, rest, message), encoding: "hex" } });
        }
        case "eth_signTransaction": {
          const t = body.params.transaction;
          const signed = await signWith.signTransaction({
            to: t.to,
            value: t.value,
            data: t.data,
            chainId: t.chain_id,
            nonce: t.nonce,
            gasLimit: t.gas_limit,
            type: t.type,
            maxFeePerGas: t.max_fee_per_gas,
            maxPriorityFeePerGas: t.max_priority_fee_per_gas,
          });
          return reply(200, { method: body.method, data: { signed_transaction: signed, encoding: "rlp" } });
        }
        case "eth_sendTransaction":
          return reply(200, { method: body.method, data: { hash: sentHash, caip2: body.caip2, transaction_id: "cm0tx" } });
        default:
          return reply(400, { error: `unknown method ${body.method}` });
      }
    }
    return reply(404, { error: "not found" });
  };
  return { fetch, calls, rpcCalls: () => calls.filter((call) => call.url.endsWith("/rpc")) };
}

/**
 * A provider double: nonce 7, fixed gas and fees, an allowance of `allowance`
 * for any `allowance(...)` read, and a broadcast that records the raw
 * transaction and returns a mined receipt.
 */
function providerDouble({ allowance = 0n } = {}) {
  const broadcast = [];
  const provider = {
    async getNetwork() {
      return { chainId: CHAIN_ID };
    },
    async getTransactionCount() {
      return 7;
    },
    async estimateGas() {
      return 90_000n;
    },
    async getFeeData() {
      return { gasPrice: 100n * 10n ** 9n, maxFeePerGas: 102n * 10n ** 9n, maxPriorityFeePerGas: 2n * 10n ** 9n };
    },
    async call() {
      return `0x${allowance.toString(16).padStart(64, "0")}`;
    },
    async broadcastTransaction(signed) {
      broadcast.push(signed);
      const parsed = Transaction.from(signed);
      return { hash: parsed.hash, wait: async () => ({ hash: parsed.hash, status: 1, logs: [] }) };
    },
    async getTransaction(hash) {
      return { hash, wait: async () => ({ hash, status: 1, logs: [] }) };
    },
  };
  return { provider, broadcast };
}

const signerOver = (double, extra = {}) => {
  const built = createPrivyAgentSigner({
    appId: APP_ID,
    appSecret: APP_SECRET,
    walletId: WALLET_ID,
    chainId: CHAIN_ID,
    fetch: double.fetch,
    logger: silent,
    ...extra,
  });
  assert.equal(built.ok, true, built.ok ? "" : built.error.message);
  return built.value;
};

// ------------------------------------------------------------ tests

test("the wallet address is read once from Privy with Basic auth and the app id header", async () => {
  const double = privyDouble();
  const signer = signerOver(double);
  assert.equal(await signer.getAddress(), new Wallet(AGENT_KEY).address, "checksummed, whatever case Privy sends");
  assert.equal(await signer.getAddress(), new Wallet(AGENT_KEY).address);
  assert.equal(double.calls.length, 1, "the address is cached");
  const [call] = double.calls;
  assert.equal(call.url, `https://api.privy.io/v1/wallets/${WALLET_ID}`);
  assert.equal(call.method, "GET");
  assert.equal(call.headers.authorization, BASIC);
  assert.equal(call.headers["privy-app-id"], APP_ID);
  assert.equal(call.headers["privy-authorization-signature"], undefined, "a GET is never signed");
  assert.equal(signer.caip2, "eip155:10143");
});

test("a wallet that is not an ethereum wallet is refused by name", async () => {
  const signer = signerOver(privyDouble({ chainType: "solana" }));
  await assert.rejects(signer.getAddress(), (error) => error instanceof PrivyError && error.code === "PRIVY_RESPONSE_INVALID" && /chain_type ethereum/.test(error.message));
});

test("signMessage is personal_sign, in utf-8 for text and hex for bytes, and recovers to the wallet", async () => {
  const double = privyDouble();
  const signer = signerOver(double);
  const text = "tab-metering-request\nPOST\n/meter/x";
  const signature = await signer.signMessage(text);
  assert.equal(verifyMessage(text, signature), new Wallet(AGENT_KEY).address);
  const [rpc] = double.rpcCalls();
  assert.equal(rpc.url, `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`);
  assert.equal(rpc.method, "POST");
  assert.deepEqual(rpc.body, { method: "personal_sign", params: { message: text, encoding: "utf-8" } });
  assert.equal(rpc.headers.authorization, BASIC);
  assert.equal(rpc.headers["content-type"], "application/json");

  const bytes = new Uint8Array([1, 2, 3, 255]);
  const byteSignature = await signer.signMessage(bytes);
  assert.equal(verifyMessage(bytes, byteSignature), new Wallet(AGENT_KEY).address);
  assert.deepEqual(double.rpcCalls()[1].body.params, { message: "0x010203ff", encoding: "hex" });
});

test("signTypedData is eth_signTypedData_v4 with EIP712Domain and primary_type, and recovers to the wallet", async () => {
  const double = privyDouble();
  const signer = signerOver(double);
  const domain = permit2Domain(CHAIN_ID, PERMIT2_ADDRESS);
  const value = {
    permitted: { token: MUSDC, amount: 47_000n },
    spender: TAB_SETTLEMENT,
    nonce: 9n,
    deadline: 1_800_000_000n,
    witness: { serviceId: SERVICE_ID, asset: MUSDC, amount: 47_000n, surface: TAB_SETTLEMENT, chainId: CHAIN_ID },
  };
  const signature = await signer.signTypedData(domain, PERMIT2_WITNESS_TRANSFER_FROM_TYPES, value);
  assert.equal(verifyTypedData(domain, PERMIT2_WITNESS_TRANSFER_FROM_TYPES, value, signature), new Wallet(AGENT_KEY).address);
  const [rpc] = double.rpcCalls();
  assert.equal(rpc.body.method, "eth_signTypedData_v4");
  const typed = rpc.body.params.typed_data;
  assert.equal(typed.primary_type, "PermitWitnessTransferFrom");
  assert.deepEqual(typed.domain, { name: "Permit2", chainId: 10143, verifyingContract: PERMIT2_ADDRESS });
  assert.deepEqual(typed.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ]);
  assert.equal(typed.message.spender, TAB_SETTLEMENT.toLowerCase());
  assert.equal(typed.message.permitted.amount, "47000", "integers travel as decimal strings");
});

test("sendTransaction has Privy sign with eth_signTransaction and broadcasts through the provider", async () => {
  const double = privyDouble();
  const { provider, broadcast } = providerDouble();
  const signer = signerOver(double, { provider });
  const data = erc20.encodeFunctionData("approve", [TAB_SETTLEMENT, 5n]);
  const response = await signer.sendTransaction({ to: MUSDC, data });
  const [rpc] = double.rpcCalls();
  assert.deepEqual(rpc.body, {
    method: "eth_signTransaction",
    params: {
      transaction: {
        to: MUSDC,
        value: "0x0",
        data,
        chain_id: 10143,
        nonce: 7,
        gas_limit: "0x15f90",
        type: 2,
        max_fee_per_gas: "0x17bfac7c00",
        max_priority_fee_per_gas: "0x77359400",
      },
    },
  });
  assert.equal(broadcast.length, 1);
  const sent = Transaction.from(broadcast[0]);
  assert.equal(sent.from, new Wallet(AGENT_KEY).address, "the broadcast transaction is the wallet's");
  assert.equal(sent.to, MUSDC);
  assert.equal(sent.data, data);
  assert.equal(response.hash, sent.hash);
});

test("with transactions: privy, sendTransaction is eth_sendTransaction on the chain's caip2", async () => {
  const hash = keccak256(toUtf8Bytes("sent"));
  const double = privyDouble({ sentHash: hash });
  const { provider, broadcast } = providerDouble();
  const signer = signerOver(double, { provider, transactions: "privy" });
  const data = erc20.encodeFunctionData("approve", [PERMIT2_ADDRESS, 1n]);
  const response = await signer.sendTransaction({ to: MUSDC, data });
  assert.equal(response.hash, hash);
  const [rpc] = double.rpcCalls();
  assert.deepEqual(rpc.body, {
    method: "eth_sendTransaction",
    caip2: "eip155:10143",
    chain_type: "ethereum",
    params: { transaction: { to: MUSDC, value: "0x0", data, chain_id: 10143 } },
  });
  assert.equal(broadcast.length, 0, "Privy broadcasts; the provider only finds it");
});

test("a signer with an authorization key signs each POST over the canonical payload with P-256", async () => {
  const keys = generatePrivyAuthorizationKeyPair();
  assert.match(keys.privateKey, /^wallet-auth:/);
  const double = privyDouble();
  const signer = signerOver(double, { authorizationKey: keys.privateKey, now: () => 1_700_000_000_000 });
  await signer.signMessage("tab-metering-request\nhello");
  const [rpc] = double.rpcCalls();
  assert.equal(rpc.headers["privy-request-expiry"], "1700000060000");
  const payload = canonicalJson({
    version: 1,
    method: "POST",
    url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
    body: rpc.body,
    headers: { "privy-app-id": APP_ID, "privy-request-expiry": "1700000060000" },
  });
  const publicKey = createPublicKey({ key: Buffer.from(keys.publicKey, "base64"), format: "der", type: "spki" });
  assert.equal(
    verifyBytes("sha256", Buffer.from(payload), publicKey, Buffer.from(rpc.headers["privy-authorization-signature"], "base64")),
    true,
    "the header verifies against the public key Privy holds",
  );
  const other = generatePrivyAuthorizationKeyPair();
  const otherKey = createPublicKey({ key: Buffer.from(other.publicKey, "base64"), format: "der", type: "spki" });
  assert.equal(verifyBytes("sha256", Buffer.from(payload), otherKey, Buffer.from(rpc.headers["privy-authorization-signature"], "base64")), false);
});

test("canonical JSON sorts keys, drops undefined members and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: [3, { d: "x", c: null }], e: undefined, "é": true }), '{"a":[3,{"c":null,"d":"x"}],"b":1,"é":true}');
  assert.throws(() => canonicalJson({ a: Number.NaN }));
});

test("the policy refuses a transfer of the Asset to a stranger, and the error says what and which rules", async () => {
  const double = privyDouble({ policy: policyFor() });
  const signer = signerOver(double);
  const transfer = { to: MUSDC, data: erc20.encodeFunctionData("transfer", [STRANGER, 1_000_000n]), nonce: 1, gasLimit: 60_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  await assert.rejects(signer.signTransaction(transfer), (error) => {
    assert.ok(error instanceof PrivyError);
    assert.equal(error.code, "PRIVY_POLICY_DENIED");
    assert.equal(error.name, "PRIVY_POLICY_DENIED", "a wrapping strategy reports the code as the cause");
    assert.equal(error.privyCode, "policy_violation");
    assert.match(error.message, /Privy's policy refused eth_signTransaction for wallet cm0wallet/);
    assert.match(error.message, new RegExp(`transfer\\(${STRANGER}, 1000000\\)`), "names the call refused");
    assert.match(error.message, /allows eth_signTransaction only under "TabSettlement settle \(sign\)"/, "names the rules that did not allow it");
    return true;
  });
  // Value is refused even on an allowed call.
  const withValue = { ...transfer, data: erc20.encodeFunctionData("approve", [TAB_SETTLEMENT, 1n]), value: 1n };
  await assert.rejects(signer.signTransaction(withValue), (error) => error.code === "PRIVY_POLICY_DENIED");
  // An approval to anyone but TabSettlement or Permit2 is refused.
  const approveStranger = { ...transfer, data: erc20.encodeFunctionData("approve", [STRANGER, 1n]) };
  await assert.rejects(signer.signTransaction(approveStranger), (error) => error.code === "PRIVY_POLICY_DENIED");
  // A message that is not a metering claim is refused.
  await assert.rejects(signer.signMessage("please sign this login"), (error) => error.code === "PRIVY_POLICY_DENIED" && /personal_sign/.test(error.message));
  // A Permit2 transfer to a spender other than TabSettlement is refused.
  const domain = permit2Domain(CHAIN_ID, PERMIT2_ADDRESS);
  const permit = {
    permitted: { token: MUSDC, amount: 1n },
    spender: STRANGER,
    nonce: 1n,
    deadline: 1_800_000_000n,
    witness: { serviceId: SERVICE_ID, asset: MUSDC, amount: 1n, surface: STRANGER, chainId: CHAIN_ID },
  };
  await assert.rejects(signer.signTypedData(domain, PERMIT2_WITNESS_TRANSFER_FROM_TYPES, permit), (error) => error.code === "PRIVY_POLICY_DENIED");
  // The same permit on another chain is refused.
  await assert.rejects(
    signer.signTypedData(permit2Domain(1n, PERMIT2_ADDRESS), PERMIT2_WITNESS_TRANSFER_FROM_TYPES, { ...permit, spender: TAB_SETTLEMENT }),
    (error) => error.code === "PRIVY_POLICY_DENIED",
  );
});

test("a signature from another key is refused before it is used", async () => {
  const signer = signerOver(privyDouble({ signWith: new Wallet(OTHER_KEY), address: new Wallet(AGENT_KEY).address }));
  await assert.rejects(signer.signMessage("tab-metering-request\nx"), (error) => error.code === "PRIVY_SIGNATURE_MISMATCH");
  const tx = { to: MUSDC, data: "0x", nonce: 1, gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  await assert.rejects(signer.signTransaction(tx), (error) => error.code === "PRIVY_SIGNATURE_MISMATCH" && /not broadcast/.test(error.message));
});

test("Privy's other refusals map to named errors", async () => {
  const answer = (status, body) => ({ fetch: async () => reply(status, body) });
  const cases = [
    [401, { error: "Invalid app ID or app secret" }, "PRIVY_AUTHENTICATION_FAILED"],
    [401, { error: "Missing authorization signature", code: "missing_or_empty_authorization_header" }, "PRIVY_AUTHORIZATION_REQUIRED"],
    [400, { error: "Wallet has insufficient funds for this transaction", code: "insufficient_funds" }, "PRIVY_INSUFFICIENT_FUNDS"],
    [404, { error: "Wallet not found" }, "PRIVY_NOT_FOUND"],
    [429, { error: "Too many requests" }, "PRIVY_RATE_LIMITED"],
    [503, { error: "upstream" }, "PRIVY_UNAVAILABLE"],
  ];
  for (const [status, body, code] of cases) {
    const signer = signerOver(answer(status, body));
    await assert.rejects(signer.getAddress(), (error) => error.code === code && error.message.includes(body.error), code);
    assert.ok(!String(await signer.getAddress().catch((error) => error.message)).includes(APP_SECRET), "no error carries the secret");
  }
  const unreachable = signerOver({ fetch: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(unreachable.getAddress(), (error) => error.code === "PRIVY_UNAVAILABLE");
});

test("createPrivyAgentSigner returns a Result for bad options and never throws", () => {
  const base = { appId: APP_ID, appSecret: APP_SECRET, walletId: WALLET_ID, chainId: CHAIN_ID };
  const cases = [
    [{ ...base, appId: "" }, /PRIVY_APP_ID/],
    [{ ...base, appSecret: " " }, /PRIVY_APP_SECRET/],
    [{ ...base, walletId: "" }, /PRIVY_WALLET_ID/],
    [{ ...base, walletId: "../policies" }, /letters, digits/],
    [{ ...base, chainId: 0 }, /positive/],
    [{ ...base, authorizationKey: "wallet-auth:not-a-key" }, /PKCS#8/],
    [{ ...base, apiUrl: "http://api.example" }, /https/],
    [{ ...base, transactions: "maybe" }, /"sign" or "privy"/],
  ];
  for (const [options, message] of cases) {
    const built = createPrivyAgentSigner(options);
    assert.equal(built.ok, false);
    assert.equal(built.error.category, "VALIDATION");
    assert.match(built.error.message, message);
  }
});

test("agentSignedMetering signs a metering claim through Privy, inside the policy", async () => {
  const double = privyDouble({ policy: policyFor() });
  const signer = signerOver(double);
  const agent = new Wallet(AGENT_KEY).address;
  const provider = agentSignedMetering(() => signer, { now: () => 1_750_000_000_000 });
  const headers = await provider({ method: "POST", url: "https://gateway.test/meter/quote.generate", agent, tool: "quote.generate", serviceId: SERVICE_ID });
  const digest = meteringDigest({ method: "POST", path: "/meter/quote.generate", agent, tool: toolKeyOf("quote.generate"), units: 1, issuedAt: 1_750_000_000_000 });
  assert.equal(headers[METERING_HEADER.agentIssuedAt], "1750000000000");
  assert.equal(verifyMessage(digest, headers[METERING_HEADER.agentSignature]), agent, "the gateway recovers the Agent");
});

test("the relayed strategy settles with a Privy Permit2 signature the policy allows and that verifies against the Agent", async () => {
  const double = privyDouble({ policy: policyFor() });
  const { provider } = providerDouble({ allowance: 1n << 200n });
  const signer = signerOver(double, { provider });
  const posted = [];
  const strategy = createRelayedMonadStrategy({
    signer,
    tabSettlement: TAB_SETTLEMENT,
    relayUrl: "https://gateway.test/relay/settle",
    assets: { [`10143:${MUSDC.toLowerCase()}`]: USDC },
    fetchImpl: async (url, init) => {
      posted.push(JSON.parse(init.body));
      return { status: 200, json: async () => ({ ok: true, txHash: `0x${"ee".repeat(32)}`, settlementId: null, applied: null, toPrepaid: null }) };
    },
    logger: silent,
  });
  const agent = new Wallet(AGENT_KEY).address;
  const receipt = await strategy.settle({ agent, serviceId: SERVICE_ID, asset: USDC, amount: 47_000n });
  assert.equal(receipt.ok, true, receipt.ok ? "" : `${receipt.error.message} ${receipt.error.cause?.message ?? ""}`);
  const [body] = posted;
  assert.equal(body.agent, agent);
  const recovered = verifyTypedData(
    permit2Domain(CHAIN_ID, PERMIT2_ADDRESS),
    PERMIT2_WITNESS_TRANSFER_FROM_TYPES,
    {
      permitted: { token: MUSDC, amount: 47_000n },
      spender: TAB_SETTLEMENT,
      nonce: BigInt(body.nonce),
      deadline: BigInt(body.deadline),
      witness: { serviceId: SERVICE_ID, asset: MUSDC, amount: 47_000n, surface: TAB_SETTLEMENT, chainId: CHAIN_ID },
    },
    body.signature,
  );
  assert.equal(recovered, agent, "TabSettlement's Permit2 check recovers the Agent");
  assert.equal(double.rpcCalls().length, 1);
});

test("the direct strategy approves and settles through Privy inside the policy, and a wrong surface is refused with the cause", async () => {
  const double = privyDouble({ policy: policyFor() });
  const { provider, broadcast } = providerDouble({ allowance: 0n });
  const signer = signerOver(double, { provider });
  const strategy = createMonadStrategy({ signer, tabSettlement: TAB_SETTLEMENT, assets: { [`10143:${MUSDC.toLowerCase()}`]: USDC }, logger: silent });
  const agent = new Wallet(AGENT_KEY).address;
  const receipt = await strategy.settle({ agent, serviceId: SERVICE_ID, asset: USDC, amount: 47_000n });
  assert.equal(receipt.ok, true, receipt.ok ? "" : `${receipt.error.message} ${receipt.error.cause?.message ?? ""}`);
  assert.deepEqual(
    broadcast.map((raw) => Transaction.from(raw)).map((tx) => [tx.to, tx.data.slice(0, 10), tx.from]),
    [
      [MUSDC, erc20.getFunction("approve").selector, agent],
      [TAB_SETTLEMENT, new Interface(["function settle(bytes32,address,uint128)"]).getFunction("settle").selector, agent],
    ],
  );

  const elsewhere = createMonadStrategy({
    signer,
    tabSettlement: getAddress(STRANGER),
    assets: { [`10143:${MUSDC.toLowerCase()}`]: USDC },
    allowanceCheck: "skip",
    logger: silent,
  });
  const refused = await elsewhere.settle({ agent, serviceId: SERVICE_ID, asset: USDC, amount: 1n });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "SETTLEMENT_SUBMISSION_FAILED");
  assert.equal(refused.error.cause.code, "PRIVY_POLICY_DENIED");
  assert.match(refused.error.cause.message, /settle\(/);
});

test("the policy has the documented shape, names every address in both cases and keeps rule names short", () => {
  const policy = policyFor();
  assert.equal(policy.version, "1.0");
  assert.equal(policy.chain_type, "ethereum");
  assert.equal(policy.name, "Tab Agent on chain 10143");
  for (const rule of policy.rules) {
    assert.ok(rule.name.length <= 50, rule.name);
    assert.equal(rule.action, "ALLOW");
    for (const condition of rule.conditions) {
      assert.ok(typeof condition.value === "string" || condition.value.every((entry) => typeof entry === "string"), "Privy takes string values");
    }
  }
  const methods = policy.rules.map((rule) => rule.method);
  assert.equal(methods.filter((method) => method === "eth_signTransaction").length, 5);
  assert.equal(methods.filter((method) => method === "eth_sendTransaction").length, 5);
  assert.deepEqual([...new Set(methods)].sort(), ["eth_sendTransaction", "eth_signTransaction", "eth_signTypedData_v4", "personal_sign"]);
  const settle = policy.rules.find((rule) => rule.name === "TabSettlement settle (sign)");
  assert.deepEqual(settle.conditions[0].value, [TAB_SETTLEMENT, TAB_SETTLEMENT.toLowerCase()]);
  assert.equal(policy.rules.some((rule) => rule.name.startsWith("x402")), false, "x402 is off by default");

  const withX402 = policyFor({ x402MaxBaseUnits: 250_000n });
  assert.ok(withX402.rules.some((rule) => rule.name === "x402 EIP-3009 payment, capped"));

  for (const [overrides, message] of [
    [{ addresses: { tabSettlement: "0x12", tabBook: TAB_BOOK, assets: [MUSDC] } }, /tabSettlement/],
    [{ addresses: { tabSettlement: TAB_SETTLEMENT, tabBook: TAB_BOOK, assets: [] } }, /at least one Asset/],
    [{ name: "x".repeat(51) }, /1 to 50/],
    [{ x402MaxBaseUnits: 0n }, /positive/],
  ]) {
    const built = buildPrivyAgentPolicy({ chainId: CHAIN_ID, addresses: { tabSettlement: TAB_SETTLEMENT, tabBook: TAB_BOOK, assets: [MUSDC] }, ...overrides });
    assert.equal(built.ok, false);
    assert.match(built.error.message, message);
  }
});

test("the x402 rule allows an EIP-3009 authorisation up to its cap and no further", async () => {
  const double = privyDouble({ policy: policyFor({ x402MaxBaseUnits: 250_000n }) });
  const signer = signerOver(double);
  const domain = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: MUSDC };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const authorisation = (value) => ({ from: new Wallet(AGENT_KEY).address, to: STRANGER, value, validAfter: 0n, validBefore: 1_800_000_000n, nonce: `0x${"01".repeat(32)}` });
  const signature = await signer.signTypedData(domain, types, authorisation(250_000n));
  assert.equal(verifyTypedData(domain, types, authorisation(250_000n), signature), new Wallet(AGENT_KEY).address);
  await assert.rejects(signer.signTypedData(domain, types, authorisation(250_001n)), (error) => error.code === "PRIVY_POLICY_DENIED");
  const permit = { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
  await assert.rejects(
    signer.signTypedData(domain, permit, { owner: new Wallet(AGENT_KEY).address, spender: STRANGER, value: 1n, nonce: 0n, deadline: 1n }),
    (error) => error.code === "PRIVY_POLICY_DENIED",
    "an EIP-2612 permit under the same domain is not an x402 payment",
  );
});

test("createPrivyAgentWallet creates an owned policy, the Agent's signer quorum and the wallet, in that order", async () => {
  const owner = generatePrivyAuthorizationKeyPair();
  const agent = generatePrivyAuthorizationKeyPair();
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const path = new URL(url).pathname;
    if (path === "/v1/policies") return reply(200, { id: POLICY_ID, ...body, owner_id: "cm0owner" });
    if (path === "/v1/key_quorums") return reply(200, { id: "cm0signer0000000000000001", authorization_threshold: 1 });
    if (path === "/v1/wallets") return reply(200, { id: WALLET_ID, address: new Wallet(AGENT_KEY).address.toLowerCase(), chain_type: "ethereum" });
    return reply(404, {});
  };
  const created = await createPrivyAgentWallet({
    appId: APP_ID,
    appSecret: APP_SECRET,
    chainId: CHAIN_ID,
    addresses: { tabSettlement: TAB_SETTLEMENT, tabBook: TAB_BOOK, assets: [MUSDC] },
    ownerPublicKey: owner.publicKey,
    signerPublicKey: agent.publicKey,
    fetch,
    logger: silent,
  });
  assert.equal(created.ok, true, created.ok ? "" : created.error.message);
  assert.deepEqual(
    { walletId: created.value.walletId, address: created.value.address, policyId: created.value.policyId, signerId: created.value.signerId },
    { walletId: WALLET_ID, address: new Wallet(AGENT_KEY).address, policyId: POLICY_ID, signerId: "cm0signer0000000000000001" },
  );
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/v1/policies", "/v1/key_quorums", "/v1/wallets"]);
  assert.deepEqual(calls[0].body.owner, { public_key: owner.publicKey }, "the policy is owned by the owner key");
  assert.equal(calls[0].body.chain_type, "ethereum");
  assert.deepEqual(calls[0].body.rules, created.value.policy.rules);
  assert.deepEqual(calls[1].body, { display_name: "Tab Agent 10143", public_keys: [agent.publicKey], authorization_threshold: 1 });
  assert.deepEqual(calls[2].body, {
    chain_type: "ethereum",
    display_name: "Tab Agent 10143",
    owner: { public_key: owner.publicKey },
    policy_ids: [POLICY_ID],
    additional_signers: [{ signer_id: "cm0signer0000000000000001", override_policy_ids: [POLICY_ID] }],
  });
  for (const call of calls) assert.equal(call.headers["privy-authorization-signature"], undefined, "creation needs no owner signature");

  const same = await createPrivyAgentWallet({
    appId: APP_ID,
    appSecret: APP_SECRET,
    chainId: CHAIN_ID,
    addresses: { tabSettlement: TAB_SETTLEMENT, tabBook: TAB_BOOK, assets: [MUSDC] },
    ownerPublicKey: owner.publicKey,
    signerPublicKey: owner.publicKey,
    fetch,
  });
  assert.equal(same.ok, false);
  assert.match(same.error.message, /must differ/);

  const failing = await createPrivyAgentWallet({
    appId: APP_ID,
    appSecret: APP_SECRET,
    chainId: CHAIN_ID,
    addresses: { tabSettlement: TAB_SETTLEMENT, tabBook: TAB_BOOK, assets: [MUSDC] },
    ownerPublicKey: owner.publicKey,
    signerPublicKey: agent.publicKey,
    fetch: async (url, init) => (new URL(url).pathname === "/v1/wallets" ? reply(500, { error: "boom" }) : fetch(url, init)),
    logger: silent,
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.error.code, "PRIVY_UNAVAILABLE");
  assert.equal(failing.error.details.policyId, POLICY_ID, "what was already made is named for cleanup");
  assert.match(failing.error.message, /safe to delete/);
});
