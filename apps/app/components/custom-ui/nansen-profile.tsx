/**
 * `NansenProfile` - what Nansen says about an Agent's address, beside its
 * credit picture.
 *
 * ## Bought once a week, said to be
 *
 * The registry buys three of Nansen's profiler calls per Agent over x402, a
 * cent each in USDC on Monad Mainnet, and serves that answer to every visitor
 * for a week. The section shows when it was fetched, when it refreshes, what it
 * cost and the payment transactions, so a reader can see the pay-per-call rail
 * working rather than take it on trust.
 *
 * ## An overlay, said to be one
 *
 * Holdings, funders and counterparties are Nansen's, off chain and not read by
 * `TabBook`, so the section says in one sentence that is always present that
 * none of it changes the Credit Limit. A refusal (Testnet, an address that is
 * not an Agent, no payer configured) is rendered as a plain statement in the
 * same voice as the rest of the page, never in the danger tone.
 *
 * This is a server component. It has no state and no clock.
 */

import type { ReactNode } from "react";

import { Badge } from "../ui/badge";
import { cn } from "../ui/cn";
import { Link } from "../ui/link";
import { formatInstantUtc } from "./format";

/** The view, as the view model shapes it. Structural, so the composition layer supplies it. */
export interface NansenProfileSectionView {
  readonly status: "served" | "stale" | "testnet" | "not-an-agent" | "not-configured" | "budget" | "unavailable" | "not-served";
  readonly statement: string;
  readonly fetchedAt: string | undefined;
  readonly refreshesAt: string | undefined;
  readonly paidText: string | undefined;
  readonly payments: readonly { readonly endpoint: string; readonly amountText: string; readonly txHash: string | undefined }[];
  readonly holdings: Part<{ readonly symbol: string; readonly amountText: string; readonly valueText: string | undefined }> & {
    readonly totalText: string | undefined;
  };
  readonly funding: Part<{
    readonly address: string;
    readonly label: string | undefined;
    readonly relation: string;
    readonly txHash: string | undefined;
    readonly at: string | undefined;
  }>;
  readonly activity: Part<{ readonly address: string; readonly label: string | undefined; readonly transactionsText: string }> & {
    readonly summary: string | undefined;
    readonly lastAt: string | undefined;
  };
}

interface Part<Row> {
  readonly available: boolean;
  readonly statement: string;
  readonly rows: readonly Row[];
}

export interface NansenProfileProps {
  readonly view: NansenProfileSectionView;
  /** The one sentence about what this is not. Supplied so the page and the test share the wording. */
  readonly offchainStatement: string;
  readonly explorerAddressHrefFor: (address: string) => string;
  readonly explorerHrefFor: (txHash: string) => string;
  readonly className?: string | undefined;
}

/** An ISO instant as `YYYY-MM-DD HH:MM UTC`, or the raw text where it will not parse. */
function instant(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : formatInstantUtc(ms);
}

const short = (value: string): string => (value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`);

function Block({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">{title}</p>
      {children}
    </div>
  );
}

function Address({ address, label, href }: { readonly address: string; readonly label: string | undefined; readonly href: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      {label === undefined ? null : <span className="truncate text-sm text-foreground">{label}</span>}
      <Link href={href} external mono className="truncate text-xs">
        {short(address)}
      </Link>
    </span>
  );
}

export function NansenProfile({ view, offchainStatement, explorerAddressHrefFor, explorerHrefFor, className }: NansenProfileProps) {
  const served = view.status === "served" || view.status === "stale";
  return (
    <aside
      aria-label="Profile from Nansen"
      className={cn("flex flex-col gap-4 rounded-lg border border-border/60 bg-muted/30 p-5", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
          Profile, from Nansen
          {view.status === "stale" ? (
            <Badge variant="outline" tone="muted">
              stale
            </Badge>
          ) : null}
        </p>
        {view.fetchedAt === undefined ? null : (
          <p className="font-mono text-[11px] text-muted-foreground">
            fetched {instant(view.fetchedAt)}
            {view.refreshesAt === undefined ? "" : `, refreshes ${instant(view.refreshesAt)}`}
          </p>
        )}
      </div>

      <p className="text-sm text-foreground">{view.statement}</p>

      {served ? (
        <>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
            <Block title="Holdings">
              {view.holdings.available && view.holdings.rows.length > 0 ? (
                <>
                  {view.holdings.totalText === undefined ? null : (
                    <p className="font-mono text-lg text-foreground">{view.holdings.totalText}</p>
                  )}
                  <ul className="flex flex-col gap-1 font-mono text-xs">
                    {view.holdings.rows.map((token) => (
                      <li key={token.symbol} className="flex justify-between gap-3">
                        <span className="text-foreground">
                          {token.amountText} {token.symbol}
                        </span>
                        <span className="text-muted-foreground">{token.valueText ?? "unpriced"}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{view.holdings.statement}</p>
              )}
            </Block>

            <Block title="Funded by">
              {view.funding.available && view.funding.rows.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {view.funding.rows.map((wallet) => (
                    <li key={`${wallet.relation}:${wallet.address}`} className="flex flex-col gap-0.5">
                      <span className="text-xs text-muted-foreground">
                        {wallet.relation}
                        {wallet.at === undefined ? "" : `, ${instant(wallet.at)}`}
                      </span>
                      <Address address={wallet.address} label={wallet.label} href={explorerAddressHrefFor(wallet.address)} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{view.funding.statement}</p>
              )}
            </Block>

            <Block title="Last 30 days">
              {view.activity.summary === undefined ? null : (
                <p className="text-xs text-foreground">
                  {view.activity.summary}
                  {view.activity.lastAt === undefined ? null : (
                    <span className="text-muted-foreground"> Latest {instant(view.activity.lastAt)}.</span>
                  )}
                </p>
              )}
              {view.activity.available && view.activity.rows.length > 0 ? (
                <ul className="flex flex-col gap-2" aria-label={view.activity.statement}>
                  {view.activity.rows.map((party) => (
                    <li key={party.address} className="flex items-start justify-between gap-3">
                      <Address address={party.address} label={party.label} href={explorerAddressHrefFor(party.address)} />
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{party.transactionsText}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">{view.activity.statement}</p>
              )}
            </Block>
          </div>

          {view.paidText === undefined ? null : (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>
                Bought for {view.paidText} in USDC over x402, {view.payments.length}{" "}
                {view.payments.length === 1 ? "call" : "calls"}:
              </span>
              {view.payments.map((payment) =>
                payment.txHash === undefined ? (
                  <span key={payment.endpoint} className="font-mono">
                    {payment.endpoint} {payment.amountText}
                  </span>
                ) : (
                  <Link key={payment.endpoint} href={explorerHrefFor(payment.txHash)} external mono className="text-xs">
                    {payment.endpoint} {payment.amountText}
                  </Link>
                ),
              )}
            </p>
          )}
        </>
      ) : null}

      <p className="text-xs leading-relaxed text-muted-foreground">{offchainStatement}</p>
    </aside>
  );
}

export default NansenProfile;
