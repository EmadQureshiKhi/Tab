/**
 * The six command classes, run against a fake `CommandIO` and a fake host
 * context, exactly as the host would run them after `io.resolveInputs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { CommandError, PluginManifestSchema } from "@metamask/agent-wallet/plugin";

import TabAuthorise from "../dist/commands/tab/authorise.js";
import TabCall from "../dist/commands/tab/call.js";
import TabDelegate from "../dist/commands/tab/delegate.js";
import TabDiscover from "../dist/commands/tab/discover.js";
import TabSettle from "../dist/commands/tab/settle.js";
import TabStatus from "../dist/commands/tab/status.js";
import { hintFor, unwrap } from "../dist/boundary.js";
import { AGENT, fakeContext, fakeIo, SERVICE_ID, TAB_SETTLEMENT, USDC } from "./fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "oclif.manifest.json"), "utf8"));

const COMMANDS = [
  ["tab:discover", TabDiscover],
  ["tab:status", TabStatus],
  ["tab:call", TabCall],
  ["tab:settle", TabSettle],
  ["tab:authorise", TabAuthorise],
  ["tab:delegate", TabDelegate],
];

/** Builds a command the way oclif does, then installs the fake context the host would. */
function instantiate(Command, ctx) {
  const command = new Command([], {});
  command.ctx = ctx;
  return command;
}

const ENV_KEYS = [
  "TAB_BOOK_ADDRESS",
  "TAB_SETTLEMENT_ADDRESS",
  "METERING_DELEGATES_ADDRESS",
  "NEXT_PUBLIC_REGISTRY_API_URL",
  "MONAD_CHAIN_ID",
  "MONAD_RPC_URL",
  "MONAD_EXPLORER_URL",
  "MOCK_USDC_ADDRESS",
];
function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  return fn().finally(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

test("every command's pluginCommandId is declared in package.json#mm and in the oclif manifest", () => {
  const declared = pkg.mm.commands.map((entry) => entry.id).sort();
  assert.deepEqual(declared, COMMANDS.map(([id]) => id).sort());
  assert.deepEqual(Object.keys(manifest.commands).sort(), declared);
  for (const [id, Command] of COMMANDS) {
    const command = instantiate(Command, {});
    assert.equal(command.pluginCommandId, id);
  }
});

test("package.json#mm validates against the host's own manifest schema", () => {
  const parsed = PluginManifestSchema.safeParse(pkg.mm);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

test("the manifest asks for wallet-submit only where a transaction is submitted, and discover asks for nothing", () => {
  const byId = new Map(pkg.mm.commands.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get("tab:discover").capabilities, []);
  assert.deepEqual(byId.get("tab:status").capabilities, ["wallet-read"]);
  assert.deepEqual(byId.get("tab:call").capabilities, ["wallet-read"]);
  assert.deepEqual(byId.get("tab:settle").capabilities, ["wallet-read", "wallet-submit"]);
  assert.deepEqual(byId.get("tab:authorise").capabilities, ["wallet-read", "wallet-submit"]);
  assert.deepEqual(byId.get("tab:delegate").capabilities, ["wallet-read", "wallet-submit"]);
  assert.deepEqual(pkg.mm.capabilities, [], "plugin-wide capabilities stay empty so nothing is over-granted");
  assert.equal(pkg.mm.schemaVersion, 1);
  assert.equal(pkg.keywords.includes("oclif-plugin"), true);
  assert.ok(pkg.peerDependencies["@metamask/agent-wallet"]);
  assert.equal(pkg.oclif.commands, "./dist/commands");
});

test("discover runs without sign-in or a wallet; the others gate on both", () => {
  assert.equal(TabDiscover.requiresAuth, false);
  assert.equal(TabDiscover.requiresInit, false);
  for (const [, Command] of COMMANDS.slice(1)) {
    assert.equal(Command.requiresAuth, true);
    assert.equal(Command.requiresInit, true);
  }
});

test("the positionals read as documented: settle <service> <asset> <amount>, authorise <service> <asset> <ceiling> <expiryDays>, call <service> <tool>", () => {
  assert.deepEqual(Object.keys(TabSettle.args), ["service", "asset", "amount"]);
  assert.deepEqual(Object.keys(TabAuthorise.args), ["service", "asset", "ceiling", "expiry-days"]);
  assert.deepEqual(Object.keys(TabCall.args), ["service", "tool"]);
  assert.ok("broadcast" in TabSettle.flags);
  assert.ok("broadcast" in TabAuthorise.flags);
  assert.ok("args" in TabCall.flags, "the arguments flag is --args, because --json is the host's output flag");
  assert.deepEqual(Object.keys(TabDelegate.args), [], "delegate takes flags only");
  for (const flag of ["days", "revoke", "broadcast"]) assert.ok(flag in TabDelegate.flags, `--${flag}`);
});

test("mm tab settle: a dry run through the command class returns the plan and touches no executor", async () => {
  const context = fakeContext({ allowance: 0n });
  const command = instantiate(TabSettle, context.ctx);
  const io = fakeIo({ service: SERVICE_ID, asset: USDC, amount: "47000", broadcast: false });
  const report = await withEnv({ NEXT_PUBLIC_REGISTRY_API_URL: "http://registry.test", MOCK_USDC_ADDRESS: USDC }, async () => {
    // The registry is stubbed at the global fetch, since the command builds its own client.
    const original = globalThis.fetch;
    const { stubRegistryFetch } = await import("./fixtures.mjs");
    globalThis.fetch = stubRegistryFetch();
    try {
      return await command.execute(io);
    } finally {
      globalThis.fetch = original;
    }
  });
  assert.equal(report.broadcast, false);
  assert.equal(report.plan.agent, AGENT);
  assert.equal(report.plan.settlement.to, TAB_SETTLEMENT);
  assert.equal(context.executorCalls.length, 0);
  assert.match(command.successHint(report), /Dry run/);
});

test("mm tab settle --broadcast through the command class submits both transactions as the command's source", async () => {
  const context = fakeContext({ allowance: 0n, status: "CONFIRMED" });
  const command = instantiate(TabSettle, context.ctx);
  const io = fakeIo({ service: SERVICE_ID, asset: USDC, amount: "47000", broadcast: true });
  const report = await withEnv({ NEXT_PUBLIC_REGISTRY_API_URL: "http://registry.test", MOCK_USDC_ADDRESS: USDC }, async () => {
    const original = globalThis.fetch;
    const { stubRegistryFetch } = await import("./fixtures.mjs");
    globalThis.fetch = stubRegistryFetch();
    try {
      return await command.execute(io);
    } finally {
      globalThis.fetch = original;
    }
  });
  assert.equal(report.broadcast, true);
  assert.equal(context.requests.length, 2);
  assert.equal(context.executorCalls[0].source, "tab:settle");
  assert.equal(context.executorCalls[0].io, io);
  assert.deepEqual(command.analyticsOutcome(report), { tx_hash: report.settlementTx.txHash });
});

test("mm tab authorise through the command class is a dry run by default", async () => {
  const context = fakeContext();
  const command = instantiate(TabAuthorise, context.ctx);
  const report = await withEnv({}, () => command.execute(fakeIo({ service: SERVICE_ID, asset: USDC, ceiling: "5000000", "expiry-days": "30", broadcast: false })));
  assert.equal(report.broadcast, false);
  assert.equal(context.requests.length, 0);
  assert.deepEqual(command.analyticsOutcome(report), { outcome: "dry-run" });
});

test("a failed Result becomes the host's CommandError, with a hint", async () => {
  const context = fakeContext({ wallets: [] });
  const command = instantiate(TabStatus, context.ctx);
  await withEnv({ NEXT_PUBLIC_REGISTRY_API_URL: "http://registry.test" }, async () => {
    await assert.rejects(
      () => command.execute(fakeIo({})),
      (error) => error instanceof CommandError && error.code === "WALLET_MISSING" && /mm init/.test(error.hint),
    );
  });
  assert.throws(() => unwrap({ ok: false, error: { category: "VALIDATION", code: "X", message: "m", retryable: false } }), CommandError);
  assert.deepEqual(unwrap({ ok: true, value: 3 }), 3);
});

test("a settings failure surfaces as a CommandError naming the variable", async () => {
  const command = instantiate(TabDiscover, {});
  await withEnv({ TAB_BOOK_ADDRESS: `0x${"0".repeat(40)}` }, async () => {
    await assert.rejects(() => command.execute(fakeIo({})), (error) => error instanceof CommandError && error.code === "ADDRESS_PLACEHOLDER");
  });
});

test("the LIMIT_EXCEEDED hint tells the agent to settle, with both figures", () => {
  const hint = hintFor({ category: "LIMIT", code: "LIMIT_EXCEEDED", message: "m", retryable: false, details: { requiredBaseUnits: "10000", headroomBaseUnits: "2500" } });
  assert.match(hint, /10000 base units/);
  assert.match(hint, /2500 of headroom/);
  assert.match(hint, /mm tab settle/);
  assert.match(hintFor({ category: "UPSTREAM", code: "REGISTRY_UNCONFIGURED", message: "m", retryable: false }), /NEXT_PUBLIC_REGISTRY_API_URL/);
});

test("mm tab delegate through the command class reads its flags, and refuses --revoke with --days before touching a key or the wallet", async () => {
  const context = fakeContext();
  const command = instantiate(TabDelegate, context.ctx);
  await withEnv({}, async () => {
    await assert.rejects(
      () => command.execute(fakeIo({ days: "7", revoke: true, broadcast: true })),
      (error) => error instanceof CommandError && error.code === "DELEGATE_FLAGS_CONFLICT",
    );
  });
  assert.equal(context.executorCalls.length, 0);
});

test("the metering-signature refusals point at mm tab delegate", () => {
  for (const code of ["METERING_SIGNATURE_ABSENT", "METERING_DELEGATE_NOT_REGISTERED", "DELEGATE_KEY_MISSING"]) {
    assert.match(hintFor({ category: "AUTHORISATION", code, message: "m", retryable: false }), /mm tab delegate --broadcast/, code);
  }
  assert.match(hintFor({ category: "AUTHORISATION", code: "METERING_DELEGATE_UNSUPPORTED", message: "m", retryable: false }), /METERING_DELEGATES_ADDRESS/);
});

test("the delegate command's success hint names the delegate, never its key", () => {
  const report = {
    broadcast: true,
    action: "register",
    delegate: "0x00000000000000000000000000000000000de1e9",
    expiryIso: "2026-10-30T00:00:00.000Z",
    tx: { txHash: "0x01", status: "CONFIRMED", explorerUrl: "https://testnet.monadvision.com/tx/0x01" },
    note: "n",
  };
  const command = instantiate(TabDelegate, {});
  assert.match(command.successHint(report), /0x00000000000000000000000000000000000de1e9 registered until 2026-10-30/);
  assert.match(command.successHint({ ...report, action: "revoke" }), /^Revoked 0x0000/);
  assert.equal(command.successHint({ ...report, broadcast: false }), "n");
  assert.deepEqual(command.analyticsOutcome(report), { tx_hash: "0x01" });
});

test("no option in any command prompts, so a flag left off means its default and never an interactive question", () => {
  const dir = resolve(root, "src", "commands", "tab");
  for (const name of ["authorise", "call", "delegate", "discover", "settle", "status"]) {
    const source = readFileSync(resolve(dir, `${name}.ts`), "utf8");
    const block = source.slice(source.indexOf("const inputs = {"), source.indexOf("} satisfies InputSchema"));
    const entries = block.split(/\n  (?=[a-z"-]+: \{)/).slice(1);
    assert.ok(entries.length > 0, `${name} declares its inputs`);
    for (const entry of entries) {
      assert.match(entry, /prompt: false/, `${name}: ${entry.split(":")[0]} must set prompt: false`);
    }
  }
});
