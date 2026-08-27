/**
 * Turning a thrown value into something an operator can act on.
 *
 * `causeOf` in `@tabai/shared` covers the ordinary `Error`. One case it cannot cover
 * usefully is `AggregateError`, which is exactly what a Postgres driver throws when
 * a host resolves to several addresses and every connection attempt fails: the
 * outer error carries an empty message and all the information sits in `errors`.
 * Reported through `causeOf` alone that surfaces as `AggregateError:` with nothing
 * after the colon, which tells an operator that something failed and not what.
 *
 * So the sub-errors are flattened into the message. This is the difference between
 * "the migration transaction was rolled back" and "the migration transaction was
 * rolled back: connect ECONNREFUSED 127.0.0.1:5432".
 */

import { causeOf } from "@tabai/shared";

/** A thrown value as a `TabError` cause, with aggregate members flattened. */
export function describeCause(error: unknown): { code: string; message: string } {
  const base = causeOf(error);
  if (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0) {
    const parts = error.errors.map((member) => causeOf(member).message).filter((part) => part.length > 0);
    if (parts.length > 0) {
      return { code: base.code, message: base.message.length > 0 ? `${base.message}: ${parts.join("; ")}` : parts.join("; ") };
    }
  }
  return base;
}
