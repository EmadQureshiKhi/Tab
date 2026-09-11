/**
 * x402 configuration for the gateway: the prepaid fallback on a `402`, and the
 * API Hub upstreams the gateway fronts on credit.
 *
 * ## Two things x402 does here, and what it never does
 *
 * A `LimitExceeded` refusal carries, beside its `Tab-Charge-*` block, an x402
 * `PAYMENT-REQUIRED` naming the same charge as an `exact` requirement paid to
 * the Service's Collection address. An Agent that would rather pay for the one
 * call than settle its tab signs it and sends the request again with
 * `PAYMENT-SIGNATURE`; the gateway verifies through the facilitator, delivers,
 * settles, and meters nothing, because nothing is owed. That is the whole of
 * the first thing.
 *
 * The second is the reverse: `/hub/<prefix>/*` fronts an x402 upstream. The
 * gateway pays the upstream with the operator's key and meters the Agent's
 * Open Tab for the upstream's price plus a margin. The Agent buys on credit
 * from a pay-per-request API.
 *
 * What x402 never does here is replace credit. A request without a signature
 * is served on the Open Tab as before, and the `402` is still issued on
 * `LimitExceeded` alone.
 *
 * ## Every environment read is spelled out
 *
 * `scripts/env-check.mjs` recognises a direct member read off the process
 * environment and nothing else, so each name is read on its own line and each
 * is declared in the tracked `.env.example`.
 */

import { Interface } from "ethers";
import { causeOf, err, ok, type Address, type Result } from "@tabai/shared";
import { MONAD_FACILITATOR_URL } from "@tabai/sdk";

/** The environment names this module reads. */
export interface GatewayX402Env {
  readonly X402_ENABLED?: string | undefined;
  readonly X402_FACILITATOR_URL?: string | undefined;
  readonly GATEWAY_COLLECTION_ADDRESS?: string | undefined;
  readonly GATEWAY_HUB_UPSTREAMS?: string | undefined;
  readonly GATEWAY_X402_PRIVATE_KEY?: string | undefined;
}

/** The process environment, restricted to what this module reads, one name per line. */
export function processX402Env(): GatewayX402Env {
  return {
    X402_ENABLED: process.env.X402_ENABLED,
    X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL,
    GATEWAY_COLLECTION_ADDRESS: process.env.GATEWAY_COLLECTION_ADDRESS,
    GATEWAY_HUB_UPSTREAMS: process.env.GATEWAY_HUB_UPSTREAMS,
    GATEWAY_X402_PRIVATE_KEY: process.env.GATEWAY_X402_PRIVATE_KEY,
  };
}

export interface GatewayX402Config {
  /** Defaults to true. `false` serves `402`s without an offer and refuses `PAYMENT-SIGNATURE`. */
  readonly enabled: boolean;
  readonly facilitatorUrl: string;
  /** Where a prepaid call's funds go when the registry cannot say. Absent when unset. */
  readonly collectionFallback: Address | undefined;
  readonly hubUpstreams: readonly GatewayHubUpstreamConfig[];
  /** A separate key for paying upstreams, when the operator prefers one. The operator key otherwise. */
  readonly x402Key: string | undefined;
}

/** One fronted upstream, as `GATEWAY_HUB_UPSTREAMS` declares it. */
export interface GatewayHubUpstreamConfig {
  /** The mount: `/hub/<prefix>/*`. */
  readonly prefix: string;
  /** The upstream base URL the rest of the path is appended to. */
  readonly url: string;
  /** The tool name the fronted calls are metered under, as it appears in the applied price list. */
  readonly tool: string;
  /** Margin on the upstream price, in basis points. Defaults to 0. */
  readonly marginBps: bigint;
  /** Flat margin per call, in Asset base units. Defaults to 0. */
  readonly marginBaseUnits: bigint;
  /** Refuse an upstream price above this many base units. Absent sets no ceiling. */
  readonly maxUpstreamBaseUnits: bigint | undefined;
  /**
   * What one unit of the fronted tool costs in the applied price list.
   *
   * A fronted call's price varies per request and `recordDelivery` refuses a
   * unit price the registry does not hold, so the amount rides in the unit
   * count and this is the price that must match. Defaults to one base unit,
   * which makes the charge exact.
   */
  readonly unitBaseUnits: bigint;
  /**
   * The chain and Asset the upstream is paid on, where that is not the
   * Service's own. The API Hub takes Mainnet USDC only, so a Testnet Service
   * fronting it pays there and meters here; the paying key is the same
   * GATEWAY_X402_PRIVATE_KEY, holding funds on that chain.
   */
  readonly payOn: { readonly chainId: bigint; readonly asset: Address } | undefined;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;

const invalid = (name: string, why: string): Result<never> =>
  err({
    category: "VALIDATION",
    code: "GATEWAY_CONFIG_INVALID",
    message: `${name} ${why}`,
    retryable: false,
    details: { variable: name },
  });

/** Loads the x402 configuration, or names the first variable that is wrong. */
export function loadX402Config(env: GatewayX402Env = processX402Env()): Result<GatewayX402Config> {
  const enabledRaw = env.X402_ENABLED?.trim().toLowerCase();
  if (enabledRaw !== undefined && enabledRaw.length > 0 && enabledRaw !== "true" && enabledRaw !== "false") {
    return invalid("X402_ENABLED", "must be `true` or `false`");
  }
  const enabled = enabledRaw !== "false";

  const facilitatorRaw = env.X402_FACILITATOR_URL?.trim();
  const facilitatorUrl = facilitatorRaw === undefined || facilitatorRaw.length === 0 ? MONAD_FACILITATOR_URL : facilitatorRaw;
  try {
    const parsed = new URL(facilitatorUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalid("X402_FACILITATOR_URL", "must be an http or https URL");
  } catch {
    return invalid("X402_FACILITATOR_URL", "must be an absolute URL");
  }

  const collectionRaw = env.GATEWAY_COLLECTION_ADDRESS?.trim();
  let collectionFallback: Address | undefined;
  if (collectionRaw !== undefined && collectionRaw.length > 0) {
    if (!ADDRESS.test(collectionRaw)) return invalid("GATEWAY_COLLECTION_ADDRESS", "must be a 20-byte 0x address");
    if (/^0x0{40}$/.test(collectionRaw)) return invalid("GATEWAY_COLLECTION_ADDRESS", "is the zero address, which nobody can be paid at");
    collectionFallback = collectionRaw.toLowerCase() as Address;
  }

  const hubUpstreams = parseHubUpstreams(env.GATEWAY_HUB_UPSTREAMS);
  if (!hubUpstreams.ok) return hubUpstreams;

  const keyRaw = env.GATEWAY_X402_PRIVATE_KEY?.trim();
  const x402Key = keyRaw === undefined || keyRaw.length === 0 || !KEY.test(keyRaw) ? undefined : keyRaw;

  return ok({ enabled, facilitatorUrl: facilitatorUrl.replace(/\/+$/, ""), collectionFallback, hubUpstreams: hubUpstreams.value, x402Key });
}

/**
 * `GATEWAY_HUB_UPSTREAMS`: a JSON array of `{ prefix, url, tool, marginBps?,
 * marginBaseUnits?, maxUpstreamBaseUnits?, unitBaseUnits?, payOn? }`, where `payOn` is
 * `{ chainId, asset }` for an upstream paid on another chain. Empty or unset
 * means no hub routes.
 */
export function parseHubUpstreams(raw: string | undefined): Result<readonly GatewayHubUpstreamConfig[]> {
  const text = raw?.trim();
  if (text === undefined || text.length === 0) return ok([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return err({
      category: "VALIDATION",
      code: "GATEWAY_CONFIG_INVALID",
      message: "GATEWAY_HUB_UPSTREAMS is not JSON",
      retryable: false,
      details: { variable: "GATEWAY_HUB_UPSTREAMS" },
      cause: causeOf(error),
    });
  }
  if (!Array.isArray(parsed)) return invalid("GATEWAY_HUB_UPSTREAMS", "must be a JSON array of upstreams");

  const upstreams: GatewayHubUpstreamConfig[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const label = `GATEWAY_HUB_UPSTREAMS[${index}]`;
    if (typeof entry !== "object" || entry === null) return invalid(label, "must be an object");
    const record = entry as Record<string, unknown>;

    const prefix = typeof record["prefix"] === "string" ? record["prefix"].trim().replace(/^\/+|\/+$/g, "") : "";
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(prefix)) return invalid(`${label}.prefix`, "must be a path segment such as `nansen`");
    if (seen.has(prefix.toLowerCase())) return invalid(`${label}.prefix`, `repeats \`${prefix}\``);
    seen.add(prefix.toLowerCase());

    const url = typeof record["url"] === "string" ? record["url"].trim() : "";
    try {
      const target = new URL(url);
      if (target.protocol !== "http:" && target.protocol !== "https:") return invalid(`${label}.url`, "must be an http or https URL");
    } catch {
      return invalid(`${label}.url`, "must be an absolute URL");
    }

    const tool = typeof record["tool"] === "string" ? record["tool"].trim() : "";
    if (tool.length === 0 || tool.length > 31) return invalid(`${label}.tool`, "must be a tool name of at most 31 characters");

    const marginBps = integerField(record["marginBps"], `${label}.marginBps`, 0n);
    if (!marginBps.ok) return marginBps;
    const marginBaseUnits = integerField(record["marginBaseUnits"], `${label}.marginBaseUnits`, 0n);
    if (!marginBaseUnits.ok) return marginBaseUnits;
    const ceiling = record["maxUpstreamBaseUnits"] === undefined ? ok(undefined) : integerField(record["maxUpstreamBaseUnits"], `${label}.maxUpstreamBaseUnits`, 0n);
    if (!ceiling.ok) return ceiling;

    const unit = record["unitBaseUnits"] === undefined ? ok(1n) : integerField(record["unitBaseUnits"], `${label}.unitBaseUnits`, 1n);
    if (!unit.ok) return unit;
    if (unit.value === 0n) return invalid(`${label}.unitBaseUnits`, "must be a positive count of base units");

    let payOn: { chainId: bigint; asset: Address } | undefined;
    if (record["payOn"] !== undefined && record["payOn"] !== null) {
      const pay = record["payOn"];
      if (typeof pay !== "object") return invalid(`${label}.payOn`, "must be { chainId, asset }");
      const payRecord = pay as Record<string, unknown>;
      const chainId = integerField(payRecord["chainId"], `${label}.payOn.chainId`, 0n);
      if (!chainId.ok) return chainId;
      if (chainId.value === 0n) return invalid(`${label}.payOn.chainId`, "must name a chain");
      const payAsset = typeof payRecord["asset"] === "string" ? payRecord["asset"].trim() : "";
      if (!ADDRESS.test(payAsset)) return invalid(`${label}.payOn.asset`, "must be a 20-byte 0x address");
      payOn = { chainId: chainId.value, asset: payAsset.toLowerCase() as Address };
    }

    upstreams.push({
      prefix,
      url: url.replace(/\/+$/, ""),
      tool,
      marginBps: marginBps.value,
      marginBaseUnits: marginBaseUnits.value,
      maxUpstreamBaseUnits: ceiling.value,
      unitBaseUnits: unit.value,
      payOn,
    });
  }
  return ok(upstreams);
}

function integerField(value: unknown, name: string, fallback: bigint): Result<bigint> {
  if (value === undefined || value === null) return ok(fallback);
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return ok(BigInt(value));
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) return ok(BigInt(value.trim()));
  return invalid(name, "must be a non-negative integer");
}

const SERVICE_REGISTRY_ABI = ["function collectionOf(bytes32 serviceId, address asset) view returns (address collection)"] as const;
const serviceRegistry = new Interface([...SERVICE_REGISTRY_ABI]);

/** A provider that can `eth_call`. An ethers `JsonRpcProvider` satisfies it. */
export interface CallProvider {
  call(transaction: { readonly to: string; readonly data: string }): Promise<string>;
}

const EIP712_ABI = [
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function name() view returns (string)",
  "function version() view returns (string)",
] as const;
const eip712 = new Interface([...EIP712_ABI]);

/**
 * The Asset's EIP-712 domain, read off the token itself.
 *
 * An x402 `exact` payment is an EIP-3009 authorization signed under the
 * token's own domain, so the offer must carry the exact `name` and `version`
 * the contract hashes with, and guessing them from a symbol is how a mock
 * named `mUSDC` here and `USDC` in its constructor produces signatures the
 * facilitator cannot verify. ERC-5267's `eip712Domain()` is asked first,
 * which every OpenZeppelin token answers; Circle's FiatToken predates it and
 * answers `name()` and `version()` instead. A token that answers neither is
 * `ok(undefined)`, and the caller falls back to what it knows by symbol.
 */
export async function readEip712Domain(provider: CallProvider, asset: string): Promise<{ readonly name: string; readonly version: string } | undefined> {
  try {
    const raw = await provider.call({ to: asset, data: eip712.encodeFunctionData("eip712Domain") });
    const decoded = eip712.decodeFunctionResult("eip712Domain", raw);
    const name = String(decoded[1]);
    const version = String(decoded[2]);
    if (name.length > 0 && version.length > 0) return { name, version };
  } catch {
    // Not ERC-5267. Try the older pair.
  }
  try {
    const [nameRaw, versionRaw] = await Promise.all([
      provider.call({ to: asset, data: eip712.encodeFunctionData("name") }),
      provider.call({ to: asset, data: eip712.encodeFunctionData("version") }),
    ]);
    const name = String(eip712.decodeFunctionResult("name", nameRaw)[0]);
    const version = String(eip712.decodeFunctionResult("version", versionRaw)[0]);
    if (name.length > 0 && version.length > 0) return { name, version };
  } catch {
    // Neither. The caller decides.
  }
  return undefined;
}

/**
 * The Service's Collection address for the Asset, from `ServiceRegistry`.
 *
 * `ok(undefined)` when the registry holds the zero address, which means the
 * Service does not accept the Asset and no `payTo` exists to offer.
 */
export async function readCollectionAddress(
  provider: CallProvider,
  registry: string,
  serviceId: string,
  asset: string,
): Promise<Result<Address | undefined>> {
  try {
    const raw = await provider.call({ to: registry, data: serviceRegistry.encodeFunctionData("collectionOf", [serviceId, asset]) });
    const decoded = String(serviceRegistry.decodeFunctionResult("collectionOf", raw)[0]).toLowerCase();
    if (!ADDRESS.test(decoded) || /^0x0{40}$/.test(decoded)) return ok(undefined);
    return ok(decoded as Address);
  } catch (error) {
    return err({
      category: "UPSTREAM",
      code: "COLLECTION_UNREADABLE",
      message: `ServiceRegistry.collectionOf could not be read for ${serviceId} and ${asset}`,
      retryable: true,
      details: { serviceId, asset },
      cause: causeOf(error),
    });
  }
}
