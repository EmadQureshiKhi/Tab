/**
 * `EmptyChain` - what a view shows when a chain has nothing on it.
 *
 * ## Empty is a fact, and it has to read like one
 *
 * Tab settles on two Source Chains and has settled on only one of them. Ethereum
 * Mainnet will be empty for as long as that holds, and it will be empty on a
 * reader's first visit rather than exceptionally. So this is not an error state,
 * not a spinner, and not a blank region: it is a sentence stating that nothing
 * has settled on the named chain, next to the horizon proving the index actually
 * looked.
 *
 * That last part is the whole point. "No rows" and "we could not read" are
 * indistinguishable to a reader unless the view proves it read something, so the
 * indexed block height is shown beside the sentence. A reader can then tell an
 * empty chain from a broken page without opening a console.
 *
 * This is a server component. It has no state and no clock.
 *
 * Requirements: 24.4, 24.9
 */

import { cn } from "../ui/cn";

export interface EmptyChainProps {
  /** The sentence for this chain. Comes from the chain option, never invented here. */
  readonly message: string;
  /** Highest Creditcoin block the index has read, proving it looked. */
  readonly indexedBlock?: number | null | undefined;
  readonly className?: string | undefined;
}

export function EmptyChain({ message, indexedBlock, className }: EmptyChainProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-border/60 bg-muted/30 px-6 py-10 text-center",
        className,
      )}
    >
      <p className="text-sm text-foreground">{message}</p>
      {indexedBlock === undefined || indexedBlock === null ? (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          The indexer has not recorded a block for this stream yet.
        </p>
      ) : (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          The index has read Creditcoin up to block {indexedBlock.toLocaleString("en-US")}, so this
          is an answer about the chain rather than a page that failed to load.
        </p>
      )}
    </div>
  );
}
