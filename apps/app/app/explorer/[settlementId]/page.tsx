/**
 * `/explorer/[settlementId]` - one Settlement, and what it did to the tab.
 *
 * ## Why the settlement id is the route
 *
 * A transaction hash names more than one thing. One Monad transaction can apply
 * several Settlements, and one `settle` call can be batched with others, so a
 * route keyed on the hash would sometimes be ambiguous. `TabBook` assigns each
 * Settlement its own identifier when it applies the payment, and that names
 * exactly one, on chain and here.
 *
 * ## The timeline is one transaction, drawn as its three effects
 *
 * Every entry below carries the same block time, because they happened in the
 * same transaction: the Asset moved to the Service's collection address, the
 * amount was applied against the Open Tab, and whatever exceeded the tab was
 * banked as prepaid credit. Drawing them as steps is not a claim that time
 * passed between them. It is the three figures a reader needs, in the order the
 * contract computes them.
 */

import { notFound } from "next/navigation";

import { Link } from "../../../components/ui/link";
import { SettlementStrip } from "../../../components/motion/settlement-strip";
import { SettlementCard } from "../../../components/custom-ui/settlement-card";
import { SettlementTimeline } from "../../../components/custom-ui/settlement-timeline";
import { toSettlementView } from "../../../src/dashboard/views";
import { routeContext } from "../../_lib/context";

export const dynamic = "force-dynamic";

export default async function SettlementDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly settlementId: string }>;
}) {
  const { settlementId } = await params;
  const context = await routeContext();

  const detail = await context.registry.settlement(settlementId);
  if (!detail.ok) {
    if (detail.error.category === "NOT_FOUND") notFound();
    return (
      <section className="flex flex-col gap-3">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Settlement</h1>
        <p className="text-sm text-muted-foreground">
          The registry could not be read: {detail.error.message}
        </p>
      </section>
    );
  }

  const view = toSettlementView(detail.value.settlement);
  if (view === undefined) {
    return (
      <section className="flex flex-col gap-3">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Settlement</h1>
        <p className="text-sm text-muted-foreground">
          This Settlement is indexed but its figures will not decode, so it is not shown rather
          than shown with invented figures.
        </p>
      </section>
    );
  }

  const atMs = view.blockTime === null ? 0 : new Date(view.blockTime).getTime();
  const entries = [
    {
      id: `${view.settlementId}:moved`,
      label: "Asset moved to collection",
      atMs,
      amountBaseUnits: view.amountBaseUnits,
      asset: view.asset,
      note: `Paid by the Agent to ${view.collection}, the Service's collection address for this Asset.`,
    },
    {
      id: `${view.settlementId}:applied`,
      label: "Applied to Open Tab",
      atMs,
      amountBaseUnits: view.appliedBaseUnits,
      asset: view.asset,
      note:
        view.openAfterBaseUnits === undefined
          ? "Reduced the Open Tab by this amount."
          : `Reduced the Open Tab by this amount, leaving ${view.openAfterBaseUnits.toString()} base units open.`,
    },
    ...(view.prepaidBaseUnits > 0n
      ? [
          {
            id: `${view.settlementId}:prepaid`,
            label: "Banked as prepaid",
            atMs,
            amountBaseUnits: view.prepaidBaseUnits,
            asset: view.asset,
            note: "Exceeded the Open Tab, so it is held as prepaid credit against the next delivery.",
          },
        ]
      : []),
  ];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Settlement</h1>
        <Link href="/explorer">Back to the explorer</Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <SettlementCard settlement={view} explorerUrl={context.explorerUrl} />
        <SettlementStrip blockNumber={view.blockNumber.toLocaleString("en-GB")} />
      </div>

      <SettlementTimeline entries={entries} caption="What one transaction did" />

      <p className="font-mono text-xs text-muted-foreground">
        Recorded on {context.network.name} in{" "}
        <Link href={context.explorerHrefFor(view.txHash)} external mono>
          {view.txHash}
        </Link>
        , block {view.blockNumber.toLocaleString("en-GB")}, log {view.logIndex}.
      </p>
    </section>
  );
}
