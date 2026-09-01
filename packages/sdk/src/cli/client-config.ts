/**
 * Where an MCP client keeps its server list, and how `tab connect` edits it.
 *
 * ## The claim this file has to earn
 *
 * Adopting Tab costs one line of configuration. That line is a `mcpServers`
 * stanza in a file the client already owns, and `tab connect` writes it. The
 * claim is only worth making if the write is safe to run, so three properties
 * are enforced here rather than documented:
 *
 * - **Idempotent.** Running it twice writes once. The second run compares the
 *   merged document against what is on disk and, finding no change, writes
 *   nothing and takes no backup. A connect command that rewrote the file every
 *   time would churn a file the client also writes.
 * - **Backed up.** Any run that does change the file copies the previous
 *   contents beside it first, named with the instant. This is somebody's editor
 *   configuration, and it may hold servers this package has never heard of.
 * - **Never a key.** {@link assertNoSecret} walks the stanza before it is
 *   written and refuses on anything key-shaped. The settlement signing key is
 *   read from the environment at the moment a Settlement is signed. It does not
 *   belong in a JSON file that a desktop client rewrites, syncs, and quotes in
 *   its own logs.
 *
 * ## Only `mcpServers.tab` is touched
 *
 * The merge is by key, and every other server in the document is carried through
 * untouched, as is every top-level key the client keeps beside `mcpServers`. A
 * file that fails to parse is not overwritten: it is reported, because a
 * half-written config file is a client that will not start and the caller is the
 * only one who knows what was in it.
 *
 * Requirements: 25.5, 25.6
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Result } from "@tabai/shared";
import { ok } from "@tabai/shared";

import { fail, notFoundError, validationError } from "../errors.js";
import { isRecord, type JsonRecord } from "../mcp/json.js";

/** One MCP client this command knows how to find. */
export interface McpClientTarget {
  /** The `--client` value, for example `claude-desktop`. */
  readonly id: string;
  /** What to call it in a message a person reads. */
  readonly label: string;
  /** Absolute path to its server list on this platform, or undefined where it has none. */
  readonly configPath: string | undefined;
  /** True when the file exists. A known client with no file yet is still a valid target. */
  readonly present: boolean;
  /**
   * True when the directory the file would live in exists, which is the signal
   * that the client is installed even though it has never been configured.
   */
  readonly installed: boolean;
}

const home = (): string => homedir();

/**
 * The per-platform locations, one entry per client.
 *
 * Each path is the client's own documented location. A client absent from a
 * platform has `undefined` there rather than a guessed path, so `--client` names
 * something real or fails by name.
 */
function configPathFor(id: string, os: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const appData = env["APPDATA"];
  switch (id) {
    case "claude-desktop":
      if (os === "darwin") return join(home(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
      if (os === "win32") return appData === undefined ? undefined : join(appData, "Claude", "claude_desktop_config.json");
      return join(home(), ".config", "Claude", "claude_desktop_config.json");
    case "claude-code":
      // Project-scoped and checked in beside the code, which is the form a team
      // shares. The user-scoped list lives in `~/.claude.json` and is edited by
      // the CLI itself, so this command does not reach into it.
      return resolve(cwd, ".mcp.json");
    case "cursor":
      return join(home(), ".cursor", "mcp.json");
    case "windsurf":
      return join(home(), ".codeium", "windsurf", "mcp_config.json");
    case "vscode":
      if (os === "darwin") return join(home(), "Library", "Application Support", "Code", "User", "mcp.json");
      if (os === "win32") return appData === undefined ? undefined : join(appData, "Code", "User", "mcp.json");
      return join(home(), ".config", "Code", "User", "mcp.json");
    default:
      return undefined;
  }
}

/** Every client `connect` can target, in the order detection prefers them. */
export const MCP_CLIENT_IDS = ["claude-code", "claude-desktop", "cursor", "windsurf", "vscode"] as const;

const LABELS: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code (project .mcp.json)",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  windsurf: "Windsurf",
  vscode: "Visual Studio Code",
};

export interface DetectOptions {
  readonly os?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

const exists = (path: string | undefined): boolean => {
  if (path === undefined) return false;
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
};

const directoryExists = (path: string | undefined): boolean => {
  if (path === undefined) return false;
  try {
    return existsSync(dirname(path));
  } catch {
    return false;
  }
};

/** Every known client on this platform, whether or not it is installed. */
export function detectMcpClients(options: DetectOptions = {}): readonly McpClientTarget[] {
  const os = options.os ?? platform();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  return MCP_CLIENT_IDS.map((id) => {
    const configPath = configPathFor(id, os, env, cwd);
    return {
      id,
      label: LABELS[id] ?? id,
      configPath,
      present: exists(configPath),
      installed: directoryExists(configPath),
    };
  });
}

/**
 * The client to write to when the caller named none.
 *
 * A client with an existing config file wins over one that is merely installed,
 * because an existing file is evidence somebody uses it. Detection never picks
 * between two files silently: with more than one candidate present, the caller
 * is asked to name one.
 */
export function chooseMcpClient(
  targets: readonly McpClientTarget[],
): Result<McpClientTarget> {
  const present = targets.filter((target) => target.present);
  if (present.length === 1) return ok(present[0]!);
  if (present.length > 1) {
    return fail(
      "CONFLICT",
      "CLIENT_AMBIGUOUS",
      `more than one MCP client is configured on this machine (${present.map((t) => t.id).join(", ")}); name one with --client`,
      { details: { candidates: present.map((t) => t.id).join(", ") } },
    );
  }
  const installed = targets.filter((target) => target.installed);
  if (installed.length === 1) return ok(installed[0]!);
  if (installed.length > 1) {
    return fail(
      "CONFLICT",
      "CLIENT_AMBIGUOUS",
      `more than one MCP client is installed on this machine (${installed.map((t) => t.id).join(", ")}); name one with --client`,
      { details: { candidates: installed.map((t) => t.id).join(", ") } },
    );
  }
  return notFoundError(
    "CLIENT_NOT_FOUND",
    `no MCP client config was found on this machine; name one with --client (${MCP_CLIENT_IDS.join(", ")}) or point at the file with --config`,
  );
}

// ---------------------------------------------------------------- the stanza

/** The `env` block the stanza carries. Non-secret values only, by construction. */
export type StanzaEnv = Readonly<Record<string, string>>;

export interface TabStanza {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: StanzaEnv;
}

/** The key the stanza is written under. One server, one name, always this one. */
export const TAB_SERVER_KEY = "tab";

/**
 * Builds the stanza.
 *
 * `npx -y @tabai/sdk mcp` rather than a path: the client launches it, `npx`
 * resolves the published package, and nothing has to be installed first. That is
 * the one line the adoption claim rests on.
 *
 * The `env` block carries only what the server reads and a person could publish
 * -- an RPC endpoint and a read API URL. The design sketches this block with
 * `TAB_RPC_URL`; the name this deployment actually reads, and the one in the
 * tracked environment contract, is `CREDITCOIN_RPC_URL`, so that is what is
 * written.
 */
export function buildTabStanza(env: StanzaEnv = {}): TabStanza {
  const entries = Object.entries(env).filter(([, value]) => typeof value === "string" && value.trim() !== "");
  return {
    command: "npx",
    args: ["-y", "@tabai/sdk", "mcp"],
    ...(entries.length === 0 ? {} : { env: Object.fromEntries(entries) }),
  };
}

/** Anything that looks like a signing key, by name or by shape. */
const SECRET_NAME = /(PRIVATE[_-]?KEY|SECRET|MNEMONIC|SEED[_-]?PHRASE|PASSWORD|API[_-]?KEY|TOKEN|CREDENTIAL)/i;
const SECRET_SHAPE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Refuses a stanza that carries a secret.
 *
 * Both a name check and a shape check, because either alone is defeated by the
 * obvious mistake: a key under an innocuous name has the shape, and an empty
 * placeholder under `PRIVATE_KEY` has the name. This runs on the merged document
 * before it is written, so it also catches a secret that was already in the file
 * under the `tab` key from an earlier hand edit.
 */
export function assertNoSecret(stanza: unknown, where = "the tab stanza"): Result<void> {
  const problems: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (SECRET_SHAPE.test(value.trim())) problems.push(`${path} holds a 32-byte hex value, which is the shape of a signing key`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const child = path === "" ? key : `${path}.${key}`;
        if (SECRET_NAME.test(key)) problems.push(`${child} names a credential`);
        walk(entry, child);
      }
    }
  };
  walk(stanza, "");
  if (problems.length > 0) {
    return validationError(
      "STANZA_CARRIES_SECRET",
      `${where} would carry a credential and was not written: ${problems.join("; ")}. Settlement signing keys are read from the environment at run time and never from a client config file.`,
      { details: { problems: problems.join("; ") } },
    );
  }
  return ok(undefined);
}

// ---------------------------------------------------------------- merge

export interface MergeOutcome {
  /** The document as it should be on disk. */
  readonly merged: JsonRecord;
  /** The document that was on disk, or an empty object when the file did not exist. */
  readonly previous: JsonRecord;
  /** False when the file already said exactly this, which is the idempotent case. */
  readonly changed: boolean;
  /** Whether a `tab` stanza was already there, so a message can say added or updated. */
  readonly hadStanza: boolean;
}

/** Two-space JSON with a trailing newline, which is what every one of these files uses. */
export const renderConfig = (document: unknown): string => `${JSON.stringify(document, null, 2)}\n`;

/**
 * Merges the stanza into a document, leaving every other key alone.
 *
 * `changed` compares rendered text rather than object identity, so a run that
 * produces the same file is reported as no change even when the objects differ
 * by key order.
 */
export function mergeTabStanza(previous: JsonRecord, stanza: TabStanza): Result<MergeOutcome> {
  const existingServers = previous["mcpServers"];
  if (existingServers !== undefined && !isRecord(existingServers)) {
    return validationError(
      "CONFIG_MCP_SERVERS_INVALID",
      "the config file has an `mcpServers` key that is not an object, so it was left alone rather than replaced",
    );
  }
  const servers: Record<string, unknown> = { ...(isRecord(existingServers) ? existingServers : {}) };
  const hadStanza = servers[TAB_SERVER_KEY] !== undefined;
  servers[TAB_SERVER_KEY] = stanza;

  // Only the `tab` stanza is checked. Another server's API key is that server's
  // business and carrying it through untouched is the whole point of merging
  // rather than replacing -- refusing on it would make `connect` fail on exactly
  // the machines that already use MCP. The guarantee this command owes is about
  // what it writes, and what it writes is the stanza.
  const secret = assertNoSecret(servers[TAB_SERVER_KEY], `the \`${TAB_SERVER_KEY}\` stanza`);
  if (!secret.ok) return secret;

  const merged: JsonRecord = { ...previous, mcpServers: servers };

  return ok({
    merged,
    previous,
    changed: renderConfig(previous) !== renderConfig(merged),
    hadStanza,
  });
}

// ---------------------------------------------------------------- the file

export interface ReadConfigOutcome {
  readonly document: JsonRecord;
  readonly existed: boolean;
  readonly raw: string;
}

/**
 * Reads a client config.
 *
 * A file that does not exist is an empty document and not an error: connecting a
 * client that has never been configured is the common case. A file that exists
 * and does not parse *is* an error, and nothing is written over it.
 */
export function readClientConfig(path: string): Result<ReadConfigOutcome> {
  if (!existsSync(path)) return ok({ document: {}, existed: false, raw: "" });
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return fail("UNAVAILABLE", "CONFIG_UNREADABLE", `\`${path}\` could not be read`, {
      details: { path },
      cause: { code: "READ_FAILED", message: error instanceof Error ? error.message : String(error) },
    });
  }
  if (raw.trim() === "") return ok({ document: {}, existed: true, raw });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return validationError(
      "CONFIG_MALFORMED",
      `\`${path}\` is not valid JSON, so it was left untouched: ${error instanceof Error ? error.message : String(error)}`,
      { details: { path } },
    );
  }
  if (!isRecord(parsed)) {
    return validationError("CONFIG_MALFORMED", `\`${path}\` must hold a JSON object at its top level`, {
      details: { path },
    });
  }
  return ok({ document: parsed, existed: true, raw });
}

/** Where a backup of `path` goes, named with the instant so two runs never collide. */
export const backupPathFor = (path: string, at: Date): string =>
  `${path}.tab-backup-${at.toISOString().replace(/[:.]/g, "-")}`;

export interface WriteOutcome {
  readonly path: string;
  /** Absent when nothing was written, which is the idempotent case. */
  readonly backupPath?: string;
  readonly wrote: boolean;
}

/** Writes the merged document, taking a backup first when a file was already there. */
export function writeClientConfig(
  path: string,
  outcome: MergeOutcome,
  existed: boolean,
  at: Date,
): Result<WriteOutcome> {
  if (!outcome.changed) return ok({ path, wrote: false });
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    return fail("UNAVAILABLE", "CONFIG_DIRECTORY_UNWRITABLE", `\`${dirname(path)}\` could not be created`, {
      details: { path },
      cause: { code: "MKDIR_FAILED", message: error instanceof Error ? error.message : String(error) },
    });
  }

  let backupPath: string | undefined;
  if (existed) {
    backupPath = backupPathFor(path, at);
    try {
      copyFileSync(path, backupPath);
    } catch (error) {
      return fail("UNAVAILABLE", "CONFIG_BACKUP_FAILED", `\`${path}\` could not be backed up, so it was not changed`, {
        details: { path, backupPath },
        cause: { code: "COPY_FAILED", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  try {
    writeFileSync(path, renderConfig(outcome.merged), "utf8");
  } catch (error) {
    return fail("UNAVAILABLE", "CONFIG_UNWRITABLE", `\`${path}\` could not be written`, {
      details: { path },
      cause: { code: "WRITE_FAILED", message: error instanceof Error ? error.message : String(error) },
    });
  }
  return ok({ path, wrote: true, ...(backupPath === undefined ? {} : { backupPath }) });
}

// ---------------------------------------------------------------- the diff

/**
 * A unified diff of two JSON documents, line by line.
 *
 * Written here rather than pulled in because it is a longest-common-subsequence
 * over at most a few hundred lines and the alternative is a dependency for a
 * command that prints one. `connect` shows this before it claims to have done
 * anything, because a command that edits a file the user did not open owes them
 * a look at what it changed.
 */
export function unifiedDiff(before: string, after: string, context = 2): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");

  // LCS table. Both sides are one JSON document, so the quadratic cost is a few
  // hundred thousand cells at worst and is paid once, on a command a person ran.
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const lines: { readonly mark: " " | "-" | "+"; readonly text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ mark: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      lines.push({ mark: "-", text: a[i]! });
      i += 1;
    } else {
      lines.push({ mark: "+", text: b[j]! });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) lines.push({ mark: "-", text: a[i]! });
  for (; j < b.length; j += 1) lines.push({ mark: "+", text: b[j]! });

  // Keep only the changed lines and `context` lines either side, so a large
  // config with one added server prints as one hunk.
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.mark === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep.add(k);
  });

  // Nothing changed is no diff at all, not one elision marker.
  if (keep.size === 0) return "";

  const rendered: string[] = [];
  let skipping = false;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      rendered.push(`${line.mark}${line.text}`);
      skipping = false;
    } else if (!skipping) {
      rendered.push("@@");
      skipping = true;
    }
  });
  return rendered.join("\n");
}
