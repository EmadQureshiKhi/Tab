/**
 * Act one. Each Agent states what it is willing to owe.
 *
 * A spending authorisation is the Agent's side of the arrangement and the only
 * thing standing between a Service's operator key and the Agent's whole credit
 * line. It names a Service, an Asset, a ceiling and an expiry, and only the Agent
 * itself can set it.
 *
 * **Setting one replaces it wholesale, and `spent` returns to zero.** That is the
 * contract's deliberate behaviour: an Agent raising a ceiling is stating a fresh
 * intent, and carrying the old `spent` forward would silently make the new ceiling
 * smaller than the number written in the call. It also means running this act
 * against an Agent that is already authorised is not free of consequence, so the
 * act reads the existing authorisation first and leaves an adequate one alone
 * unless `--reauthorise` says otherwise.
 *
 * Requirements: 12.1, 12.2, 22.4
 */

import { Interface, JsonRpcProvider, Wallet } from "ethers";

import type { Result } from "@tabai/shared";
import { err, ok } from "@tabai/shared";

import { readLedger } from "../chain.js";
import type { AgentLedger } from "../ledger.js";
import { formatBaseUnits } from "../narrate.js";
import { creditcoinRoleFor } from "../secrets.js";
import { agentsInScope, type Act, type ActContext, type ActOutcome } from "./index.js";

/**
 * Stated, not estimated.
 *
 * Measured on this deployment: `authorise` cost 307,986 gas. An estimate comes
 * from a warm simulation and reads low against a cold storage write, and a limit
 * that is exactly exhausted returns `status 0` with `gasUsed == gasLimit`, which
 * is indistinguishable from a revert unless the two are compared. The stated
 * limit therefore sits above the measurement rather than beside it.
 */
export const AUTHORISE_GAS_LIMIT = 450_000n;

export const AUTHORISE_ABI = [
  "function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry)",
] as const;

export const AUTHORISE_INTERFACE = new Interface([...AUTHORISE_ABI]);

/** Whether an existing authorisation leaves room for the planned spend. */
export interface AuthorisationVerdict {
  readonly adequate: boolean;
  readonly reason: string;
  readonly remaining: bigint;
}

/**
 * Decides whether an Agent needs a new authorisation.
 *
 * Pure, because this is the judgement the act turns on and it has three
 * interesting cases that no live run reaches in one pass: no record at all, a
 * record that has lapsed, and a record whose remaining headroom is too small.
 */
export function assessAuthorisation(
  ledger: AgentLedger,
  needed: bigint,
  nowSeconds: number,
): AuthorisationVerdict {
  if (!ledger.authorised) {
    return { adequate: false, reason: "there is no authorisation for this Service and Asset", remaining: 0n };
  }
  if (ledger.authorisationExpiry <= nowSeconds) {
    return {
      adequate: false,
      reason: `the authorisation expired at ${new Date(ledger.authorisationExpiry * 1000).toISOString()}`,
      remaining: 0n,
    };
  }
  const remaining =
    ledger.authorisationCeiling > ledger.authorisationSpent
      ? ledger.authorisationCeiling - ledger.authorisationSpent
      : 0n;
  if (remaining < needed) {
    return {
      adequate: false,
      reason: `${String(remaining)} base units remain under the ceiling and the act needs ${String(needed)}`,
      remaining,
    };
  }
  return { adequate: true, reason: `${String(remaining)} base units remain under the ceiling`, remaining };
}

export const authoriseAct: Act = {
  id: "authorise",
  number: 1,
  title: "Each Agent states what it is willing to owe",
  synopsis:
    "Every Agent sets its own spending authorisation on TabBook: a Service, an Asset, a ceiling and an expiry. Nobody else can set it and nothing is prepaid.",

  async run(context: ActContext): Promise<Result<ActOutcome>> {
    const { cast, providers, options, log } = context;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiry = BigInt(nowSeconds + options.ttlSeconds);
    const gasLimit = options.gas ?? AUTHORISE_GAS_LIMIT;
    const needed = BigInt(options.units) * 10_000n;

    const results: Record<string, unknown>[] = [];
    let allWell = true;
    let broadcastAny = false;

    for (const agent of agentsInScope(cast, options)) {
      const index = cast.agents.findIndex((candidate) => candidate.name === agent.name);
      const before = await readLedger(providers, cast, agent);
      const verdict = assessAuthorisation(before, needed, nowSeconds);

      log(`  ${agent.name}: ${verdict.reason}`);

      if (verdict.adequate) {
        log(`    leaving the existing authorisation alone; setting a new one would reset spent to zero`);
        results.push({ agent: agent.name, action: "kept", remaining: verdict.remaining.toString() });
        continue;
      }

      const data = AUTHORISE_INTERFACE.encodeFunctionData("authorise", [
        cast.serviceId,
        cast.asset.address,
        options.ceiling,
        expiry,
      ]);

      // Simulated from the Agent's own address. A keyless `eth_call` runs as the
      // zero address, and this call writes to storage keyed by `msg.sender`, so a
      // simulation from nobody would report a change to nobody's authorisation.
      try {
        await providers.creditcoin.call({ to: cast.tabBook, data, from: agent.creditcoin });
      } catch (error) {
        allWell = false;
        log(`    simulation refused: ${String(error)}`);
        results.push({ agent: agent.name, action: "refused", error: String(error) });
        continue;
      }

      log(
        `    would grant a ceiling of ${formatBaseUnits(options.ceiling, cast.asset.decimals, cast.asset.symbol)} expiring ${new Date(Number(expiry) * 1000).toISOString()}`,
      );

      if (!options.broadcast) {
        results.push({
          agent: agent.name,
          action: "simulated",
          ceiling: options.ceiling.toString(),
          expiry: expiry.toString(),
        });
        continue;
      }

      const key = context.secrets.keyFor(creditcoinRoleFor(index));
      if (!key.ok) return key;
      const wallet = new Wallet(key.value, providers.creditcoin as JsonRpcProvider);
      if (wallet.address.toLowerCase() !== agent.creditcoin.toLowerCase()) {
        return err({
          category: "VALIDATION",
          code: "DEMO_KEY_IS_NOT_THE_AGENT",
          message: `the key configured for ${agent.name} controls ${wallet.address}, not ${agent.creditcoin}`,
          retryable: false,
        });
      }

      const sent = await wallet.sendTransaction({ to: cast.tabBook, data, gasLimit });
      log(`    submitted ${sent.hash}`);
      const receipt = await sent.wait();
      broadcastAny = true;
      const exhausted = receipt !== null && receipt.gasUsed === gasLimit;
      const applied = receipt !== null && receipt.status === 1;
      if (!applied) allWell = false;
      log(
        `    ${applied ? "applied" : "refused"} in block ${String(receipt?.blockNumber ?? 0)} using ${String(receipt?.gasUsed ?? 0n)} of ${String(gasLimit)} gas${exhausted ? " - the limit was exhausted, which is not the same as a revert" : ""}`,
      );

      const after = await readLedger(providers, cast, agent);
      results.push({
        agent: agent.name,
        action: applied ? "authorised" : "reverted",
        txHash: sent.hash,
        gasUsed: (receipt?.gasUsed ?? 0n).toString(),
        ceiling: after.authorisationCeiling.toString(),
        spent: after.authorisationSpent.toString(),
        expiry: after.authorisationExpiry,
      });
    }

    return ok({
      act: "authorise",
      ok: allWell,
      broadcast: broadcastAny,
      summary: allWell
        ? "every Agent in scope holds an adequate spending authorisation"
        : "at least one Agent could not be authorised",
      detail: { agents: results },
    });
  },
};
