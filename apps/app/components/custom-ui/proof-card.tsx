/**
 * `ProofCard` — one Verified Settlement, with the proof coordinates that make it
 * one.
 *
 * ## Identity
 *
 * A Verified Settlement is identified by its **replay key**: the tuple
 * `(chainKey, blockHeight, txIndex, logIndex)`, packed into a single 32-byte
 * word. Four `uint64` fields fill the word exactly, so the map from tuple to key
 * is injective by construction and no hash is involved. That tuple is the whole
 * identity, and the card shows all four fields as well as the packed key, because
 * the packed key is what an explorer route is keyed by and the four fields are
 * what a reader can check against a block.
 *
 * The card carries **no Source Chain transaction hash**, because a Verified
 * Settlement does not have one. The transaction index comes from the proof
 * itself, never from a caller, and the log ordinal is the receipt-wide position
 * of the recognised Settlement log. Adding a hash field here would invent a fact
 * the record does not hold, so the card says so in as many words.
 *
 * The one transaction it does link is the **Creditcoin** transaction that
 * recorded the settlement, which resolves on Blockscout.
 *
 * Layout follows the card pattern the rest of the Dashboard uses: a raised panel
 * separated from the page by its 1 px boundary rather than by its fill, a mono
 * uppercase label column, and values in mono. The coordinates are a description
 * list, so the pairing between a label and its value is programmatic rather than
 * visual.
 *
 * Requirements: 24.10, 15.7, 11.8
 */

import type { ReactNode } from "react";

import { CREDITCOIN, chainFor, packReplayKey, type ChainKey } from "@tabai/shared";

import { cn } from "../ui/cn";
import { Link } from "../ui/link";
import { AssetAmount } from "./asset-amount";
import { ClearingBadge } from "./clearing-badge";
import type { ClearingState } from "./clearing-state";
import type { AssetUnit } from "./format";
import { ProofSealIcon } from "./icons";
import { TierBadge } from "./tier-badge";
import type { ServiceTier } from "./tier";

/** One Verified Settlement, as a read API hands it to a view. */
export interface VerifiedSettlementView {
  /** `1` is Ethereum Sepolia, `3` is Ethereum Mainnet. */
  readonly chainKey: ChainKey;
  readonly blockHeight: bigint;
  readonly txIndex: bigint;
  readonly logIndex: bigint;
  /** The Agent the payer address resolved to, as a Creditcoin identity. */
  readonly agent: string;
  readonly serviceId: string;
  /** A human name for the Service, where the registry carries one. */
  readonly serviceName?: string | undefined;
  readonly tier: ServiceTier;
  readonly asset: AssetUnit;
  readonly amountBaseUnits: bigint;
  readonly clearing: ClearingState;
  /** The confirmation deadline, where the clearing is still provisional. */
  readonly clearingDeadlineMs?: number | undefined;
  /** The Creditcoin transaction that recorded this Verified Settlement. */
  readonly creditcoinTxHash?: string | undefined;
}

export interface ProofCardProps {
  readonly settlement: VerifiedSettlementView;
  /** A fixed clock, forwarded to the clearing badge. */
  readonly nowMs?: number | undefined;
  readonly className?: string | undefined;
}

const LABEL_CLASS = "font-mono text-xs uppercase tracking-wider text-muted-foreground";
const VALUE_CLASS = "font-mono text-sm text-foreground";

function Row({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border py-2 first:border-t-0">
      <dt className={LABEL_CLASS}>{label}</dt>
      <dd className={cn(VALUE_CLASS, "text-right break-all")}>{children}</dd>
    </div>
  );
}

export function ProofCard({ settlement, nowMs, className }: ProofCardProps) {
  const chain = chainFor(settlement.chainKey);
  const replayKey = packReplayKey({
    chainKey: BigInt(settlement.chainKey),
    blockHeight: settlement.blockHeight,
    txIndex: settlement.txIndex,
    logIndex: settlement.logIndex,
  });
  const explorerHref =
    settlement.creditcoinTxHash === undefined
      ? undefined
      : `${CREDITCOIN.explorerUrl}/tx/${settlement.creditcoinTxHash}`;

  return (
    <article
      className={cn("raised-panel flex flex-col gap-4 rounded-[2px] p-6", className)}
      aria-labelledby={`proof-${replayKey}-heading`}
    >
      {/*
        The words stay for assistive technology and the seal stays for the eye. The
        visible text is dropped because this card's only caller titles its page
        "Verified Settlement" directly above it, so the label was printed twice one
        line apart. `aria-labelledby` still points here, so the region keeps its name.
      */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3
          id={`proof-${replayKey}-heading`}
          className="inline-flex items-center gap-2 font-mono text-sm uppercase tracking-wider text-foreground"
        >
          <ProofSealIcon className="size-4 text-accent" aria-hidden="true" />
          <span className="sr-only">Verified Settlement</span>
        </h3>
        <ClearingBadge
          state={settlement.clearing}
          deadlineMs={settlement.clearingDeadlineMs}
          nowMs={nowMs}
        />
      </header>

      <div className="flex flex-col gap-1">
        <span className={LABEL_CLASS}>Replay key</span>
        <code className="font-mono text-xs break-all text-foreground">{replayKey}</code>
        <p className="text-xs text-muted-foreground">
          The packed tuple below. A Verified Settlement is identified by these four coordinates and
          carries no Source Chain transaction hash.
        </p>
      </div>

      <dl className="flex flex-col">
        <Row label="Source chain">
          {chain.name} <span className="text-muted-foreground">· chainKey {settlement.chainKey}</span>
        </Row>
        <Row label="Block height">{settlement.blockHeight.toString()}</Row>
        <Row label="Transaction index">{settlement.txIndex.toString()}</Row>
        <Row label="Log index">{settlement.logIndex.toString()}</Row>
        <Row label="Agent">{settlement.agent}</Row>
        <Row label="Service">
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            <span>{settlement.serviceName ?? settlement.serviceId}</span>
            <TierBadge tier={settlement.tier} subject="Service" variant="outline" />
          </span>
        </Row>
        <Row label="Settled amount">
          <AssetAmount
            baseUnits={settlement.amountBaseUnits}
            asset={settlement.asset}
            emphasis="strong"
          />
        </Row>
      </dl>

      {explorerHref === undefined ? null : (
        <footer className="border-t border-border pt-3">
          <Link
            href={explorerHref}
            external
            externalLabel="opens the Creditcoin explorer in a new browser tab"
            size="xs"
            mono
            className="uppercase tracking-wider"
          >
            Creditcoin transaction on Blockscout
          </Link>
        </footer>
      )}
    </article>
  );
}

export default ProofCard;
