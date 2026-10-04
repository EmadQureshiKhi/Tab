/**
 * The four Tab tools, as functions.
 *
 * The MCP protocol wiring lives next door in `server.ts`. This file is the
 * behaviour, and it is separate so the tools can be exercised without a
 * transport: every test in `test/mcp-tools.test.mjs` calls these directly, which
 * is what lets the suite validate every output against its declared schema
 * without standing a server up.
 *
 * ## Nothing here throws, including into the transport
 *
 * A tool that throws over stdio does not produce a bad answer, it produces no
 * answer: the MCP client sees a protocol error, the model sees nothing it can
 * reason about, and a long-running server can lose its transport to one
 * malformed argument. So every entry point below returns a value that validates
 * against the tool's declared output schema, on every path, including the paths
 * where the work failed. A failure is `error: { category, code, message }` in
 * the payload, and for `tab_call` and `tab_settle` it is `ok: false` beside it.
 *
 * `LIMIT_EXCEEDED` is the case that earns the discipline. An Agent out of
 * headroom is not an error in the Agent, the Service, or the call: it is the
 * credit facility working. The tool answers `ok: false` with
 * `requiredBaseUnits` and `headroomBaseUnits` both filled in, so the model can
 * settle the difference and call again instead of retrying into the same wall.
 *
 * ## Every input is validated against the schema that was published
 *
 * Not a hand-written check that resembles it. {@link applyJsonDefaults} fills in
 * the declared defaults and {@link validateJsonValue} enforces the same document
 * `tools/list` served, so a `limit` of 500 is refused with the same bound the
 * model was shown.
 */

import type { Address, Bytes32, Result, TabError } from "@tabai/shared";
import { isAddress, ok } from "@tabai/shared";
import { JsonRpcProvider, Wallet, decodeBytes32String, encodeBytes32String } from "ethers";

import { fail, notFoundError, tabError, upstreamError, validationError } from "../errors.js";
import { createTab402Client, type Tab402Fetch, type Tab402Response } from "../http/client-402.js";
import { defaultLogger, type Logger } from "../logger.js";
import type { ServiceHeaderRequest, TabServiceEntry } from "../payments/config.js";
import { loadTabConfig } from "../payments/config.js";
import { createMonadStrategy } from "../payments/monad.js";
import { createStrategyRegistry, moduleStrategyRegistry, type StrategyRegistry } from "../payments/registry.js";
import type { AssetRef, PaymentStrategy, SettleRequest } from "../payments/strategy.js";
import { assetFacts, assetStringOf, formatAsset, parseAsset } from "./assets.js";
import { applyJsonDefaults, validateJsonValue } from "./json-schema.js";
import {
  asArray,
  asBoolean,
  asDigits,
  asDigitsOrNull,
  asNumber,
  asRecord,
  asString,
  asStringOrNull,
  field,
  isRecord,
  path as jsonPath,
  secondsToIso,
} from "./json.js";
import { createRegistryReadClient, type RegistryFetch, type RegistryReadClient } from "./registry-client.js";
import { fetchHubManifest, type HubFetch } from "../x402/hub.js";
import {
  TAB_CALL_INPUT,
  TAB_DISCOVER_INPUT,
  TAB_SETTLE_INPUT,
  TAB_STATUS_INPUT,
  tabToolByName,
} from "./schemas.js";
import type { TabMcpSettings } from "./settings.js";

// ---------------------------------------------------------------- output types

/** The error block every output can carry. */
export interface TabToolError {
  readonly category: TabError["category"];
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly requiredBaseUnits?: string;
  readonly headroomBaseUnits?: string;
}

export interface DiscoveredAsset {
  readonly chainId: number;
  readonly address: string;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly collectionAddress: string | null;
  readonly curatedAsset: boolean;
}

export interface DiscoveredTool {
  readonly tool: string;
  readonly toolName: string | null;
  readonly asset: string;
  readonly priceBaseUnits: string;
}

export interface DiscoveredBond {
  readonly asset: string;
  readonly stakedBaseUnits: string;
  readonly freeBaseUnits: string;
}

export interface DiscoveredHubEndpoint {
  readonly endpoint: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly priceType: string;
  readonly priceUsd: string | null;
  readonly priceBaseUnits: string | null;
  readonly networks: readonly string[];
}

/** The API Hub provider a Service fronts, with its endpoints as the Service's tools. */
export interface DiscoveredHub {
  readonly provider: string;
  readonly prefix: string;
  readonly endpoints: readonly DiscoveredHubEndpoint[];
  readonly total: number;
  /** Present when the manifest could not be read; `endpoints` is then empty. */
  readonly error?: TabToolError;
}

export interface DiscoveredService {
  readonly serviceId: string;
  readonly name: string | null;
  readonly endpoint: string | null;
  readonly tier: "curated" | "permissionless" | "unknown";
  readonly settlementWindowSeconds: number;
  readonly assets: readonly DiscoveredAsset[];
  readonly tools: readonly DiscoveredTool[];
  readonly bonds: readonly DiscoveredBond[];
  readonly pendingChange: { readonly changeId: string; readonly kind: string | null; readonly etaIso: string | null } | null;
  readonly hub?: DiscoveredHub;
}

export interface TabDiscoverOutput {
  readonly services: readonly DiscoveredService[];
  readonly error?: TabToolError;
}

/** The prepaid receipt a call carries when x402 paid for it instead of the Open Tab. */
export interface TabCallX402Block {
  readonly txHash: string;
  readonly network: string;
  readonly amountBaseUnits: string;
  readonly asset: string;
  readonly payTo: string;
  readonly payer: string;
  readonly explorerUrl: string | null;
}

export interface TabCallOutput {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly charge?: { readonly amountBaseUnits: string; readonly asset: string; readonly tool: string };
  readonly tab?: {
    readonly openTabBaseUnits: string;
    readonly headroomBaseUnits: string;
    readonly creditLimitBaseUnits?: string;
    readonly asset: string;
    readonly settlementDueIso?: string | null;
  };
  readonly x402?: TabCallX402Block;
  readonly error?: TabToolError;
}

export interface TabStatusOutput {
  readonly agent: string;
  /**
   * The Monad block every figure here is as at, from the index that served them.
   *
   * A Settlement in a later block is not yet reflected; the index reaches it
   * within a few blocks. Null when the index has never ticked or the read failed.
   */
  readonly indexedBlock: number | null;
  readonly perAsset: readonly {
    readonly asset: string;
    readonly creditLimitBaseUnits: string | null;
    readonly openTabBaseUnits: string;
    readonly prepaidBaseUnits: string | null;
    readonly headroomBaseUnits: string | null;
    readonly delinquent: boolean;
    readonly tabs: readonly {
      readonly tabId: string | null;
      readonly serviceId: string;
      readonly openBaseUnits: string;
      readonly dueIso: string | null;
    }[];
  }[];
  readonly settlements?: readonly {
    readonly settlementId: string;
    readonly txHash: string;
    readonly serviceId: string;
    readonly asset: string;
    readonly amountBaseUnits: string;
    readonly appliedBaseUnits: string;
    readonly prepaidBaseUnits: string;
    readonly explorerUrl: string | null;
  }[];
  readonly error?: TabToolError;
}

export interface TabSettleOutput {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly txHash?: string | null;
  readonly chainId?: number | null;
  readonly amountBaseUnits: string;
  /** The strategy that settled, or would settle on a dry run. */
  readonly strategyId?: string | null;
  /**
   * On a dry run, the strategy's own account of what `settle` would do: gas,
   * and for a funded strategy the funding step it would take first. Null once
   * sent.
   */
  readonly note?: string | null;
  readonly settlementId?: string | null;
  readonly appliedBaseUnits?: string | null;
  readonly prepaidBaseUnits?: string | null;
  readonly explorerUrl?: string | null;
  /**
   * Whether the registry had indexed this Settlement when the tool answered. True means
   * `tab_status` now reads the tab as paid; false means the read API is a few blocks
   * behind and the chain, not a second Settlement, is the place to look.
   */
  readonly indexed?: boolean | null;
  readonly error?: TabToolError;
}

// ---------------------------------------------------------------- the toolset

export interface TabToolsetOptions {
  readonly settings: TabMcpSettings;
  /** Overrides the client built from `settings.registryUrl`. A test hands in a stub. */
  readonly registry?: RegistryReadClient;
  /** The `fetch` `tab_call` sends Service requests with. Defaults to the host's. */
  readonly fetchImpl?: Tab402Fetch<Tab402Response>;
  /**
   * The `fetch` the registry read client uses, when one is built from settings.
   *
   * Separate from {@link TabToolsetOptions.fetchImpl} because the two talk to
   * different things: one to a third party's Service, one to the read API. A
   * test that stubs a Service should not silently start answering registry
   * reads too.
   */
  readonly registryFetch?: RegistryFetch;
  /** The `fetch` `tab_discover` reads API Hub manifests with. Defaults to the host's. */
  readonly hubFetch?: HubFetch;
  /**
   * Where `tab_settle` resolves a strategy.
   *
   * Absent, the module-level registry is used, and `tab_settle` fills it from
   * `tab.config` the first time it is called. See {@link TabToolset.settle} for
   * why that load is deferred rather than done at startup.
   */
  readonly strategies?: StrategyRegistry;
  /** Where the deferred `tab.config` load walks from. Defaults to the working directory. */
  readonly cwd?: string;
  readonly logger?: Logger;
  readonly now?: () => number;
  /**
   * How long `tab_settle` waits, after a Settlement lands, for the registry to index it,
   * so a status read straight after it is current. Defaults to 20 seconds; 0 skips the wait.
   */
  readonly settleIndexWaitMs?: number;
  /**
   * The environment the Asset table is read from: on Testnet `MOCK_USDC_ADDRESS`
   * names the token this deployment settles in. Defaults to the process
   * environment; a test passes its own so a machine's configuration cannot
   * change a result.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/** The four tools, plus a dispatcher the MCP server calls by name. */
export interface TabToolset {
  discover(input: unknown): Promise<TabDiscoverOutput>;
  call(input: unknown): Promise<TabCallOutput>;
  status(input: unknown): Promise<TabStatusOutput>;
  settle(input: unknown): Promise<TabSettleOutput>;
  /** Dispatches by MCP tool name. `NOT_FOUND` for a name this package does not declare. */
  invoke(name: string, input: unknown): Promise<Result<unknown>>;
}

const errorOf = (error: TabError): TabToolError => {
  const details = asRecord(error.details);
  const required = asDigitsOrNull(details["requiredBaseUnits"]);
  const headroom = asDigitsOrNull(details["headroomBaseUnits"]);
  return {
    category: error.category,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(required === null ? {} : { requiredBaseUnits: required }),
    ...(headroom === null ? {} : { headroomBaseUnits: headroom }),
  };
};

/** Validates a tool input against the schema that was published for it. */
function readInput<T>(toolName: string, raw: unknown): Result<T> {
  const declaration = tabToolByName(toolName);
  if (declaration === undefined) {
    return notFoundError("TOOL_UNKNOWN", `\`${toolName}\` is not a tool this server declares`, {
      details: { tool: toolName },
    });
  }
  const supplied = raw === undefined || raw === null ? {} : raw;
  return validateJsonValue<T>(
    declaration.inputSchema,
    applyJsonDefaults(declaration.inputSchema, supplied),
    `${toolName} input`,
    "INPUT_INVALID",
  );
}

/** The ascii a 32-byte word decodes to, or null when it is not padded ascii. */
function wordToName(word: string): string | null {
  try {
    const decoded = decodeBytes32String(word);
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** A tool name as its 32-byte key: a hex word passes through, ascii is padded. */
function toolKeyOf(tool: string): Result<Bytes32> {
  if (/^0x[a-fA-F0-9]{64}$/.test(tool)) return ok(tool.toLowerCase() as Bytes32);
  try {
    return ok(encodeBytes32String(tool).toLowerCase() as Bytes32);
  } catch {
    return validationError(
      "TOOL_NAME_TOO_LONG",
      `\`${tool}\` cannot be a tool key: a tool name is stored as 31 bytes of ascii, zero-padded, or given as a 32-byte hex word`,
      { details: { tool } },
    );
  }
}

const ZERO_WORD = `0x${"00".repeat(32)}` as Bytes32;

export function createTabToolset(options: TabToolsetOptions): TabToolset {
  const settings = options.settings;
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => Date.now());
  const env = options.env ?? process.env;
  const chainId = settings.chainId;

  /**
   * The strategy registry, filled from `tab.config` on first use.
   *
   * Deferred, and this is the one piece of laziness in the package that is not
   * an optimisation. Resolving a strategy entry runs consumer code: a factory in
   * a config file typically builds a signer, and a signer is built from a key.
   * Doing that at startup would mean `tab_discover`, `tab_status` and `tab
   * doctor` -- three surfaces whose whole claim is that they need no key --
   * loading one every time the server starts. So the load happens inside
   * `tab_settle`, the only tool that signs, at the moment it needs a strategy.
   *
   * Memoised, so a second Settlement does not re-import the config, and
   * registration is idempotent by strategy id in any case.
   */
  let loading: Promise<StrategyRegistry> | undefined;
  const strategiesFor = (): Promise<StrategyRegistry> => {
    if (options.strategies !== undefined) return Promise.resolve(options.strategies);
    loading ??= (async () => {
      const registry = moduleStrategyRegistry(logger);
      if (registry.list().length > 0) return registry;
      const loaded = await loadTabConfig({
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        registry,
        logger,
      });
      if (!loaded.ok) {
        logger.warn("tab.config could not be loaded, so no payment strategy is registered", {
          code: loaded.error.code,
          message: loaded.error.message,
        });
      }
      /*
        A fresh install with no tab.config and the Agent's key in the environment
        settles through the direct Monad strategy against the hosted deployment's
        TabSettlement, in that network's Assets. The same wiring the repository's
        tab.config does by hand, so tab_settle works out of the box wherever
        tab_call already does. A tab.config that registers anything wins.
      */
      const hosted = settings.hostedSettlement;
      const key = (env["AGENT_PRIVATE_KEY"] ?? "").trim();
      if (registry.list().length === 0 && hosted !== undefined && key !== "") {
        try {
          const provider = new JsonRpcProvider(hosted.rpcUrl, chainId, { staticNetwork: true });
          const signer = new Wallet(key, provider);
          // This toolset's own registry, over the shared one: a default built from one
          // environment's key must never leak into another toolset in the same process.
          const own = createStrategyRegistry({ inherit: registry, logger });
          own.register(createMonadStrategy({ signer, tabSettlement: hosted.tabSettlement, assets: hosted.assets, logger }));
          logger.info("no tab.config strategy, so tab_settle signs with AGENT_PRIVATE_KEY through the direct Monad strategy", {
            tabSettlement: hosted.tabSettlement,
          });
          return own;
        } catch (error) {
          logger.warn("AGENT_PRIVATE_KEY is not a usable key, so no payment strategy is registered", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return registry;
    })();
    return loading;
  };

  const directory = new Map<string, TabServiceEntry>(
    settings.services.map((entry) => [entry.serviceId.toLowerCase(), entry]),
  );

  /** The registry client, or the one failure that stands in for it. */
  const registryOf = (): Result<RegistryReadClient> => {
    if (options.registry !== undefined) return ok(options.registry);
    if (settings.registryUrl === undefined) {
      return upstreamError(
        "REGISTRY_UNCONFIGURED",
        "no Tab registry read API is configured, so on-chain discovery and status cannot be read; set NEXT_PUBLIC_REGISTRY_API_URL, or registryUrl in tab.config",
      );
    }
    return ok(
      createRegistryReadClient({
        baseUrl: settings.registryUrl,
        ...(options.registryFetch === undefined ? {} : { fetchImpl: options.registryFetch }),
        logger,
      }),
    );
  };

  // ------------------------------------------------------------- tab_discover

  const discover = async (raw: unknown): Promise<TabDiscoverOutput> => {
    const input = readInput<{ asset?: string; tier: string; search?: string; limit: number }>("tab_discover", raw);
    if (!input.ok) return { services: [], error: errorOf(input.error) };

    let wanted: AssetRef | undefined;
    if (input.value.asset !== undefined) {
      const parsed = parseAsset(input.value.asset);
      if (!parsed.ok) return { services: [], error: errorOf(parsed.error) };
      wanted = parsed.value;
    }

    const registry = registryOf();
    if (!registry.ok) return { services: [], error: errorOf(registry.error) };

    // A filtered request has to over-fetch: the read API pages by registration
    // order and filters nothing, so asking for `limit` rows would return `limit`
    // rows before the filter and fewer after it.
    const filtered = wanted !== undefined || input.value.search !== undefined || input.value.tier !== "any";
    const body = await registry.value.services(filtered ? 200 : input.value.limit);
    if (!body.ok) return { services: [], error: errorOf(body.error) };

    const services = await Promise.all(
      asArray(field(body.value, "services"))
        .map((entry) => toDiscoveredService(entry, directory, chainId, env))
        .filter((service) => matches(service, input.value.tier, input.value.search, wanted))
        .slice(0, input.value.limit)
        .map((service) => withHub(service, directory.get(service.serviceId), options.hubFetch)),
    );

    return { services };
  };

  // ---------------------------------------------------------------- tab_call

  const call = async (raw: unknown): Promise<TabCallOutput> => {
    const input = readInput<{
      serviceId: string;
      tool: string;
      asset?: string;
      arguments?: Record<string, unknown>;
      timeoutMs: number;
    }>("tab_call", raw);
    if (!input.ok) return { ok: false, error: errorOf(input.error) };

    if (settings.agent === undefined) return { ok: false, error: errorOf(agentUnconfigured()) };

    const serviceId = input.value.serviceId.toLowerCase();
    const entry = directory.get(serviceId);
    if (entry === undefined) {
      return {
        ok: false,
        error: errorOf(
          tabError(
            "NOT_FOUND",
            "SERVICE_ENDPOINT_UNKNOWN",
            `no endpoint is configured for Service ${serviceId}; the chain records no URL, so add it to the \`services\` list in tab.config`,
            { details: { serviceId, configured: [...directory.keys()].join(", ") } },
          ),
        ),
      };
    }

    const toolKey = toolKeyOf(input.value.tool);
    if (!toolKey.ok) return { ok: false, error: errorOf(toolKey.error) };

    const client = createTab402Client({
      baseUrl: entry.endpoint,
      agent: settings.agent,
      // The credit decision is the Service's, and this tool reports it rather than
      // arguing with it. A repeat would meter the same call twice on the path where
      // the first attempt was declined, so the repeat is off.
      maxRetries: 0,
      logger,
      now,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(settings.strategyId === undefined ? {} : { strategyId: settings.strategyId }),
      // The prepaid fallback, only when tab.config declared a signer factory. The
      // factory is called at the moment a refusal carries an x402 offer and not
      // before, which is what keeps this tool keyless on every other path.
      ...(settings.x402 === undefined ? {} : { x402: { signer: settings.x402, chainId: BigInt(chainId) } }),
    });

    // A Service meters its tools under `/meter/<tool>` off its published
    // endpoint, the shape Tab's gateway serves and the Dashboard calls,
    // so the endpoint in the directory is the Service's root and `/hub/<prefix>`
    // sits beside the tools rather than under them.
    const url = `${entry.endpoint.replace(/\/+$/, "")}/meter/${encodeURIComponent(input.value.tool)}`;

    const supplied = await serviceHeaders(entry, {
      method: "POST",
      url,
      tool: input.value.tool,
      agent: settings.agent,
      serviceId,
    });
    if (!supplied.ok) return { ok: false, error: errorOf(supplied.error) };

    const response = await client.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...supplied.value },
      body: JSON.stringify(input.value.arguments ?? {}),
      signal: timeoutSignal(input.value.timeoutMs),
    });

    const charges = client.charges();
    const charge = charges.at(-1);
    const payment = client.payments().at(-1);
    const x402Block: TabCallX402Block | undefined =
      payment === undefined
        ? undefined
        : {
            txHash: payment.txHash,
            network: payment.network,
            amountBaseUnits: payment.amount.toString(10),
            asset: formatAsset(Number(payment.chainId), payment.asset),
            payTo: payment.payTo,
            payer: payment.payer,
            explorerUrl: explorerTx(settings.explorerUrl, payment.txHash),
          };
    const chargeBlock =
      charge === undefined
        ? undefined
        : {
            amountBaseUnits: charge.amount.toString(10),
            asset: formatAsset(charge.asset.chainId, charge.asset.address),
            tool: charge.tool,
          };
    const tabBlock =
      charge === undefined
        ? undefined
        : {
            openTabBaseUnits: charge.openTab.toString(10),
            headroomBaseUnits: charge.headroom.toString(10),
            asset: formatAsset(charge.asset.chainId, charge.asset.address),
            settlementDueIso: null,
          };

    if (!response.ok) {
      // A 402 that still stands is the headroom case, and it is the one failure
      // this tool restates rather than passes through: the model needs both
      // figures side by side to decide whether to settle. A standing 402 that
      // an x402 signer tried and failed to pay keeps the payment error instead,
      // because "the facilitator refused the signature" is the actionable fact.
      if (charge !== undefined && charge.outcome === "declined" && response.error.code === "LIMIT_EXCEEDED") {
        return {
          ok: false,
          ...(chargeBlock === undefined ? {} : { charge: chargeBlock }),
          ...(tabBlock === undefined ? {} : { tab: tabBlock }),
          error: {
            // `LIMIT` and not `CONFLICT`: the category maps to HTTP 402 everywhere
            // else in Tab, which is exactly what the Service answered.
            category: "LIMIT",
            code: "LIMIT_EXCEEDED",
            message: `this call needs ${charge.amount.toString(10)} base units and the Agent has ${charge.headroom.toString(10)} of headroom for the Asset; settle with tab_settle and call again`,
            retryable: false,
            requiredBaseUnits: charge.amount.toString(10),
            headroomBaseUnits: charge.headroom.toString(10),
          },
        };
      }
      return {
        ok: false,
        ...(chargeBlock === undefined ? {} : { charge: chargeBlock }),
        ...(tabBlock === undefined ? {} : { tab: tabBlock }),
        error: errorOf(response.error),
      };
    }

    const status = response.value.status;
    const body = await readBody(response.value);
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        ...(chargeBlock === undefined ? {} : { charge: chargeBlock }),
        ...(tabBlock === undefined ? {} : { tab: tabBlock }),
        ...(x402Block === undefined ? {} : { x402: x402Block }),
        error: serviceRefusal(status, body, input.value.tool),
      };
    }

    const result = body;
    return {
      ok: true,
      result,
      // A prepaid call carries the credit refusal it was answered with, so the
      // model sees both what the tab could not cover and what paid for it.
      ...(chargeBlock === undefined ? {} : { charge: chargeBlock }),
      ...(tabBlock === undefined ? {} : { tab: tabBlock }),
      ...(x402Block === undefined ? {} : { x402: x402Block }),
    };
  };

  // -------------------------------------------------------------- tab_status

  const status = async (raw: unknown): Promise<TabStatusOutput> => {
    const input = readInput<{ agent?: string; asset?: string; historyLimit: number }>("tab_status", raw);
    const agent = (input.ok ? input.value.agent : undefined) ?? settings.agent;
    const subject = agent ?? "0x0000000000000000000000000000000000000000";

    if (!input.ok) return { agent: subject, indexedBlock: null, perAsset: [], error: errorOf(input.error) };
    if (agent === undefined) {
      return { agent: subject, indexedBlock: null, perAsset: [], error: errorOf(agentUnconfigured()) };
    }

    let assetFilter: string | undefined;
    if (input.value.asset !== undefined) {
      const parsed = parseAsset(input.value.asset);
      if (!parsed.ok) return { agent: agent.toLowerCase(), indexedBlock: null, perAsset: [], error: errorOf(parsed.error) };
      assetFilter = parsed.value.address.toLowerCase();
    }

    const registry = registryOf();
    if (!registry.ok) return { agent: agent.toLowerCase(), indexedBlock: null, perAsset: [], error: errorOf(registry.error) };

    const body = await registry.value.agent(agent);
    if (!body.ok) return { agent: agent.toLowerCase(), indexedBlock: null, perAsset: [], error: errorOf(body.error) };

    // The block the index had read to when it answered. Stated, because a
    // Settlement the Agent sent a moment ago sits in a later block and an
    // answer that looked current while omitting it would be the misleading kind.
    const horizon = jsonPath(body.value, "index", "lastBlock");
    const indexedBlock = typeof horizon === "number" && Number.isInteger(horizon) && horizon >= 0 ? horizon : null;

    const perAsset = asArray(field(body.value, "assets"))
      .map((entry) => toPerAsset(entry, input.value.historyLimit, chainId))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .filter((entry) => assetFilter === undefined || entry.assetAddress === assetFilter)
      .map(({ assetAddress: _assetAddress, ...rest }) => rest);
    let settlements: TabStatusOutput["settlements"] = [];
    if (input.value.historyLimit > 0) {
      const settled = await registry.value.settlements({
        agent,
        ...(assetFilter === undefined ? {} : { asset: assetFilter }),
        limit: input.value.historyLimit,
      });
      if (settled.ok) {
        settlements = asArray(field(settled.value, "settlements")).map((row) =>
          toSettlementRow(row, settings.explorerUrl, chainId),
        );
      } else {
        logger.warn("the settlement feed could not be read; status reports credit without history", {
          code: settled.error.code,
        });
      }
    }
    return { agent: agent.toLowerCase(), indexedBlock, perAsset, settlements };
  };

  // -------------------------------------------------------------- tab_settle

  const settle = async (raw: unknown): Promise<TabSettleOutput> => {
    const input = readInput<{
      serviceId: string;
      asset: string;
      amountBaseUnits: string;
      strategyId?: string;
      dryRun: boolean;
    }>("tab_settle", raw);
    if (!input.ok) return { ok: false, dryRun: false, amountBaseUnits: "0", error: errorOf(input.error) };
    const dryRun = input.value.dryRun;
    const amountBaseUnits = input.value.amountBaseUnits;
    const failure = (error: TabError): TabSettleOutput => ({
      ok: false,
      dryRun,
      amountBaseUnits,
      error: errorOf(error),
    });
    if (settings.agent === undefined) return failure(agentUnconfigured());
    const asset = parseAsset(input.value.asset, "asset", env);
    if (!asset.ok) return failure(asset.error);
    const amount = BigInt(amountBaseUnits);
    if (amount === 0n) {
      return failure(
        tabError("VALIDATION", "AMOUNT_ZERO", "a Settlement of zero base units moves nothing and proves nothing"),
      );
    }
    // The strategy is resolved before the Service is read, because it is a local
    // lookup and the Service is a network read: an Agent with no strategy for the
    // Asset should be told that, not made to wait for a read it could not use.
    const strategy = resolveStrategy(
      await strategiesFor(),
      input.value.strategyId ?? settings.strategyId,
      asset.value,
    );
    if (!strategy.ok) return failure(strategy.error);
    const serviceId = input.value.serviceId.toLowerCase();
    const accepted = await serviceAcceptsAsset(registryOf(), serviceId, asset.value);
    if (!accepted.ok) return failure(accepted.error);
    const request: SettleRequest = {
      agent: settings.agent,
      serviceId: serviceId as Bytes32,
      asset: asset.value,
      amount,
    };
    if (dryRun) {
      const quote = await strategy.value.quote(request);
      if (!quote.ok) return failure(quote.error);
      return {
        ok: true,
        dryRun: true,
        txHash: null,
        chainId: Number(asset.value.chainId),
        amountBaseUnits,
        strategyId: strategy.value.id,
        note: quote.value.feeNote,
        settlementId: null,
        appliedBaseUnits: null,
        prepaidBaseUnits: null,
        explorerUrl: null,
      };
    }
    const receipt = await strategy.value.settle(request);
    if (!receipt.ok) return failure(receipt.error);
    const indexed = await settlementIndexed(request.agent, receipt.value.txHash);
    return {
      ok: true,
      dryRun: false,
      txHash: receipt.value.txHash,
      chainId: Number(receipt.value.chainId),
      amountBaseUnits: receipt.value.amount.toString(10),
      strategyId: receipt.value.strategyId,
      note: null,
      settlementId: receipt.value.settlementId,
      appliedBaseUnits: receipt.value.applied === null ? null : receipt.value.applied.toString(10),
      prepaidBaseUnits: receipt.value.toPrepaid === null ? null : receipt.value.toPrepaid.toString(10),
      explorerUrl: explorerTx(settings.explorerUrl, receipt.value.txHash),
      indexed,
    };
  };

  /**
   * Waits, briefly, until the registry lists a Settlement's transaction. An Agent that
   * settles and then reads its status would otherwise see the tab as it was a few blocks
   * earlier, still owing, and could pay the same bill twice. Null when there is no
   * registry to ask.
   */
  const settlementIndexed = async (agent: string, txHash: string): Promise<boolean | null> => {
    const registry = registryOf();
    if (!registry.ok) return null;
    const budget = options.settleIndexWaitMs ?? 20_000;
    const deadline = Date.now() + budget;
    const wanted = txHash.toLowerCase();
    for (;;) {
      const listed = await registry.value.settlements({ agent: agent.toLowerCase(), limit: 5 });
      if (listed.ok && asArray(field(listed.value, "settlements")).some((row) => asString(jsonPath(row, "monad", "txHash"), "").toLowerCase() === wanted)) {
        return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  };

  // -------------------------------------------------------------- dispatch

  const invoke = async (name: string, input: unknown): Promise<Result<unknown>> => {
    switch (name) {
      case "tab_discover":
        return ok(await discover(input));
      case "tab_call":
        return ok(await call(input));
      case "tab_status":
        return ok(await status(input));
      case "tab_settle":
        return ok(await settle(input));
      default:
        return notFoundError("TOOL_UNKNOWN", `\`${name}\` is not a tool this server declares`, {
          details: { tool: name },
        });
    }
  };

  return { discover, call, status, settle, invoke };
}

// ---------------------------------------------------------------- mapping

/**
 * The one setting no tool that touches a tab can proceed without.
 *
 * An Agent address, never a key. Deriving the address from a signing key would
 * mean this process holds one, and the whole point of the split is that
 * discovery, calling and status hold none.
 */
const agentUnconfigured = (): TabError =>
  tabError(
    "VALIDATION",
    "AGENT_UNCONFIGURED",
    "no Agent address is configured, so there is no Open Tab to meter against; set `agent` in tab.config, or pass it to this tool where the schema allows it",
  );

/**
 * Names an Asset the index reports as a bare address.
 *
 * `TabBook` keys an Asset by token address alone, one ledger per address and no
 * chain column, while everything that crosses the MCP boundary is
 * `chainId:address`, because the SDK may be pointed at Mainnet or Testnet and a
 * bare address is ambiguous between the two. The chain id is the one the
 * settings resolved, which is the one the registry this toolset reads indexes.
 */
const assetStringFor = (address: string, chainId: number): string => formatAsset(chainId, address.toLowerCase());

/** A transaction link on the configured explorer, or null for anything that is not a hash. */
const explorerTx = (explorerUrl: string, txHash: string): string | null =>
  /^0x[a-fA-F0-9]{64}$/.test(txHash) ? `${explorerUrl.replace(/\/+$/, "")}/tx/${txHash}` : null;

function toDiscoveredService(
  entry: unknown,
  directory: Map<string, TabServiceEntry>,
  chainId: number,
  env: NodeJS.ProcessEnv,
): DiscoveredService {
  const serviceId = asString(field(entry, "serviceId"), "").toLowerCase();
  const configured = directory.get(serviceId);

  const assets: DiscoveredAsset[] = [];
  for (const accepted of asArray(field(entry, "acceptedAssets"))) {
    const address = asString(field(accepted, "asset"), "").toLowerCase();
    if (!isAddress(address)) continue;
    const collection = asStringOrNull(field(accepted, "collection"));
    const facts = assetFacts(chainId, address, env);
    assets.push({
      chainId,
      address,
      symbol: facts.symbol,
      decimals: facts.decimals,
      collectionAddress: collection === null ? null : collection.toLowerCase(),
      curatedAsset: facts.curatedAsset,
    });
  }

  const nameAsset = (address: string): string => formatAsset(chainId, address);

  const tools: DiscoveredTool[] = asArray(field(entry, "prices")).map((price) => {
    const tool = asString(field(price, "tool"), ZERO_WORD).toLowerCase();
    return {
      tool,
      toolName: wordToName(tool),
      asset: nameAsset(asString(field(price, "asset"), "")),
      priceBaseUnits: asDigits(field(price, "baseUnits"), "0"),
    };
  });

  const bonds: DiscoveredBond[] = asArray(field(entry, "bond")).map((bond) => ({
    asset: nameAsset(asString(field(bond, "asset"), "")),
    stakedBaseUnits: asDigits(field(bond, "staked"), "0"),
    freeBaseUnits: asDigits(field(bond, "free"), "0"),
  }));

  const pending = asArray(field(entry, "pendingChanges"))[0];
  const pendingChange =
    pending === undefined
      ? null
      : {
          changeId: asString(field(pending, "changeId"), ZERO_WORD).toLowerCase(),
          kind: asStringOrNull(field(pending, "kindName")),
          etaIso: asStringOrNull(field(pending, "etaIso")),
        };

  const tierName = asString(jsonPath(entry, "tier", "name"), "").toLowerCase();

  return {
    serviceId,
    name: configured?.name ?? wordToName(serviceId),
    endpoint: configured?.endpoint ?? null,
    tier: tierName === "curated" ? "curated" : tierName === "permissionless" ? "permissionless" : "unknown",
    settlementWindowSeconds: asNumber(jsonPath(entry, "settlementWindowSeconds", "value"), 0),
    assets,
    tools,
    bonds,
    pendingChange,
  };
}

/**
 * Attaches the fronted API Hub provider's endpoints to a discovered Service.
 *
 * A manifest that cannot be read is reported inside the `hub` block rather than
 * failing discovery: the Service is still real and its on-chain tools are still
 * listed, and the Hub's catalogue is an addition the chain does not carry.
 */
async function withHub(
  service: DiscoveredService,
  configured: TabServiceEntry | undefined,
  hubFetch: HubFetch | undefined,
): Promise<DiscoveredService> {
  const hub = configured?.hub;
  if (hub === undefined) return service;
  const prefix = (hub.prefix ?? hub.provider).replace(/^\/+|\/+$/g, "");
  const manifest = await fetchHubManifest({
    provider: hub.provider,
    ...(hub.manifestUrl === undefined ? {} : { manifestUrl: hub.manifestUrl }),
    ...(hubFetch === undefined ? {} : { fetchImpl: hubFetch }),
  });
  if (!manifest.ok) {
    return { ...service, hub: { provider: hub.provider, prefix, endpoints: [], total: 0, error: errorOf(manifest.error) } };
  }
  return {
    ...service,
    hub: {
      provider: manifest.value.provider,
      prefix,
      endpoints: manifest.value.endpoints.map((endpoint) => ({
        endpoint: endpoint.endpoint,
        name: endpoint.name,
        description: endpoint.description,
        priceType: endpoint.priceType,
        priceUsd: endpoint.priceUsd,
        priceBaseUnits: endpoint.priceBaseUnits,
        networks: endpoint.networks,
      })),
      total: manifest.value.total,
    },
  };
}

function matches(
  service: DiscoveredService,
  tier: string,
  search: string | undefined,
  asset: AssetRef | undefined,
): boolean {
  if (tier !== "any" && service.tier !== tier) return false;
  if (asset !== undefined) {
    const wanted = assetStringOf(asset);
    if (!service.assets.some((entry) => formatAsset(entry.chainId, entry.address) === wanted)) return false;
  }
  if (search !== undefined) {
    const needle = search.toLowerCase();
    const haystack = `${service.serviceId} ${service.name ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function toPerAsset(
  entry: unknown,
  historyLimit: number,
  chainId: number,
): (TabStatusOutput["perAsset"][number] & { readonly assetAddress: string }) | null {
  const address = asString(field(entry, "asset"), "").toLowerCase();
  if (!isAddress(address)) return null;

  const openTab =
    asDigitsOrNull(jsonPath(entry, "headroom", "openTab")) ?? asDigits(jsonPath(entry, "openTab", "observed"), "0");

  const tabs = asArray(jsonPath(entry, "openTab", "tabs"))
    .slice(0, historyLimit)
    .map((tab) => {
      // An older registry keys a tab observation by Agent, Service and Asset
      // without the `TabBook` tabId, so the identity may be absent. Reporting
      // the zero word here would name a tab that does not exist.
      const tabId = asStringOrNull(field(tab, "tabId"));
      // `live` is TabBook.tabOf at the index horizon. Without it, the last
      // observation is all there is, and it is a lower bound.
      return {
        tabId: tabId !== null && /^0x[a-fA-F0-9]{64}$/.test(tabId) ? tabId.toLowerCase() : null,
        serviceId: asString(field(tab, "serviceId"), ZERO_WORD).toLowerCase(),
        openBaseUnits: asDigitsOrNull(jsonPath(tab, "live", "open")) ?? asDigits(field(tab, "openAfter"), "0"),
        dueIso: null,
      };
    });

  return {
    assetAddress: address,
    asset: assetStringFor(address, chainId),
    creditLimitBaseUnits: asDigitsOrNull(jsonPath(entry, "creditLimit", "value")),
    openTabBaseUnits: openTab,
    prepaidBaseUnits: asDigitsOrNull(jsonPath(entry, "settlements", "prepaidTotal")),
    headroomBaseUnits: asDigitsOrNull(jsonPath(entry, "headroom", "value")),
    delinquent: asBoolean(jsonPath(entry, "delinquency", "delinquent"), false),
    tabs,
  };
}

function toSettlementRow(
  row: unknown,
  explorerUrl: string,
  chainId: number,
): NonNullable<TabStatusOutput["settlements"]>[number] {
  const txHash = asString(jsonPath(row, "monad", "txHash"), "");
  return {
    settlementId: asString(field(row, "settlementId"), ZERO_WORD).toLowerCase(),
    txHash: txHash.toLowerCase(),
    serviceId: asString(field(row, "serviceId"), ZERO_WORD).toLowerCase(),
    asset: formatAsset(chainId, asString(field(row, "asset"), "")),
    amountBaseUnits: asDigits(field(row, "amount"), "0"),
    appliedBaseUnits: asDigits(field(row, "applied"), "0"),
    prepaidBaseUnits: asDigits(field(row, "toPrepaid"), "0"),
    explorerUrl: explorerTx(explorerUrl, txHash),
  };
}

const SERVICE_CATEGORIES: readonly TabError["category"][] = [
  "VALIDATION",
  "AUTHORISATION",
  "NOT_FOUND",
  "LIMIT",
  "CHAIN",
  "UPSTREAM",
  "CONFLICT",
  "UNAVAILABLE",
  "INTERNAL",
];

/**
 * What a Service's refusal means, in this package's vocabulary.
 *
 * A Service that speaks Tab answers `{ error: { category, code, message } }` in
 * the same vocabulary, and that is passed through unchanged: a model told
 * `METERING_SIGNATURE_ABSENT` can act on it, where a flattened
 * "the Service answered 403" leaves it guessing. A Service that answers
 * something else has its status mapped, which is the most that can be said about
 * a body this package cannot read.
 */
function serviceRefusal(status: number, body: unknown, tool: string): TabToolError {
  const declared = field(body, "error");
  if (isRecord(declared)) {
    const category = asString(declared["category"], "");
    if ((SERVICE_CATEGORIES as readonly string[]).includes(category)) {
      return {
        category: category as TabError["category"],
        code: asString(declared["code"], "SERVICE_REFUSED"),
        message: asString(declared["message"], `the Service answered ${status} for ${tool}`),
        retryable: asBoolean(declared["retryable"], status >= 500),
      };
    }
  }
  const category: TabError["category"] =
    status === 401 || status === 403
      ? "AUTHORISATION"
      : status === 402
        ? "LIMIT"
        : status === 404
          ? "NOT_FOUND"
          : status === 409
            ? "CONFLICT"
            : status === 408 || status === 429 || status === 503 || status === 504
              ? "UNAVAILABLE"
              : status >= 500
                ? "UPSTREAM"
                : "VALIDATION";
  return {
    category,
    code: "SERVICE_REFUSED",
    message: `the Service answered ${status} for ${tool}`,
    retryable: status >= 500 || status === 408 || status === 429,
  };
}

/**
 * The headers one Service requires for one call.
 *
 * A provider is consumer code, so it is called inside a `catch`: a config file
 * that throws becomes a failed tool call carrying the reason, not an unhandled
 * rejection that takes the transport with it.
 */
async function serviceHeaders(
  entry: TabServiceEntry,
  request: ServiceHeaderRequest,
): Promise<Result<Readonly<Record<string, string>>>> {
  const declared = entry.headers;
  if (declared === undefined) return ok({});
  if (typeof declared !== "function") return ok(declared);
  try {
    return ok(await declared(request));
  } catch (error) {
    return fail(
      "UPSTREAM",
      "SERVICE_HEADERS_FAILED",
      `the header provider configured for Service ${request.serviceId} failed, so the call was not sent`,
      {
        details: { serviceId: request.serviceId },
        cause: { code: "PROVIDER_THREW", message: error instanceof Error ? error.message : String(error) },
      },
    );
  }
}

/** Reads the body of whatever the Service answered, without assuming a `Response`. */
async function readBody(response: Tab402Response): Promise<unknown> {
  const candidate = response as { json?: unknown; text?: unknown; body?: unknown };
  if (typeof candidate.json === "function") {
    try {
      return await (candidate.json as () => Promise<unknown>)();
    } catch {
      // fall through to text
    }
  }
  if (typeof candidate.text === "function") {
    try {
      return await (candidate.text as () => Promise<string>)();
    } catch {
      return null;
    }
  }
  return candidate.body ?? null;
}

/** An abort signal for one call, described structurally because there are no DOM types here. */
function timeoutSignal(ms: number): unknown {
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal;
  return typeof ctor?.timeout === "function" ? ctor.timeout(ms) : undefined;
}

/**
 * Checks that the Service accepts the Asset before a transaction is built.
 *
 * `TabSettlement` would refuse it anyway, but a revert costs the Agent gas and
 * says less than this does. The registry read is keyless and one request.
 */
async function serviceAcceptsAsset(
  registry: Result<RegistryReadClient>,
  serviceId: string,
  asset: AssetRef,
): Promise<Result<void>> {
  if (!registry.ok) return registry;
  const body = await registry.value.service(serviceId);
  if (!body.ok) return body;
  const wanted = asset.address.toLowerCase();
  for (const accepted of asArray(jsonPath(body.value, "service", "acceptedAssets"))) {
    if (asString(field(accepted, "asset"), "").toLowerCase() === wanted) return ok(undefined);
  }
  return notFoundError(
    "ASSET_NOT_ACCEPTED",
    `Service ${serviceId} does not accept ${assetStringOf(asset)}, so a Settlement in it would be refused`,
    { details: { serviceId, asset: assetStringOf(asset) } },
  );
}

function resolveStrategy(
  registry: StrategyRegistry,
  strategyId: string | undefined,
  asset: AssetRef,
): Result<PaymentStrategy> {
  const resolved: Result<PaymentStrategy> = registry.resolve({
    ...(strategyId === undefined ? {} : { strategyId }),
    asset,
  });
  if (resolved.ok) return resolved;
  const cause = resolved.error;
  return fail(
    cause.category,
    cause.code,
    `${cause.message}; tab_settle signs with the Agent's own key through a payment strategy, so one must be registered for ${assetStringOf(asset)} before a Settlement can be built`,
    { details: { asset: assetStringOf(asset), ...(strategyId === undefined ? {} : { strategyId }) } },
  );
}

