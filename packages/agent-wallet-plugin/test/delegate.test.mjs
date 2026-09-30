/**
 * `mm tab delegate` and the delegate `mm tab call` signs with.
 *
 * The host is faked the way the other tests fake it, with a public client that
 * plays `MeteringDelegates` by decoding the real calldata against the real
 * fragments. Keys are written to a fresh temporary directory per test, never
 * to the home directory.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Interface, verifyMessage } from "ethers";
import { METERING_DELEGATES_ABI, METERING_HEADER, meteringDigest, toolKeyOf } from "@tabai/sdk";

import { createDelegateKeyStore } from "../dist/delegate-key.js";
import { createHost } from "../dist/host-context.js";
import { resolvePluginSettings } from "../dist/settings.js";
import { DELEGATE_BOUND, parseDelegationDays, runDelegate } from "../dist/tab/delegate.js";
import { runCall } from "../dist/tab/reads.js";
import { withMeteringSignature } from "../dist/tab/toolset.js";
import { AGENT, ENV, SERVICE_ID, SETTINGS, fakeIo } from "./fixtures.mjs";

const REGISTRY = "0x00000000000000000000000000000000000de1e9";
const NOW = 1_788_700_000_000;
const NOW_S = BigInt(NOW / 1000);
const IFACE = new Interface([...METERING_DELEGATES_ABI]);
const DELEGATE_SETTINGS = { ...SETTINGS, meteringDelegates: REGISTRY };
const HERMETIC = { ...ENV, TAB_HOSTED_DEFAULTS: "off" };

const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/**
 * A host whose chain reader answers `MeteringDelegates` from a table of
 * `agent:delegate` to expiry, and whose executor records what it was handed.
 */
function delegatesHost({ entries = new Map(), code = true } = {}) {
  const reads = [];
  const requests = [];
  const executorCalls = [];
  const ctx = {
    logger: { debug() {}, warn() {} },
    walletStateManager: {
      read: () => ({
        byokWallets: [{ id: "byok:evm:0", namespace: "evm", address: AGENT, name: "agent" }],
        remoteWallets: [],
        selectedWallet: { namespace: "evm", ref: { id: "byok:evm:0" } },
      }),
    },
    publicClient: () => ({
      async call({ to, data }) {
        assert.equal(to, REGISTRY);
        if (!code) return { data: "0x" };
        const parsed = IFACE.parseTransaction({ data });
        const [agent, delegate] = parsed.args.map((value) => String(value).toLowerCase());
        reads.push(parsed.name);
        const expiry = entries.get(`${agent}:${delegate}`) ?? 0n;
        if (parsed.name === "expiryOf") return { data: IFACE.encodeFunctionResult("expiryOf", [expiry]) };
        if (parsed.name === "isDelegate") return { data: IFACE.encodeFunctionResult("isDelegate", [expiry > NOW_S]) };
        throw new Error(`unexpected read ${parsed.name}`);
      },
    }),
    walletExecutor: async (io, source) => {
      executorCalls.push({ io, source });
      return async (request) => {
        requests.push(request);
        return { kind: "transaction", hash: `0x${"ab".repeat(32)}`, status: "CONFIRMED" };
      };
    },
  };
  return { host: createHost({ ctx, io: fakeIo({}), commandId: "tab:delegate" }), reads, requests, executorCalls };
}

// ---------------------------------------------------------------- the key file

test("a new key is written 0600 in a 0700 directory, and the same key is read back", () => {
  const directory = join(tempDir("tab-delegates-"), "nested");
  const store = createDelegateKeyStore(directory);
  const made = store.loadOrCreate(10143, AGENT);
  assert.ok(made.ok, made.ok ? "" : made.error.message);
  assert.equal(made.value.created, true);
  assert.equal(made.value.path, join(directory, `10143-${AGENT}.json`));
  assert.equal(statSync(made.value.path).mode & 0o777, 0o600, "only the owner reads the key");
  assert.equal(statSync(directory).mode & 0o777, 0o700, "only the owner lists the directory");

  const again = store.loadOrCreate(10143, AGENT);
  assert.ok(again.ok);
  assert.equal(again.value.created, false);
  assert.equal(again.value.address, made.value.address, "reused, not replaced");
  assert.equal(again.value.signer.privateKey, made.value.signer.privateKey);

  // One per network: the other chain has none until one is made.
  const mainnet = store.load(143, AGENT);
  assert.ok(mainnet.ok);
  assert.equal(mainnet.value, undefined);
});

test("a key file other users can read is refused rather than used", () => {
  const store = createDelegateKeyStore(tempDir("tab-delegates-"));
  const made = store.loadOrCreate(10143, AGENT);
  assert.ok(made.ok);
  chmodSync(made.value.path, 0o644);
  const loaded = store.load(10143, AGENT);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.code, "DELEGATE_KEY_EXPOSED");
  assert.match(loaded.error.message, /chmod 600/);
});

test("a key file that is not this Agent's, or not a key, is refused by name and never echoed", () => {
  const directory = tempDir("tab-delegates-");
  const store = createDelegateKeyStore(directory);
  const made = store.loadOrCreate(10143, AGENT);
  assert.ok(made.ok);
  const file = JSON.parse(readFileSync(made.value.path, "utf8"));

  writeFileSync(made.value.path, JSON.stringify({ ...file, agent: `0x${"12".repeat(20)}` }), { mode: 0o600 });
  assert.equal(store.load(10143, AGENT).error.code, "DELEGATE_KEY_CORRUPT");

  writeFileSync(made.value.path, JSON.stringify({ ...file, privateKey: "0xnot-a-key" }), { mode: 0o600 });
  const broken = store.load(10143, AGENT);
  assert.equal(broken.error.code, "DELEGATE_KEY_CORRUPT");
  assert.doesNotMatch(JSON.stringify(broken.error), /not-a-key/, "the file's contents are not repeated");

  writeFileSync(made.value.path, "{", { mode: 0o600 });
  assert.equal(store.load(10143, AGENT).error.code, "DELEGATE_KEY_CORRUPT");
});

// ---------------------------------------------------------------- mm tab delegate

test("--days defaults to 30 and is bounded to the contract's year", () => {
  assert.equal(parseDelegationDays(undefined).value, 30);
  assert.equal(parseDelegationDays("365").value, 365);
  assert.equal(parseDelegationDays("366").error.code, "DAYS_TOO_FAR");
  assert.equal(parseDelegationDays("0").error.code, "DAYS_MALFORMED");
  assert.equal(parseDelegationDays("a week").error.code, "DAYS_MALFORMED");
});

test("the dry run makes the key, plans setDelegate for its address, submits nothing, and never prints the key", async () => {
  const { host, executorCalls } = delegatesHost();
  const store = createDelegateKeyStore(tempDir("tab-delegates-"));
  const result = await runDelegate({ host, settings: DELEGATE_SETTINGS, store, now: () => NOW }, { days: "7", revoke: false, broadcast: false });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const report = result.value;
  assert.equal(report.action, "register");
  assert.equal(report.broadcast, false);
  assert.equal(report.keyCreated, true);
  assert.equal(report.registeredUntil, null, "nothing on chain yet");
  assert.equal(report.meteringDelegates, REGISTRY);
  assert.equal(report.transaction.to, REGISTRY);
  assert.equal(report.bound, DELEGATE_BOUND);
  assert.match(report.bound, /cannot move funds/);

  const decoded = IFACE.decodeFunctionData("setDelegate", report.transaction.data);
  assert.equal(decoded[0].toLowerCase(), report.delegate);
  assert.equal(decoded[1], NOW_S + 7n * 86_400n);
  assert.equal(report.expiry, Number(NOW_S + 7n * 86_400n));
  assert.equal(executorCalls.length, 0, "a dry run never asks for wallet-submit");

  const key = store.load(10143, AGENT).value.signer.privateKey;
  assert.doesNotMatch(JSON.stringify(report), new RegExp(key.slice(2)), "the private key is not in the report");
});

test("--broadcast hands setDelegate to the wallet as the delegate command, and reports what is on chain", async () => {
  const store = createDelegateKeyStore(tempDir("tab-delegates-"));
  const made = store.loadOrCreate(10143, AGENT);
  const { host, requests, executorCalls } = delegatesHost({ entries: new Map([[`${AGENT}:${made.value.address}`, NOW_S + 3_600n]]) });
  const result = await runDelegate({ host, settings: DELEGATE_SETTINGS, store, now: () => NOW }, { revoke: false, broadcast: true });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(result.value.keyCreated, false, "the stored key is reused");
  assert.equal(result.value.registeredUntil, new Date(Number(NOW_S + 3_600n) * 1000).toISOString(), "the current registration is shown before it is replaced");
  assert.equal(executorCalls[0].source, "tab:delegate");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].transaction.to, REGISTRY);
  assert.equal(requests[0].chainId, 10143);
  const decoded = IFACE.decodeFunctionData("setDelegate", requests[0].transaction.data);
  assert.equal(decoded[1], NOW_S + 30n * 86_400n, "thirty days by default");
  assert.match(requests[0].intent.summary, /cannot move funds/, "the wallet's own prompt states the bound");
  assert.equal(result.value.tx.explorerUrl, `https://testnet.monadvision.com/tx/0x${"ab".repeat(32)}`);
});

test("--revoke plans revokeDelegate for the stored key, and refuses when there is nothing to revoke", async () => {
  const store = createDelegateKeyStore(tempDir("tab-delegates-"));

  const none = await runDelegate({ host: delegatesHost().host, settings: DELEGATE_SETTINGS, store, now: () => NOW }, { revoke: true, broadcast: false });
  assert.equal(none.error.code, "DELEGATE_KEY_MISSING");

  const made = store.loadOrCreate(10143, AGENT);
  const unset = await runDelegate({ host: delegatesHost().host, settings: DELEGATE_SETTINGS, store, now: () => NOW }, { revoke: true, broadcast: true });
  assert.equal(unset.error.code, "DELEGATE_NOT_SET", "a key never registered is not revoked on chain for nothing");

  const { host, requests } = delegatesHost({ entries: new Map([[`${AGENT}:${made.value.address}`, NOW_S + 60n]]) });
  const revoked = await runDelegate({ host, settings: DELEGATE_SETTINGS, store, now: () => NOW }, { revoke: true, broadcast: true });
  assert.ok(revoked.ok, revoked.ok ? "" : revoked.error.message);
  assert.equal(revoked.value.action, "revoke");
  assert.equal(IFACE.decodeFunctionData("revokeDelegate", requests[0].transaction.data)[0].toLowerCase(), made.value.address);
  assert.equal(revoked.value.expiry, undefined);

  const both = await runDelegate({ host, settings: DELEGATE_SETTINGS, store, now: () => NOW }, { days: "3", revoke: true, broadcast: false });
  assert.equal(both.error.code, "DELEGATE_FLAGS_CONFLICT");
});

test("with no MeteringDelegates on the network, the command refuses by name and makes no key", async () => {
  const directory = tempDir("tab-delegates-");
  const store = createDelegateKeyStore(directory);
  const { host, executorCalls } = delegatesHost();
  const result = await runDelegate({ host, settings: { ...SETTINGS, meteringDelegates: undefined }, store, now: () => NOW }, { revoke: false, broadcast: true });
  assert.equal(result.error.code, "METERING_DELEGATES_UNDEPLOYED");
  assert.match(result.error.message, /METERING_DELEGATES_ADDRESS/);
  assert.equal(store.load(10143, AGENT).value, undefined, "no key was made");
  assert.equal(executorCalls.length, 0);
});

test("an address with no MeteringDelegates at it is refused, not read as 'nothing registered'", async () => {
  const store = createDelegateKeyStore(tempDir("tab-delegates-"));
  const result = await runDelegate({ host: delegatesHost({ code: false }).host, settings: DELEGATE_SETTINGS, store, now: () => NOW }, { revoke: false, broadcast: true });
  assert.equal(result.error.code, "METERING_DELEGATES_UNREADABLE");
});

// ---------------------------------------------------------------- mm tab call

/** A directory holding a tab.config that names the Service's endpoint, so the SDK's own config walk finds it. */
function configDir() {
  const directory = tempDir("tab-call-");
  writeFileSync(
    join(directory, "tab.config.mjs"),
    `export default { services: [{ serviceId: "${SERVICE_ID}", name: "demo", endpoint: "http://service.test" }] };\n`,
  );
  return directory;
}

/** A Service that answers with the charge, or with the refusal a signature-requiring gateway gives an unsigned call. */
function serviceFetch({ requireSignature = false } = {}) {
  const posted = [];
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers);
    posted.push({ url, headers });
    const signed = headers.has(METERING_HEADER.delegateSignature) || headers.has(METERING_HEADER.agentSignature);
    if (requireSignature && !signed) {
      const body = { ok: false, error: { category: "AUTHORISATION", code: "METERING_SIGNATURE_ABSENT", message: "a metered request must carry a signature", retryable: false } };
      return { ok: false, status: 403, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "application/json",
        "tab-charge-amount": "10000",
        "tab-charge-asset": `10143:${ENV.MOCK_USDC_ADDRESS}`,
        "tab-charge-service": SERVICE_ID,
        "tab-charge-tool": toolKeyOf("quote.generate"),
        "tab-open-tab": "10000",
        "tab-headroom": "4740000",
      }),
      json: async () => ({ quote: "hello" }),
      text: async () => JSON.stringify({ quote: "hello" }),
    };
  };
  return { fetchImpl, posted };
}

test("call signs with the registered delegate: the claim names the Agent and the key recovers from the signature", async () => {
  const store = createDelegateKeyStore(tempDir("tab-delegates-"));
  const made = store.loadOrCreate(10143, AGENT);
  const { host, reads } = delegatesHost({ entries: new Map([[`${AGENT}:${made.value.address}`, NOW_S + 86_400n]]) });
  const { fetchImpl, posted } = serviceFetch({ requireSignature: true });

  const result = await runCall(
    { settings: DELEGATE_SETTINGS, env: HERMETIC, cwd: configDir(), fetchImpl, host, delegateStore: store },
    { service: SERVICE_ID, tool: "quote.generate" },
  );
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.deepEqual(reads, ["isDelegate"], "the registration is checked before the key signs");

  const headers = posted[0].headers;
  assert.equal(headers.get(METERING_HEADER.delegate), made.value.address);
  assert.equal(headers.get("Tab-Agent").toLowerCase(), AGENT);
  const digest = meteringDigest({
    method: "POST",
    path: "/meter/quote.generate",
    agent: AGENT,
    tool: toolKeyOf("quote.generate"),
    units: 1,
    issuedAt: Number(headers.get(METERING_HEADER.delegateIssuedAt)),
  });
  assert.equal(verifyMessage(digest, headers.get(METERING_HEADER.delegateSignature)).toLowerCase(), made.value.address);
});

test("call with a stored key that is not registered goes unsigned, and the refusal says how to register it", async () => {
  const store = createDelegateKeyStore(tempDir("tab-delegates-"));
  store.loadOrCreate(10143, AGENT);
  const { host } = delegatesHost();
  const { fetchImpl, posted } = serviceFetch({ requireSignature: true });

  const result = await runCall(
    { settings: DELEGATE_SETTINGS, env: HERMETIC, cwd: configDir(), fetchImpl, host, delegateStore: store },
    { service: SERVICE_ID, tool: "quote.generate" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "METERING_SIGNATURE_ABSENT", "the Service's own code is kept");
  assert.match(result.error.message, /not registered for this wallet/);
  assert.match(result.error.message, /mm tab delegate --broadcast/);
  assert.equal(result.error.details.delegate, "not-registered");
  assert.equal(posted[0].headers.has(METERING_HEADER.delegateSignature), false, "an unregistered key signs nothing");
});

test("call with no key at all, or no MeteringDelegates, behaves exactly as before: unsigned, and accepted where the Service allows it", async () => {
  const store = createDelegateKeyStore(tempDir("tab-delegates-"));
  const { host, reads } = delegatesHost();

  const noKey = serviceFetch({ requireSignature: true });
  const refused = await runCall(
    { settings: DELEGATE_SETTINGS, env: HERMETIC, cwd: configDir(), fetchImpl: noKey.fetchImpl, host, delegateStore: store },
    { service: SERVICE_ID, tool: "quote.generate" },
  );
  assert.equal(refused.error.code, "METERING_SIGNATURE_ABSENT");
  assert.match(refused.error.message, /has no metering delegate/);
  assert.equal(refused.error.details.delegate, "no-key");
  assert.deepEqual(reads, [], "no key, no chain read");

  const open = serviceFetch({ requireSignature: false });
  const accepted = await runCall(
    { settings: { ...SETTINGS, meteringDelegates: undefined }, env: HERMETIC, cwd: configDir(), fetchImpl: open.fetchImpl, host, delegateStore: store },
    { service: SERVICE_ID, tool: "quote.generate" },
  );
  assert.ok(accepted.ok, accepted.ok ? "" : accepted.error.message);
  assert.equal(accepted.value.charge.amountBaseUnits, "10000");
  assert.equal(open.posted[0].headers.has(METERING_HEADER.delegateSignature), false);
});

test("an Agent signature a Service entry already carries is kept, and the delegate adds nothing over it", async () => {
  const request = { method: "POST", url: "http://service.test/meter/q", tool: "q", agent: AGENT, serviceId: SERVICE_ID };
  const delegateHeaders = async () => ({ [METERING_HEADER.delegateSignature]: "0xdelegate" });
  const agentSigned = withMeteringSignature(async () => ({ [METERING_HEADER.agentSignature]: "0xagent" }), delegateHeaders);
  assert.deepEqual(await agentSigned(request), { [METERING_HEADER.agentSignature]: "0xagent" });

  const keyed = withMeteringSignature({ "x-api-key": "k" }, delegateHeaders);
  assert.deepEqual(await keyed(request), { "x-api-key": "k", [METERING_HEADER.delegateSignature]: "0xdelegate" });
  assert.deepEqual(await withMeteringSignature(undefined, delegateHeaders)(request), { [METERING_HEADER.delegateSignature]: "0xdelegate" });
});

// ---------------------------------------------------------------- settings

test("METERING_DELEGATES_ADDRESS names the contract; unset, the recorded default applies, and none means unsupported", () => {
  const named = resolvePluginSettings({ METERING_DELEGATES_ADDRESS: "0x00000000000000000000000000000000000DE1E9" });
  assert.ok(named.ok);
  assert.equal(named.value.meteringDelegates, REGISTRY);
  assert.equal(named.value.sources.METERING_DELEGATES_ADDRESS, "env METERING_DELEGATES_ADDRESS");

  const placeholder = resolvePluginSettings({ METERING_DELEGATES_ADDRESS: `0x${"0".repeat(40)}` });
  assert.equal(placeholder.error.code, "ADDRESS_PLACEHOLDER");

  for (const chainId of ["10143", "143"]) {
    const unset = resolvePluginSettings({ MONAD_CHAIN_ID: chainId, METERING_DELEGATES_ADDRESS: "" });
    assert.ok(unset.ok);
    if (unset.value.meteringDelegates === undefined) {
      assert.match(unset.value.sources.METERING_DELEGATES_ADDRESS, /not deployed/);
    } else {
      assert.match(unset.value.sources.METERING_DELEGATES_ADDRESS, /default/);
    }
  }
});
