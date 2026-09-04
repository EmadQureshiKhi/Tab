/**
 * The design-token model.
 *
 * Every colour token is *derived* from `assets/palette.json`: either it names a
 * colour in the palette, or it aliases another token. No hex value appears in
 * this file, so the theme cannot drift from the artwork.
 *
 * The token set covers surfaces, ink, the accent, the control stroke, the two
 * curation tiers, and the five clearing states, in light and dark.
 *
 * Requirements: 24.8, 24.10
 */

import { CLEARING_STATES, type ClearingState, type ModePalette } from "./palette.js";

/** The six palette colours that a token may name directly. */
export const BASE_COLOUR_KEYS = [
  "surface",
  "surfaceRaised",
  "text",
  "textMuted",
  "accent",
  "stroke",
] as const;

export type BaseColourKey = (typeof BASE_COLOUR_KEYS)[number];

/** How a token gets its value. */
export type TokenValue =
  | { readonly kind: "base"; readonly key: BaseColourKey }
  | { readonly kind: "clearing"; readonly state: ClearingState }
  | { readonly kind: "alias"; readonly of: string };

export interface TokenSpec {
  /** Token name; the CSS custom property is `--tab-<token>`. */
  readonly token: string;
  /** What the token is for, emitted as a comment into the generated CSS. */
  readonly purpose: string;
  readonly value: TokenValue;
}

/**
 * The token table.
 *
 * `tier-curated` and `tier-permissionless` alias the accent and the muted ink
 * rather than introducing colours of their own, because `assets/palette.json`
 * publishes no separate tier colours and inventing two would put the theme
 * outside the checked palette. Curation tier is always spelled out in words as
 * well, so the tier never rests on colour alone.
 *
 * `badge-ink` aliases `surface`: a filled badge always takes the surface colour
 * as its label ink, which is the rule the artwork already follows.
 *
 * `focus-ring` aliases `accent`, so task 20.1 consumes a focus-ring token
 * instead of picking a colour again.
 */
export const TOKENS: readonly TokenSpec[] = [
  {
    token: "surface",
    purpose: "page background",
    value: { kind: "base", key: "surface" },
  },
  {
    token: "surface-raised",
    purpose: "card, panel, and table-header background",
    value: { kind: "base", key: "surfaceRaised" },
  },
  {
    token: "text",
    purpose: "body and numeric ink",
    value: { kind: "base", key: "text" },
  },
  {
    token: "text-muted",
    purpose: "secondary ink, labels, units",
    value: { kind: "base", key: "textMuted" },
  },
  {
    token: "accent",
    purpose: "accent ink, primary chart series, accent-filled badge",
    value: { kind: "base", key: "accent" },
  },
  {
    token: "stroke",
    purpose: "control boundary, table rule, outline of every raised surface",
    value: { kind: "base", key: "stroke" },
  },
  {
    token: "clearing-applied",
    purpose: "clearing state Applied",
    value: { kind: "clearing", state: "applied" },
  },
  {
    token: "clearing-confirmed",
    purpose: "clearing state Confirmed",
    value: { kind: "clearing", state: "confirmed" },
  },
  {
    token: "clearing-reversed",
    purpose: "clearing state Reversed",
    value: { kind: "clearing", state: "reversed" },
  },
  {
    token: "clearing-declined",
    purpose: "clearing state Declined",
    value: { kind: "clearing", state: "declined" },
  },
  {
    token: "clearing-superseded",
    purpose: "clearing state Superseded",
    value: { kind: "clearing", state: "superseded" },
  },
  {
    token: "tier-curated",
    purpose: "Curated Tier, alongside the words Curated Tier",
    value: { kind: "alias", of: "accent" },
  },
  {
    token: "tier-permissionless",
    purpose: "Permissionless Tier, alongside the words Permissionless Tier",
    value: { kind: "alias", of: "text-muted" },
  },
  {
    token: "badge-ink",
    purpose: "label ink on any filled badge",
    value: { kind: "alias", of: "surface" },
  },
  {
    token: "focus-ring",
    purpose: ":focus-visible ring colour",
    value: { kind: "alias", of: "accent" },
  },
];

const TOKENS_BY_NAME: ReadonlyMap<string, TokenSpec> = new Map(
  TOKENS.map((spec) => [spec.token, spec]),
);

/** @returns the token spec, or throws when the name is unknown */
export function tokenSpec(token: string): TokenSpec {
  const spec = TOKENS_BY_NAME.get(token);
  if (spec === undefined) throw new Error(`tokens: unknown token \`${token}\``);
  return spec;
}

/** Resolves a token to a hex colour for one mode, following alias chains. */
export function resolveTokenColour(token: string, mode: ModePalette): string {
  let spec = tokenSpec(token);
  for (let hop = 0; hop <= TOKENS.length; hop += 1) {
    const value = spec.value;
    if (value.kind === "base") return mode[value.key];
    if (value.kind === "clearing") return mode.clearing[value.state];
    spec = tokenSpec(value.of);
  }
  throw new Error(`tokens: alias chain for \`${token}\` does not terminate`);
}

/** The CSS custom property that carries a token's raw value. */
export function tokenCssVariable(token: string): string {
  return `--tab-${token}`;
}

/** The Tailwind colour-namespace property a token is published under. */
export function tokenThemeVariable(token: string): string {
  return `--color-${token}`;
}

/**
 * Mode-independent scalars.
 *
 * The focus ring is a token here so that every control gets the same 2 px ring
 * at a 2 px offset without deciding it again. `--tab-raised-outline-width` is
 * the width of the outline that carries the separation between the two
 * surfaces, which is the compensating mechanism the contrast check requires.
 */
export const SCALAR_TOKENS: readonly {
  readonly token: string;
  readonly value: string;
  readonly purpose: string;
}[] = [
  { token: "focus-ring-width", value: "2px", purpose: ":focus-visible outline width" },
  { token: "focus-ring-offset", value: "2px", purpose: ":focus-visible outline offset" },
  { token: "focus-ring-style", value: "solid", purpose: ":focus-visible outline style" },
  {
    token: "raised-outline-width",
    value: "1px",
    purpose: "outline that separates a raised surface from the page",
  },
  { token: "motion-fast", value: "120ms", purpose: "hover, focus, and press transitions" },
  { token: "motion-base", value: "240ms", purpose: "panel, drawer, and reveal transitions" },
  {
    token: "motion-instant",
    value: "0.01ms",
    purpose: "duration substituted under prefers-reduced-motion: reduce",
  },
];

/** Accessibility roles a token pair can play, with the ratio each role demands. */
export const ROLE_MINIMUMS = {
  /** Body and numeric text. */
  text: 4.5,
  /** Text at 24 px, or 19 px bold and above. */
  largeText: 3,
  /** Interactive control boundaries. */
  controlBoundary: 3,
  /** The `:focus-visible` ring against what sits next to it. */
  focusRing: 3,
  /** Chart series strokes against the plot background. */
  chartStroke: 3,
  /** Badge borders and badge fills against the surface behind them. */
  badgeBorder: 3,
  /**
   * Two surfaces that are deliberately close. Every pair carrying this role
   * must appear in LOW_CONTRAST_ALLOWLIST with a reason and a compensating
   * pair, and the compensating pair is itself checked.
   */
  surfaceSeparation: 1,
} as const;

export type Role = keyof typeof ROLE_MINIMUMS;

export interface TokenPair {
  readonly id: string;
  readonly mode: "light" | "dark";
  readonly foregroundToken: string;
  readonly backgroundToken: string;
  readonly roles: readonly Role[];
}

/** The strictest ratio any of a pair's roles demands. */
export function pairThreshold(pair: TokenPair): number {
  return pair.roles.reduce((highest, role) => Math.max(highest, ROLE_MINIMUMS[role]), 0);
}

const CLEARING_TOKENS: readonly string[] = CLEARING_STATES.map(
  (state) => `clearing-${state}`,
);

/** Every token that may sit as ink on a surface, with the roles it plays there. */
const INK_ON_SURFACE: readonly { readonly token: string; readonly roles: readonly Role[] }[] = [
  { token: "text", roles: ["text"] },
  { token: "text-muted", roles: ["text"] },
  { token: "accent", roles: ["text", "chartStroke", "badgeBorder"] },
  { token: "tier-curated", roles: ["text", "badgeBorder"] },
  { token: "tier-permissionless", roles: ["text", "badgeBorder"] },
  ...CLEARING_TOKENS.map((token) => ({
    token,
    roles: ["text", "chartStroke", "badgeBorder"] as readonly Role[],
  })),
];

/** Every fill that can sit under badge ink. */
const BADGE_FILLS: readonly string[] = [
  "accent",
  "tier-curated",
  "tier-permissionless",
  ...CLEARING_TOKENS,
];

const SURFACES: readonly string[] = ["surface", "surface-raised"];

function pairId(mode: "light" | "dark", foreground: string, background: string): string {
  return `${mode}.${foreground}-on-${background}`;
}

function pairsForMode(mode: "light" | "dark"): readonly TokenPair[] {
  const pairs: TokenPair[] = [];

  for (const background of SURFACES) {
    for (const ink of INK_ON_SURFACE) {
      pairs.push({
        id: pairId(mode, ink.token, background),
        mode,
        foregroundToken: ink.token,
        backgroundToken: background,
        roles: ink.roles,
      });
    }
    // The control boundary, the table rule, and the outline around every
    // raised surface are all drawn with `stroke`.
    pairs.push({
      id: pairId(mode, "stroke", background),
      mode,
      foregroundToken: "stroke",
      backgroundToken: background,
      roles: ["controlBoundary", "badgeBorder"],
    });
    // The ring sits in a 2 px gap of the surface behind the control, so the
    // surface is what the ring is adjacent to, including on a filled control.
    pairs.push({
      id: pairId(mode, "focus-ring", background),
      mode,
      foregroundToken: "focus-ring",
      backgroundToken: background,
      roles: ["focusRing"],
    });
  }

  for (const fill of BADGE_FILLS) {
    pairs.push({
      id: pairId(mode, "badge-ink", fill),
      mode,
      foregroundToken: "badge-ink",
      backgroundToken: fill,
      roles: ["text"],
    });
  }

  pairs.push({
    id: pairId(mode, "surface-raised", "surface"),
    mode,
    foregroundToken: "surface-raised",
    backgroundToken: "surface",
    roles: ["surfaceSeparation"],
  });

  return pairs;
}

/** Every token pair the check evaluates, light then dark. */
export const TOKEN_PAIRS: readonly TokenPair[] = [
  ...pairsForMode("light"),
  ...pairsForMode("dark"),
];

/**
 * A pair that is below the 3:1 non-text floor on purpose.
 *
 * An entry is only valid when it states a reason and names at least one
 * compensating pair, and the check evaluates every compensating pair against
 * its own threshold. A pair below the floor with no entry fails the build; an
 * entry whose pair now clears the floor also fails, so a stale exemption
 * cannot sit here unnoticed.
 */
export interface LowContrastAllowance {
  readonly pairId: string;
  readonly reason: string;
  readonly compensatingPairIds: readonly string[];
}

export const LOW_CONTRAST_ALLOWLIST: readonly LowContrastAllowance[] = [
  {
    pairId: "light.surface-raised-on-surface",
    reason:
      "A raised surface is meant to read as the same paper under a slightly different light, so the two light surfaces sit close together by design. The separation is carried by a 1 px outline in `stroke` around every raised surface, not by the fill difference.",
    compensatingPairIds: ["light.stroke-on-surface", "light.stroke-on-surface-raised"],
  },
  {
    pairId: "dark.surface-raised-on-surface",
    reason:
      "The dark pair follows the same rule: the raised surface is the same paper under a different light, and the 1 px outline in `stroke` is what separates it from the page.",
    compensatingPairIds: ["dark.stroke-on-surface", "dark.stroke-on-surface-raised"],
  },
];

/** The floor a pair must clear to need no allowance. */
export const NON_TEXT_FLOOR = ROLE_MINIMUMS.controlBoundary;
