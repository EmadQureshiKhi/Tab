/**
 * `/analytics` - what has actually settled, and how much of it was us.
 *
 * ## The split is the point of this page
 *
 * R29.2 to R29.4 ask for adoption figures, and an adoption figure a project
 * computes about itself is worth nothing unless it says which side of the line each
 * number falls on. So every count here is drawn split rather than as a total, and
 * the internal share is not hidden in a footnote: at the time of writing every
 * Verified Settlement on this deployment is internal, and a page that reported "9
 * settlements" without saying so would be misleading by omission.
 *
 * The classification is the registry's, from the committed allowlist, and the rule
 * runs in the safe direction: every address absent from the list counts as
 * external, so an incomplete list can only ever overstate adoption. That is the one
 * failure mode worth naming on the page, and it is named.
 *
 * ## Lower bounds are labelled as lower bounds
 *
 * Metered Deliveries are counted from `PrepaidConsumed`, which fires only when a
 * delivery draws on prepaid credit, because `DeliveryRecorded` is not indexed. That
 * count is therefore a floor and not a total, and it is drawn and worded as one.
 * Publishing it as a total would be the easiest way for this page to be wrong.
 *
 * ## No chart library
 *
 * Recharts is not a dependency of this package and was not added. Every figure here
 * is a proportion of a total or a four-part ledger, both of which are rectangles,
 * and the existing `BondMeter` already draws the second. Everything renders on the
 * server with no client runtime, which is also what keeps R24.9 true here.
 *
 * Requirements: 24.7, 29.2, 29.3, 29.4, 24.9, 24.10
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
import { registry } from "../_lib/context";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const [adoption, services] = await Promise.all([
    registry().adoption(),
    registry().services(50),
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
              title="Verified Settlements"
              noun="Verified Settlement"
              plural="Verified Settlements"
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
            Read at Creditcoin block{" "}
            {adoption.value.index.lastBlock === null
              ? "an unrecorded height"
              : adoption.value.index.lastBlock.toLocaleString("en-US")}
            .
          </p>
        </>
      )}

      <section aria-labelledby="bond" className="flex flex-col gap-4">
        <h2 id="bond" className="font-mono text-xs tracking-wider text-muted-foreground uppercase">
          Bond utilisation
        </h2>
        {!services.ok ? (
          <EmptyChain
            message={`The Service directory could not be read: ${services.error.message}`}
            indexedBlock={null}
          />
        ) : (
          services.value.services.map((service) => {
            // A ledger the registry could not cross-check against `Bond.ledgerOf`
            // is dropped rather than drawn. A utilisation bar is a claim about
            // money at risk, and drawing one from figures the registry itself
            // would not stand behind is the wrong kind of confident.
            const ledgers = service.bond
              .filter((row) => row.crossCheck?.agrees !== false)
              .map((row) => ({
                asset: assetUnitFor(row.asset),
                stakedBaseUnits: BigInt(row.staked),
                reservedBaseUnits: BigInt(row.reserved),
                slashedBaseUnits: BigInt(row.slashed),
                releasedBaseUnits: BigInt(row.released),
                freeBaseUnits: BigInt(row.free),
              }));
            if (ledgers.length === 0) return null;
            return (
              <BondMeter
                key={service.serviceId}
                caption={`Bond staked by ${service.operator}`}
                ledgers={ledgers}
              />
            );
          })
        )}
      </section>
    </section>
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
  // It did, and read "USDC: 0.452003 USDC settled in total".
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
