/**
 * `tab connect`: the one line of configuration.
 *
 * The whole adoption story is this command. It finds the MCP client's server
 * list, reads the deployment keylessly so it can tell the caller what they are
 * about to be connected to, merges one `mcpServers.tab` stanza, backs up what
 * was there, and prints the diff.
 *
 * ## Read before write
 *
 * The keyless read happens first and its result is reported whether it succeeded
 * or not. A `connect` that silently wrote a stanza pointing at a registry that
 * does not answer would look like success and behave like a broken install, and
 * the person running it would find out from a model instead of from the command.
 * The read never blocks the write: a deployment that is temporarily down is not
 * a reason to refuse to configure a client against it.
 *
 * ## Nothing here is a secret
 *
 * The stanza carries a command, its arguments, and at most two URLs. Every value
 * in it is publishable. {@link assertNoSecret} runs over the merged document
 * before anything is written, so the property is enforced rather than asserted
 * in a comment.
 *
 * Requirements: 25.5, 25.6
 */

import type { Result } from "@tabai/shared";
import { ok } from "@tabai/shared";

import { validationError } from "../errors.js";
import type { Logger } from "../logger.js";
import { silentLogger } from "../logger.js";
import { asArray, field } from "../mcp/json.js";
import { createRegistryReadClient, type RegistryFetch } from "../mcp/registry-client.js";
import type { TabMcpSettings } from "../mcp/settings.js";
import {
  buildTabStanza,
  chooseMcpClient,
  detectMcpClients,
  mergeTabStanza,
  readClientConfig,
  renderConfig,
  unifiedDiff,
  writeClientConfig,
  type McpClientTarget,
  type StanzaEnv,
  type TabStanza,
} from "./client-config.js";

export interface ConnectOptions {
  readonly settings: TabMcpSettings;
  /** `claude-code`, `claude-desktop`, `cursor`, `windsurf` or `vscode`. */
  readonly client?: string;
  /** An explicit config file, which beats `client` and skips detection. */
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly os?: string;
  readonly cwd?: string;
  /** Injectable clock, so a backup name is testable. */
  readonly now?: () => Date;
  /** Work out and print everything, and write nothing. */
  readonly dryRun?: boolean;
  readonly fetchImpl?: RegistryFetch;
  readonly logger?: Logger;
}

/** What the deployment said when it was asked, before anything was written. */
export interface ConnectPreflight {
  readonly registryUrl: string | undefined;
  /** Services indexed, or null when the read API did not answer. */
  readonly services: number | null;
  readonly note: string;
}

export interface ConnectReport {
  readonly client: string;
  readonly configPath: string;
  /** False when the file already said exactly this. */
  readonly changed: boolean;
  /** True when a `tab` stanza was already there, so a message can say updated. */
  readonly hadStanza: boolean;
  readonly backupPath: string | undefined;
  readonly stanza: TabStanza;
  /** Empty when nothing changed. */
  readonly diff: string;
  readonly preflight: ConnectPreflight;
  readonly dryRun: boolean;
}

/** The environment values that belong in a stanza. Publishable, both of them. */
function stanzaEnv(settings: TabMcpSettings, env: NodeJS.ProcessEnv): StanzaEnv {
  const values: Record<string, string> = {};
  const rpc = settings.rpcUrl ?? env["CREDITCOIN_RPC_URL"];
  if (rpc !== undefined && rpc.trim() !== "") values["CREDITCOIN_RPC_URL"] = rpc.trim();
  const registry = settings.registryUrl ?? env["NEXT_PUBLIC_REGISTRY_API_URL"];
  if (registry !== undefined && registry.trim() !== "") values["NEXT_PUBLIC_REGISTRY_API_URL"] = registry.trim();
  return values;
}

/** Reads the deployment, keylessly, so `connect` can say what it connected to. */
async function preflight(
  settings: TabMcpSettings,
  fetchImpl: RegistryFetch | undefined,
  logger: Logger,
): Promise<ConnectPreflight> {
  if (settings.registryUrl === undefined) {
    return {
      registryUrl: undefined,
      services: null,
      note: "no registry read API is configured, so discovery and status will not work until one is. Calling and settling do not need it",
    };
  }
  const registry = createRegistryReadClient({
    baseUrl: settings.registryUrl,
    logger,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  const services = await registry.services(50);
  if (!services.ok) {
    return {
      registryUrl: registry.baseUrl,
      services: null,
      note: `the read API did not answer: ${services.error.message}`,
    };
  }
  const count = asArray(field(services.value, "services")).length;
  const lastBlock = field(field(services.value, "index"), "lastBlock");
  return {
    registryUrl: registry.baseUrl,
    services: count,
    note:
      typeof lastBlock === "number"
        ? `${count} Service(s) indexed at Creditcoin block ${lastBlock}`
        : `${count} Service(s) indexed`,
  };
}

/** Resolves which file to write, from `--config`, then `--client`, then detection. */
function resolveTarget(options: ConnectOptions): Result<{ id: string; configPath: string }> {
  if (options.configPath !== undefined) {
    return ok({ id: options.client ?? "custom", configPath: options.configPath });
  }
  const detected = detectMcpClients({
    ...(options.os === undefined ? {} : { os: options.os }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  if (options.client !== undefined) {
    const named: McpClientTarget | undefined = detected.find((target) => target.id === options.client);
    if (named === undefined || named.configPath === undefined) {
      return validationError(
        "CLIENT_UNKNOWN",
        `\`${options.client}\` is not an MCP client this command knows on this platform; the known ones are ${detected
          .filter((target) => target.configPath !== undefined)
          .map((target) => target.id)
          .join(", ")}`,
        { details: { client: options.client } },
      );
    }
    return ok({ id: named.id, configPath: named.configPath });
  }
  const chosen = chooseMcpClient(detected);
  if (!chosen.ok) return chosen;
  if (chosen.value.configPath === undefined) {
    return validationError("CLIENT_UNKNOWN", `\`${chosen.value.id}\` has no config path on this platform`);
  }
  return ok({ id: chosen.value.id, configPath: chosen.value.configPath });
}

/**
 * Runs the command.
 *
 * Every failure is a `Result`, including a config file that will not parse. The
 * one thing this never does is write over something it could not read.
 */
export async function runConnect(options: ConnectOptions): Promise<Result<ConnectReport>> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? silentLogger;
  const at = (options.now ?? (() => new Date()))();
  const dryRun = options.dryRun ?? false;

  const target = resolveTarget(options);
  if (!target.ok) return target;

  const read = readClientConfig(target.value.configPath);
  if (!read.ok) return read;

  const stanza = buildTabStanza(stanzaEnv(options.settings, env));
  const merged = mergeTabStanza(read.value.document, stanza);
  if (!merged.ok) return merged;

  const checked = await preflight(options.settings, options.fetchImpl, logger);

  const before = read.value.existed ? renderConfig(read.value.document) : "";
  const after = renderConfig(merged.value.merged);
  const diff = merged.value.changed ? unifiedDiff(before, after) : "";

  if (dryRun) {
    return ok({
      client: target.value.id,
      configPath: target.value.configPath,
      changed: merged.value.changed,
      hadStanza: merged.value.hadStanza,
      backupPath: undefined,
      stanza,
      diff,
      preflight: checked,
      dryRun: true,
    });
  }

  const written = writeClientConfig(target.value.configPath, merged.value, read.value.existed, at);
  if (!written.ok) return written;

  return ok({
    client: target.value.id,
    configPath: target.value.configPath,
    changed: written.value.wrote,
    hadStanza: merged.value.hadStanza,
    backupPath: written.value.backupPath,
    stanza,
    diff,
    preflight: checked,
    dryRun: false,
  });
}
