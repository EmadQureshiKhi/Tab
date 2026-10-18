/**
 * The credit curve under one Asset's gauge, read apart from the Agent read.
 *
 * Apart because it costs the registry a witness rebuild, a cross-check and one
 * LimitLib evaluation per point, and the gauge above it must not wait on that.
 * The page suspends this section, so the figures arrive first and the curve
 * follows. A curve the registry cannot serve leaves a sentence, never an empty
 * box: the gauge already carries the figure that matters.
 */
import { CreditCurveChart } from "../../../components/custom-ui/credit-curve";
import type { AssetUnit } from "../../../components/custom-ui/format";
import type { NetworkContext } from "../../_lib/context";

export async function CreditCurveSection({
  context,
  agent,
  asset,
  unit,
}: {
  readonly context: NetworkContext;
  readonly agent: string;
  readonly asset: string;
  readonly unit: AssetUnit;
}) {
  const curve = await context.registry.agentCreditCurve(agent, asset);
  if (!curve.ok) {
    return (
      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        The credit curve could not be read: {curve.error.message}
      </p>
    );
  }
  return (
    <CreditCurveChart
      className="border-t border-border pt-3"
      points={curve.value.points}
      asset={unit}
      agrees={curve.value.current.agrees}
      delinquent={curve.value.current.delinquent}
    />
  );
}
