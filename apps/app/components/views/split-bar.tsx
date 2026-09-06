/**
 * `SplitBar` - one proportion, external against internal.
 *
 * ## Why the internal share is hatched
 *
 * Every measure on the analytics page is currently 100% internal, which drew the
 * bar as a single flat pill in one muted grey across its whole width. Four of
 * those stacked down the page read as loading skeletons rather than as findings,
 * and a reader who bounced off them never got to the sentence underneath. A
 * diagonal hatch cannot be mistaken for a placeholder, and it carries the meaning
 * honestly besides: the hatched part is the share that is us, and it is drawn as
 * the part that does not count rather than as a solid achievement.
 *
 * The bar is never the only channel. The caller states both figures in the
 * `aria-label`, again in a visible sentence, and again in a real table. This
 * draws the geometry and nothing else, which is why it takes percentages rather
 * than the numbers: the arithmetic belongs to the caller, who knows whether it is
 * counting rows or base units and must not put a `bigint` through a float.
 *
 * Requirements: 24.7, 24.10
 */

export interface SplitBarProps {
  /** What the bar is a picture of, stated in words. Names it for a screen reader. */
  readonly label: string;
  /** The external share, 0 to 100. The internal share takes the rest. */
  readonly externalPercent: number;
}

export function SplitBar({ label, externalPercent }: SplitBarProps) {
  const external = Math.max(0, Math.min(100, externalPercent));

  return (
    <div
      role="img"
      aria-label={label}
      className="flex h-2 w-full overflow-hidden rounded-full border border-border bg-background"
    >
      <div className="bg-accent" style={{ width: `${external}%` }} />
      <div
        className="bg-[repeating-linear-gradient(135deg,var(--color-muted-foreground)_0_1.5px,transparent_1.5px_6px)] opacity-50"
        style={{ width: `${100 - external}%` }}
      />
    </div>
  );
}
