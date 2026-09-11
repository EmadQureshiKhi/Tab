/**
 * The settlement relay: the gateway pays the gas for an Agent's Settlement.
 *
 * ## Why a Service relays
 *
 * `TabSettlement.settleWithPermit2` lets anyone submit an Agent's signed
 * Settlement. The signature binds the Service, the Asset and the amount, so a
 * relayer can only cause the Agent to be settled with exactly this Service for
 * exactly what the Agent signed. The Service wants that to happen: a settled
 * tab is a paid Service, and an Agent with headroom again is an Agent that
 * keeps buying. So the gateway is the natural relayer, and an Agent needs no
 * MON at all once it has approved Permit2 once.
 *
 * ## Simulate, then send
 *
 * Every relayed permit is run through `eth_call` first, from the operator. A
 * bad signature, a spent nonce, a lapsed deadline, an Asset the Service does
 * not accept: all of them are refused here for free, with the revert named,
 * rather than paid for as a mined failure. That is also the whole of the
 * gateway's defence against gas griefing: a request that would revert costs
 * the relayer one RPC read and nothing else, and a request that would succeed
 * is a Settlement the Service wanted.
 *
 * ## No signature over the request
 *
 * The relay route carries no operator signature and no `Tab-Agent` claim,
 * deliberately. The permit is the authentication: only the Agent could have
 * produced it, and it says everything the contract will act on.
 */

import { Interface, type JsonRpcProvider, type Signer } from "ethers";
import { PERMIT2_ADDRESS, TAB_SETTLEMENT_PERMIT2_ABI, causeOf, err, ok, type Address, type Result, type TabError } from "@tabai/shared";
import { decodeSettled, encodeSettleWithPermit2, fromRelayBody, type RelaySettleReply, type SettlementPermit } from "@tabai/sdk";

/** Every revert a relayed settlement can surface, named so a refusal reads as one. */
const RELAY_ERRORS = [
  "error InvalidSignatureLength()",
  "error InvalidSignature()",
  "error InvalidSigner()",
  "error InvalidContractSignature()",
  "error InvalidAmount(uint256 maxAmount)",
  "error SignatureExpired(uint256 signatureDeadline)",
  "error InvalidNonce()",
  "error ZeroAddressField()",
  "error AssetNotAccepted(bytes32 serviceId, address asset)",
  "error UnknownService(bytes32 serviceId)",
  "error NotSettlementSurface(address caller)",
  "error ZeroAmount()",
  "error AmountOutOfRange(uint256 amount)",
] as const;

const RELAY_INTERFACE = new Interface([...TAB_SETTLEMENT_PERMIT2_ABI, ...RELAY_ERRORS]);

/**
 * The most gas a relayed Settlement is ever stated with, and the least.
 *
 * Monad charges the limit a transaction states rather than the gas it uses,
 * so the limit is the relayer's cost and a loose one is money spent for
 * nothing. The relay estimates each Settlement and states the estimate plus
 * {@link RELAY_GAS_MARGIN_BPS}, clamped between these two: the floor covers a
 * cold write the estimate can undercount, the ceiling bounds what one call
 * can cost the relayer whatever the estimate says. An estimate that cannot
 * be made falls back to the ceiling, which is never wrong, only dear.
 */
export const RELAY_GAS_LIMIT = 900_000n;
export const RELAY_GAS_FLOOR = 400_000n;
export const RELAY_GAS_MARGIN_BPS = 3_000n;

/** How long a relay waits for its receipt before it reports the hash as unconfirmed. */
export const RELAY_RECEIPT_WAIT_MS = 120_000;

/** What the relay needs, narrow enough to fake. */
export interface SettlementRelayOptions {
  readonly provider: Pick<JsonRpcProvider, "call" | "waitForTransaction"> & Partial<Pick<JsonRpcProvider, "estimateGas">>;
  readonly signer: Pick<Signer, "sendTransaction" | "getAddress">;
  /** The `TabSettlement` this gateway relays for. A permit naming another one is refused. */
  readonly tabSettlement: Address;
  readonly chainId: bigint;
  readonly permit2?: Address;
  readonly gasLimit?: bigint;
  readonly now?: () => number;
}

export interface SettlementRelay {
  /** Reads a JSON body, checks it against this deployment, simulates, sends, and reports. */
  relay(body: unknown): Promise<Result<RelaySettleReply>>;
}

/** Names a revert from its data, or says it could not. */
function describeRevert(error: unknown): { readonly name: string | null; readonly detail: string } {
  const data = (error as { data?: unknown; error?: { data?: unknown } })?.data ?? (error as { error?: { data?: unknown } })?.error?.data;
  if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
    try {
      const parsed = RELAY_INTERFACE.parseError(data);
      if (parsed !== null) return { name: parsed.name, detail: `${parsed.name}(${parsed.args.map(String).join(", ")})` };
    } catch {
      // Not one of the named reverts. Reported as raw below.
    }
    return { name: null, detail: `revert data ${data.slice(0, 74)}` };
  }
  return { name: null, detail: causeOf(error).message };
}

const REFUSAL_BY_REVERT: Readonly<Record<string, { readonly category: TabError["category"]; readonly code: string; readonly message: string }>> = {
  InvalidSigner: { category: "AUTHORISATION", code: "PERMIT_SIGNER_MISMATCH", message: "the signature does not recover to the Agent it names" },
  InvalidSignature: { category: "VALIDATION", code: "PERMIT_SIGNATURE_INVALID", message: "the signature is malformed" },
  InvalidSignatureLength: { category: "VALIDATION", code: "PERMIT_SIGNATURE_INVALID", message: "the signature is not 65 bytes" },
  InvalidContractSignature: { category: "AUTHORISATION", code: "PERMIT_SIGNER_MISMATCH", message: "the contract signer refused the signature" },
  SignatureExpired: { category: "VALIDATION", code: "PERMIT_EXPIRED", message: "the permit's deadline has passed; sign a fresh one" },
  InvalidNonce: { category: "CONFLICT", code: "PERMIT_NONCE_USED", message: "this nonce was already spent, so the Settlement it carried has already happened or was cancelled" },
  InvalidAmount: { category: "VALIDATION", code: "PERMIT_AMOUNT_INVALID", message: "the requested amount exceeds what the permit allows" },
  AssetNotAccepted: { category: "VALIDATION", code: "ASSET_NOT_ACCEPTED", message: "the Service does not accept this Asset" },
  UnknownService: { category: "NOT_FOUND", code: "SERVICE_UNKNOWN", message: "no Service is registered under that id" },
  ZeroAmount: { category: "VALIDATION", code: "AMOUNT_ZERO", message: "a Settlement of zero moves nothing" },
};

export function createSettlementRelay(options: SettlementRelayOptions): SettlementRelay {
  const permit2 = options.permit2 ?? (PERMIT2_ADDRESS as Address);
  const gasLimit = options.gasLimit ?? RELAY_GAS_LIMIT;
  const now = options.now ?? (() => Date.now());

  const refuse = (permit: SettlementPermit, error: unknown, stage: string): Result<never> => {
    const revert = describeRevert(error);
    const known = revert.name === null ? undefined : REFUSAL_BY_REVERT[revert.name];
    if (known !== undefined) {
      return err({ ...known, retryable: false, details: { stage, revert: revert.detail, agent: permit.agent, serviceId: permit.serviceId } });
    }
    return err({
      category: "CHAIN",
      code: "RELAY_SIMULATION_FAILED",
      message: `the relayed Settlement would not succeed: ${revert.detail}`,
      retryable: false,
      details: { stage, agent: permit.agent, serviceId: permit.serviceId },
    });
  };

  return {
    async relay(body): Promise<Result<RelaySettleReply>> {
      const parsed = fromRelayBody(body, permit2);
      if (!parsed.ok) return parsed;
      const permit = parsed.value;
      if (permit.chainId !== options.chainId) {
        return err({
          category: "VALIDATION",
          code: "PERMIT_CHAIN_MISMATCH",
          message: `the permit was signed for chain ${permit.chainId.toString(10)} and this relay settles on ${options.chainId.toString(10)}`,
          retryable: false,
        });
      }
      if (permit.tabSettlement.toLowerCase() !== options.tabSettlement.toLowerCase()) {
        return err({
          category: "VALIDATION",
          code: "PERMIT_SURFACE_MISMATCH",
          message: `the permit names TabSettlement ${permit.tabSettlement} and this relay serves ${options.tabSettlement}`,
          retryable: false,
        });
      }
      if (permit.deadline <= BigInt(Math.floor(now() / 1000))) {
        return err({ category: "VALIDATION", code: "PERMIT_EXPIRED", message: "the permit's deadline has passed; sign a fresh one", retryable: false });
      }

      const data = encodeSettleWithPermit2(permit);
      const from = await options.signer.getAddress();
      try {
        await options.provider.call({ to: options.tabSettlement, data, from });
      } catch (error) {
        return refuse(permit, error, "simulation");
      }

      // Stated from an estimate, because the limit is what the relayer pays.
      let stated = gasLimit;
      if (options.gasLimit === undefined && options.provider.estimateGas !== undefined) {
        try {
          const estimate = await options.provider.estimateGas({ to: options.tabSettlement, data, from });
          const padded = (estimate * (10_000n + RELAY_GAS_MARGIN_BPS)) / 10_000n;
          stated = padded < RELAY_GAS_FLOOR ? RELAY_GAS_FLOOR : padded > RELAY_GAS_LIMIT ? RELAY_GAS_LIMIT : padded;
        } catch {
          stated = gasLimit;
        }
      }

      let hash: string;
      try {
        const sent = await options.signer.sendTransaction({ to: options.tabSettlement, data, gasLimit: stated });
        hash = sent.hash;
      } catch (error) {
        return err({
          category: "CHAIN",
          code: "RELAY_SUBMISSION_FAILED",
          message: `the relayed Settlement could not be submitted: ${causeOf(error).message}`,
          retryable: true,
        });
      }

      let receipt;
      try {
        receipt = await options.provider.waitForTransaction(hash, 1, RELAY_RECEIPT_WAIT_MS);
      } catch (error) {
        return err({ category: "CHAIN", code: "RELAY_UNCONFIRMED", message: `the relayed Settlement ${hash} has no receipt yet: ${causeOf(error).message}`, retryable: true, details: { txHash: hash } });
      }
      if (receipt === null) {
        return err({ category: "CHAIN", code: "RELAY_UNCONFIRMED", message: `the relayed Settlement ${hash} has no receipt within ${RELAY_RECEIPT_WAIT_MS / 1000}s`, retryable: true, details: { txHash: hash } });
      }
      if (receipt.status !== 1) {
        return err({ category: "CHAIN", code: "RELAY_REVERTED", message: `the relayed Settlement ${hash} was mined and reverted`, retryable: false, details: { txHash: hash } });
      }
      const settled = receipt.logs.map((log) => decodeSettled(log, options.tabSettlement)).find((entry) => entry !== null) ?? null;
      return ok({
        ok: true,
        txHash: hash,
        settlementId: settled?.settlementId ?? null,
        applied: settled === null ? null : settled.applied.toString(10),
        toPrepaid: settled === null ? null : settled.toPrepaid.toString(10),
      });
    },
  };
}
