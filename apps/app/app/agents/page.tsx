/**
 * `/agents` - the credit observatory.
 *
 * A page of Agents ordered by most recent Settlement. The Credit Limit is
 * deliberately absent from this list and present on the detail route, because a
 * Credit Limit is per Asset and costs a witness rebuild plus a cross-check
 * against the contract. Serving a per-row figure would mean either doing that
 * work for every row of every page, or showing a cheaper number that is not the
 * Credit Limit. The read API says so in the same words.
 *
 * Requirements: 24.1, 24.9
 */

import { Link } from "../../components/ui/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { EmptyChain } from "../../components/views/empty-chain";
import { routeContext, type SearchParams } from "../_lib/context";

export const dynamic = "force-dynamic";

export default async function AgentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const context = routeContext(await searchParams);
  const page = await context.registry.agents(25);

  return (
    <section className="flex flex-col gap-4">
      <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Agents</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">
        An Agent is a Creditcoin account address. There is no identity token, so an address with no
        activity is a real address with an empty history rather than an address that does not exist.
        Credit Limits are per Asset and are shown on each Agent&apos;s own page.
      </p>

      {!page.ok ? (
        <EmptyChain message={`The registry could not be read: ${page.error.message}`} indexedBlock={null} />
      ) : page.value.agents.length === 0 ? (
        <EmptyChain
          message="No Agent has settled yet, on any chain."
          indexedBlock={page.value.index.lastBlock}
        />
      ) : (
        <Table caption="Agents by most recent Verified Settlement">
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Verified Settlements</TableHead>
              <TableHead>Assets</TableHead>
              <TableHead>Last recorded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.value.agents.map((agent) => (
              <TableRow key={agent.agent}>
                <TableCell>
                  <Link href={`/agents/${agent.agent}?chainKey=${context.chainKey}`} mono>
                    {agent.agent}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{agent.settlementCount}</TableCell>
                <TableCell className="font-mono text-xs">{agent.assetCount}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  block {agent.creditcoin.blockNumber.toLocaleString("en-US")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
