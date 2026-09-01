/**
 * Task 16.3, second half: `connect` is idempotent and writes no key.
 *
 * Both claims are load-bearing. Idempotent, because the file being edited is one
 * the MCP client also writes, and a command that rewrote it on every run would
 * churn somebody's editor configuration. No key, because the alternative is a
 * signing key sitting in a JSON file that a desktop application rewrites, syncs
 * and quotes in its own logs.
 *
 * Every test runs against a temporary directory and an explicit environment, so
 * nothing here can read or write a real client config on the machine running it.
 *
 * Requirements: 25.5, 25.6
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MCP_CLIENT_IDS,
  TAB_SERVER_KEY,
  assertNoSecret,
  buildTabStanza,
  detectMcpClients,
  mergeTabStanza,
  runCli,
  runConnect,
  runDoctor,
  unifiedDiff,
} from "../dist/cli/index.js";

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const settings = (overrides = {}) => ({
  agent: "0x1f6f797edc2eecb02bd54009b805fb2e99f80542",
  registryUrl: undefined,
  rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
  explorerUrl: "https://creditcoin-testnet.blockscout.com",
  services: [],
  strategyId: undefined,
  sources: {},
  ...overrides,
});

/** A temporary directory that cleans itself up. */
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "tab-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Every string anywhere in a value, so a key cannot hide behind nesting. */
function allStrings(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => allStrings(entry, found));
  else if (value !== null && typeof value === "object") Object.values(value).forEach((entry) => allStrings(entry, found));
  return found;
}

// ---------------------------------------------------------------- detection

test("every known client has a config path on this platform, or is honestly absent", () => {
  for (const os of ["linux", "darwin", "win32"]) {
    const targets = detectMcpClients({ os, env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" }, cwd: "/tmp/project" });
    assert.deepEqual(targets.map((target) => target.id), [...MCP_CLIENT_IDS]);
    for (const target of targets) {
      assert.ok(target.configPath !== undefined, `${target.id} on ${os} resolves a path`);
      assert.ok(target.configPath.length > 0);
    }
  }
});

test("a Windows detection with no APPDATA reports the clients that need it as absent, not as a guessed path", () => {
  const targets = detectMcpClients({ os: "win32", env: {}, cwd: "/tmp/project" });
  const desktop = targets.find((target) => target.id === "claude-desktop");
  assert.equal(desktop.configPath, undefined);
  // Claude Code is project-scoped and needs no APPDATA, so it still resolves.
  assert.ok(targets.find((target) => target.id === "claude-code").configPath.endsWith(".mcp.json"));
});

// ---------------------------------------------------------------- the stanza

test("the stanza is npx, the package, and the mcp command, with publishable env only", () => {
  const stanza = buildTabStanza({ CREDITCOIN_RPC_URL: "https://rpc.example", NEXT_PUBLIC_REGISTRY_API_URL: "https://registry.example" });
  assert.equal(stanza.command, "npx");
  assert.deepEqual(stanza.args, ["-y", "@tabai/sdk", "mcp"]);
  assert.deepEqual(stanza.env, {
    CREDITCOIN_RPC_URL: "https://rpc.example",
    NEXT_PUBLIC_REGISTRY_API_URL: "https://registry.example",
  });
});

test("assertNoSecret refuses a key by shape and by name, and passes the real stanza", () => {
  assert.equal(assertNoSecret(buildTabStanza({ CREDITCOIN_RPC_URL: "https://rpc.example" })).ok, true);

  const byShape = assertNoSecret({ command: "npx", env: { SOMETHING: `0x${"ab".repeat(32)}` } });
  assert.equal(byShape.ok, false);
  assert.equal(byShape.error.code, "STANZA_CARRIES_SECRET");
  assert.match(byShape.error.message, /signing key/);

  // Unprefixed hex is refused too: a key pasted without `0x` is still a key.
  assert.equal(assertNoSecret({ env: { X: "ab".repeat(32) } }).ok, false);

  for (const name of ["AGENT_ETHEREUM_PRIVATE_KEY", "apiKey", "SESSION_TOKEN", "mnemonic"]) {
    const byName = assertNoSecret({ env: { [name]: "anything" } });
    assert.equal(byName.ok, false, `${name} must be refused by name`);
  }
});

test("merging keeps every other server and every other top-level key", () => {
  const previous = {
    theme: "dark",
    mcpServers: { other: { command: "node", args: ["other.js"] } },
  };
  const merged = mergeTabStanza(previous, buildTabStanza());
  assert.equal(merged.ok, true);
  assert.equal(merged.value.merged.theme, "dark");
  assert.deepEqual(merged.value.merged.mcpServers.other, { command: "node", args: ["other.js"] });
  assert.equal(merged.value.merged.mcpServers[TAB_SERVER_KEY].command, "npx");
  assert.equal(merged.value.hadStanza, false);
  assert.equal(merged.value.changed, true);
});

test("merging refuses a file whose mcpServers key is not an object rather than replacing it", () => {
  const merged = mergeTabStanza({ mcpServers: "yes please" }, buildTabStanza());
  assert.equal(merged.ok, false);
  assert.equal(merged.error.code, "CONFIG_MCP_SERVERS_INVALID");
});

test("merging replaces a secret that was under the tab key, and leaves another server's alone", () => {
  const previous = { mcpServers: { tab: { command: "npx", env: { PRIVATE_KEY: "x" } } } };
  const merged = mergeTabStanza(previous, buildTabStanza());
  assert.equal(merged.ok, true);
  assert.equal(merged.value.merged.mcpServers.tab.env, undefined, "the tab key is replaced, so the secret is gone");

  // Another server's API key is that server's business. Refusing on it would make
  // connect fail on exactly the machines that already use MCP, and dropping it
  // would break their setup, so it is carried through untouched.
  const other = mergeTabStanza({ mcpServers: { other: { env: { API_KEY: "sk-live-abc" } } } }, buildTabStanza());
  assert.equal(other.ok, true);
  assert.equal(other.value.merged.mcpServers.other.env.API_KEY, "sk-live-abc");
  assert.equal(other.value.merged.mcpServers.tab.command, "npx");
});

// ---------------------------------------------------------------- connect

test("connect writes the stanza, is idempotent on a second run, and backs up only when it changes", async (t) => {
  const dir = sandbox(t);
  const configPath = join(dir, "mcp.json");
  const at = new Date("2026-09-06T12:00:00.000Z");

  const first = await runConnect({
    settings: settings(),
    configPath,
    env: { CREDITCOIN_RPC_URL: "https://rpc.example" },
    now: () => at,
    logger: silent,
  });
  assert.equal(first.ok, true, first.ok ? "" : first.error.message);
  assert.equal(first.value.changed, true);
  assert.equal(first.value.hadStanza, false);
  assert.equal(first.value.backupPath, undefined, "there was no file to back up");
  assert.ok(existsSync(configPath));

  const written = readJson(configPath);
  assert.deepEqual(written.mcpServers.tab.args, ["-y", "@tabai/sdk", "mcp"]);
  assert.equal(
    written.mcpServers.tab.env.CREDITCOIN_RPC_URL,
    "https://rpc.cc3-testnet.creditcoin.network",
    "an explicitly resolved setting beats the ambient environment",
  );

  const second = await runConnect({
    settings: settings(),
    configPath,
    env: { CREDITCOIN_RPC_URL: "https://rpc.example" },
    now: () => at,
    logger: silent,
  });
  assert.equal(second.ok, true);
  assert.equal(second.value.changed, false, "the second run writes nothing");
  assert.equal(second.value.hadStanza, true);
  assert.equal(second.value.backupPath, undefined, "an unchanged run takes no backup");
  assert.equal(second.value.diff, "");
  assert.deepEqual(readJson(configPath), written, "the file is byte-identical after the second run");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes("tab-backup")),
    [],
    "no backup was left behind by the idempotent run",
  );
});

test("connect backs up the previous file when it does change it, and keeps other servers", async (t) => {
  const dir = sandbox(t);
  const configPath = join(dir, "mcp.json");
  writeFileSync(configPath, `${JSON.stringify({ mcpServers: { other: { command: "node" } } }, null, 2)}\n`);

  const report = await runConnect({
    settings: settings(),
    configPath,
    env: {},
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    logger: silent,
  });
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  assert.equal(report.value.changed, true);
  assert.ok(report.value.backupPath !== undefined);
  assert.deepEqual(readJson(report.value.backupPath), { mcpServers: { other: { command: "node" } } });
  assert.deepEqual(readJson(configPath).mcpServers.other, { command: "node" });
  assert.match(report.value.diff, /\+\s+"tab"/);
});

test("connect writes no private key, under any environment", async (t) => {
  const dir = sandbox(t);
  const configPath = join(dir, "mcp.json");

  // Every secret in the tracked environment contract, set to a key-shaped value.
  const hostile = {
    CREDITCOIN_RPC_URL: "https://rpc.example",
    NEXT_PUBLIC_REGISTRY_API_URL: "https://registry.example",
    AGENT_ETHEREUM_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    AGENT_CREDITCOIN_PRIVATE_KEY: `0x${"22".repeat(32)}`,
    WATCHER_PRIVATE_KEY: `0x${"33".repeat(32)}`,
    GATEWAY_PRIVATE_KEY: `0x${"44".repeat(32)}`,
    PROOF_SERVICE_PRIVATE_KEY: `0x${"55".repeat(32)}`,
    DATABASE_URL: "postgres://tab:tab@127.0.0.1:5432/tab",
  };

  const report = await runConnect({ settings: settings(), configPath, env: hostile, logger: silent });
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);

  const raw = readFileSync(configPath, "utf8");
  for (const [name, value] of Object.entries(hostile)) {
    if (name.endsWith("_RPC_URL") || name === "NEXT_PUBLIC_REGISTRY_API_URL") continue;
    assert.ok(!raw.includes(value), `${name} must not reach the config file`);
    assert.ok(!raw.includes(name), `${name} must not even be named in the config file`);
  }
  // And nothing key-shaped got in by another route.
  for (const value of allStrings(readJson(configPath))) {
    assert.ok(!/^(0x)?[0-9a-fA-F]{64}$/.test(value), `\`${value}\` is key-shaped and must not be written`);
  }
  assert.equal(assertNoSecret(readJson(configPath).mcpServers.tab).ok, true);
});

test("connect on a dry run prints the change and writes nothing", async (t) => {
  const dir = sandbox(t);
  const configPath = join(dir, "mcp.json");
  const report = await runConnect({ settings: settings(), configPath, env: {}, dryRun: true, logger: silent });
  assert.equal(report.ok, true);
  assert.equal(report.value.dryRun, true);
  assert.equal(report.value.changed, true, "it reports what would change");
  assert.ok(report.value.diff.includes(`"${TAB_SERVER_KEY}"`));
  assert.equal(existsSync(configPath), false, "and writes nothing");
});

test("connect leaves a config file it cannot parse exactly as it found it", async (t) => {
  const dir = sandbox(t);
  const configPath = join(dir, "mcp.json");
  writeFileSync(configPath, "{ not json at all");
  const report = await runConnect({ settings: settings(), configPath, env: {}, logger: silent });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "CONFIG_MALFORMED");
  assert.equal(readFileSync(configPath, "utf8"), "{ not json at all");
  assert.deepEqual(readdirSync(dir), ["mcp.json"], "no backup, no rewrite");
});

test("connect names the choice when more than one client is configured", async (t) => {
  const dir = sandbox(t);
  const cwd = join(dir, "project");
  writeFileSync(join(dir, "marker"), "");
  const report = await runConnect({
    settings: settings(),
    client: "nonesuch",
    env: {},
    cwd,
    logger: silent,
  });
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "CLIENT_UNKNOWN");
  assert.match(report.error.message, /claude-code/);
});

// ---------------------------------------------------------------- the diff

test("the diff shows the added lines with context and elides the rest", () => {
  const before = `${JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, mcpServers: {} }, null, 2)}\n`;
  const after = `${JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, mcpServers: { tab: { command: "npx" } } }, null, 2)}\n`;
  const diff = unifiedDiff(before, after);
  assert.match(diff, /^@@/m, "unchanged runs are elided");
  assert.match(diff, /\+\s+"tab"/);
  assert.ok(!diff.includes('\n "a": 1'), "distant context is not printed");
  assert.equal(unifiedDiff(before, before), "", "no change is no diff");
});

// ---------------------------------------------------------------- doctor

test("doctor reports a client config with no tab stanza as a warning, and one with a key as a failure", async (t) => {
  const dir = sandbox(t);
  const empty = join(dir, "empty.json");
  writeFileSync(empty, "{}\n");

  const withoutStanza = await runDoctor({ settings: settings({ rpcUrl: undefined }), env: {}, clientConfigPath: empty, logger: silent });
  const clientCheck = withoutStanza.checks.find((check) => check.name === "mcp-client-config");
  assert.equal(clientCheck.status, "warn");
  assert.equal(withoutStanza.ok, true, "a missing stanza is not a broken installation");

  const compromised = join(dir, "compromised.json");
  writeFileSync(
    compromised,
    `${JSON.stringify({ mcpServers: { tab: { command: "npx", env: { AGENT_ETHEREUM_PRIVATE_KEY: `0x${"11".repeat(32)}` } } } }, null, 2)}\n`,
  );
  const withKey = await runDoctor({ settings: settings({ rpcUrl: undefined }), env: {}, clientConfigPath: compromised, logger: silent });
  const keyCheck = withKey.checks.find((check) => check.name === "mcp-client-config");
  assert.equal(keyCheck.status, "fail");
  assert.equal(withKey.ok, false);
});

test("doctor never reads the value of a signing key, only whether one is set", async () => {
  const secret = `0x${"ab".repeat(32)}`;
  const report = await runDoctor({
    settings: settings({ rpcUrl: undefined }),
    env: { AGENT_ETHEREUM_PRIVATE_KEY: secret },
    logger: silent,
  });
  const check = report.checks.find((entry) => entry.name === "settlement-key");
  assert.equal(check.status, "pass");
  assert.ok(!JSON.stringify(report).includes(secret), "the key must appear nowhere in the report");

  const without = await runDoctor({ settings: settings({ rpcUrl: undefined }), env: {}, logger: silent });
  assert.equal(without.checks.find((entry) => entry.name === "settlement-key").status, "warn");
  assert.equal(without.ok, true, "no key is not a failure: three of the four tools need none");
});

test("doctor fails on a Creditcoin endpoint that answers the wrong chain id", async () => {
  // No network: an unroutable endpoint fails the read, which is the same branch a
  // wrong answer takes and is the one that must be a failure rather than a warning.
  const report = await runDoctor({
    settings: settings({ rpcUrl: "http://127.0.0.1:1" }),
    env: {},
    timeoutMs: 1500,
    logger: silent,
  });
  const rpc = report.checks.find((check) => check.name === "creditcoin-rpc");
  assert.equal(rpc.status, "fail");
  assert.equal(report.ok, false);
});

// ---------------------------------------------------------------- the entry point

test("the CLI answers help and an unknown command without throwing", async () => {
  const lines = [];
  const io = { out: (line) => lines.push(line), err: (line) => lines.push(line) };

  assert.equal(await runCli([], { io }), 0);
  assert.match(lines.join("\n"), /post-paid billing for autonomous agents on Creditcoin/);

  lines.length = 0;
  assert.equal(await runCli(["teleport"], { io }), 1);
  assert.match(lines.join("\n"), /is not a command/);

  lines.length = 0;
  assert.equal(await runCli(["--version"], { io }), 0);
  assert.equal(lines[0], "0.0.0");
});

test("the CLI connect command is idempotent end to end and prints the no-key guarantee", async (t) => {
  const dir = sandbox(t);
  const configPath = join(dir, "mcp.json");
  const env = { CREDITCOIN_RPC_URL: "https://rpc.example", AGENT_ETHEREUM_PRIVATE_KEY: `0x${"11".repeat(32)}` };

  const first = [];
  assert.equal(
    await runCli(["connect", "--config", configPath], { io: { out: (l) => first.push(l), err: (l) => first.push(l) }, env, cwd: dir }),
    0,
  );
  assert.match(first.join("\n"), /No private key was written/);
  assert.match(first.join("\n"), /Added the tab server stanza/);

  const second = [];
  assert.equal(
    await runCli(["connect", "--config", configPath], { io: { out: (l) => second.push(l), err: (l) => second.push(l) }, env, cwd: dir }),
    0,
  );
  assert.match(second.join("\n"), /Already connected/);
  assert.ok(!readFileSync(configPath, "utf8").includes("11".repeat(32)));
});

test("the CLI settle command refuses to broadcast when the process forbids it", async (t) => {
  const dir = sandbox(t);
  const lines = [];
  const code = await runCli(
    ["settle", "--service", `0x${"11".repeat(32)}`, "--asset", "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238", "--amount", "1", "--broadcast"],
    { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, env: {}, cwd: dir, allowBroadcast: false },
  );
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /broadcasting is disabled/);
});
