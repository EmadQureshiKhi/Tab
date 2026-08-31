/**
 * The metering seam: what the post-paid plugin calls to record one Metered
 * Delivery, and how a `recordDelivery` revert becomes a `TabError`.
 *
 * Two things live here and they are deliberately separate. {@link TabBookClient}
 * is the interface the plugin depends on, so the plugin has no opinion about
 * `ethers`, an RPC endpoint, a signer, or a witness. {@link RECORD_DELIVERY_REVERTS}
 * is the mapping table from `TabBook.recordDelivery`'s revert set to the
 * `TabError` each one becomes, so every implementation of that interface — the
 * gateway, the Proof Service, a Service operator's own client — classifies a
 * refusal the same way rather than each inventing its own status codes.
 *
 * ## The revert set is the real one, read off the contract
 *
 * `recordDelivery(agent, serviceId, asset, tool, units, expectedUnitPrice,
 * witness)` runs six steps in a fixed order, and each step has its own refusals.
 * In call order: the registry read (`UnknownService`), the operator check
 * (`NotServiceOperator`), the delinquency check (`TabIsDelinquent`), pricing
 * (`ZeroUnits`, `UnknownTool`, `PriceListChangedMidCall`, `AmountOutOfRange`),
 * the authorisation (`AuthorisationMissing`, `AuthorisationExpired`,
 * `AuthorisationExceeded`), and the headroom check (`LimitExceeded`, plus the
 * witness-validation errors the Credit Limit computation raises). Every name in
 * {@link RECORD_DELIVERY_REVERTS} is one of those; nothing in the table was
 * guessed from the design.
 *
 * ## Whose fault it is decides who sees it
 *
 * Each row carries a {@link RefusalDisposition}, and that field is the whole
 * policy of this module:
 *
 * - `refuse-request` — the refusal is the Agent's to fix. Its Credit Limit has no
 *   headroom, its spending authorisation is missing, lapsed, or spent, or its tab
 *   went past its Settlement Window. The Agent is told, with the figures it needs
 *   to act on.
 * - `deliver-anyway` — the refusal is the Service's to fix, or ours. A wrong
 *   operator key, a tool that is not in the applied price list, a price that
 *   moved under the call, a witness the Service assembled wrongly. The Agent did
 *   nothing, so the Agent's response is delivered and the Service is told through
 *   its own failure channel. A Service whose billing is broken eats the cost of
 *   the delivery; it does not hand the cost to the caller.
 *
 * `refuse-request` is the smaller set on purpose. The plugin exists to accrue, not
 * to gate.
 *
 * ## Amounts
 *
 * Every amount here is an integer count of Asset base units as a `bigint`. USDC
 * is 6 decimals, and nothing in this module converts, scales, or rounds.
 *
 * Requirements: 23.3, 12.1, 12.2, 12.3, 21.5
 */

import {
  httpStatusOf,
  type Address,
  type Bytes32,
  type ErrorCategory,
  type Hex,
  type Result,
  type TabError,
} from "@tabai/shared";
import { tabError } from "../errors.js";
import type { AssetRef } from "../payments/strategy.js";

/**
 * The one delivery a Service is charging for.
 *
 * The fields are `recordDelivery`'s own parameters minus the witness, because the
 * witness is not the plugin's to build: it is the full ordered Verified
 * Settlement history plus one Bond entry per counterparty, validated on chain
 * against the rolling commitment, and assembling it needs chain reads the plugin
 * does not make. A {@link TabBookClient} owns that.
 */
export interface MeteredDelivery {
  /** The Agent's Creditcoin address. Identified from the request, never from a session. */
  readonly agent: Address;
  readonly serviceId: Bytes32;
  readonly asset: AssetRef;
  /** The named priced unit, as the 32-byte word the applied price list is keyed by. */
  readonly tool: Bytes32;
  /** Count of priced units. A `uint32` on chain, and zero reverts `ZeroUnits`. */
  readonly units: number;
  /**
   * The unit price the Service quoted, in Asset base units.
   *
   * Compared for exact equality against the applied price list, so a price that
   * moved between the quote and the charge reverts `PriceListChangedMidCall`
   * rather than charging a figure the Agent never saw. Per unit rather than
   * total, so the count cannot be adjusted to match a total already committed to.
   */
  readonly expectedUnitPrice: bigint;
}

/** What `recordDelivery` returned, in the order the contract returns it. */
export interface DeliveryReceipt {
  /** `units * expectedUnitPrice`, in Asset base units. */
  readonly charged: bigint;
  /** The Open Tab for this Agent, Service, and Asset after the charge. */
  readonly openAfter: bigint;
  /** Headroom left for this Agent across every Service in this Asset. */
  readonly headroomAfter: bigint;
  /** The Creditcoin transaction the delivery was recorded in, when the client knows it. */
  readonly creditcoinTxHash?: Hex;
  /** Milliseconds since the epoch, on the recording client's clock. */
  readonly recordedAt: number;
}

/**
 * The two calls the post-paid plugin makes.
 *
 * Narrow on purpose: this is what lets a Service meter against a real signer in
 * production and against a stub in a test without the plugin knowing the
 * difference. Both methods return a `Result` and neither throws (design section
 * 13.1). On a revert, `recordDelivery` returns the `TabError`
 * {@link classifyRecordDeliveryRevert} produces, so the plugin reads the
 * disposition off `details.disposition` rather than re-decoding contract data.
 */
export interface TabBookClient {
  recordDelivery(delivery: MeteredDelivery): Promise<Result<DeliveryReceipt>>;
  /**
   * The Open Tab for this Agent, Service, and Asset, read without metering.
   *
   * A second method rather than one, because the `402` needs a figure a revert
   * does not carry. `LimitExceeded` reverts with the requested amount and the
   * headroom and says nothing about the Open Tab, and the charge block on the wire
   * is all six headers or none of them, so a 402 that could not name the Open Tab
   * would reach the 402 client as a malformed charge block instead of as the credit
   * decision it is. The call is a view — no witness, no signature — and the figure
   * is truthful precisely because the metering transaction reverted and moved
   * nothing.
   *
   * Called on the refusal path alone. It is never on the path of a successful
   * delivery, which reads its figures off `recordDelivery`'s own return.
   */
  openTabOf(delivery: MeteredDelivery): Promise<Result<bigint>>;
}

/**
 * The human-readable ABI fragment of the real entrypoint, field for field.
 *
 * Carried here so a {@link TabBookClient} implementation encodes against the
 * deployed signature rather than a remembered one. The witness is one tuple of
 * two arrays: `LimitLib.SettlementRecord[]` and `LimitLib.BondEntry[]`, in that
 * order.
 */
export const TAB_BOOK_RECORD_DELIVERY_ABI = [
  "function recordDelivery(address agent, bytes32 serviceId, address asset, bytes32 tool, uint32 units, uint256 expectedUnitPrice, ((bytes32 serviceId, address asset, uint128 amount, uint64 settledAt, uint64 firstDeliveryAt, uint64 chainKey, bool curated, bool bonded)[] history, (bytes32 serviceId, address asset, uint128 amount)[] bonds) witness) returns (uint256 charged, uint128 openAfter, uint256 headroomAfter)",
] as const;

/**
 * Whether a refusal changes what the caller receives.
 *
 * `refuse-request` replaces the handler's response. `deliver-anyway` does not:
 * the response goes out, and the Service learns about the refusal through
 * `onMeteringFailed`.
 */
export type RefusalDisposition = "refuse-request" | "deliver-anyway";

/** One row of the revert mapping table. */
export interface RevertMapping {
  /** The `TabError` category, which is also what fixes the HTTP status (design section 13.1). */
  readonly category: ErrorCategory;
  /** Stable and machine-readable, for example `LIMIT_EXCEEDED`. */
  readonly code: string;
  readonly disposition: RefusalDisposition;
  readonly retryable: boolean;
  /**
   * The revert's argument names, positionally. Decoded arguments are attached to
   * `TabError.details` under these names, so the 402 body can carry the required
   * amount and the headroom without this module knowing which row it is on.
   */
  readonly args: readonly string[];
  /** What the Agent or the Service operator is supposed to do about it. */
  readonly action: string;
}

/**
 * Every revert `recordDelivery` can produce, and what each one becomes.
 *
 * The status each row maps to is not stored: it is `httpStatusOf(category)`, so
 * `LIMIT` is 402 and nothing else is, which is the whole of design section 9.5's
 * rule expressed as a lookup rather than as a comment.
 */
export const RECORD_DELIVERY_REVERTS: Readonly<Record<string, RevertMapping>> = {
  // --- the Agent's to fix: these replace the response -----------------------

  /** The one 402. The Agent's Open Tab for the Asset has no room for this charge. */
  LimitExceeded: {
    category: "LIMIT",
    code: "LIMIT_EXCEEDED",
    disposition: "refuse-request",
    retryable: false,
    args: ["agent", "asset", "requested", "headroom"],
    action:
      "settle the Open Tab, or raise the Credit Limit by growing proven settlement history, then repeat the request",
  },
  AuthorisationMissing: {
    category: "AUTHORISATION",
    code: "AUTHORISATION_MISSING",
    disposition: "refuse-request",
    retryable: false,
    args: ["agent", "serviceId", "asset"],
    action: "the Agent must call TabBook.authorise for this Service and Asset before any delivery is metered",
  },
  AuthorisationExpired: {
    category: "AUTHORISATION",
    code: "AUTHORISATION_EXPIRED",
    disposition: "refuse-request",
    retryable: false,
    args: ["expiry", "nowTs"],
    action: "the Agent must call TabBook.authorise again with a later expiry",
  },
  AuthorisationExceeded: {
    category: "AUTHORISATION",
    code: "AUTHORISATION_EXCEEDED",
    disposition: "refuse-request",
    retryable: false,
    args: ["maxCumulative", "spent", "requested"],
    action: "the Agent must raise maxCumulative on its authorisation",
  },
  /**
   * Past the Settlement Window, so the tab is delinquent and the Agent's Credit
   * Limit for the Asset is zero.
   *
   * A 409 rather than a 402, deliberately. Design section 9.5 fixes 402 to
   * `LimitExceeded` alone on this surface, and delinquency is a different fact
   * from a full tab: the state of the tab conflicts with metering at all, and no
   * headroom figure would make this request succeed. The Agent settles the named
   * tab and the state clears.
   */
  TabIsDelinquent: {
    category: "CONFLICT",
    code: "TAB_DELINQUENT",
    disposition: "refuse-request",
    retryable: false,
    args: ["tabId"],
    action: "the Agent must settle the named tab; its Credit Limit for this Asset is zero until it does",
  },

  // --- the Service's to fix, or ours: the response is delivered anyway ------

  /**
   * The applied price moved between the Service's quote and the charge.
   *
   * The Service's problem, not the Agent's: the Agent was quoted a price and the
   * work was delivered at it. Retryable once with the price the registry now
   * serves, which is the row the Watcher error table already prescribes.
   */
  PriceListChangedMidCall: {
    category: "CONFLICT",
    code: "PRICE_LIST_CHANGED_MID_CALL",
    disposition: "deliver-anyway",
    retryable: true,
    args: ["serviceId", "asset", "tool", "quoted", "applied"],
    action: "re-quote from the applied price list and record the delivery again",
  },
  UnknownTool: {
    category: "NOT_FOUND",
    code: "UNKNOWN_TOOL",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["serviceId", "asset", "tool"],
    action: "register the tool in the Service's price list; a priced unit that is not listed cannot be charged",
  },
  UnknownService: {
    category: "NOT_FOUND",
    code: "UNKNOWN_SERVICE",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["serviceId"],
    action: "register the Service before metering into it",
  },
  NotServiceOperator: {
    category: "AUTHORISATION",
    code: "NOT_SERVICE_OPERATOR",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["serviceId", "caller"],
    action: "meter with the Service operator's own Creditcoin key",
  },
  ZeroUnits: {
    category: "VALIDATION",
    code: "ZERO_UNITS",
    disposition: "deliver-anyway",
    retryable: false,
    args: [],
    action: "price the delivery at one unit or more, or treat it as unbillable and record nothing",
  },
  AmountOutOfRange: {
    category: "VALIDATION",
    code: "AMOUNT_OUT_OF_RANGE",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["amount"],
    action: "reduce the unit count; the Open Tab is kept in uint128 base units",
  },
  HistoryCommitmentMismatch: {
    category: "CONFLICT",
    code: "HISTORY_COMMITMENT_MISMATCH",
    disposition: "deliver-anyway",
    retryable: true,
    args: ["expected", "provided"],
    action: "refresh the witness from chain state and record the delivery again",
  },
  HistoryLengthMismatch: {
    category: "CONFLICT",
    code: "HISTORY_LENGTH_MISMATCH",
    disposition: "deliver-anyway",
    retryable: true,
    args: ["expected", "provided"],
    action: "refresh the witness from chain state and record the delivery again",
  },
  DuplicateBondEntry: {
    category: "INTERNAL",
    code: "DUPLICATE_BOND_ENTRY",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["serviceId"],
    action: "fix the witness builder: one Bond entry per counterparty Service",
  },
  IneligibleBondEntry: {
    category: "INTERNAL",
    code: "INELIGIBLE_BOND_ENTRY",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["serviceId", "asset"],
    action: "fix the witness builder: every Bond entry must name a counterparty from the history",
  },
  TooManyBondEntries: {
    category: "INTERNAL",
    code: "TOO_MANY_BOND_ENTRIES",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["count", "maximum"],
    action: "compact the history; this is the documented scaling limit of the pure computation",
  },
  HistoryTooLong: {
    category: "INTERNAL",
    code: "HISTORY_TOO_LONG",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["count", "maximum"],
    action: "compact the history; this is the documented scaling limit of the pure computation",
  },
  TooManyCounterparties: {
    category: "INTERNAL",
    code: "TOO_MANY_COUNTERPARTIES",
    disposition: "deliver-anyway",
    retryable: false,
    args: ["count", "maximum"],
    action: "compact the history; this is the documented scaling limit of the pure computation",
  },
};

/** The revert name and decoded arguments, as `ethers` v6 reports them. */
export interface DecodedRevert {
  readonly name: string;
  readonly args?: readonly unknown[];
}

/**
 * Pulls a decoded revert out of whatever a client caught.
 *
 * `ethers` v6 attaches `error.revert` as `{ name, signature, args }` when it can
 * match the returndata against the contract's ABI; older shapes carry
 * `errorName` and `errorArgs`; and a plain object with a `name` is what a test
 * or a non-`ethers` client hands over. All three are read, and anything else
 * yields undefined rather than a guess.
 */
export function decodeRevert(thrown: unknown): DecodedRevert | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;
  const candidate = thrown as {
    revert?: { name?: unknown; args?: unknown } | null;
    errorName?: unknown;
    errorArgs?: unknown;
    name?: unknown;
    args?: unknown;
  };

  const revert = candidate.revert;
  if (revert !== undefined && revert !== null && typeof revert.name === "string") {
    return { name: revert.name, ...(Array.isArray(revert.args) ? { args: revert.args } : {}) };
  }
  if (typeof candidate.errorName === "string") {
    return {
      name: candidate.errorName,
      ...(Array.isArray(candidate.errorArgs) ? { args: candidate.errorArgs } : {}),
    };
  }
  if (typeof candidate.name === "string" && RECORD_DELIVERY_REVERTS[candidate.name] !== undefined) {
    return { name: candidate.name, ...(Array.isArray(candidate.args) ? { args: candidate.args } : {}) };
  }
  return undefined;
}

/** The mapping row for one revert name, or undefined when the name is not one of them. */
export const revertMappingFor = (name: string): RevertMapping | undefined =>
  RECORD_DELIVERY_REVERTS[name];

/**
 * Turns a `recordDelivery` revert into the `TabError` the plugin acts on.
 *
 * `details` always carries `revert` and `disposition`, and carries each decoded
 * argument under the name the row gives it. That is how the plugin builds a 402
 * body naming the required amount and the current headroom without a special
 * case for `LimitExceeded`: it reads `details.requested` and `details.headroom`,
 * which the table put there.
 *
 * A revert this table does not name is `CHAIN`/`RECORD_DELIVERY_REVERTED` with
 * `deliver-anyway`, because an unclassified refusal is not something to charge an
 * Agent for and not something to refuse a delivered response over either.
 */
export function classifyRecordDeliveryRevert(thrown: unknown): TabError {
  const decoded = decodeRevert(thrown);
  const mapping = decoded === undefined ? undefined : revertMappingFor(decoded.name);
  const cause = causeFrom(thrown);
  const carriedCause = cause === undefined ? {} : { cause };

  if (decoded === undefined || mapping === undefined) {
    return tabError(
      "CHAIN",
      "RECORD_DELIVERY_REVERTED",
      decoded === undefined
        ? "recordDelivery failed and the returndata matched no known revert"
        : `recordDelivery reverted \`${decoded.name}\`, which is not a revert this SDK version classifies`,
      {
        retryable: false,
        details: {
          disposition: "deliver-anyway",
          ...(decoded === undefined ? {} : { revert: decoded.name }),
        },
        ...carriedCause,
      },
    );
  }

  return tabError(
    mapping.category,
    mapping.code,
    `recordDelivery reverted \`${decoded.name}\`: ${mapping.action}`,
    {
      retryable: mapping.retryable,
      details: {
        revert: decoded.name,
        disposition: mapping.disposition,
        ...namedArgs(mapping.args, decoded.args),
      },
      ...carriedCause,
    },
  );
}

/** The disposition carried on a classified error, defaulting to the safe one. */
export const dispositionOf = (error: TabError): RefusalDisposition =>
  error.details?.["disposition"] === "refuse-request" ? "refuse-request" : "deliver-anyway";

/** The HTTP status a refusal is served with, taken from its category alone. */
export const refusalStatusOf = (error: TabError): number => httpStatusOf(error);

/**
 * Reads one decoded argument off a classified error as a `bigint`.
 *
 * Arguments land in `details` as decimal strings, because `TabError.details`
 * holds no `bigint`. This reads one back, and returns undefined rather than
 * `0n` when it is absent — a headroom nobody reported is not a headroom of zero.
 */
export function detailAmount(error: TabError, name: string): bigint | undefined {
  const raw = error.details?.[name];
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return BigInt(raw);
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  return BigInt(raw);
}

/** Names the positional revert arguments and renders each into `details`. */
function namedArgs(
  names: readonly string[],
  args: readonly unknown[] | undefined,
): Record<string, string | number | boolean> {
  if (args === undefined) return {};
  const named: Record<string, string | number | boolean> = {};
  for (const [index, name] of names.entries()) {
    if (index >= args.length) break;
    const value = args[index];
    if (typeof value === "bigint") named[name] = value.toString(10);
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      named[name] = value;
    } else if (value !== undefined && value !== null) named[name] = String(value);
  }
  return named;
}

/** Narrows a caught value into the `cause` shape a `TabError` accepts. */
function causeFrom(thrown: unknown): { code: string; message: string } | undefined {
  if (thrown instanceof Error) return { code: thrown.name, message: thrown.message };
  if (typeof thrown === "object" && thrown !== null) {
    const candidate = thrown as { code?: unknown; shortMessage?: unknown; message?: unknown };
    const message =
      typeof candidate.shortMessage === "string"
        ? candidate.shortMessage
        : typeof candidate.message === "string"
          ? candidate.message
          : undefined;
    if (message === undefined) return undefined;
    return { code: typeof candidate.code === "string" ? candidate.code : "UNKNOWN", message };
  }
  return undefined;
}
