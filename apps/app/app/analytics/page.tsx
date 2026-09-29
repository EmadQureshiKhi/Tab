/**
 * `/analytics` - what has actually settled, and how much of it was us.
 *
 * ## The split is the point of this page
 *
 * An adoption figure a project computes about itself is worth nothing unless it
 * says which side of the line each number falls on. So every count here is drawn
 * split rather than as a total, and the internal share is not hidden in a
 * footnote: a page that reported "9 settlements" without saying how many were the
 * project's own would be misleading by omission.
 *
 * The classification is the registry's, from the committed allowlist, and the rule
 * runs in the safe direction: every address absent from the list counts as
 * external, so an incomplete list can only ever overstate adoption. That is the one
 * failure mode worth naming on the page, and it is named.
 *
 * ## Floors are labelled as floors
 *
 * The registry's adoption figures count Metered Deliveries from `PrepaidConsumed`,
 * which fires only when a delivery draws on prepaid credit. That count is
 * therefore a floor and not a total, and it is drawn and worded as one, with the
 * registry's own basis sentence beside it. Publishing it as a total would be the
 * easiest way for this page to be wrong.
 *
 * ## No chart library
 *
 * Every figure here is a proportion of a total or a three-part ledger, both of
 * which are rectangles, and `BondMeter` already draws the second. Everything
 * renders on the server with no client runtime, which is also why this page needs
 * no wallet.
 */

import { AssetAmount } from "../../components/custom-ui/asset-amount";
import { BondMeter } from "../../components/custom-ui/bond-meter";
import { assetUnitFor, formatAssetAmount } from "../../components/custom-ui/format";
import { EmptyChain } from "../../components/views/empty-chain";
import { SplitBar } from "../../components/views/split-bar";
import { SplitChart } from "../../components/views/split-chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import type { ServiceRow } from "../../src/dashboard/client";
import { routeContext } from "../_lib/context";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const context = await routeContext();
  const [adoption, services] = await Promise.all([
    context.registry.adoption(),
    context.registry.services(50),
  ]);

  return (
    <section className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Adoption and Bond</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every count below is split by whether the address it came from is one this project
          controls. The classification is an allowlist of our own addresses, committed to the
          repository, and every address absent from it counts as external. That direction is
          deliberate: an incomplete list can only overstate how much of this is other people, so
          these figures are the pessimistic reading rather than the flattering one.
        </p>
      </div>

      {!adoption.ok ? (
        <EmptyChain
          message={`The adoption figures could not be read: ${adoption.error.message}`}
          indexedBlock={null}
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <SplitChart
              title="Agents"
              noun="Agent"
              plural="Agents"
              external={adoption.value.externalAgentCount}
              internal={adoption.value.internalAgentCount}
              basis={adoption.value.basis["agents"] ?? ""}
            />
            <SplitChart
              title="Settlements"
              noun="Settlement"
              plural="Settlements"
              external={adoption.value.externalSettlementCount}
              internal={adoption.value.internalSettlementCount}
              basis={adoption.value.basis["settlements"] ?? ""}
            />
            <SplitChart
              title="Metered Deliveries"
              noun="Metered Delivery"
              plural="Metered Deliveries"
              external={adoption.value.externalDeliveryLowerBound}
              internal={adoption.value.internalDeliveryLowerBound}
              basis={adoption.value.basis["deliveries"] ?? ""}
              lowerBound
            />
            <figure className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/30 p-5">
              <figcaption className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
                Settled volume by Asset
              </figcaption>
              {adoption.value.volumeByAsset.length === 0 ? (
                <p className="text-sm text-foreground">Nothing has settled yet, so there is no volume.</p>
              ) : (
                adoption.value.volumeByAsset.map((row) => {
                  const asset = assetUnitFor(row.asset);
                  return (
                    <VolumeRow
                      key={row.asset}
                      symbol={asset.symbol}
                      decimals={asset.decimals}
                      externalBaseUnits={BigInt(row.externalBaseUnits)}
                      internalBaseUnits={BigInt(row.internalBaseUnits)}
                      totalBaseUnits={BigInt(row.totalBaseUnits)}
                    />
                  );
                })
              )}
              <p className="font-mono text-xs text-muted-foreground">
                {adoption.value.basis["volume"] ?? ""}
              </p>
            </figure>
          </div>

          <p className="font-mono text-xs text-muted-foreground">
            {adoption.value.allowlistInternalCount} address
            {adoption.value.allowlistInternalCount === 1 ? " is" : "es are"} classified as ours.
            Read at {context.network.name} block{" "}
            {adoption.value.index.lastBlock === null
              ? "an unrecorded height"
              : adoption.value.index.lastBlock.toLocaleString("en-US")}
            .
          </p>
        </>
      )}

      <section aria-labelledby="bond" className="flex flex-col gap-4">
        <h2 id="bond" className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Bond escrowed
        </h2>
        {!services.ok ? (
          <EmptyChain
            message={`The Service directory could not be read: ${services.error.message}`}
            indexedBlock={null}
          />
        ) : (
          <BondMeters services={services.value.services} networkName={context.network.name} />
        )}
      </section>
    </section>
  );
}

/**
 * One meter per Service that has something the index will stand behind.
 *
 * A ledger the registry could not cross-check against `Bond.ledgerOf` is
 * dropped rather than drawn. A stake bar is a claim about the escrow behind a
 * Service's credit weight, and drawing one from figures the registry itself
 * would not stand behind is the wrong kind of confident. When that leaves
 * nothing, the section says so rather than standing empty under its heading.
 */
function BondMeters({
  services,
  networkName,
}: {
  readonly services: readonly ServiceRow[];
  readonly networkName: string;
}) {
  const meters = services
    .map((service) => ({
      serviceId: service.serviceId,
      operator: service.operator,
      ledgers: service.bond
        .filter((row) => row.crossCheck?.agrees !== false)
        .map((row) => ({
          asset: assetUnitFor(row.asset),
          stakedBaseUnits: BigInt(row.staked),
          withdrawnBaseUnits: BigInt(row.withdrawn),
          freeBaseUnits: BigInt(row.free),
        })),
    }))
    .filter((entry) => entry.ledgers.length > 0);

  if (meters.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/60 bg-muted/30 px-5 py-6 text-sm text-muted-foreground">
        {services.length === 0
          ? `No Service is registered on ${networkName} yet, so there is no Bond to draw.`
          : "No registered Service has escrowed a Bond the index could cross-check against the chain, so nothing is drawn rather than a bar at zero."}
      </p>
    );
  }

  return (
    <>
      {meters.map((entry) => (
        <BondMeter
          key={entry.serviceId}
          caption="Bond staked by"
          account={entry.operator}
          ledgers={entry.ledgers}
        />
      ))}
    </>
  );
}

/** One Asset's settled volume, split. Amounts stay exact and never pass through a float. */
function VolumeRow({
  symbol,
  decimals,
  externalBaseUnits,
  internalBaseUnits,
  totalBaseUnits,
}: {
  readonly symbol: string;
  readonly decimals: number;
  readonly externalBaseUnits: bigint;
  readonly internalBaseUnits: bigint;
  readonly totalBaseUnits: bigint;
}) {
  const asset = { symbol, decimals };
  // Integer arithmetic for the geometry too: a `bigint` that went through a float
  // would be wrong for large amounts, and this is basis points rather than a ratio.
  const share =
    totalBaseUnits === 0n ? 0 : Number((externalBaseUnits * 10_000n) / totalBaseUnits) / 100;
  // `.text` already carries the symbol, so the sentence does not prefix it again.
  const summary = `${formatAssetAmount(totalBaseUnits, asset).text} settled in total, of which ${formatAssetAmount(externalBaseUnits, asset).text} came from addresses outside this project and ${formatAssetAmount(internalBaseUnits, asset).text} from addresses inside it.`;

  return (
    <div className="flex flex-col gap-2">
      <SplitBar label={summary} externalPercent={share} />
      <p className="text-sm text-foreground">{summary}</p>
      <Table caption={`${symbol} settled volume, exact figures`} captionVisible={false}>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>External</TableCell>
            <TableCell>
              <AssetAmount baseUnits={externalBaseUnits} asset={asset} />
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Internal</TableCell>
            <TableCell>
              <AssetAmount baseUnits={internalBaseUnits} asset={asset} />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
