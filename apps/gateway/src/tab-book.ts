/**
 * The chain-backed `TabBookClient`: the seam `packages/sdk`'s post-paid plugin
 * calls to record one Metered Delivery.
 *
 * The SDK deliberately owns no chain code. `TabBookClient` is an interface there
 * precisely so a Service can meter against a real signer in production and a stub
 * in a test without the plugin knowing the difference, and this module is the real
 * signer half. It matches that interface structurally rather than importing it,
 * because the plugin only ever calls two methods and structural agreement is what
 * the plugin actually depends on.
 *
 * The one thing it does import from the SDK is `revertMappingFor`, the table that
 * says what each `recordDelivery` revert means. That table is shared rather than
 * copied because one of its fields, `disposition`, decides whether a refusal
 * replaces the delivered response, and a second copy of it that fell out of step
 * would turn the one 402 this surface adds into a 200 carrying no charge block.
 *
 * ## Gas is stated, never estimated, and an exhausted limit is not a revert
 *
 * Measured on this chain rather than assumed. `TabBook.authorise`, which writes far
 * less than this call does, cost **301,896** gas, and an attempt at a 300,000 limit
 * came back `status 0` with `gasUsed == gasLimit` exactly. That is indistinguishable
 * from a revert unless the two are compared, and the deployment runbook records the
 * same trap from the wiring step, where a 62,561 estimate met a real cost of
 * 101,535. The cause is that an estimate comes from a warm simulation while a
 * broadcast pays cold-storage costs again.
 *
 * `recordDelivery` does considerably more than `authorise`: it validates a witness
 * against the rolling commitment, resolves every Bond entry through the registry
 * and the `Bond` ledger, recomputes the Credit Limit through `LimitLib`, and then
 * writes tab state. So {@link RECORD_DELIVERY_GAS_LIMIT} is set well above the
 * measured neighbours rather than tuned down to them, and
 * {@link classifySubmission} reports an exhausted limit as its own outcome so a
 * caller never reads "out of gas" as "the contract refused you".
 *
 * ## Simulate before spending
 *
 * Every path here can run as a keyless `eth_call` first. That is not a nicety on
 * this rail: a revert costs real CTC and tells the Agent nothing, while a
 * simulation costs nothing and returns the same revert data. So the driver
 * simulates, prints what it would charge, and only then broadcasts.
 *
 * Requirements: 12.1, 12.2, 12.3, 23.3
 */

import { Interface, type JsonRpcProvider, type Signer } from "ethers";

import { causeOf, err, ok, type Result, type TabError } from "@tabai/shared";
import { revertMappingFor } from "@tabai/sdk";

import type { LimitWitness } from "./witness.js";

/**
 * Gas stated for a `recordDelivery` broadcast.
 *
 * Deliberately generous. Unused gas is refunded, so the only cost of a high limit
 * is the balance briefly reserved, while the cost of a low one is a mined failure
 * that looks exactly like a refusal and spends the whole limit proving nothing.
 */
export const RECORD_DELIVERY_GAS_LIMIT = 2_000_000n;

/** How long a broadcast waits for its receipt before reporting that it is unconfirmed. */
export const RECEIPT_WAIT_MS = 180_000;

/**
 * The entrypoint, field for field, copied from the SDK's own
 * `TAB_BOOK_RECORD_DELIVERY_ABI` so both encode against the deployed signature.
 */
export const TAB_BOOK_ABI = [
  "function recordDelivery(address agent, bytes32 serviceId, address asset, bytes32 tool, uint32 units, uint256 expectedUnitPrice, ((bytes32 serviceId, address asset, uint128 amount, uint64 settledAt, uint64 firstDeliveryAt, uint64 chainKey, bool curated, bool bonded)[] history, (bytes32 serviceId, address asset, uint128 amount)[] bonds) witness) returns (uint256 charged, uint128 openAfter, uint256 headroomAfter)",
  "function tabIdOf(address agent, bytes32 serviceId, address asset) pure returns (bytes32 tabId)",
  "function tabOf(bytes32 tabId) view returns ((uint128 open, uint128 prepaid, uint64 oldestUnsettledAt, uint64 lastDeliveryAt, uint32 deliveryCount, bool delinquent) tab)",
  "function creditLimit(address agent, address asset, ((bytes32 serviceId, address asset, uint128 amount, uint64 settledAt, uint64 firstDeliveryAt, uint64 chainKey, bool curated, bool bonded)[] history, (bytes32 serviceId, address asset, uint128 amount)[] bonds) witness) view returns (uint256 limit)",
] as const;

/**
 * Every revert these calls can surface, for decoding only.
 *
 * The mapping from a revert to an HTTP status and a disposition lives in
 * `packages/sdk/src/server/metering.ts` and is deliberately not repeated here: two
 * copies of that table would drift, and the plugin is what consumes it. This list
 * exists so a decoded revert arrives with its name and arguments instead of as raw
 * bytes, which is what makes a failed simulation readable.
 */
export const TAB_BOOK_ERRORS = [
  "error LimitExceeded(address agent, address asset, uint256 requested, uint256 headroom)",
  "error AuthorisationMissing(address agent, bytes32 serviceId, address asset)",
  "error AuthorisationExpired(uint64 expiry, uint64 nowTs)",
  "error AuthorisationExceeded(uint128 maxCumulative, uint128 spent, uint256 requested)",
  "error TabIsDelinquent(bytes32 tabId)",
  "error HistoryCommitmentMismatch(bytes32 expected, bytes32 provided)",
  "error HistoryLengthMismatch(uint32 expected, uint256 provided)",
  "error IneligibleBondEntry(bytes32 serviceId, address asset)",
  "error DuplicateBondEntry(bytes32 serviceId)",
  "error TooManyBondEntries(uint256 count, uint256 maximum)",
  "error PriceListChangedMidCall(bytes32 serviceId, address asset, bytes32 tool)",
  "error UnknownTool(bytes32 serviceId, address asset, bytes32 tool)",
  "error UnknownService(bytes32 serviceId)",
  "error NotServiceOperator(bytes32 serviceId, address caller)",
  "error ZeroUnits()",
  "error AmountOutOfRange(uint256 amount)",
  "error AssetMismatch(address expected, address provided)",
] as const;

export const TAB_BOOK_INTERFACE = new Interface([...TAB_BOOK_ABI, ...TAB_BOOK_ERRORS]);

/** One delivery, as the SDK's `MeteredDelivery` describes it. */
export interface MeteredDelivery {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: string;
  readonly tool: string;
  readonly units: number;
  readonly expectedUnitPrice: bigint;
}

/** What `recordDelivery` returns, in the contract's own order. */
export interface DeliveryReceipt {
  readonly charged: bigint;
  readonly openAfter: bigint;
  readonly headroomAfter: bigint;
  readonly creditcoinTxHash?: `0x${string}`;
  readonly recordedAt: number;
}

/** A decoded refusal, name and arguments, without the SDK's status mapping. */
export interface DecodedRevert {
  readonly name: string;
  readonly args: Readonly<Record<string, string>>;
}

/** Pulls the revert payload out of whatever shape the provider wrapped it in. */
function revertDataOf(error: unknown): string | undefined {
  const candidate = error as { data?: unknown; info?: { error?: { data?: unknown } } };
  const direct = candidate?.data;
  if (typeof direct === "string" && direct.startsWith("0x")) return direct;
  const nested = candidate?.info?.error?.data;
  if (typeof nested === "string" && nested.startsWith("0x")) return nested;
  return undefined;
}

/** Decodes a revert into its name and arguments, or reports that it could not. */
export function decodeRevert(data: string): DecodedRevert | undefined {
  try {
    const parsed = TAB_BOOK_INTERFACE.parseError(data);
    if (parsed === null) return undefined;
    const args: Record<string, string> = {};
    parsed.fragment.inputs.forEach((input, index) => {
      args[input.name] = String(parsed.args[index]);
    });
    return { name: parsed.name, args };
  } catch {
    return undefined;
  }
}

function refusal(error: unknown, what: string): TabError {
  const data = revertDataOf(error);
  const decoded = data === undefined ? undefined : decodeRevert(data);
  if (decoded !== undefined) {
    // The category, code and disposition come from the SDK's own table rather than
    // from a guess here. `disposition` is the load-bearing field: the post-paid
    // plugin reads it to decide whether a refusal replaces the delivered response,
    // and a refusal that omits it is treated as the Service's fault and delivered
    // anyway. That silently turned the one 402 this surface adds into a 200 with
    // no charge block, which is the opposite of what design section 9.5 says.
    const mapping = revertMappingFor(decoded.name);
    const rendered = Object.entries(decoded.args)
      .map(([name, value]) => `${name}=${value}`)
      .join(", ");
    return {
      category: mapping?.category ?? "CHAIN",
      code: mapping?.code ?? decoded.name,
      message: `${what} was refused: ${decoded.name}(${rendered})`,
      retryable: mapping?.retryable ?? false,
      details: {
        revert: decoded.name,
        ...decoded.args,
        ...(mapping === undefined ? {} : { disposition: mapping.disposition, action: mapping.action }),
      },
    };
  }
  return {
    category: "CHAIN",
    code: "RECORD_DELIVERY_REFUSED",
    message: `${what} was refused and the revert did not decode against the pinned error set`,
    retryable: false,
    ...(data === undefined ? {} : { details: { raw: data.slice(0, 200) } }),
    cause: causeOf(error),
  };
}

/** How a broadcast ended, keeping an exhausted limit distinct from a refusal. */
export type SubmissionOutcome = "APPLIED" | "REVERTED" | "GAS_EXHAUSTED";

export interface SubmissionVerdict {
  readonly outcome: SubmissionOutcome;
  readonly txHash: string;
  readonly gasUsed: bigint;
  readonly gasLimit: bigint;
  readonly detail: string;
}

/**
 * Reads a mined receipt without confusing an exhausted limit for a refusal.
 *
 * `gasUsed == gasLimit` on a failed transaction is the signature of a limit that
 * was too low, which on this chain is a live trap rather than a theoretical one.
 * Reporting it as a revert would send an operator hunting for a contract refusal
 * that never happened.
 */
export function classifySubmission(
  status: number,
  gasUsed: bigint,
  gasLimit: bigint,
  txHash: string,
): SubmissionVerdict {
  if (status === 1) {
    return {
      outcome: "APPLIED",
      txHash,
      gasUsed,
      gasLimit,
      detail: `the delivery was recorded, consuming ${gasUsed} gas of a stated ${gasLimit}`,
    };
  }
  if (gasUsed >= gasLimit) {
    return {
      outcome: "GAS_EXHAUSTED",
      txHash,
      gasUsed,
      gasLimit,
      detail: `the transaction consumed its entire ${gasLimit} gas limit, so it ran out of gas rather than being refused; raise the limit and resend`,
    };
  }
  return {
    outcome: "REVERTED",
    txHash,
    gasUsed,
    gasLimit,
    detail: `the contract refused the delivery, consuming ${gasUsed} gas of a stated ${gasLimit}`,
  };
}

/** The two calls the SDK plugin makes, plus the simulation the driver leans on. */
export interface GatewayTabBookClient {
  recordDelivery(delivery: MeteredDelivery): Promise<Result<DeliveryReceipt>>;
  openTabOf(delivery: MeteredDelivery): Promise<Result<bigint>>;
  /** What `recordDelivery` would return, over a keyless `eth_call`. Spends nothing. */
  simulateDelivery(delivery: MeteredDelivery): Promise<Result<DeliveryReceipt>>;
  /** The Credit Limit the same witness yields, for reporting beside a charge. */
  creditLimit(agent: string, asset: string): Promise<Result<bigint>>;
}

export interface TabBookClientOptions {
  readonly provider: JsonRpcProvider;
  readonly tabBook: string;
  readonly blockTag: string | number;
  /** Supplies the witness for an Agent and Asset, already proven against the chain. */
  readonly witnessFor: (agent: string, asset: string) => Promise<Result<LimitWitness>>;
  /** Absent on a read-only run, which is the default. */
  readonly signer?: Signer;
  /**
   * The address a simulation should present as `msg.sender`.
   *
   * Needed because `recordDelivery` is gated on the Service operator, so a keyless
   * `eth_call` runs as the zero address and is refused `NotServiceOperator` before
   * it can tell you anything useful. Measured that way on the first live run. The
   * operator's address is public, so stating it costs nothing and lets an operator
   * simulate a charge without holding the key that could make it.
   */
  readonly simulateFrom?: string;
  /** Defaults to {@link RECORD_DELIVERY_GAS_LIMIT}. */
  readonly gasLimit?: bigint;
  /** Injected so a test does not wait on a real clock. */
  readonly now?: () => number;
}

const witnessTuple = (witness: LimitWitness): readonly unknown[] => [
  witness.history.map((record) => [
    record.serviceId,
    record.asset,
    record.amount,
    record.settledAt,
    record.firstDeliveryAt,
    record.chainKey,
    record.curated,
    record.bonded,
  ]),
  witness.bonds.map((entry) => [entry.serviceId, entry.asset, entry.amount]),
];

/**
 * The delivery as `packages/sdk` describes it, where the Asset is a descriptor
 * rather than an address.
 *
 * Declared here rather than imported so this module stays usable without the SDK,
 * and so the one place the two shapes meet is {@link toSdkTabBookClient} below.
 */
export interface SdkMeteredDelivery {
  readonly agent: string;
  readonly serviceId: string;
  readonly asset: { readonly address: string };
  readonly tool: string;
  readonly units: number;
  readonly expectedUnitPrice: bigint;
}

/**
 * Presents this chain client in the shape the SDK's post-paid plugin expects.
 *
 * The only difference between the two shapes is the Asset: the plugin carries a
 * full `AssetRef` because it has to format `chainKey:address` into a header, while
 * everything on chain is keyed by the address alone. Converting explicitly, in one
 * named function, is what keeps that difference from being re-derived at each call
 * site and getting it wrong somewhere.
 */
export function toSdkTabBookClient(client: GatewayTabBookClient): {
  recordDelivery(delivery: SdkMeteredDelivery): Promise<Result<DeliveryReceipt>>;
  openTabOf(delivery: SdkMeteredDelivery): Promise<Result<bigint>>;
} {
  const flatten = (delivery: SdkMeteredDelivery): MeteredDelivery => ({
    agent: delivery.agent,
    serviceId: delivery.serviceId,
    asset: delivery.asset.address,
    tool: delivery.tool,
    units: delivery.units,
    expectedUnitPrice: delivery.expectedUnitPrice,
  });
  return {
    recordDelivery: (delivery) => client.recordDelivery(flatten(delivery)),
    openTabOf: (delivery) => client.openTabOf(flatten(delivery)),
  };
}

/** Builds the client. Construction cannot fail; every fallible thing is a call. */
export function createTabBookClient(options: TabBookClientOptions): GatewayTabBookClient {
  const { provider, tabBook, blockTag } = options;
  const gasLimit = options.gasLimit ?? RECORD_DELIVERY_GAS_LIMIT;
  const now = options.now ?? (() => Date.now());

  const encode = async (delivery: MeteredDelivery): Promise<Result<string>> => {
    const witness = await options.witnessFor(delivery.agent, delivery.asset);
    if (!witness.ok) return witness;
    try {
      return ok(
        TAB_BOOK_INTERFACE.encodeFunctionData("recordDelivery", [
          delivery.agent,
          delivery.serviceId,
          delivery.asset,
          delivery.tool,
          delivery.units,
          delivery.expectedUnitPrice,
          witnessTuple(witness.value),
        ]),
      );
    } catch (error) {
      return err({
        category: "VALIDATION",
        code: "RECORD_DELIVERY_UNENCODABLE",
        message: "the delivery could not be encoded against the pinned recordDelivery signature",
        retryable: false,
        cause: causeOf(error),
      });
    }
  };

  const decodeReceipt = (returned: string): Result<DeliveryReceipt> => {
    try {
      const decoded = TAB_BOOK_INTERFACE.decodeFunctionResult("recordDelivery", returned);
      return ok({
        charged: BigInt(decoded[0] as bigint),
        openAfter: BigInt(decoded[1] as bigint),
        headroomAfter: BigInt(decoded[2] as bigint),
        recordedAt: now(),
      });
    } catch (error) {
      return err({
        category: "CHAIN",
        code: "RECORD_DELIVERY_UNDECODABLE",
        message: "recordDelivery returned a shape the pinned ABI cannot read",
        retryable: false,
        cause: causeOf(error),
      });
    }
  };

  const simulate = async (delivery: MeteredDelivery): Promise<Result<DeliveryReceipt>> => {
    const data = await encode(delivery);
    if (!data.ok) return data;
    // The signer's address when there is one, and the stated operator otherwise.
    const from = options.simulateFrom ?? (options.signer === undefined ? undefined : await options.signer.getAddress());
    try {
      const returned = await provider.call({
        to: tabBook,
        data: data.value,
        blockTag,
        ...(from === undefined ? {} : { from }),
      });
      return decodeReceipt(returned);
    } catch (error) {
      return err(refusal(error, "the simulated delivery"));
    }
  };

  return {
    simulateDelivery: simulate,

    async recordDelivery(delivery): Promise<Result<DeliveryReceipt>> {
      const signer = options.signer;
      if (signer === undefined) {
        return err({
          category: "VALIDATION",
          code: "GATEWAY_KEY_MISSING",
          message: "recording a delivery is a write and this client holds no signer, so it is read-only",
          retryable: false,
        });
      }

      // Simulated first, always. A refusal costs nothing here and the same revert
      // costs real CTC once broadcast, so the only reason to skip this would be to
      // pay for information already available for free.
      const preflight = await simulate(delivery);
      if (!preflight.ok) return preflight;

      const data = await encode(delivery);
      if (!data.ok) return data;

      try {
        const sent = await signer.sendTransaction({ to: tabBook, data: data.value, gasLimit });
        const receipt = await provider.waitForTransaction(sent.hash, 1, RECEIPT_WAIT_MS);
        if (receipt === null) {
          return err({
            category: "CHAIN",
            code: "RECORD_DELIVERY_UNCONFIRMED",
            message: `the delivery was broadcast as ${sent.hash} and no receipt arrived within ${RECEIPT_WAIT_MS / 1000}s, so whether it was recorded is unknown`,
            retryable: true,
            details: { txHash: sent.hash },
          });
        }

        const verdict = classifySubmission(receipt.status ?? 0, receipt.gasUsed, gasLimit, sent.hash);
        if (verdict.outcome !== "APPLIED") {
          return err({
            category: "CHAIN",
            code: verdict.outcome === "GAS_EXHAUSTED" ? "RECORD_DELIVERY_GAS_EXHAUSTED" : "RECORD_DELIVERY_REVERTED",
            message: verdict.detail,
            retryable: verdict.outcome === "GAS_EXHAUSTED",
            details: {
              txHash: verdict.txHash,
              gasUsed: verdict.gasUsed.toString(10),
              gasLimit: verdict.gasLimit.toString(10),
            },
          });
        }

        // A mined transaction carries no return data, so the figures come from the
        // simulation that gated it. They are the contract's own answer against the
        // same state, which is why the simulation is mandatory rather than advisory.
        return ok({ ...preflight.value, creditcoinTxHash: sent.hash as `0x${string}`, recordedAt: now() });
      } catch (error) {
        return err(refusal(error, "the delivery broadcast"));
      }
    },

    async openTabOf(delivery): Promise<Result<bigint>> {
      try {
        const tabIdData = TAB_BOOK_INTERFACE.encodeFunctionData("tabIdOf", [
          delivery.agent,
          delivery.serviceId,
          delivery.asset,
        ]);
        const tabId = TAB_BOOK_INTERFACE.decodeFunctionResult(
          "tabIdOf",
          await provider.call({ to: tabBook, data: tabIdData, blockTag }),
        )[0] as string;

        const tabData = TAB_BOOK_INTERFACE.encodeFunctionData("tabOf", [tabId]);
        const tab = TAB_BOOK_INTERFACE.decodeFunctionResult(
          "tabOf",
          await provider.call({ to: tabBook, data: tabData, blockTag }),
        )[0] as readonly unknown[];
        return ok(BigInt(tab[0] as bigint));
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "OPEN_TAB_UNREADABLE",
          message: "the Open Tab could not be read, so a refusal cannot carry its charge headers",
          retryable: true,
          cause: causeOf(error),
        });
      }
    },

    async creditLimit(agent, asset): Promise<Result<bigint>> {
      const witness = await options.witnessFor(agent, asset);
      if (!witness.ok) return witness;
      try {
        const data = TAB_BOOK_INTERFACE.encodeFunctionData("creditLimit", [
          agent,
          asset,
          witnessTuple(witness.value),
        ]);
        const returned = await provider.call({ to: tabBook, data, blockTag });
        return ok(BigInt(TAB_BOOK_INTERFACE.decodeFunctionResult("creditLimit", returned)[0] as bigint));
      } catch (error) {
        return err(refusal(error, "the Credit Limit read"));
      }
    },
  };
}
