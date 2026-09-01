/**
 * `tab`: the executable entry point of this package.
 *
 * Five commands. `mcp` serves the four tools, and is what the `mcpServers`
 * stanza launches. `connect` writes that stanza. `doctor` checks the whole
 * installation without a key. `status` and `settle` are the two tools a person
 * reaches for outside a model, one to see what is owed and one to pay it.
 *
 * ## stdout belongs to the protocol
 *
 * Under `mcp` the process speaks MCP over stdout, so this file writes every
 * human-readable line to stderr and every machine-readable payload to stdout,
 * and the two never mix. `--json` on `status`, `settle` and `doctor` puts a
 * single JSON document on stdout and nothing else, which is what makes the
 * commands scriptable.
 *
 * ## `settle` does not broadcast unless it is told to
 *
 * A Settlement spends real funds, and a command that spends by default is a
 * command somebody runs to see what it does. So `tab settle` is a dry run unless
 * `--broadcast` is passed: it resolves the strategy, the Collection Address and
 * the surface, reports exactly what would be sent, and sends nothing. The MCP
 * tool has the same `dryRun` field for the same reason, defaulted the other way
 * because a model calling `tab_settle` has already decided.
 *
 * Requirements: 25.5, 25.6
 */

import type { Result } from "@tabai/shared";
import { ok } from "@tabai/shared";

import { validationError } from "../errors.js";
import { createTabMcpServer, stderrLogger } from "../mcp/server.js";
import { resolveTabMcpSettings, type TabMcpSettings } from "../mcp/settings.js";
import { detectMcpClients } from "./client-config.js";
import { runConnect } from "./connect.js";
import { runDoctor, type CheckStatus, type DoctorReport } from "./doctor.js";

/** The name the help text uses. `npx @tabai/sdk` resolves to this. */
export const CLI_NAME = "tab";

export interface CliIo {
  /** Machine-readable output. Under `mcp` this is the protocol stream and nothing else writes to it. */
  out(line: string): void;
  /** Everything a person reads. */
  err(line: string): void;
}

const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export interface CliOptions {
  readonly io?: CliIo;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Blocks the two commands that would spend, so a test can never broadcast. */
  readonly allowBroadcast?: boolean;
}

// ---------------------------------------------------------------- flags

/** A flag parse. Everything is `--name value` or `--name` for a boolean. */
interface Flags {
  readonly positional: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly booleans: ReadonlySet<string>;
}

const BOOLEAN_FLAGS = new Set(["help", "version", "json", "dry-run", "broadcast", "http"]);

function parseFlags(argv: readonly string[]): Result<Flags> {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const booleans = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      values[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.has(body) && (next === undefined || next.startsWith("--"))) {
      booleans.add(body);
      continue;
    }
    if (next === undefined || next.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(body)) {
        booleans.add(body);
        continue;
      }
      return validationError("FLAG_VALUE_MISSING", `\`--${body}\` needs a value`, { details: { flag: body } });
    }
    values[body] = next;
    index += 1;
  }
  return ok({ positional, values, booleans });
}

// ---------------------------------------------------------------- rendering

/** Fixed-width so the check names line up in a terminal. */
const markOf = (status: CheckStatus): string =>
  status === "pass" ? "  ok  " : status === "warn" ? " warn " : status === "fail" ? " FAIL " : " skip ";

function renderDoctor(report: DoctorReport, io: CliIo): void {
  io.err("");
  for (const check of report.checks) {
    io.err(`[${markOf(check.status)}] ${check.name}: ${check.detail}`);
    if (check.hint !== undefined) io.err(`           ${check.hint}`);
  }
  io.err("");
  io.err(
    `${report.counts.pass} passed, ${report.counts.warn} warned, ${report.counts.fail} failed, ${report.counts.skip} skipped`,
  );
  io.err(report.ok ? "This installation can read the deployment." : "This installation is not usable as configured.");
}

const HELP = `${CLI_NAME} - post-paid billing for autonomous agents on Creditcoin

Usage
  npx -y @tabai/sdk <command> [options]

Commands
  mcp                Serve the four Tab tools over MCP. This is what an MCP client launches.
  connect            Write the tab server into an MCP client's config. Never writes a key.
  doctor             Check the installation. Every check is a keyless read.
  status             What the Agent owes, may still spend, and has settled.
  settle             Pay down an Open Tab. A dry run unless --broadcast is given.

Options
  mcp        --http [--port <n>] [--host <h>] [--endpoint <p>]   serve streamable HTTP instead of stdio
  connect    --client <id> | --config <path> | --dry-run
             clients: ${detectMcpClients()
               .filter((target) => target.configPath !== undefined)
               .map((target) => target.id)
               .join(", ")}
  doctor     --client <id> | --config <path> | --json
  status     --agent <0x..> --asset <chainKey:0x..> --history-limit <n> --json
  settle     --service <0x..> --asset <chainKey:0x..> --amount <baseUnits>
             --mode <direct-transfer|settlement-contract|auto> --strategy <id> --broadcast --json

Environment
  CREDITCOIN_RPC_URL              the Creditcoin JSON-RPC endpoint
  NEXT_PUBLIC_REGISTRY_API_URL    the Tab registry read API, which serves discovery and status
  AGENT_ETHEREUM_PRIVATE_KEY      read only when a Settlement is signed, and never written anywhere

Configuration
  tab.config.ts beside your project declares the Agent address, the registry URL,
  the Service endpoints, and the payment strategies. The chain records no Service
  endpoint, so tab_call needs one from there.
`;

// ---------------------------------------------------------------- commands

async function settingsFor(flags: Flags, options: CliOptions): Promise<TabMcpSettings> {
  return resolveTabMcpSettings({
    ...(flags.values["agent"] === undefined ? {} : { agent: flags.values["agent"] }),
    ...(flags.values["registry-url"] === undefined ? {} : { registryUrl: flags.values["registry-url"] }),
    ...(flags.values["rpc-url"] === undefined ? {} : { rpcUrl: flags.values["rpc-url"] }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    logger: stderrLogger,
  });
}

async function commandMcp(flags: Flags, options: CliOptions): Promise<number> {
  const io = options.io ?? processIo;
  const server = await createTabMcpServer({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    logger: stderrLogger,
  });

  if (flags.booleans.has("http") || flags.values["port"] !== undefined) {
    const port = Number.parseInt(flags.values["port"] ?? "8790", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      io.err(`tab: --port must be a TCP port, received \`${flags.values["port"] ?? ""}\``);
      return 1;
    }
    const served = await server.serveHttp({
      port,
      ...(flags.values["host"] === undefined ? {} : { host: flags.values["host"] }),
      ...(flags.values["endpoint"] === undefined ? {} : { endpoint: flags.values["endpoint"] }),
    });
    if (!served.ok) {
      io.err(`tab: ${served.error.message}`);
      return 1;
    }
    io.err(`tab: MCP over streamable HTTP at http://${served.value.host}:${served.value.port}${served.value.endpoint}`);
    // Held open by the listening socket. The process exits when it is closed.
    return 0;
  }

  const served = await server.serveStdio();
  if (!served.ok) {
    io.err(`tab: ${served.error.message}`);
    return 1;
  }
  return 0;
}

async function commandConnect(flags: Flags, options: CliOptions): Promise<number> {
  const io = options.io ?? processIo;
  const settings = await settingsFor(flags, options);
  const report = await runConnect({
    settings,
    ...(flags.values["client"] === undefined ? {} : { client: flags.values["client"] }),
    ...(flags.values["config"] === undefined ? {} : { configPath: flags.values["config"] }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    dryRun: flags.booleans.has("dry-run"),
    logger: stderrLogger,
  });

  if (!report.ok) {
    io.err(`tab connect: ${report.error.message}`);
    return 1;
  }

  const value = report.value;
  io.err("");
  io.err(`Client   ${value.client}`);
  io.err(`Config   ${value.configPath}`);
  io.err(`Registry ${value.preflight.registryUrl ?? "not configured"}`);
  io.err(`         ${value.preflight.note}`);
  io.err("");

  if (!value.changed) {
    io.err(`Already connected. \`${value.configPath}\` already runs the tab server, so nothing was written.`);
  } else if (value.dryRun) {
    io.err("Dry run. Nothing was written. This is the change that would be made:");
    io.err("");
    io.err(value.diff);
  } else {
    io.err(value.hadStanza ? "Updated the tab server stanza." : "Added the tab server stanza.");
    if (value.backupPath !== undefined) io.err(`Backed up the previous config to ${value.backupPath}`);
    io.err("");
    io.err(value.diff);
  }

  io.err("");
  io.err("No private key was written. Settlement signing keys are read from the environment at run time.");
  io.err("");
  io.err("Next");
  io.err(
    value.client === "custom"
      ? "  1. Restart the client that reads that file, so it picks up the new server."
      : `  1. Restart ${value.client} so it picks up the new server.`,
  );
  io.err("  2. Ask it to run tab_discover, which lists the Services registered on Creditcoin.");
  io.err(`  3. Check the whole installation with: npx -y @tabai/sdk doctor --config ${value.configPath}`);
  return 0;
}

async function commandDoctor(flags: Flags, options: CliOptions): Promise<number> {
  const io = options.io ?? processIo;
  const settings = await settingsFor(flags, options);

  let clientConfigPath = flags.values["config"];
  if (clientConfigPath === undefined) {
    const detected = detectMcpClients({
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const named = flags.values["client"];
    const chosen = named === undefined ? detected.find((t) => t.present) : detected.find((t) => t.id === named);
    clientConfigPath = chosen?.configPath;
  }

  const report = await runDoctor({
    settings,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(clientConfigPath === undefined ? {} : { clientConfigPath }),
    logger: stderrLogger,
  });

  if (flags.booleans.has("json")) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    renderDoctor(report, io);
  }
  return report.ok ? 0 : 1;
}

async function commandStatus(flags: Flags, options: CliOptions): Promise<number> {
  const io = options.io ?? processIo;
  const settings = await settingsFor(flags, options);
  const server = await createTabMcpServer({ settings, logger: stderrLogger });

  const output = await server.toolset.status({
    ...(flags.values["agent"] === undefined ? {} : { agent: flags.values["agent"] }),
    ...(flags.values["asset"] === undefined ? {} : { asset: flags.values["asset"] }),
    ...(flags.values["history-limit"] === undefined
      ? {}
      : { historyLimit: Number.parseInt(flags.values["history-limit"], 10) }),
  });

  if (flags.booleans.has("json")) {
    io.out(JSON.stringify(output, null, 2));
    return output.error === undefined ? 0 : 1;
  }

  io.err("");
  io.err(`Agent ${output.agent}`);
  if (output.error !== undefined) {
    io.err(`  ${output.error.code}: ${output.error.message}`);
    return 1;
  }
  if (output.perAsset.length === 0) io.err("  no Asset activity is indexed for this Agent");
  for (const entry of output.perAsset) {
    io.err(`  ${entry.asset}`);
    io.err(`    credit limit  ${entry.creditLimitBaseUnits ?? "withheld"}`);
    io.err(`    open tab      ${entry.openTabBaseUnits}`);
    io.err(`    headroom      ${entry.headroomBaseUnits ?? "withheld"}`);
    io.err(`    delinquent    ${String(entry.delinquent)}`);
  }
  io.err(`  verified settlements ${output.verifiedSettlements?.length ?? 0}`);
  io.err(`  provisional clearings ${output.provisionalClearings?.length ?? 0}`);
  return 0;
}

async function commandSettle(flags: Flags, options: CliOptions): Promise<number> {
  const io = options.io ?? processIo;
  const broadcast = flags.booleans.has("broadcast");

  if (broadcast && options.allowBroadcast === false) {
    io.err("tab settle: broadcasting is disabled in this process");
    return 1;
  }

  // The strategy comes from `tab.config`, loaded by the toolset the first time a
  // Settlement needs one. Nothing is loaded here, so a dry run that fails for
  // another reason never touches a signer.
  const settings = await settingsFor(flags, options);
  const server = await createTabMcpServer({
    settings,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    logger: stderrLogger,
  });

  const output = await server.toolset.settle({
    ...(flags.values["service"] === undefined ? {} : { serviceId: flags.values["service"] }),
    ...(flags.values["asset"] === undefined ? {} : { asset: flags.values["asset"] }),
    ...(flags.values["amount"] === undefined ? {} : { amountBaseUnits: flags.values["amount"] }),
    ...(flags.values["mode"] === undefined ? {} : { mode: flags.values["mode"] }),
    ...(flags.values["strategy"] === undefined ? {} : { strategyId: flags.values["strategy"] }),
    dryRun: !broadcast,
  });

  if (flags.booleans.has("json")) {
    io.out(JSON.stringify(output, null, 2));
    return output.ok ? 0 : 1;
  }

  io.err("");
  if (!output.ok) {
    io.err(`tab settle: ${output.error?.code ?? "FAILED"}: ${output.error?.message ?? "the Settlement was not built"}`);
    return 1;
  }
  if (output.dryRun) {
    io.err("Dry run. Nothing was broadcast.");
    io.err(`  chain key   ${String(output.chainKey)}`);
    io.err(`  amount      ${output.amountBaseUnits}`);
    io.err(`  collection  ${output.collectionAddress ?? "unknown"}`);
    io.err(`  attestation ${output.expectedAttestationWait ?? "unknown"}`);
    io.err("");
    io.err("Add --broadcast to send it. This spends real funds.");
    return 0;
  }
  io.err("Broadcast.");
  io.err(`  source tx   ${output.sourceTxHash ?? "unknown"}`);
  io.err(`  amount      ${output.amountBaseUnits}`);
  io.err(`  attestation ${output.expectedAttestationWait ?? "unknown"}`);
  return 0;
}

// ---------------------------------------------------------------- entry

/** Runs one invocation and answers a process exit code. Never throws. */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  const parsed = parseFlags(argv);
  if (!parsed.ok) {
    io.err(`tab: ${parsed.error.message}`);
    return 1;
  }
  const flags = parsed.value;
  const command = flags.positional[0];

  if (flags.booleans.has("version")) {
    io.out("0.0.0");
    return 0;
  }
  if (command === undefined || flags.booleans.has("help") || command === "help") {
    io.err(HELP);
    return command === undefined || command === "help" || flags.booleans.has("help") ? 0 : 1;
  }

  try {
    switch (command) {
      case "mcp":
        return await commandMcp(flags, options);
      case "connect":
        return await commandConnect(flags, options);
      case "doctor":
        return await commandDoctor(flags, options);
      case "status":
        return await commandStatus(flags, options);
      case "settle":
        return await commandSettle(flags, options);
      default:
        io.err(`tab: \`${command}\` is not a command. Run \`${CLI_NAME} help\` for the list.`);
        return 1;
    }
  } catch (error) {
    // The commands are written not to reach here. A bug that does should still
    // leave a message and an exit code rather than an unhandled rejection.
    io.err(`tab: ${command} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
