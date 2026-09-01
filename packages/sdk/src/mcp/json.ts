/**
 * Defensive readers for JSON this package did not produce.
 *
 * The registry read API is a separate process on a separate release cadence, and
 * a Service endpoint is a third party's code. Neither is a compile-time
 * dependency of this package and neither should be: an interface mirrored here
 * would be a copy that goes stale silently, and the failure it produces is a
 * `TypeError` deep inside a tool handler rather than a message naming the field.
 *
 * So every field is read through one of these, each of which answers a value or
 * a stated fallback and never throws. A field that went missing upstream becomes
 * a null in the tool's output, which the schema declares as possible, instead of
 * taking the call down.
 *
 * Requirements: 25.1, 25.2
 */

/** A JSON object, as far as anything here is concerned. */
export type JsonRecord = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at `key`, when the container is an object. */
export const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** The value at a dotted path, stopping at the first non-object. */
export const path = (value: unknown, ...keys: readonly string[]): unknown =>
  keys.reduce<unknown>((current, key) => field(current, key), value);

export const asRecord = (value: unknown): JsonRecord => (isRecord(value) ? value : {});

export const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

export const asString = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

export const asStringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A finite number, or the fallback. `NaN` and an infinity are not numbers a schema accepts. */
export const asNumber = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
};

export const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/**
 * A `uint256` as the decimal string every amount crosses this boundary as.
 *
 * A JavaScript number is accepted only when it is a safe integer, because a
 * larger one has already lost digits by the time it arrives and stringifying it
 * would launder a rounded amount into something that looks exact.
 */
export const asDigits = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && /^[0-9]{1,39}$/.test(value)) return value;
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return fallback;
};

/** The same, but absence stays absence. */
export const asDigitsOrNull = (value: unknown): string | null => {
  const digits = asDigits(value, "");
  return digits === "" ? null : digits;
};

/** Seconds since the epoch, as an ISO instant. Null for anything unreadable. */
export const secondsToIso = (value: unknown): string | null => {
  const seconds = asDigits(value, "");
  if (seconds === "") return null;
  const millis = Number(seconds) * 1000;
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString();
};
