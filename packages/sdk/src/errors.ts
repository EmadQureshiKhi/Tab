/**
 * Error constructors for the SDK.
 *
 * Nothing exported from this package throws (R21.5, design section 13.1), so
 * every fallible call ends in one of these. The categories, codes, and the
 * status each category maps to all come from `@tabai/shared`; this module only
 * saves every call site from writing the same object literal.
 *
 * Requirements: 21.5
 */

import { err, type ErrorCategory, type Result, type TabError } from "@tabai/shared";

/** The optional half of a `TabError`, so a call site names only what it knows. */
export type ErrorExtras = Partial<Pick<TabError, "retryable" | "retryAfterMs" | "details" | "cause">>;

/**
 * Builds a `TabError`. `retryable` defaults to false: a caller that retries an
 * error nobody marked retryable is the failure mode worth defaulting against.
 */
export function tabError(
  category: ErrorCategory,
  code: string,
  message: string,
  extras: ErrorExtras = {},
): TabError {
  return {
    category,
    code,
    message,
    retryable: extras.retryable ?? false,
    ...(extras.retryAfterMs === undefined ? {} : { retryAfterMs: extras.retryAfterMs }),
    ...(extras.details === undefined ? {} : { details: extras.details }),
    ...(extras.cause === undefined ? {} : { cause: extras.cause }),
  };
}

/** `tabError` already wrapped as a failed `Result`. */
export const fail = (
  category: ErrorCategory,
  code: string,
  message: string,
  extras: ErrorExtras = {},
): Result<never> => err(tabError(category, code, message, extras));

/** Caller-supplied input is malformed. HTTP 400. */
export const validationError = (code: string, message: string, extras?: ErrorExtras): Result<never> =>
  fail("VALIDATION", code, message, extras);

/** Unknown strategy, asset, service, or config file. HTTP 404. */
export const notFoundError = (code: string, message: string, extras?: ErrorExtras): Result<never> =>
  fail("NOT_FOUND", code, message, extras);

/** An RPC endpoint, a module loader, or a consumer-supplied callback failed. HTTP 502. */
export const upstreamError = (code: string, message: string, extras?: ErrorExtras): Result<never> =>
  fail("UPSTREAM", code, message, extras);

/** A Source Chain transaction failed to submit. HTTP 500. */
export const chainError = (code: string, message: string, extras?: ErrorExtras): Result<never> =>
  fail("CHAIN", code, message, extras);
