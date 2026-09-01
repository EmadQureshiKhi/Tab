/**
 * `tab doctor`: every check that can be made without a key.
 *
 * The point of the command is that a person who has just run `tab connect` can
 * find out whether it worked before they ask a model to spend anything. So every
 * check here is a read -- an `eth_chainId`, an `eth_getCode`, a `GET /healthz`.
 * Nothing here signs, nothing here writes, and nothing here loads a private key.
 * The one thing it says about a signing key is whether the environment carries
 * one at all, reported as present or absent and never read, because "you have no
 * key configured" is the answer to why `tab_settle` will refuse, and printing the
 * key would be the worst possible way to say it.
 *
 * ## Three outcomes, not two
 *
 * A check answers `pass`, `warn`, `fail` or `skip`, and the distinction carries
 * weight. A missing registry read API is a `warn`: discovery and status will not
 * work, but calling and settling will, so it is not a broken installation. An
 * RPC endpoint that answers the wrong chain id is a `fail`: every address in the
 * configuration names a contract on a different chain, and anything built on top
 * of it would be wrong rather than absent. `skip` is for a check whose input was
 * not configured, which is a statement about the configuration and not about the
 * deployment.
 *
 * Requirements: 25.6, 28.6
 */

import { JsonRpcProvider } from "ethers";

import type { Logger } from "../logger.js";
import { silentLogger } from "../logger.js";
import { asArray, field, isRecord } from "../mcp/json.js";
import { createRegistryReadClient, type RegistryFetch } from "../mcp/registry-client.js";
import type { TabMcpSettings } from "../mcp/settings.js";
import { readClientConfig, TAB_SERVER_KEY, assertNoSecret } from "./client-config.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  /** Short and stable, so a script can grep for one. */
  readonly name: string;
  readonly status: CheckStatus;
  /** What was found, in one sentence. */
  readonly detail: string;
  /** What to do about it, when there is something to do. */
  readonly hint?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** True when nothing failed. Warnings do not make a report unhealthy. */
  readonly ok: boolean;
  readonly counts: Readonly<Record<CheckStatus, number>>;
}

export interface DoctorOptions {
  readonly settings: TabMcpSettings;
  readonly env?: NodeJS.ProcessEnv;
  /** The MCP client config to inspect, when the caller resolved one. */
  readonly clientConfigPath?: string;
  readonly fetchImpl?: RegistryFetch;
  readonly logger?: Logger;
  /** How long any one network read may take. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

/** The Creditcoin CC3 Testnet chain id, used when the environment names none. */
export const DEFAULT_CREDITCOIN_CHAIN_ID = 102031;

/** The contracts a working deployment has code at, under their environment names. */
const CONTRACTS = [
  ["SETTLEMENT_VERIFIER_ADDRESS", "SettlementVerifier"],
  ["TAB_BOOK_ADDRESS", "TabBook"],
  ["SERVICE_REGISTRY_ADDRESS", "ServiceRegistry"],
  ["AGENT_REGISTRY_ADDRESS", "AgentRegistry"],
  ["BOND_ADDRESS", "Bond"],
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const pass = (name: string, detail: string): DoctorCheck => ({ name, status: "pass", detail });
const warn = (name: string, detail: string, hint?: string): DoctorCheck => ({
  name,
  status: "warn",
  detail,
  ...(hint === undefined ? {} : { hint }),
});
const bad = (name: string, detail: string, hint?: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  ...(hint === undefined ? {} : { hint }),
});
const skip = (name: string, detail: string, hint?: string): DoctorCheck => ({
  name,
  status: "skip",
  detail,
  ...(hint === undefined ? {} : { hint }),
});

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs every check and answers the whole report. Never throws, never signs. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const settings = options.settings;
  const logger = options.logger ?? silentLogger;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checks: DoctorCheck[] = [];

  // ---- the runtime
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push(
    major >= 20
      ? pass("node", `Node ${process.versions.node}`)
      : bad("node", `Node ${process.versions.node}`, "the MCP server needs Node 20.10 or later for its global fetch"),
  );

  // ---- what is configured
  checks.push(
    settings.agent === undefined
      ? warn(
          "agent",
          "no Agent address is configured",
          "set `agent` in tab.config; tab_call and tab_settle need to know whose Open Tab to meter",
        )
      : pass("agent", `${settings.agent} (${settings.sources["agent"] ?? "unknown source"})`),
  );
  checks.push(
    settings.services.length === 0
      ? warn(
          "service-directory",
          "no Service endpoints are configured",
          "the chain records no URL for a Service, so add each one to the `services` list in tab.config or tab_call has nowhere to send a request",
        )
      : pass("service-directory", `${settings.services.length} Service endpoint(s) configured`),
  );

  // ---- Creditcoin, keyless
  if (settings.rpcUrl === undefined) {
    checks.push(
      skip("creditcoin-rpc", "no Creditcoin RPC endpoint is configured", "set CREDITCOIN_RPC_URL"),
      skip("creditcoin-contracts", "skipped: there is no endpoint to read from"),
    );
  } else {
    const expected = Number.parseInt(env["CREDITCOIN_CHAIN_ID"] ?? String(DEFAULT_CREDITCOIN_CHAIN_ID), 10);
    const provider = new JsonRpcProvider(settings.rpcUrl, undefined, { staticNetwork: true });
    try {
      const [network, head] = await Promise.all([
        withTimeout(provider.getNetwork(), timeoutMs, "eth_chainId"),
        withTimeout(provider.getBlockNumber(), timeoutMs, "eth_blockNumber"),
      ]);
      const chainId = Number(network.chainId);
      checks.push(
        chainId === expected
          ? pass("creditcoin-rpc", `chain id ${chainId} at block ${head}`)
          : bad(
              "creditcoin-rpc",
              `the endpoint answers chain id ${chainId} and the configuration expects ${expected}`,
              "every contract address in the configuration names a contract on one chain; reading a different one would produce confident wrong answers",
            ),
      );
      checks.push(...(await contractChecks(provider, env, timeoutMs)));
    } catch (error) {
      checks.push(
        bad("creditcoin-rpc", `${settings.rpcUrl} could not be read: ${reason(error)}`, "check CREDITCOIN_RPC_URL"),
        skip("creditcoin-contracts", "skipped: the endpoint did not answer"),
      );
    } finally {
      provider.destroy();
    }
  }

  // ---- the registry read API, keyless
  if (settings.registryUrl === undefined) {
    checks.push(
      warn(
        "registry-api",
        "no registry read API is configured",
        "tab_discover and tab_status read from it; set NEXT_PUBLIC_REGISTRY_API_URL or `registryUrl` in tab.config. tab_call and tab_settle work without it",
      ),
    );
  } else {
    const registry = createRegistryReadClient({
      baseUrl: settings.registryUrl,
      timeoutMs,
      logger,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    const health = await registry.health();
    if (!health.ok) {
      checks.push(
        warn("registry-api", `${registry.baseUrl} did not answer: ${health.error.message}`, "start the registry read API, or point at a deployed one"),
      );
    } else {
      checks.push(pass("registry-api", `${registry.baseUrl} is healthy`));
      const services = await registry.services(5);
      if (!services.ok) {
        checks.push(warn("registry-services", `the Service directory could not be read: ${services.error.message}`));
      } else {
        const count = asArray(field(services.value, "services")).length;
        const lastBlock = field(field(services.value, "index"), "lastBlock");
        checks.push(
          count === 0
            ? warn(
                "registry-services",
                "the read API is healthy and no Service is registered yet",
                "register a Service, or wait for the indexer to catch up",
              )
            : pass(
                "registry-services",
                `${count} Service(s) indexed${typeof lastBlock === "number" ? ` at Creditcoin block ${lastBlock}` : ""}`,
              ),
        );
      }
    }
  }

  // ---- each configured Service endpoint
  checks.push(...(await endpointChecks(settings, options.fetchImpl, timeoutMs)));

  // ---- the MCP client config
  checks.push(clientConfigCheck(options.clientConfigPath));

  // ---- the signing key, named and never read
  const keyPresent = env["AGENT_ETHEREUM_PRIVATE_KEY"] !== undefined;
  checks.push(
    keyPresent
      ? pass("settlement-key", "AGENT_ETHEREUM_PRIVATE_KEY is set in this environment; its value is never read here or written anywhere")
      : warn(
          "settlement-key",
          "AGENT_ETHEREUM_PRIVATE_KEY is not set",
          "tab_settle signs the Settlement with the Agent's own key, read from the environment at signing time. Discovery, calling and status need no key",
        ),
  );

  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { checks, ok: counts.fail === 0, counts };
}

/** `eth_getCode` at each configured contract address. */
async function contractChecks(
  provider: JsonRpcProvider,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<readonly DoctorCheck[]> {
  const configured: { readonly variable: string; readonly label: string; readonly address: string }[] = [];
  for (const [variable, label] of CONTRACTS) {
    const address = env[variable];
    // The zero address is the placeholder `.env.example` ships before a
    // deployment fills it in, so it means "not configured" and not "no code".
    if (address === undefined) continue;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address) || address.toLowerCase() === ZERO_ADDRESS) continue;
    configured.push({ variable, label, address });
  }

  if (configured.length === 0) {
    return [
      skip(
        "creditcoin-contracts",
        "no contract addresses are configured",
        "set SETTLEMENT_VERIFIER_ADDRESS, TAB_BOOK_ADDRESS, SERVICE_REGISTRY_ADDRESS, AGENT_REGISTRY_ADDRESS and BOND_ADDRESS",
      ),
    ];
  }

  const results = await Promise.all(
    configured.map(async (entry) => {
      try {
        // Pinned to `latest`, deliberately. Creditcoin's `finalized` tag lags the
        // head, and a contract deployed within the lag would read as absent -- a
        // false failure at exactly the moment somebody is checking a fresh
        // deployment.
        const code = await withTimeout(provider.getCode(entry.address, "latest"), timeoutMs, "eth_getCode");
        return { entry, hasCode: code !== undefined && code !== "0x" && code.length > 2, error: undefined };
      } catch (error) {
        return { entry, hasCode: false, error: reason(error) };
      }
    }),
  );

  const missing = results.filter((result) => !result.hasCode);
  if (missing.length === 0) {
    return [pass("creditcoin-contracts", `${results.length} contract(s) hold code: ${results.map((r) => r.entry.label).join(", ")}`)];
  }
  return [
    bad(
      "creditcoin-contracts",
      `no code at ${missing.map((result) => `${result.entry.label} (${result.entry.address})`).join(", ")}`,
      "the addresses name nothing on this chain: check the environment against the deployment, and that the RPC endpoint is the right network",
    ),
  ];
}

/** A `GET /healthz` against each configured Service endpoint. */
async function endpointChecks(
  settings: TabMcpSettings,
  fetchImpl: RegistryFetch | undefined,
  timeoutMs: number,
): Promise<readonly DoctorCheck[]> {
  if (settings.services.length === 0) return [];
  const send = fetchImpl ?? (globalThis as { fetch?: RegistryFetch }).fetch;
  if (send === undefined) return [skip("service-endpoints", "this host has no global fetch")];

  const signal = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal?.timeout?.(timeoutMs);
  const results = await Promise.all(
    settings.services.map(async (entry) => {
      const url = `${entry.endpoint.replace(/\/+$/, "")}/healthz`;
      try {
        const response = await send(url, { method: "GET", ...(signal === undefined ? {} : { signal }) });
        return { entry, reachable: response.status >= 200 && response.status < 500, status: response.status };
      } catch (error) {
        return { entry, reachable: false, status: reason(error) };
      }
    }),
  );

  const unreachable = results.filter((result) => !result.reachable);
  if (unreachable.length === 0) {
    return [pass("service-endpoints", `${results.length} Service endpoint(s) answered`)];
  }
  return [
    warn(
      "service-endpoints",
      `${unreachable.length} of ${results.length} Service endpoint(s) did not answer: ${unreachable
        .map((result) => `${result.entry.serviceId} at ${result.entry.endpoint} (${String(result.status)})`)
        .join(", ")}`,
      "a Service that is down is not a broken installation, but tab_call against it will fail",
    ),
  ];
}

/** Is the `tab` stanza in the client config, and is it free of credentials? */
function clientConfigCheck(path: string | undefined): DoctorCheck {
  if (path === undefined) {
    return skip("mcp-client-config", "no MCP client config was named", "run `tab connect`, or pass --config");
  }
  const read = readClientConfig(path);
  if (!read.ok) return bad("mcp-client-config", read.error.message);
  if (!read.value.existed) {
    return warn("mcp-client-config", `\`${path}\` does not exist yet`, "run `tab connect` to write it");
  }
  const servers = field(read.value.document, "mcpServers");
  const stanza = field(servers, TAB_SERVER_KEY);
  if (stanza === undefined) {
    return warn("mcp-client-config", `\`${path}\` has no \`${TAB_SERVER_KEY}\` server`, "run `tab connect`");
  }
  const secret = assertNoSecret(stanza, `the \`${TAB_SERVER_KEY}\` stanza in ${path}`);
  if (!secret.ok) return bad("mcp-client-config", secret.error.message);
  const command = isRecord(stanza) ? stanza["command"] : undefined;
  return pass("mcp-client-config", `\`${path}\` runs the tab server with \`${String(command)}\` and carries no credential`);
}

/** A promise with a deadline, so one slow endpoint does not hold the whole report. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
