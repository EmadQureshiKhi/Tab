/**
 * The metering claim: what a signed metered request binds, and who may sign it.
 *
 * ## Two signers, one digest
 *
 * A metered call records a delivery on chain and spends the Service operator's
 * gas, so a metering endpoint anyone can reach must know the call was meant.
 * Two parties can say so, and the digest they sign is the same string:
 *
 *   - **The operator**, from the Service's own front, which has authenticated
 *     its caller however it likes. `Tab-Operator-Signature` carries it.
 *   - **The Agent**, whose Open Tab the charge lands on. `Tab-Agent-Signature`
 *     carries it, recovered against the address in `Tab-Agent`, so the one
 *     party that pays for the call is the one that asked for it, and a
 *     stranger who knows an Agent's address can put nothing on its tab.
 *
 * The digest binds the method, the path, the Agent, the tool, the unit count
 * and a timestamp. Binding the Agent and the units is the point: a signature
 * over the path alone would be a bearer token that replays against a
 * different Agent for a different amount. The timestamp bounds replay to a
 * window the gateway checks.
 *
 * ## Why it is written out and not JSON
 *
 * Newline-separated and fully ordered, so two different claims can never
 * produce one digest. JSON key order is not guaranteed across
 * implementations, and a signature over a reordered object would fail for a
 * caller who did nothing wrong.
 */

import { encodeBytes32String } from "ethers";

import type { ServiceHeaderProvider, ServiceHeaderRequest } from "../payments/config.js";

/** The headers a signed metering request carries, by who signed it. */
export const METERING_HEADER = {
  operatorSignature: "Tab-Operator-Signature",
  operatorIssuedAt: "Tab-Operator-Issued-At",
  agentSignature: "Tab-Agent-Signature",
  agentIssuedAt: "Tab-Agent-Issued-At",
} as const;

/** The fields a metering request signature binds. */
export interface MeteringRequestClaim {
  readonly method: string;
  readonly path: string;
  readonly agent: string;
  /** The 32-byte tool key the price list is keyed by, never the label. */
  readonly tool: string;
  readonly units: number;
  /** Milliseconds since the epoch, as the caller stated it. */
  readonly issuedAt: number;
}

/**
 * The first line of every metering digest. A signing policy can allow
 * `personal_sign` for messages that start with it and refuse the rest.
 */
export const METERING_DIGEST_PREFIX = "tab-metering-request" as const;

/** The exact string a signer signs, with EIP-191 `personal_sign`. */
export function meteringDigest(claim: MeteringRequestClaim): string {
  return [
    METERING_DIGEST_PREFIX,
    claim.method.toUpperCase(),
    claim.path,
    claim.agent.toLowerCase(),
    claim.tool.toLowerCase(),
    String(claim.units),
    String(claim.issuedAt),
  ].join("\n");
}

/** A signer that can `personal_sign`. An ethers `Wallet` satisfies it. */
export interface MeteringSigner {
  getAddress(): Promise<string>;
  signMessage(message: string): Promise<string>;
}

/** A tool name as the caller gave it, packed to the key the price list holds, unless it already is one. */
export function toolKeyOf(tool: string): string {
  return (/^0x[0-9a-fA-F]{64}$/.test(tool) ? tool : encodeBytes32String(tool)).toLowerCase();
}

/**
 * A header provider that signs every metered call as the Agent.
 *
 * Put it on a Service entry in `tab.config` and `tab_call` sends
 * `Tab-Agent-Signature` and `Tab-Agent-Issued-At` with each call, signed by
 * the key the factory returns. A factory, like the strategies, so the key is
 * built only when a call is made and every read stays keyless; one that
 * returns nothing sends the call unsigned, and a gateway that requires a
 * signature says so in its refusal.
 *
 * It signs only when the key it is given is the Agent the call is metered
 * against, because that is what the gateway recovers the signature against.
 * A key for anyone else adds nothing and the Service decides: one that
 * requires a signature refuses by name, and one that does not is unaffected.
 * That is the case where the Agent comes from somewhere other than this
 * config, such as a wallet the MetaMask Agent Wallet plugin reads, and it is
 * an honest "this key is not that Agent" rather than a signature that could
 * only be rejected.
 */
export function agentSignedMetering(
  signer: () => MeteringSigner | undefined,
  options: { readonly now?: () => number } = {},
): ServiceHeaderProvider {
  const now = options.now ?? (() => Date.now());
  return async (request: ServiceHeaderRequest) => {
    const wallet = signer();
    if (wallet === undefined) return {};
    const address = (await wallet.getAddress()).toLowerCase();
    if (address !== request.agent.toLowerCase()) return {};
    const issuedAt = now();
    const digest = meteringDigest({
      method: request.method,
      path: new URL(request.url).pathname,
      agent: address,
      tool: toolKeyOf(request.tool),
      units: 1,
      issuedAt,
    });
    return {
      [METERING_HEADER.agentSignature]: await wallet.signMessage(digest),
      [METERING_HEADER.agentIssuedAt]: String(issuedAt),
    };
  };
}
