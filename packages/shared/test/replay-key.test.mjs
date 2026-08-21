/**
 * Replay-key packing tests.
 *
 * The fixed vector below is the reference the Solidity implementation is checked
 * against: the same tuple packed on chain must produce the same word, byte for
 * byte. Run against the built output, so what is tested is what consumers import.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { UINT64_MAX, packReplayKey, replayKey, unpackReplayKey } from "../dist/index.js";

/** The fixed cross-implementation vector. */
const FIXED_TUPLE = {
  chainKey: 3n,
  blockHeight: 25_868_090n,
  txIndex: 42n,
  logIndex: 7n,
};
const FIXED_KEY = "0x000000000000000300000000018ab73a000000000000002a0000000000000007";

const FIELDS = ["chainKey", "blockHeight", "txIndex", "logIndex"];

test("the fixed vector packs to the documented word", () => {
  assert.equal(packReplayKey(FIXED_TUPLE), FIXED_KEY);
  assert.deepEqual(unpackReplayKey(FIXED_KEY), FIXED_TUPLE);
});

test("each field lands at its documented bit offset", () => {
  // A single field set to 1, the rest zero, isolates that field's offset.
  assert.equal(
    replayKey(1n, 0n, 0n, 0n),
    "0x0000000000000001000000000000000000000000000000000000000000000000",
  );
  assert.equal(
    replayKey(0n, 1n, 0n, 0n),
    "0x0000000000000000000000000000000100000000000000000000000000000000",
  );
  assert.equal(
    replayKey(0n, 0n, 1n, 0n),
    "0x0000000000000000000000000000000000000000000000010000000000000000",
  );
  assert.equal(
    replayKey(0n, 0n, 0n, 1n),
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
});

test("the round trip holds at both boundaries of every field", () => {
  const boundaries = [0n, UINT64_MAX];
  for (const chainKey of boundaries) {
    for (const blockHeight of boundaries) {
      for (const txIndex of boundaries) {
        for (const logIndex of boundaries) {
          const fields = { chainKey, blockHeight, txIndex, logIndex };
          assert.deepEqual(unpackReplayKey(packReplayKey(fields)), fields);
        }
      }
    }
  }
});

test("the all-zero and all-max tuples pack to the extreme words", () => {
  assert.equal(replayKey(0n, 0n, 0n, 0n), `0x${"0".repeat(64)}`);
  assert.equal(
    replayKey(UINT64_MAX, UINT64_MAX, UINT64_MAX, UINT64_MAX),
    `0x${"f".repeat(64)}`,
  );
});

test("the round trip holds across a spread of realistic tuples", () => {
  const tuples = [
    { chainKey: 1n, blockHeight: 11_598_820n, txIndex: 0n, logIndex: 0n },
    { chainKey: 1n, blockHeight: 11_598_863n, txIndex: 199n, logIndex: 12n },
    { chainKey: 3n, blockHeight: 1n, txIndex: 65_535n, logIndex: 255n },
    { chainKey: 3n, blockHeight: UINT64_MAX - 1n, txIndex: 1n, logIndex: UINT64_MAX },
  ];
  for (const fields of tuples) {
    assert.deepEqual(unpackReplayKey(packReplayKey(fields)), fields);
  }
});

test("distinct tuples never collide", () => {
  const keys = new Set();
  for (const chainKey of [1n, 3n]) {
    for (const blockHeight of [0n, 1n, 25_868_090n]) {
      for (const txIndex of [0n, 1n, 42n]) {
        for (const logIndex of [0n, 1n, 7n]) {
          keys.add(replayKey(chainKey, blockHeight, txIndex, logIndex));
        }
      }
    }
  }
  assert.equal(keys.size, 2 * 3 * 3 * 3);
});

test("one past the ceiling is a RangeError naming the field", () => {
  const overflow = UINT64_MAX + 1n;
  for (const field of FIELDS) {
    const fields = { chainKey: 0n, blockHeight: 0n, txIndex: 0n, logIndex: 0n };
    fields[field] = overflow;
    assert.throws(
      () => packReplayKey(fields),
      (error) =>
        error instanceof RangeError &&
        error.message.includes(field) &&
        error.message.includes(overflow.toString()),
      `${field} at 2^64 must be rejected`,
    );
  }
});

test("a negative field is a RangeError naming the field", () => {
  for (const field of FIELDS) {
    const fields = { chainKey: 0n, blockHeight: 0n, txIndex: 0n, logIndex: 0n };
    fields[field] = -1n;
    assert.throws(
      () => packReplayKey(fields),
      (error) => error instanceof RangeError && error.message.includes(field),
      `${field} at -1 must be rejected`,
    );
  }
});

test("unpacking a malformed word is a TypeError", () => {
  assert.throws(() => unpackReplayKey("0x1234"), TypeError);
  assert.throws(() => unpackReplayKey(FIXED_KEY.slice(2)), TypeError);
});
