/**
 * The Tab HTTP header contract, and the only parser and formatter for it.
 *
 * This module is the reconciliation point between the two halves of the wire
 * protocol: the client wrapper in `client-402.ts` (R23.2) reads these headers off
 * a Service response, and the server-side post-paid plugin writes them. Both
 * halves go through the functions here rather than through their own string
 * handling, so a disagreement about a format is a compile or test failure in one
 * file instead of a silent mis-parse in production.
 *
 * ## The contract
 *
 * | Header | Direction | Required | Value format |
 * | --- | --- | --- | --- |
 * | `Tab-Charge-Amount` | response | yes, within the block | decimal integer Asset base units, no sign, no separators, no exponent |
 * | `Tab-Charge-Asset` | response | yes, within the block | `<chainKey>:<address>` — decimal `uint64`, a colon, then a `0x` 20-byte address |
 * | `Tab-Charge-Service` | response | yes, within the block | `0x` 32-byte word: the `serviceId` |
 * | `Tab-Charge-Tool` | response | yes, within the block | `0x` 32-byte word: the `bytes32` tool key from the applied price list |
 * | `Tab-Open-Tab` | response | yes, within the block | decimal integer base units: the Open Tab for that Agent, Service, and Asset after this call |
 * | `Tab-Headroom` | response | yes, within the block | decimal integer base units: headroom remaining for that Agent and Asset |
 * | `Tab-Agent` | request | yes on a metered call | `0x` 20-byte address: the Agent's Creditcoin address, its identity on the rail |
 * | `Tab-Authorisation` | request | optional | `0x` 32-byte word: the `authKey` the Service should meter against |
 *
 * ## Five decisions the table does not show, each of which 15.3 must match
 *
 * **1. The six response headers are one all-or-nothing block.** A response
 * carrying none of them is simply not a metered response, and
 * {@link parseChargeHeaders} returns `ok(undefined)` for it — an unmetered health
 * endpoint behind the same client must not become an error. A response carrying
 * *some* of them is a malformed metered response and is an `err`, because the
 * alternative is a client that silently records a charge against the wrong Asset
 * or against no Asset at all. There is no partial block and no default value: a
 * missing `Tab-Headroom` does not mean zero headroom.
 *
 * **2. Every amount is an integer count of Asset base units, parsed to
 * `bigint`.** Never a `number`, never a decimal, never a rate. USDC is 6
 * decimals, so `10_000` is one cent, and an Open Tab routinely exceeds the range
 * a float represents exactly. `Number.parseInt` would round a large Open Tab into
 * something that still looks plausible, which is worse than failing. The grammar
 * is deliberately narrow — `/^[0-9]+$/` — so `1e6`, `1.0`, `1_000`, `+1`, `-1`,
 * `0x10`, and `1,000` are all rejected rather than coerced.
 *
 * **3. `Tab-Charge-Asset` carries the chainKey and the Asset address and nothing
 * else.** Decimals and symbol are deliberately absent: they are registry facts,
 * not per-call facts, and a Service that could restate an Asset's decimals on
 * every response could restate what a base unit means. So the parsed
 * {@link ChargedAsset} is a two-field reference rather than an `AssetRef`, and a
 * caller that needs decimals resolves them from its own configuration.
 *
 * **4. The chainKey is bounded as a `uint64` and not narrowed to `{1, 3}`.** It
 * is a `uint64` field of the replay key, so the bound is the bound. Refusing an
 * unknown chainKey here would close a set the payment-strategy seam deliberately
 * leaves open (R23.6): a third-party strategy settling on a chain this release
 * has never heard of should still be able to read its own charge headers.
 *
 * **5. The Asset address is lower-cased on parse, and `serviceId` and the tool
 * key are not.** An address arrives checksummed from one source and lower-case
 * from another, and two spellings of one Asset in a ledger keyed by Asset is a
 * client that reports two Open Tabs where there is one. A `bytes32` word has no
 * checksum convention to normalise, so it is carried through byte-for-byte.
 *
 * A `bytes32` tool key is usually a short name right-padded with zero bytes —
 * `0x7461622e70726f6f662d73657276696365…` is `tab.proof-service` — but nothing
 * here decodes it. The key is what `ServiceRegistry.priceOf` is keyed on, and it
 * is carried as the word it is so it round-trips into a contract call unchanged.
 *
 * Requirements: 23.2, 21.5
 */

import {
  UINT64_MAX,
  isAddress,
  isBytes32,
  ok,
  type Address,
  type Bytes32,
  type Result,
} from "@tabai/shared";
import { validationError } from "../errors.js";

/** Every Tab header name, in the casing this SDK writes. */
export const TAB_HEADER = {
  chargeAmount: "Tab-Charge-Amount",
  chargeAsset: "Tab-Charge-Asset",
  chargeService: "Tab-Charge-Service",
  chargeTool: "Tab-Charge-Tool",
  openTab: "Tab-Open-Tab",
  headroom: "Tab-Headroom",
  agent: "Tab-Agent",
  authorisation: "Tab-Authorisation",
} as const;

/**
 * The six response headers that form the charge block, all six required whenever
 * any one of them is present.
 */
export const CHARGE_RESPONSE_HEADERS = [
  TAB_HEADER.chargeAmount,
  TAB_HEADER.chargeAsset,
  TAB_HEADER.chargeService,
  TAB_HEADER.chargeTool,
  TAB_HEADER.openTab,
  TAB_HEADER.headroom,
] as const;

/**
 * The Asset a charge is denominated in, exactly as `Tab-Charge-Asset` carries it:
 * a chainKey and an address, with no decimals and no symbol.
 */
export interface ChargedAsset {
  /** Tab's own chain identifier, a `uint64` field of the replay key. Not the EVM chain id. */
  readonly chainKey: bigint;
  /** Lower-cased on parse, so one Asset has one spelling in a ledger keyed by it. */
  readonly address: Address;
}

/** One decoded charge block: what the Service says this call cost and what it left. */
export interface ChargeBlock {
  /** Integer Asset base units for this call. */
  readonly amount: bigint;
  readonly asset: ChargedAsset;
  readonly serviceId: Bytes32;
  /** The `bytes32` tool key from the applied price list. */
  readonly tool: Bytes32;
  /** The Open Tab for this Agent, Service, and Asset after this call. */
  readonly openTab: bigint;
  /** Headroom remaining for this Agent and Asset. */
  readonly headroom: bigint;
}

/**
 * Anything that answers a case-insensitive header lookup. A `Headers` instance
 * satisfies it, and so does {@link headerReaderOf} over a plain object.
 */
export interface HeaderReader {
  get(name: string): string | null | undefined;
}

/** A header bag as a framework hands one over: values, or repeated values. */
export type HeaderRecord = Readonly<Record<string, string | readonly string[] | undefined>>;

/** The registry key for a charged Asset: `${chainKey}:${address}`, lower-cased. */
export const chargedAssetKey = (asset: ChargedAsset): string =>
  `${asset.chainKey.toString(10)}:${asset.address.toLowerCase()}`;

/** True when both refs name the same Asset on the same chain, spelling aside. */
export const sameChargedAsset = (a: ChargedAsset, b: ChargedAsset): boolean =>
  chargedAssetKey(a) === chargedAssetKey(b);

/**
 * Wraps a plain header object as a {@link HeaderReader}, matching names
 * case-insensitively.
 *
 * Repeated values are joined with `, ` rather than resolved to one of them. Every
 * Tab header is single-valued, so a repeat is a bug on the emitting side, and
 * joining makes it fail the format check loudly instead of picking a winner.
 */
export function headerReaderOf(source: HeaderReader | HeaderRecord): HeaderReader {
  if (typeof (source as HeaderReader).get === "function") return source as HeaderReader;
  const indexed = new Map<string, string>();
  for (const [name, value] of Object.entries(source as HeaderRecord)) {
    if (value === undefined) continue;
    indexed.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : (value as string));
  }
  return { get: (name) => indexed.get(name.toLowerCase()) ?? null };
}

/**
 * Parses a decimal integer count of Asset base units.
 *
 * `bigint` because base units are exact integers of arbitrary size, and a narrow
 * grammar because every rejected spelling is a spelling that would otherwise be
 * silently rounded or silently truncated.
 */
export function parseBaseUnits(raw: string, header: string, code: string): Result<bigint> {
  const value = raw.trim();
  if (value.length === 0) {
    return validationError(code, `${header} is empty; it must carry a decimal integer of base units`, {
      details: { header },
    });
  }
  if (!/^[0-9]+$/.test(value)) {
    return validationError(
      code,
      `${header} carries \`${value}\`, which is not a decimal integer of base units; no sign, separator, decimal point, exponent, or 0x prefix is accepted`,
      { details: { header, value } },
    );
  }
  return ok(BigInt(value));
}

/** Renders `Tab-Charge-Asset`: `<chainKey>:<address>`. */
export const formatChargedAsset = (asset: ChargedAsset): string =>
  `${asset.chainKey.toString(10)}:${asset.address.toLowerCase()}`;

/** Parses `Tab-Charge-Asset`. */
export function parseChargedAsset(raw: string): Result<ChargedAsset> {
  const value = raw.trim();
  const parts = value.split(":");
  const [chainKeyPart, addressPart] = parts;
  if (parts.length !== 2 || chainKeyPart === undefined || addressPart === undefined) {
    return validationError(
      "CHARGE_ASSET_INVALID",
      `${TAB_HEADER.chargeAsset} carries \`${value}\`; it must be exactly \`<chainKey>:<address>\``,
      { details: { header: TAB_HEADER.chargeAsset, value } },
    );
  }
  const chainKey = parseBaseUnits(chainKeyPart, `${TAB_HEADER.chargeAsset} chainKey`, "CHARGE_ASSET_INVALID");
  if (!chainKey.ok) return chainKey;
  if (chainKey.value > UINT64_MAX) {
    return validationError(
      "CHARGE_ASSET_INVALID",
      `${TAB_HEADER.chargeAsset} names chainKey ${chainKey.value.toString(10)}, which exceeds uint64; a chainKey is a uint64 field of the replay key`,
      { details: { header: TAB_HEADER.chargeAsset, value } },
    );
  }
  const address = addressPart.trim();
  if (!isAddress(address)) {
    return validationError(
      "CHARGE_ASSET_INVALID",
      `${TAB_HEADER.chargeAsset} names \`${address}\` as its Asset, which is not a 20-byte 0x address`,
      { details: { header: TAB_HEADER.chargeAsset, value } },
    );
  }
  return ok({ chainKey: chainKey.value, address: address.toLowerCase() as Address });
}

/**
 * Reads the charge block off a response.
 *
 * Three outcomes, and the middle one is the reason this returns
 * `Result<ChargeBlock | undefined>` rather than `Result<ChargeBlock>`:
 *
 * - all six headers present and well-formed — `ok(block)`;
 * - none of the six present — `ok(undefined)`, an unmetered response;
 * - some present, or one malformed — `err`, because a partial block cannot be
 *   completed by guessing and a zero is not a safe stand-in for an absent amount.
 */
export function parseChargeHeaders(
  source: HeaderReader | HeaderRecord,
): Result<ChargeBlock | undefined> {
  const headers = headerReaderOf(source);
  const raw = new Map<string, string>();
  const absent: string[] = [];
  for (const name of CHARGE_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value === null || value === undefined || value.trim().length === 0) {
      absent.push(name);
      continue;
    }
    raw.set(name, value);
  }

  if (absent.length === CHARGE_RESPONSE_HEADERS.length) return ok(undefined);
  if (absent.length > 0) {
    return validationError(
      "CHARGE_HEADERS_INCOMPLETE",
      `the response carries part of a Tab charge block and is missing ${absent.join(", ")}; the ${CHARGE_RESPONSE_HEADERS.length} charge headers are all-or-nothing, because a missing header is not a zero`,
      { details: { missing: absent.join(", "), present: [...raw.keys()].join(", ") } },
    );
  }

  const amount = parseBaseUnits(
    raw.get(TAB_HEADER.chargeAmount) ?? "",
    TAB_HEADER.chargeAmount,
    "CHARGE_AMOUNT_INVALID",
  );
  if (!amount.ok) return amount;

  const asset = parseChargedAsset(raw.get(TAB_HEADER.chargeAsset) ?? "");
  if (!asset.ok) return asset;

  const serviceId = (raw.get(TAB_HEADER.chargeService) ?? "").trim();
  if (!isBytes32(serviceId)) {
    return validationError(
      "CHARGE_SERVICE_INVALID",
      `${TAB_HEADER.chargeService} carries \`${serviceId}\`, which is not a 32-byte 0x word`,
      { details: { header: TAB_HEADER.chargeService, value: serviceId } },
    );
  }

  const tool = (raw.get(TAB_HEADER.chargeTool) ?? "").trim();
  if (!isBytes32(tool)) {
    return validationError(
      "CHARGE_TOOL_INVALID",
      `${TAB_HEADER.chargeTool} carries \`${tool}\`, which is not a 32-byte 0x word; the tool key is the bytes32 the price list is keyed on, not its decoded name`,
      { details: { header: TAB_HEADER.chargeTool, value: tool } },
    );
  }

  const openTab = parseBaseUnits(
    raw.get(TAB_HEADER.openTab) ?? "",
    TAB_HEADER.openTab,
    "OPEN_TAB_INVALID",
  );
  if (!openTab.ok) return openTab;

  const headroom = parseBaseUnits(
    raw.get(TAB_HEADER.headroom) ?? "",
    TAB_HEADER.headroom,
    "HEADROOM_INVALID",
  );
  if (!headroom.ok) return headroom;

  return ok({
    amount: amount.value,
    asset: asset.value,
    serviceId,
    tool,
    openTab: openTab.value,
    headroom: headroom.value,
  });
}

/**
 * Renders a charge block as the six response headers.
 *
 * Exported for the emitting side, so the server plugin writes what this module's
 * parser reads rather than what a second string-building routine believes. The
 * round trip through {@link parseChargeHeaders} is asserted in the tests.
 */
export function formatChargeHeaders(block: ChargeBlock): Result<Record<string, string>> {
  for (const [label, value, code] of [
    [TAB_HEADER.chargeAmount, block.amount, "CHARGE_AMOUNT_INVALID"],
    [TAB_HEADER.openTab, block.openTab, "OPEN_TAB_INVALID"],
    [TAB_HEADER.headroom, block.headroom, "HEADROOM_INVALID"],
  ] as const) {
    if (typeof value !== "bigint") {
      return validationError(code, `${label} must be a bigint count of base units, never a number`, {
        details: { header: label },
      });
    }
    if (value < 0n) {
      return validationError(code, `${label} must not be negative, received ${value.toString(10)}`, {
        details: { header: label },
      });
    }
  }
  if (typeof block.asset.chainKey !== "bigint" || block.asset.chainKey < 0n) {
    return validationError(
      "CHARGE_ASSET_INVALID",
      `${TAB_HEADER.chargeAsset} needs a non-negative bigint chainKey`,
    );
  }
  if (block.asset.chainKey > UINT64_MAX) {
    return validationError(
      "CHARGE_ASSET_INVALID",
      `${TAB_HEADER.chargeAsset} chainKey exceeds uint64: ${block.asset.chainKey.toString(10)}`,
    );
  }
  if (!isAddress(block.asset.address)) {
    return validationError(
      "CHARGE_ASSET_INVALID",
      `${TAB_HEADER.chargeAsset} needs a 20-byte 0x Asset address`,
    );
  }
  if (!isBytes32(block.serviceId)) {
    return validationError("CHARGE_SERVICE_INVALID", `${TAB_HEADER.chargeService} needs a 32-byte 0x word`);
  }
  if (!isBytes32(block.tool)) {
    return validationError("CHARGE_TOOL_INVALID", `${TAB_HEADER.chargeTool} needs a 32-byte 0x word`);
  }
  return ok({
    [TAB_HEADER.chargeAmount]: block.amount.toString(10),
    [TAB_HEADER.chargeAsset]: formatChargedAsset(block.asset),
    [TAB_HEADER.chargeService]: block.serviceId,
    [TAB_HEADER.chargeTool]: block.tool,
    [TAB_HEADER.openTab]: block.openTab.toString(10),
    [TAB_HEADER.headroom]: block.headroom.toString(10),
  });
}

/**
 * Builds the request headers that identify the Agent being metered.
 *
 * `Tab-Agent` is the Agent's Creditcoin address — its identity on the rail, and
 * the only thing that tells a Service which tab to charge. `Tab-Authorisation` is
 * optional here because the authKey is a per-Service arrangement a caller may not
 * hold; a Service that requires one answers 403 through the ordinary error path
 * rather than through this function.
 */
export function agentRequestHeaders(
  agent: Address,
  authorisation?: Bytes32,
): Result<Record<string, string>> {
  if (!isAddress(agent)) {
    return validationError(
      "AGENT_INVALID",
      `${TAB_HEADER.agent} must be the Agent's 20-byte 0x Creditcoin address, received \`${String(agent)}\``,
    );
  }
  if (authorisation !== undefined && !isBytes32(authorisation)) {
    return validationError(
      "AUTHORISATION_INVALID",
      `${TAB_HEADER.authorisation} must be a 32-byte 0x authKey, received \`${String(authorisation)}\``,
    );
  }
  return ok({
    [TAB_HEADER.agent]: agent,
    ...(authorisation === undefined ? {} : { [TAB_HEADER.authorisation]: authorisation }),
  });
}
