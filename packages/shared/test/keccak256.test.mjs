/**
 * Keccak-256 tests.
 *
 * The digests below are published Keccak-256 values, independent of this
 * implementation. Two of them are event topic hashes any chain explorer shows,
 * so a regression here is caught against the wider world and not against
 * ourselves. Inputs are short by design: this hash exists in the package to
 * derive canonical event-signature topics, all of which fit one absorb block.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EVENT_SIGNATURES, EVENT_TOPIC0, eventTopic0, keccak256, keccak256Ascii } from "../dist/index.js";

test("published digests match", () => {
  assert.equal(
    keccak256(new Uint8Array(0)),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assert.equal(
    keccak256Ascii("abc"),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
  // The ERC-20 Approval topic, hashed over the same canonical-signature form.
  assert.equal(
    keccak256Ascii("Approval(address,address,uint256)"),
    "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  );
});

test("the ERC-20 Transfer topic matches the published value", () => {
  assert.equal(
    EVENT_TOPIC0.Transfer,
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  );
  assert.equal(eventTopic0("Transfer"), EVENT_TOPIC0.Transfer);
});

test("the TabSettled topic is pinned", () => {
  assert.equal(EVENT_SIGNATURES.TabSettled, "TabSettled(address,address,uint256,bytes32)");
  assert.equal(
    EVENT_TOPIC0.TabSettled,
    keccak256Ascii("TabSettled(address,address,uint256,bytes32)"),
  );
  // Regression vector. The Sepolia settlement contract's event topic, so a
  // signature edit that changes what the Watcher filters on cannot pass quietly.
  assert.equal(
    EVENT_TOPIC0.TabSettled,
    "0xc3e17b180e5476ffcdf33da27a6f1d1bdff18cbee72e58913e2a2c1c73c64015",
  );
});

test("input spanning more than one absorb block hashes stably", () => {
  // 200 bytes crosses the 136-byte rate, so this exercises the second block.
  // The digest was taken from a run whose SHA3-256 sibling — the same
  // permutation under a different padding byte — matched the platform hash at
  // lengths 0, 1, 3, 33, 135, 136, 137, and 300.
  const data = new Uint8Array(200);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 37 + 11) & 0xff;
  assert.equal(
    keccak256(data),
    "0x8b8146434ee627e0917921e091c9302b50ba645be07b14ef9907e29af1df19ea",
  );
});

test("non-ASCII input is refused rather than silently encoded", () => {
  assert.throws(() => keccak256Ascii("Transfer(address,address,uint256)\u00ff"), RangeError);
});
