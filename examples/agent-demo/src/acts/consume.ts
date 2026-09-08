/**
 * Act two. The agents buy something and pay for none of it.
 *
 * This is the claim the whole product rests on. Each Agent makes an ordinary HTTP
 * request to the Service's metered endpoint, the Service does the work, returns
 * the response, and *then* records the charge against the Agent's Open Tab. No
 * caller prepays, no response is withheld, and the only status the rail adds is a
 * `402` when a charge would exceed the Agent's Credit Limit - which is a credit
 * decision rather than a demand for payment.
 *
 * The request goes over the real wire through the SDK's post-paid 402 client, so
 * the charge block on the response is parsed by the same file the Service formats
 * it with.
 *
 * ## Why this act holds the Service's key as well as the Agent's
 *
 * The gateway holds the operator key that can charge any Agent up to its whole
 * ceiling, so it refuses an unsigned metered request. The signature is the
 * **Service** saying "I delivered this and I am charging for it"; the Agent signs
 * nothing. A single-machine walkthrough therefore has to play both parts, and this
 * act mints that signature the way the Service's own front door would. In a real
 * deployment the two halves sit on different machines and the Agent never sees the
 * operator key.
 *
 * Requirements: 12.1, 16.1, 21.2, 23.2, 23.3
 */

import { Wallet } from "ethers";

import type { Result } from "@tabai/shared";
import { err, ok } from "@tabai/shared";

import { createTab402Client, type ChargeAccrued } from "@tabai/sdk";

import { readLedger } from "../chain.js";
import { diffLedger } from "../ledger.js";
import { describeDelta, formatBaseUnits } from "../narrate.js";
import { agentsInScope, type Act, type ActContext, type ActOutcome } from "./index.js";

/** Header carrying the Service operator's signature. Must match the gateway's own name. */
export const SIGNATURE_HEADER = "Tab-Operator-Signature";

/** Header carrying the millisecond timestamp the signature was issued at. */
export const ISSUED_AT_HEADER = "Tab-Operator-Issued-At";

/** The path the demo buys from. The gateway prices `/meter/*`. */
export const METERED_PATH = "/meter/proof";

/** The fields the operator signature binds. */
export interface MeteringClaim {
  readonly method: string;
  readonly path: string;
  readonly agent: string;
  readonly tool: string;
  readonly units: number;
  readonly issuedAt: number;
}

/**
 * The exact string the operator signs.
 *
 * **This is a second copy of the gateway's `meteringDigest`, and deliberately so.**
 * The demo may not depend on the gateway package, and reimplementing a digest is
 * exactly the kind of duplication that drifts silently. The defence is a test that
 * pins the output against the literal string, so a change on the gateway's side
 * that this file did not follow shows up as a failing assertion here rather than
 * as an unexplained `401` during a live run.
 */
export function meteringDigest(claim: MeteringClaim): string {
  return [
    "tab-metering-request",
    claim.method.toUpperCase(),
    claim.path,
    claim.agent.toLowerCase(),
    claim.tool.toLowerCase(),
    String(claim.units),
    String(claim.issuedAt),
  ].join("\n");
}

/** `bytes32` of a short tool name, right-padded, as the price list holds it. */
export function toolWord(name: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(name)) return name.toLowerCase();
  const bytes = Buffer.from(name, "utf8");
  return `0x${Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]).toString("hex")}`;
}

/** The priced unit this Service registered. Any other name is refused `UnknownTool`. */
export const DEFAULT_TOOL = "proof.generate";

export const consumeAct: Act = {
  id: "consume",
  number: 2,
  title: "The agents buy something and pay for none of it",
  synopsis:
    "Each Agent calls the metered endpoint over HTTP. The Service delivers first and records the charge afterwards, so the Open Tab rises and nothing is prepaid.",

  async run(context: ActContext): Promise<Result<ActOutcome>> {
    const { cast, providers, options, log } = context;

    if (!options.broadcast) {
      log("  a metered call writes to the chain, so this act does nothing without --broadcast");
      log(`  it would call POST ${cast.gatewayBaseUrl}${METERED_PATH} once per Agent, for ${String(options.units)} unit(s)`);
      return ok({
        act: "consume",
        ok: true,
        broadcast: false,
        summary: "described the metered call without making it",
        detail: { url: `${cast.gatewayBaseUrl}${METERED_PATH}`, units: options.units },
      });
    }

    const operatorKey = context.secrets.keyFor("service-operator");
    if (!operatorKey.ok) return operatorKey;
    const operator = new Wallet(operatorKey.value);
    const tool = toolWord(DEFAULT_TOOL);

    const results: Record<string, unknown>[] = [];
    let allWell = true;

    for (const agent of agentsInScope(cast, options)) {
      const before = await readLedger(providers, cast, agent);
      const charges: ChargeAccrued[] = [];

      const client = createTab402Client({
        baseUrl: cast.gatewayBaseUrl,
        agent: agent.creditcoin,
        onCharge: (charge) => charges.push(charge),
        fetchImpl: async (input, init) => {
          const response = await fetch(input, init as RequestInit);
          return {
            status: response.status,
            headers: response.headers,
            body: await response.text(),
          };
        },
      });

      const issuedAt = Date.now();
      const claim: MeteringClaim = {
        method: "POST",
        path: METERED_PATH,
        agent: agent.creditcoin,
        tool,
        units: 1,
        issuedAt,
      };
      const signature = await operator.signMessage(meteringDigest(claim));

      log(`  ${agent.name} calls POST ${cast.gatewayBaseUrl}${METERED_PATH}`);
      const response = await client.fetch(METERED_PATH, {
        method: "POST",
        headers: {
          [SIGNATURE_HEADER]: signature,
          [ISSUED_AT_HEADER]: String(issuedAt),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tool: DEFAULT_TOOL, units: options.units }),
      });

      if (!response.ok) {
        allWell = false;
        log(`    the call failed: ${response.error.code} ${response.error.message}`);
        results.push({ agent: agent.name, ok: false, error: response.error });
        continue;
      }

      // A cold-start Agent has no Credit Limit, and that is the product rather
      // than a fault. `LimitLib` caps credit by the Bonds of the Services the
      // Agent already has proven settlement history with, so an Agent with no
      // history has no counterparties, a bond cap of zero, and must settle first.
      // The act names that rather than reporting a broken call, because a reader
      // who saw only "refused" would conclude the rail is broken when it is
      // enforcing exactly the rule requirement 13 states.
      const coldStart = before.historyCount === 0;

      const status = response.value.status;
      const charge = charges.at(-1);
      log(`    the Service answered ${String(status)} and the response was delivered before anything was charged`);
      if (charge === undefined) {
        allWell = false;
        log("    but it carried no charge block, so nothing was metered");
      } else {
        log(`    charge ${formatBaseUnits(charge.amount, cast.asset.decimals, cast.asset.symbol)}`);
        log(`    open tab now ${formatBaseUnits(charge.openTab, cast.asset.decimals, cast.asset.symbol)}`);
        log(`    headroom now ${formatBaseUnits(charge.headroom, cast.asset.decimals, cast.asset.symbol)}`);
      }

      const after = await readLedger(providers, cast, agent);
      const delta = diffLedger(before, after);
      for (const line of describeDelta(agent.name, delta, cast.asset.decimals, cast.asset.symbol)) log(line);

      // A charge that raised prepaid rather than the tab is the task 12.6 fix in
      // the open: banked credit is spent before the Open Tab is raised, so an
      // Agent holding prepaid credit sees its balance fall and its tab stay flat.
      if (delta.prepaid < 0n) {
        log(`    the charge was met from banked prepaid credit, so the Open Tab did not move by the full amount`);
      }

      if (status === 402) {
        allWell = false;
        log("    the Service returned 402: the charge would have exceeded the Credit Limit");
        if (coldStart) {
          log(
            `    ${agent.name} has no proven settlement history, so no counterparty holds a Bond on its behalf and its Credit Limit is zero. That is the rule, not a fault: settle first, which banks prepaid credit and creates the history a limit is computed from, then buy on credit.`,
          );
        }
      }

      results.push({
        agent: agent.name,
        ok: response.ok && status !== 402,
        coldStart,
        status,
        charged: charge?.amount.toString(),
        openTab: charge?.openTab.toString(),
        headroom: charge?.headroom.toString(),
        openDelta: delta.open.toString(),
        prepaidDelta: delta.prepaid.toString(),
        deliveryDelta: delta.deliveryCount,
      });
    }

    if (results.length === 0) {
      return err({
        category: "VALIDATION",
        code: "DEMO_NO_AGENT_IN_SCOPE",
        message: `--agent named nobody in the cast`,
        retryable: false,
      });
    }

    return ok({
      act: "consume",
      ok: allWell,
      broadcast: true,
      summary: allWell
        ? "every Agent in scope was delivered a response and charged afterwards"
        : "at least one metered call did not complete",
      detail: { agents: results },
    });
  },
};
