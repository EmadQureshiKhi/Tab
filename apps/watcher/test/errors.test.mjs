/**
 * Cause flattening.
 *
 * The case that matters is the one a Postgres driver produces when a host resolves
 * to several addresses and every attempt fails: an `AggregateError` with an empty
 * message and everything useful in `errors`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { describeCause } from "../dist/index.js";

test("an aggregate error reports what its members said", () => {
  const cause = describeCause(
    new AggregateError([
      new Error("connect ECONNREFUSED ::1:5432"),
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    ]),
  );
  assert.equal(cause.code, "AggregateError");
  assert.equal(cause.message, "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432");
});

test("an ordinary error is passed through unchanged", () => {
  const cause = describeCause(new TypeError("bad shape"));
  assert.deepEqual(cause, { code: "TypeError", message: "bad shape" });
});

test("an aggregate error with a message of its own keeps it", () => {
  const cause = describeCause(new AggregateError([new Error("inner")], "all attempts failed"));
  assert.equal(cause.message, "all attempts failed: inner");
});

test("a thrown non-error still yields something printable", () => {
  assert.deepEqual(describeCause("plain string"), { code: "UNKNOWN", message: "plain string" });
});
