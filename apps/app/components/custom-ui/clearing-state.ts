/**
 * The clearing lifecycle, as the Dashboard presents it.
 *
 * A clearing is what reduces an Open Tab. It has five states and no others:
 *
 * | State | What it means |
 * | --- | --- |
 * | `Provisional` | The Watcher observed an unfinalized Settlement and the Service's free Bond covered it, so headroom was restored ahead of the proof. Revocable for its entire life. |
 * | `Confirmed` | The Verified Settlement exists. This is the only authority for a confirmed clearing, and it applies no second reduction. |
 * | `Reversed` | The confirmation deadline passed with no Verified Settlement, so the Open Tab was restored and the reserved Bond was slashed. |
 * | `Declined` | The Watcher observed a Settlement but free Bond did not cover it, so the Open Tab was left unchanged until a Verified Settlement arrives. **This is not a failure of the Settlement.** |
 * | `Superseded` | A Source Chain reorganisation removed the block carrying a Verified Settlement that had already confirmed. |
 *
 * Two notes on the words and the colours.
 *
 * The contract-side name of the first state is `Applied`, which is why its
 * design token is `clearing-applied`. The Dashboard says `Provisional`, because
 * that is what the state means to somebody reading a tab: applied, and
 * revocable. The token name and the label differ on purpose.
 *
 * Colour is named here as a `tone`, which is the vocabulary the badge primitive
 * already speaks: the primitive owns the mapping from a tone to a measured token
 * pair, and this table owns the mapping from a state to a tone. So the state
 * table never names a colour class, and the badge never has to know what a
 * clearing is. `badge-ink` on each clearing fill is checked at the 4.5:1 text
 * threshold and each clearing colour is checked as ink and as a border, so both
 * the filled and the outlined form of the badge are covered.
 *
 * Requirements: 15.7, 24.10
 */

/** The five clearing states, in the order the lifecycle introduces them. */
export const CLEARING_STATES = [
  "provisional",
  "confirmed",
  "reversed",
  "declined",
  "superseded",
] as const;

export type ClearingState = (typeof CLEARING_STATES)[number];

/** The badge tone each state resolves to. These are the primitive's own names. */
export type ClearingTone = "applied" | "confirmed" | "reversed" | "declined" | "superseded";

export interface ClearingStateDescriptor {
  readonly state: ClearingState;
  /** The word shown in the badge and spoken first in its accessible name. */
  readonly label: string;
  /** The design token carrying this state's colour, without the `--color-` prefix. */
  readonly token: string;
  /** The tone the badge primitive draws this state in. */
  readonly tone: ClearingTone;
  /** Swatch fill, for a legend or a stacked bar drawn outside a badge. */
  readonly fillClassName: string;
  /**
   * One sentence a reader can act on, spoken after the state in the accessible
   * name and offered as the badge's `title`.
   */
  readonly meaning: string;
  /** True only where a confirmation deadline is still running. */
  readonly carriesDeadline: boolean;
  /** True once the state can no longer change. */
  readonly terminal: boolean;
}

const DESCRIPTORS: Readonly<Record<ClearingState, ClearingStateDescriptor>> = {
  provisional: {
    state: "provisional",
    label: "Provisional",
    token: "clearing-applied",
    tone: "applied",
    fillClassName: "bg-clearing-applied",
    meaning:
      "Headroom was restored against the Service's Bond ahead of the proof. It stays revocable until the Verified Settlement exists.",
    carriesDeadline: true,
    terminal: false,
  },
  confirmed: {
    state: "confirmed",
    label: "Confirmed",
    token: "clearing-confirmed",
    tone: "confirmed",
    fillClassName: "bg-clearing-confirmed",
    meaning:
      "The Verified Settlement exists, so the reduction is final and the reserved Bond was released.",
    carriesDeadline: false,
    terminal: true,
  },
  reversed: {
    state: "reversed",
    label: "Reversed",
    token: "clearing-reversed",
    tone: "reversed",
    fillClassName: "bg-clearing-reversed",
    meaning:
      "The confirmation deadline passed with no Verified Settlement, so the Open Tab was restored and the reserved Bond was slashed.",
    carriesDeadline: false,
    terminal: true,
  },
  declined: {
    state: "declined",
    label: "Declined",
    token: "clearing-declined",
    tone: "declined",
    fillClassName: "bg-clearing-declined",
    meaning:
      "A Settlement was observed but free Bond did not cover it, so the Open Tab is unchanged until the Verified Settlement arrives. The Settlement itself did not fail.",
    carriesDeadline: false,
    terminal: true,
  },
  superseded: {
    state: "superseded",
    label: "Superseded",
    token: "clearing-superseded",
    tone: "superseded",
    fillClassName: "bg-clearing-superseded",
    meaning:
      "A Source Chain reorganisation removed the block carrying this Verified Settlement, so the Open Tab was restored and the Bond was slashed.",
    carriesDeadline: false,
    terminal: true,
  },
};

/** The descriptor for a state. Total over {@link ClearingState}, so it cannot fail. */
export function clearingStateDescriptor(state: ClearingState): ClearingStateDescriptor {
  return DESCRIPTORS[state];
}

/** Every descriptor, in lifecycle order. Useful for a legend. */
export const CLEARING_STATE_DESCRIPTORS: readonly ClearingStateDescriptor[] =
  CLEARING_STATES.map((state) => DESCRIPTORS[state]);

/** Runtime narrowing for a value that arrived from a read API. */
export function isClearingState(value: unknown): value is ClearingState {
  return typeof value === "string" && (CLEARING_STATES as readonly string[]).includes(value);
}
