/**
 * Resolving a Source Chain payer to the Creditcoin Agent that owns it (R10.3, R8.4).
 *
 * ## Why the clearing path cannot skip this
 *
 * A Settlement log names its payer in `topics[1]`, and that is an *Ethereum*
 * address. A tab is keyed on a *Creditcoin* Agent. The two are different
 * namespaces joined only by a proven binding in the `AgentRegistry`, so the
 * translation has to happen somewhere, and before a Provisional Clearing is the
 * only place it can: `TabBook.applyProvisionalClearing` takes an `agent` and
 * checks nothing about it beyond being non-zero.
 *
 * Passing the payer straight through was the defect this module closes. It does
 * not revert and it does not look wrong from the outside. The clearing opens
 * against `tabIdOf(payerAddress, serviceId, asset)`, a tab nobody meters into, so
 * the Service's Bond is genuinely reserved and later genuinely slashed while the
 * paying Agent's headroom never moves. The Agent is out its Settlement, the
 * Service is out its stake, and the Open Tab that should have fallen stays up.
 * Nothing on chain refuses any of it.
 *
 * The confirmation path cannot catch it afterwards either. A Verified Settlement
 * resolves its own Agent through `resolveOrBind`, so it arrives with the *right*
 * identity and looks for the clearing under the replay key, which exists but was
 * opened for someone else. `_confirmProvisional` compares the Asset and not the
 * Agent, so the mismatch is invisible at exactly the point it could still be
 * caught. That is a contract-side hardening worth a redeploy and is recorded as a
 * follow-up; the Watcher-side fix is here, and it is the one that stops the wrong
 * pledge being made at all.
 *
 * ## Unbound is a skip, never a guess
 *
 * `agentOf` answers the zero address for a payer no Agent has bound, and the
 * honest response is to observe the Settlement and offer it no clearing. The
 * money still reaches the Service on the Source Chain, and the Verified
 * Settlement still applies once it is proven, because `SettlementVerifier` calls
 * `resolveOrBind`, which can finalise a *pending* binding that `agentOf` cannot
 * see. So an unbound payer costs the Agent its instant headroom restoration and
 * costs it nothing else. Inventing an identity to pledge against would cost the
 * Service its stake.
 *
 * Requirements: 8.4, 10.3, 15.1, 15.2
 */

import { Interface, type BlockTag, type JsonRpcProvider } from "ethers";

import { err, ok, type ChainKey, type Result, type TabError } from "@tabai/shared";

import { requireAddress, type WatcherConfig } from "./config.js";
import { describeCause } from "./errors.js";

/** The 20-byte zero address, which is how the registry says "nobody". */
export const UNBOUND_AGENT = `0x${"00".repeat(20)}`;

/**
 * The one `AgentRegistry` read the Watcher makes.
 *
 * `agentOf` is `view` and needs no key, so resolution is a free `eth_call` at the
 * same pinned tag as every other read in a pass.
 */
export const AGENT_REGISTRY_ABI = [
  {
    type: "function",
    name: "agentOf",
    stateMutability: "view",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "ethAddress", type: "address" },
    ],
    outputs: [{ name: "agent", type: "address" }],
  },
] as const;

/** One resolution answer. */
export interface AgentResolution {
  /** The Creditcoin Agent, or undefined when the payer is bound to nobody. */
  readonly agent: string | undefined;
  readonly payer: string;
  readonly chainKey: ChainKey;
}

/** The registry surface the clearing path depends on, narrow enough to fake. */
export interface AgentRegistryReader {
  agentOf(chainKey: ChainKey, payer: string): Promise<Result<AgentResolution>>;
}

/**
 * Builds the reader over one provider at one pinned tag.
 *
 * Answers are cached per `(chainKey, payer)` for the life of the reader, because a
 * sweep commonly holds several Settlements from one Agent and a binding cannot be
 * revoked, so a resolved answer cannot go stale inside one pass. An *unresolved*
 * answer is cached too: a payer that is unbound at the top of a pass stays unbound
 * for it, and re-asking once per row would spend calls to learn the same thing.
 */
export function createAgentRegistryReader(
  provider: JsonRpcProvider,
  address: string,
  blockTag: BlockTag,
): AgentRegistryReader {
  const iface = new Interface(AGENT_REGISTRY_ABI);
  const cache = new Map<string, AgentResolution>();

  return {
    async agentOf(chainKey, payer): Promise<Result<AgentResolution>> {
      const key = `${chainKey}:${payer.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached !== undefined) return ok(cached);

      let returnData: string;
      try {
        returnData = await provider.call({
          to: address,
          data: iface.encodeFunctionData("agentOf", [BigInt(chainKey), payer]),
          blockTag,
        });
      } catch (error) {
        return err(readError(chainKey, payer, error));
      }

      try {
        const [raw] = iface.decodeFunctionResult("agentOf", returnData).toArray();
        const resolved = String(raw).toLowerCase();
        const resolution: AgentResolution = {
          agent: resolved === UNBOUND_AGENT ? undefined : resolved,
          payer: payer.toLowerCase(),
          chainKey,
        };
        cache.set(key, resolution);
        return ok(resolution);
      } catch (error) {
        return err(readError(chainKey, payer, error));
      }
    },
  };
}

function readError(chainKey: ChainKey, payer: string, error: unknown): TabError {
  return {
    category: "UPSTREAM",
    code: "AGENT_REGISTRY_READ_FAILED",
    message: `\`agentOf(${chainKey}, ${payer})\` could not be read from the AgentRegistry`,
    retryable: true,
    cause: describeCause(error),
  };
}

/** The `AgentRegistry` address, or an error naming the variable. */
export function requireAgentRegistry(config: WatcherConfig): Result<string> {
  return requireAddress(
    config.creditcoin.agentRegistry,
    "AGENT_REGISTRY_ADDRESS",
    "payer-to-Agent resolution on the clearing path",
  );
}
