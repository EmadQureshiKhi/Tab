/**
 * `SettlementCard` - one Settlement, with everything that identifies it.
 *
 * ## Identity
 *
 * A Settlement is identified by the `settlementId` that `TabBook` assigned when
 * it applied the payment, and it is paid for by one Monad transaction. Those two
 * facts are the whole record: `TabSettlement.settle` moved the Asset from the
 * Agent to the Service's collection address and called `TabBook.applySettlement`
 * in the same transaction, so the transaction hash is both the payment and the
 * ledger entry, with nothing to confirm afterwards. The card links that hash to
 * the Monad explorer and states the block it landed in.
 *
 * ## What the amount became
 *
 * The amount paid splits two ways on chain. Whatever the Open Tab could absorb
 * was applied to it, and any excess was banked as prepaid credit against the
 * same Service and Asset. Both figures are shown beside the amount, because a
 * reader checking a tab needs to know which part of a payment reduced it.
 *
 * Layout follows the card pattern the rest of the Dashboard uses: a raised panel
 * separated from the page by its 1 px boundary rather than by its fill, a mono
 * uppercase label column, and values in mono. The fields are a description
 * list, so the pairing between a label and its value is programmatic rather
 * than visual.
 */

import type { ReactNode } from "react";

import { cn } from "../ui/cn";
import { Link } from "../ui/link";
import { AssetAmount } from "./asset-amount";
import { CopyButton } from "./copy-button";
import { formatInstantUtc, toDateTimeAttribute, type AssetUnit } from "./format";
import { SettledSealIcon } from "./icons";
import { TierBadge } from "./tier-badge";
import type { ServiceTier } from "./tier";

/**
 * One Settlement, as the read API hands it to a view.
 *
 * Declared structurally rather than imported from `src/dashboard/views`, for
 * the reason `format.ts` gives: `components/` is a build project with its own
 * `rootDir` and cannot reach into `src/`. The shape is the same field for field,
 * so the core's `SettlementView` is assignable here by construction and a route
 * passes it straight through.
 */
export interface SettlementView {
  readonly settlementId: string;
  /** The Monad transaction that paid this Settlement and applied it. */
  readonly txHash: string;
  readonly blockNumber: number;
  readonly logIndex: number;
  readonly agent: string;
  readonly serviceId: string;
  /** A human name for the Service, where the id decodes to one. */
  readonly serviceName?: string | undefined;
  readonly tier: ServiceTier;
  readonly asset: AssetUnit;
  readonly assetAddress: string;
  readonly amountBaseUnits: bigint;
  readonly appliedBaseUnits: bigint;
  readonly prepaidBaseUnits: bigint;
  /** The Open Tab after the Settlement applied, where the index observed it. */
  readonly openAfterBaseUnits?: bigint | undefined;
  /** The Service's collection address the Asset was paid to. */
  readonly collection: string;
  readonly blockTime: string | null;
}

/** The explorer link for a transaction. Mirrors `explorerTxUrl` in the core. */
export function explorerTxHref(txHash: string, explorerUrl: string): string {
  return `${explorerUrl.replace(/\/+$/, "")}/tx/${txHash}`;
}

export interface SettlementCardProps {
  readonly settlement: SettlementView;
  /** The explorer base for the configured chain, from the network option. */
  readonly explorerUrl: string;
  readonly className?: string | undefined;
}

const LABEL_CLASS = "font-mono text-xs uppercase tracking-wider text-muted-foreground";
const VALUE_CLASS = "font-mono text-sm text-foreground";

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border py-2 first:border-t-0">
      <dt className={LABEL_CLASS}>{label}</dt>
      <dd className={cn(VALUE_CLASS, "min-w-0 text-right break-all")}>{children}</dd>
    </div>
  );
}

/** A 32-byte word, middle-truncated, with the whole value one hover away. */
function shortWord(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function SettlementCard({ settlement, explorerUrl, className }: SettlementCardProps) {
  const headingId = `settlement-${settlement.settlementId}-heading`;
  const txHref = explorerTxHref(settlement.txHash, explorerUrl);
  const blockTimeMs = settlement.blockTime === null ? undefined : Date.parse(settlement.blockTime);

  return (
    <article
      className={cn("raised-panel flex flex-col gap-4 rounded-[2px] p-6", className)}
      aria-labelledby={headingId}
    >
      {/*
        The words stay for assistive technology and the seal stays for the eye. The
        visible text is dropped because this card's only caller titles its page
        "Settlement" directly above it, so the label was printed twice one line
        apart. `aria-labelledby` still points here, so the region keeps its name.
      */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3
          id={headingId}
          className="inline-flex items-center gap-2 font-mono text-sm uppercase tracking-wider text-foreground"
        >
          <SettledSealIcon className="size-4 text-accent" aria-hidden="true" />
          <span className="sr-only">Settlement</span>
        </h3>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          Block {settlement.blockNumber.toLocaleString("en-US")}
        </span>
      </header>

      <div className="flex flex-col gap-1">
        <span className={LABEL_CLASS}>Settlement id</span>
        <span className="flex items-center gap-1">
          <code className="min-w-0 font-mono text-xs break-all text-foreground">
            {settlement.settlementId}
          </code>
          <CopyButton text={settlement.settlementId} label="the settlement id" />
        </span>
        <p className="text-xs text-muted-foreground">
          Assigned by <code className="font-mono">TabBook</code> when it applied this payment. The
          Asset was moved and the tab was reduced in one Monad transaction, so the hash below is
          the whole record of both.
        </p>
      </div>

      <dl className="flex flex-col">
        <Field label="Transaction">
          <span className="inline-flex max-w-full items-center justify-end gap-1">
            <Link
              href={txHref}
              external
              externalLabel="opens the Monad explorer in a new browser tab"
              mono
              size="xs"
              title={settlement.txHash}
            >
              {shortWord(settlement.txHash)}
            </Link>
            <CopyButton text={settlement.txHash} label="the transaction hash" />
          </span>
        </Field>
        <Field label="Block">
          {settlement.blockNumber.toLocaleString("en-US")}{" "}
          <span className="text-muted-foreground">· log {settlement.logIndex}</span>
        </Field>
        <Field label="Block time">
          {blockTimeMs === undefined || Number.isNaN(blockTimeMs) ? (
            <span className="text-muted-foreground">not indexed</span>
          ) : (
            <time dateTime={toDateTimeAttribute(blockTimeMs)} className="tabular-nums">
              {formatInstantUtc(blockTimeMs)}
            </time>
          )}
        </Field>
        <Field label="Agent">
          <span className="inline-flex max-w-full items-center justify-end gap-1">
            <span title={settlement.agent}>{settlement.agent}</span>
            <CopyButton text={settlement.agent} label="the Agent address" />
          </span>
        </Field>
        <Field label="Service">
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            <span title={settlement.serviceId}>
              {settlement.serviceName ?? shortWord(settlement.serviceId)}
            </span>
            <TierBadge tier={settlement.tier} subject="Service" variant="outline" />
          </span>
        </Field>
        <Field label="Amount">
          <AssetAmount
            baseUnits={settlement.amountBaseUnits}
            asset={settlement.asset}
            emphasis="strong"
          />
        </Field>
        <Field label="Applied to tab">
          <AssetAmount baseUnits={settlement.appliedBaseUnits} asset={settlement.asset} />
        </Field>
        <Field label="Banked as prepaid">
          <AssetAmount baseUnits={settlement.prepaidBaseUnits} asset={settlement.asset} />
        </Field>
        {settlement.openAfterBaseUnits === undefined ? null : (
          <Field label="Open Tab after">
            <AssetAmount baseUnits={settlement.openAfterBaseUnits} asset={settlement.asset} />
          </Field>
        )}
        <Field label="Paid to">
          <span className="inline-flex max-w-full items-center justify-end gap-1">
            <span title={settlement.collection}>{settlement.collection}</span>
            <CopyButton text={settlement.collection} label="the collection address" />
          </span>
        </Field>
      </dl>

      <footer className="border-t border-border pt-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Moved and applied in one transaction. <code className="font-mono">TabSettlement</code>{" "}
          took the Asset from the Agent, paid it to the Service&apos;s collection address, and{" "}
          <code className="font-mono">TabBook</code> reduced the Open Tab, all inside the block
          named above. Nothing was held by Tab at any point.
        </p>
      </footer>
    </article>
  );
}

export default SettlementCard;
