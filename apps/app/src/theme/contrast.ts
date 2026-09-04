/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * The arithmetic lives here rather than behind a dependency, so the CI check
 * owns every number it prints and nothing about the accessibility floor is
 * taken on trust.
 *
 * Relative luminance, WCAG 2.1:
 *
 *   L = 0.2126 R + 0.7152 G + 0.0722 B
 *
 * where each channel C in [0, 1] is linearised as
 *
 *   C <= 0.03928  ->  C / 12.92
 *   C >  0.03928  ->  ((C + 0.055) / 1.055) ^ 2.4
 *
 * Contrast ratio between two colours:
 *
 *   (L_lighter + 0.05) / (L_darker + 0.05)
 *
 * The ratio is symmetric, so a light label on a dark fill and the same dark
 * fill behind a light label yield one number.
 *
 * Requirements: 24.8, 24.10
 */

const SIX_DIGIT_HEX = /^#[0-9a-fA-F]{6}$/;

/** An 8-bit-per-channel colour. */
export interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/**
 * @param value a six-digit hex colour such as `#0B1220`
 * @throws when the string is not a six-digit hex colour
 */
export function parseHexColour(value: string): Rgb {
  if (!SIX_DIGIT_HEX.test(value)) {
    throw new Error(`contrast: \`${value}\` is not a six-digit hex colour`);
  }
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  };
}

/** Linearises one 8-bit channel to its light-intensity contribution. */
function linearise(channel: number): number {
  const normalised = channel / 255;
  return normalised <= 0.03928
    ? normalised / 12.92
    : Math.pow((normalised + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance, in [0, 1]. */
export function relativeLuminance(colour: Rgb): number {
  return (
    0.2126 * linearise(colour.red) +
    0.7152 * linearise(colour.green) +
    0.0722 * linearise(colour.blue)
  );
}

/** WCAG 2.1 contrast ratio between two six-digit hex colours, in [1, 21]. */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(parseHexColour(foreground));
  const second = relativeLuminance(parseHexColour(background));
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Two decimals, half away from zero. This is how the published table reads. */
export function roundToTwoDecimals(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}

/** Two decimals, always towards zero. */
export function floorToTwoDecimals(ratio: number): number {
  return Math.floor(ratio * 100) / 100;
}

/** Fixed-width `nn.nn` rendering for the report columns. */
export function formatRatio(ratio: number): string {
  return ratio.toFixed(2);
}
