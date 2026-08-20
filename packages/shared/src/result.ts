/**
 * The zero-throw result type.
 *
 * No exported SDK function throws. `wrap` is the single boundary at which a
 * thrown value from a dependency becomes a `TabError`, so a caller only ever
 * branches on `result.ok` and never writes a `try` block of its own.
 *
 * HTTP surfaces map `category` to a status code:
 * `VALIDATION` 400, `AUTHORISATION` 403, `NOT_FOUND` 404, `LIMIT` 402,
 * `CONFLICT` 409, `UPSTREAM` 502, `UNAVAILABLE` 503, and
 * `PROOF`/`CHAIN`/`INTERNAL` 500.
 *
 * Requirements: 21.5
 */

export type ErrorCategory =
  /** caller-supplied input is malformed */
  | "VALIDATION"
  /** missing, expired, or exceeded spending authorisation */
  | "AUTHORISATION"
  /** unknown service, agent, asset, tab, or settlement */
  | "NOT_FOUND"
  /** credit limit or headroom exhausted */
  | "LIMIT"
  /** proof material missing, mismatched, or rejected */
  | "PROOF"
  /** Creditcoin or source-chain transaction failure */
  | "CHAIN"
  /** proof-builder, RPC endpoint, or service endpoint failure */
  | "UPSTREAM"
  /** replay, duplicate binding, timelock still pending */
  | "CONFLICT"
  /** chain not attesting, write path unavailable */
  | "UNAVAILABLE"
  /** invariant violated inside our own code */
  | "INTERNAL";

/** The HTTP status every category maps to, so services cannot disagree. */
export const HTTP_STATUS_BY_CATEGORY: Readonly<Record<ErrorCategory, number>> = {
  VALIDATION: 400,
  AUTHORISATION: 403,
  NOT_FOUND: 404,
  LIMIT: 402,
  PROOF: 500,
  CHAIN: 500,
  UPSTREAM: 502,
  CONFLICT: 409,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export interface TabError {
  category: ErrorCategory;
  /** stable and machine-readable, for example `LIMIT_EXCEEDED` */
  code: string;
  /** human-readable, carrying no secret and no stack trace */
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, string | number | boolean>;
  cause?: { code: string; message: string };
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: TabError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = (error: TabError): Result<never> => ({ ok: false, error });

/**
 * Runs `fn` and converts a thrown value into a `TabError` through `map`.
 * This is the only place in the workspace where a `catch` belongs.
 */
export const wrap = async <T>(
  fn: () => Promise<T>,
  map: (e: unknown) => TabError,
): Promise<Result<T>> => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(map(e));
  }
};

/** The synchronous sibling of `wrap`, for pure computations that validate their input. */
export const wrapSync = <T>(fn: () => T, map: (e: unknown) => TabError): Result<T> => {
  try {
    return ok(fn());
  } catch (e) {
    return err(map(e));
  }
};

/** Narrows an unknown thrown value into the `cause` shape a `TabError` accepts. */
export const causeOf = (e: unknown): { code: string; message: string } => {
  if (e instanceof Error) {
    return { code: e.name, message: e.message };
  }
  return { code: "UNKNOWN", message: String(e) };
};

/** True when the result carries a value. Present so callers can filter without a cast. */
export const isOk = <T>(result: Result<T>): result is { ok: true; value: T } => result.ok;

/** Returns the HTTP status a failed result maps to. */
export const httpStatusOf = (error: TabError): number => HTTP_STATUS_BY_CATEGORY[error.category];
