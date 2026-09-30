/**
 * The Nansen section of `/agents/[agent]`, as its own streamed component.
 *
 * The registry serves an Agent's Nansen profile from a row it keeps for a week,
 * which answers at once. The first read of the week buys the profile instead,
 * three paid calls to Nansen over x402, and that takes a few seconds. So the
 * section suspends: the credit picture renders at once, and this arrives when
 * the registry has answered. The labels strip follows it only where Nansen
 * actually served labels; a key with no credits is not news on every page.
 */

import { LabelsStrip } from "../../../components/custom-ui/labels-strip";
import { NansenProfile } from "../../../components/custom-ui/nansen-profile";
import type { LabelsRow } from "../../../src/dashboard/client";
import { LABELS_OFFCHAIN_STATEMENT, NANSEN_OFFCHAIN_STATEMENT, toLabelsView, toNansenProfileView } from "../../../src/dashboard/views";
import type { NetworkContext } from "../../_lib/context";

export async function NansenSection({
  context,
  agent,
  labels,
}: {
  readonly context: NetworkContext;
  readonly agent: string;
  readonly labels: LabelsRow | undefined;
}) {
  const answered = await context.registry.agentNansen(agent);
  const view = toNansenProfileView(answered.ok ? answered.value.nansen : undefined, context.network.name);
  const labelsView = toLabelsView(labels);
  return (
    <div className="flex flex-col gap-3">
      <NansenProfile
        view={
          answered.ok
            ? view
            : { ...view, status: "unavailable", statement: `The Nansen profile could not be read: ${answered.error.message}.` }
        }
        offchainStatement={NANSEN_OFFCHAIN_STATEMENT}
        explorerAddressHrefFor={context.explorerAddressHrefFor}
        explorerHrefFor={context.explorerHrefFor}
      />
      {labelsView.status === "served" || labelsView.status === "empty" ? (
        <LabelsStrip view={labelsView} offchainStatement={LABELS_OFFCHAIN_STATEMENT} />
      ) : null}
    </div>
  );
}
