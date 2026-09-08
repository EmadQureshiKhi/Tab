/**
 * The setup act. Proving that a Source Chain address belongs to an Agent.
 *
 * Nothing else in the demo works until this has happened. A tab is keyed by an
 * Agent's Creditcoin address, a Settlement arrives as a log on another chain, and
 * the only thing joining the two is a binding. Requirement 8 resolves the payer
 * from `topics[1]` and then asks the registry whose address that is; an unbound
 * address resolves to nobody and the payment credits nobody.
 *
 * The proof of control is a payment of an **exact odd amount**. The registry
 * issues a nonce, the amount encodes it, and the address being bound must be the
 * one that pays it. Nobody signs a challenge and no oracle is trusted: the ability
 * to move that address's money is the evidence, and it is checked by the same
 * Continuity Proof path every other Settlement goes through.
 *
 * This is numbered outside the four acts because it is stage-setting rather than
 * story. It is idempotent: an address already bound to the right Agent is left
 * alone, and a request already open is reported with the amount still owed rather
 * than replaced.
 *
 * Requirements: 10.1, 10.2, 10.3, 8.4
 */

import { Interface, JsonRpcProvider, Wallet } from "ethers";

import type { Address, Result } from "@tabai/shared";
import { err, ok } from "@tabai/shared";

import type { AgentIdentity } from "../cast.js";
import { boundAgentOf, callView } from "../chain.js";
import { formatBaseUnits } from "../narrate.js";
import { creditcoinRoleFor, ethereumRoleFor } from "../secrets.js";
import { agentsInScope, type Act, type ActContext, type ActOutcome } from "./index.js";

/** Stated, not estimated. A nonce allocation plus two cold storage writes. */
export const REQUEST_BINDING_GAS_LIMIT = 350_000n;

/** Stated, not estimated. An ERC-20 transfer, either direct or through the relay. */
export const BINDING_TRANSFER_GAS_LIMIT = 120_000n;

export const REGISTRY_BIND_ABI = [
  "function requestBinding(uint64 chainKey, address ethAddress) returns (uint16 nonce, uint256 requiredAmount, uint64 expiresAt)",
  "function pendingBinding(uint64 chainKey, address ethAddress, address agent) view returns ((address agent, uint16 nonce, uint64 issuedAt, bool open) pending, uint64 expiresAt, bool alive)",
  "function requiredAmountForNonce(uint16 nonce) pure returns (uint256)",
] as const;

export const ERC20_TRANSFER_ABI = ["function transfer(address to, uint256 amount) returns (bool)"] as const;

export const SOURCE_RELAY_BIND_ABI = ["function relay(address asset, address to, uint256 amount)"] as const;

export const REGISTRY_BIND_INTERFACE = new Interface([...REGISTRY_BIND_ABI]);
export const ERC20_TRANSFER_INTERFACE = new Interface([...ERC20_TRANSFER_ABI]);
export const SOURCE_RELAY_BIND_INTERFACE = new Interface([...SOURCE_RELAY_BIND_ABI]);

/** One address a run was asked to bind. */
export interface BindingTarget {
  readonly agent: AgentIdentity;
  /** Index into the cast, which selects the signing role. */
  readonly index: number;
  readonly sourceAddress: Address;
  /** True when the address is a contract that has to be told to pay. */
  readonly viaSmartAccount: boolean;
}

/**
 * Every address in scope that could need binding, wallets before smart accounts.
 *
 * Pure. Ordering matters to the story: an Agent's wallet is what pays for its own
 * smart account's binding in the ordinary case, so it wants to exist first.
 */
export function bindingTargets(
  agents: readonly AgentIdentity[],
  castOrder: readonly AgentIdentity[],
): readonly BindingTarget[] {
  const targets: BindingTarget[] = [];
  const indexOf = (agent: AgentIdentity): number =>
    castOrder.findIndex((candidate) => candidate.creditcoin === agent.creditcoin);
  for (const agent of agents) {
    targets.push({ agent, index: indexOf(agent), sourceAddress: agent.ethereum, viaSmartAccount: false });
  }
  for (const agent of agents) {
    if (agent.smartAccount !== undefined) {
      targets.push({
        agent,
        index: indexOf(agent),
        sourceAddress: agent.smartAccount,
        viaSmartAccount: true,
      });
    }
  }
  return targets;
}

export const bindAct: Act = {
  id: "bind",
  number: -1,
  title: "Proving a Source Chain address belongs to an Agent",
  synopsis:
    "The registry issues a nonce, the amount encodes it, and the address being bound pays it. Control of the money is the proof; nobody signs a challenge.",

  async run(context: ActContext): Promise<Result<ActOutcome>> {
    const { cast, providers, options, log } = context;
    const results: Record<string, unknown>[] = [];
    let allWell = true;
    let broadcastAny = false;

    for (const target of bindingTargets(agentsInScope(cast, options), cast.agents)) {
      const label = `${target.agent.name}'s ${target.viaSmartAccount ? "smart account" : "wallet"} ${target.sourceAddress}`;
      const bound = await boundAgentOf(providers, cast, target.sourceAddress);

      if (bound.toLowerCase() === target.agent.creditcoin.toLowerCase()) {
        log(`  ${label} is already bound to ${target.agent.name}`);
        results.push({ address: target.sourceAddress, action: "already-bound" });
        continue;
      }
      if (bound !== "0x0000000000000000000000000000000000000000") {
        allWell = false;
        log(`  ${label} is bound to ${bound}, which is not ${target.agent.name}; a second Agent cannot claim it`);
        results.push({ address: target.sourceAddress, action: "bound-elsewhere", boundTo: bound });
        continue;
      }

      // An open request holds its nonce for 24 hours, so re-running this act after
      // a failed payment must reuse the amount already issued rather than burn a
      // second nonce that the first payment could never satisfy.
      const openRequest = await callView(
        providers.creditcoin,
        cast.agentRegistry,
        REGISTRY_BIND_INTERFACE,
        "pendingBinding",
        [cast.asset.chainKey, target.sourceAddress, target.agent.creditcoin],
      );
      const pending = openRequest[0] as readonly unknown[];
      const expiresAt = openRequest[1] as bigint;
      const alive = openRequest[2] as boolean;

      let requiredAmount: bigint;
      let nonce: bigint;

      if (alive) {
        nonce = pending[1] as bigint;
        requiredAmount = (
          await callView(
            providers.creditcoin,
            cast.agentRegistry,
            REGISTRY_BIND_INTERFACE,
            "requiredAmountForNonce",
            [nonce],
          )
        )[0] as bigint;
        log(
          `  ${label} already has an open request for nonce ${String(nonce)}, expiring ${new Date(Number(expiresAt) * 1000).toISOString()}`,
        );
      } else {
        // Simulated from the Agent's own address: `requestBinding` writes storage
        // keyed by `msg.sender`, so a keyless call would allocate a nonce to nobody.
        const simulated = REGISTRY_BIND_INTERFACE.decodeFunctionResult(
          "requestBinding",
          await providers.creditcoin.call({
            to: cast.agentRegistry,
            data: REGISTRY_BIND_INTERFACE.encodeFunctionData("requestBinding", [
              cast.asset.chainKey,
              target.sourceAddress,
            ]),
            from: target.agent.creditcoin,
          }),
        );
        nonce = simulated[0] as bigint;
        requiredAmount = simulated[1] as bigint;
        log(`  ${label} would be issued nonce ${String(nonce)}`);

        if (options.broadcast) {
          const key = context.secrets.keyFor(creditcoinRoleFor(target.index));
          if (!key.ok) return key;
          const wallet = new Wallet(key.value, providers.creditcoin as JsonRpcProvider);
          const data = REGISTRY_BIND_INTERFACE.encodeFunctionData("requestBinding", [
            cast.asset.chainKey,
            target.sourceAddress,
          ]);
          const sent = await wallet.sendTransaction({
            to: cast.agentRegistry,
            data,
            gasLimit: options.gas ?? REQUEST_BINDING_GAS_LIMIT,
          });
          const receipt = await sent.wait();
          broadcastAny = true;
          if (receipt === null || receipt.status !== 1) {
            allWell = false;
            log(`    the request was refused in ${sent.hash}`);
            results.push({ address: target.sourceAddress, action: "request-reverted", txHash: sent.hash });
            continue;
          }
          log(`    requested in ${sent.hash} using ${String(receipt.gasUsed)} gas`);
          requiredAmount = (
            await callView(
              providers.creditcoin,
              cast.agentRegistry,
              REGISTRY_BIND_INTERFACE,
              "requiredAmountForNonce",
              [nonce],
            )
          )[0] as bigint;
        }
      }

      log(
        `    the binding payment is exactly ${formatBaseUnits(requiredAmount, cast.asset.decimals, cast.asset.symbol)}, from ${target.sourceAddress} to ${cast.collectionAddress}`,
      );

      if (!options.broadcast) {
        results.push({
          address: target.sourceAddress,
          action: "planned",
          nonce: nonce.toString(),
          requiredAmount: requiredAmount.toString(),
        });
        continue;
      }

      // The payer must be the address being bound, so a wallet pays for itself and
      // a smart account is told to pay. In the second case the sender is somebody
      // else entirely, which is the same divergence act four turns on.
      let sent;
      if (target.viaSmartAccount) {
        const senderAgent = cast.agents.find(
          (candidate) => candidate.creditcoin !== target.agent.creditcoin,
        );
        if (senderAgent === undefined) {
          return err({
            category: "VALIDATION",
            code: "DEMO_NO_RELAY_CALLER",
            message: "a smart account has to be told to pay and no other Agent is in the cast to tell it",
            retryable: false,
          });
        }
        const senderIndex = cast.agents.findIndex((candidate) => candidate.name === senderAgent.name);
        const key = context.secrets.keyFor(ethereumRoleFor(senderIndex));
        if (!key.ok) return key;
        const wallet = new Wallet(key.value, providers.source as JsonRpcProvider);
        sent = await wallet.sendTransaction({
          to: target.sourceAddress,
          data: SOURCE_RELAY_BIND_INTERFACE.encodeFunctionData("relay", [
            cast.asset.address,
            cast.collectionAddress,
            requiredAmount,
          ]),
          gasLimit: options.gas ?? BINDING_TRANSFER_GAS_LIMIT,
        });
        log(`    ${senderAgent.name}'s wallet told the smart account to pay, in ${sent.hash}`);
      } else {
        const key = context.secrets.keyFor(ethereumRoleFor(target.index));
        if (!key.ok) return key;
        const wallet = new Wallet(key.value, providers.source as JsonRpcProvider);
        sent = await wallet.sendTransaction({
          to: cast.asset.address,
          data: ERC20_TRANSFER_INTERFACE.encodeFunctionData("transfer", [
            cast.collectionAddress,
            requiredAmount,
          ]),
          gasLimit: options.gas ?? BINDING_TRANSFER_GAS_LIMIT,
        });
        log(`    paid in ${sent.hash}`);
      }

      const paid = await sent.wait();
      if (paid === null || paid.status !== 1) {
        allWell = false;
        log(`    the binding payment reverted; the nonce stays open for 24 hours and can be paid again`);
        results.push({ address: target.sourceAddress, action: "payment-reverted", txHash: sent.hash });
        continue;
      }

      log(
        `    the binding completes when the Watcher proves that payment. Until then agentOf(${String(cast.asset.chainKey)}, ${target.sourceAddress}) stays the zero address.`,
      );
      results.push({
        address: target.sourceAddress,
        action: "paid",
        nonce: nonce.toString(),
        requiredAmount: requiredAmount.toString(),
        sourceTxHash: sent.hash,
      });
    }

    return ok({
      act: "bind",
      ok: allWell,
      broadcast: broadcastAny,
      summary: allWell ? "every address in scope is bound or has been paid for" : "at least one binding could not proceed",
      detail: { targets: results },
    });
  },
};
