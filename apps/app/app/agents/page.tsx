/**
 * `/agents` - the credit observatory.
 *
 * A page of Agents ordered by most recent Settlement. The Credit Limit is
 * deliberately absent from this list and present on the detail route, because a
 * Credit Limit is per Asset and costs a witness rebuild plus a cross-check
 * against the contract. Serving a per-row figure would mean either doing that
 * work for every row of every page, or showing a cheaper number that is not the
 * Credit Limit. The read API says so in the same words.
 */

import { Link } from "../../components/ui/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { EmptyChain } from "../../components/views/empty-chain";
import { routeContext } from "../_lib/context";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const context = await routeContext();
  const page = await context.registry.agents(25);

  return (
    <section className="flex flex-col gap-4">
      <h1 className="font-host text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">Agents</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">
        An Agent is a Monad account address. There is no identity token, so an address with no
        activity is a real address with an empty history rather than an address that does not exist.
        Credit Limits are per Asset and are shown on each Agent&apos;s own page.
      </p>

      {!page.ok ? (
        <EmptyChain message={`The registry could not be read: ${page.error.message}`} indexedBlock={null} />
      ) : page.value.agents.length === 0 ? (
        <EmptyChain
          message={`No Agent has settled on ${context.network.name} yet.`}
          indexedBlock={page.value.index.lastBlock}
        />
      ) : (
        <Table caption="Agents by most recent Settlement">
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Settlements</TableHead>
              <TableHead>Assets</TableHead>
              <TableHead>Last recorded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.value.agents.map((agent) => (
              <TableRow key={agent.agent}>
                <TableCell>
                  {/*
                    One line at every width. On a phone the address is shortened
                    on screen so the other columns stay in view, the full one is
                    what a screen reader hears, and `title` carries it for a
                    pointer; from `sm` the full address fits and is shown.
                  */}
                  <Link
                    href={`/agents/${agent.agent}`}
                    mono
                    title={agent.agent}
                    className="break-normal whitespace-nowrap"
                  >
                    <span aria-hidden="true" className="sm:hidden">
                      {`${agent.agent.slice(0, 8)}…${agent.agent.slice(-6)}`}
                    </span>
                    <span className="sr-only sm:not-sr-only">{agent.agent}</span>
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{agent.settlementCount}</TableCell>
                <TableCell className="font-mono text-xs">{agent.assetCount}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  <Link
                    href={context.explorerHrefFor(agent.monad.txHash)}
                    external
                    mono
                    className="break-normal whitespace-nowrap"
                  >
                    block {agent.monad.blockNumber.toLocaleString("en-US")}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
