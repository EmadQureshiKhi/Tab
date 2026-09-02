/**
 * The attestation gate, which is the one refusal R22.5 spells out figure by figure.
 *
 * The boundary case is the one worth having: a height **at** the frontier is
 * attested, because the frontier is the highest height the chain has attested rather
 * than the first it has not. Getting that comparison wrong refuses exactly the
 * freshest request that can be served.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkHeightAttested,
  chainNotAttesting,
  createPrecompileAttestationReader,
  heightNotAttested,
  ASSUMED_NAMES_THAT_DO_NOT_EXIST,
  CHAIN_INFO_INTERFACE,
} from "../dist/attestation.js";

const readerAt = (height, extra = {}) => ({
  latestAttestation: async () => ({
    ok: true,
    value: { height, digest: `0x${"ab".repeat(32)}`, isAttestation: true, exists: true, ...extra },
  }),
});

test("a height below the frontier is attested", async () => {
  const verdict = await checkHeightAttested(readerAt(25_877_000n), 3n, 25_876_970n);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.attested, true);
  assert.equal(verdict.value.blocksBehind, 0n);
});

test("a height exactly at the frontier is attested, not refused", async () => {
  const verdict = await checkHeightAttested(readerAt(25_876_970n), 3n, 25_876_970n);
  assert.equal(verdict.ok, true);
});

test("a height one past the frontier is refused and names both figures", async () => {
  const verdict = await checkHeightAttested(readerAt(25_876_969n), 3n, 25_876_970n);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error.code, "HEIGHT_NOT_ATTESTED");
  assert.equal(verdict.error.category, "UNAVAILABLE");
  assert.equal(verdict.error.retryable, true);
  assert.equal(verdict.error.details.requestedHeight, "25876970");
  assert.equal(verdict.error.details.attestedHeight, "25876969");
  assert.equal(verdict.error.details.blocksBehind, "1");
  assert.equal(verdict.error.details.metered, false);
  assert.match(verdict.error.message, /25876970/);
  assert.match(verdict.error.message, /25876969/);
  assert.match(verdict.error.message, /nothing has been metered/);
});

test("a chain with no attestation record at all is its own refusal", async () => {
  const reader = {
    latestAttestation: async () => ({
      ok: true,
      value: { height: 0n, digest: `0x${"00".repeat(32)}`, isAttestation: false, exists: false },
    }),
  };
  const verdict = await checkHeightAttested(reader, 9n, 1n);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error.code, "CHAIN_NOT_ATTESTING");
  assert.equal(verdict.error.details.metered, false);
});

test("a frontier that is a checkpoint rather than an attestation is still a frontier", async () => {
  const verdict = await checkHeightAttested(readerAt(100n, { isAttestation: false }), 3n, 50n);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.value.frontierIsAttestation, false);
});

test("a failed precompile read is passed through rather than read as unattested", async () => {
  const reader = {
    latestAttestation: async () => ({
      ok: false,
      error: { category: "UPSTREAM", code: "CHAININFO_READ_FAILED", message: "down", retryable: true },
    }),
  };
  const verdict = await checkHeightAttested(reader, 3n, 1n);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.error.code, "CHAININFO_READ_FAILED");
});

test("both refusals carry `metered: false`, which is the requirement rather than a nicety", () => {
  const verdict = { chainKey: 1n, requestedHeight: 9n, attestedHeight: 4n, blocksBehind: 5n, attested: false, frontierIsAttestation: true };
  assert.equal(heightNotAttested(verdict).details.metered, false);
  assert.equal(chainNotAttesting(1n, 9n).details.metered, false);
});

test("the camelCase names that revert Unknown selector are recorded beside the working one", () => {
  assert.equal(
    ASSUMED_NAMES_THAT_DO_NOT_EXIST["latestAttestedHeight(uint64)"],
    "get_latest_attestation_height_and_hash(uint64)",
  );
});

test("the reader decodes the precompile's four-field tuple positionally", async () => {
  const encoded = CHAIN_INFO_INTERFACE.encodeFunctionResult("get_latest_attestation_height_and_hash", [
    [25_877_000n, `0x${"cd".repeat(32)}`, true, true],
  ]);
  const provider = { call: async () => encoded };
  const reader = createPrecompileAttestationReader(provider, `0x${"0".repeat(37)}fd3`, "finalized");
  const frontier = await reader.latestAttestation(3n);
  assert.equal(frontier.ok, true);
  assert.equal(frontier.value.height, 25_877_000n);
  assert.equal(frontier.value.isAttestation, true);
  assert.equal(frontier.value.exists, true);
});

test("an unknown selector is a drifted ABI and not a downed node", async () => {
  const provider = {
    call: async () => {
      throw new Error("execution reverted: Unknown selector");
    },
  };
  const reader = createPrecompileAttestationReader(provider, `0x${"0".repeat(37)}fd3`, "finalized");
  const frontier = await reader.latestAttestation(3n);
  assert.equal(frontier.ok, false);
  assert.equal(frontier.error.code, "CHAININFO_SELECTOR_UNKNOWN");
  assert.equal(frontier.error.retryable, false);
});

test("any other read failure is retryable upstream", async () => {
  const provider = {
    call: async () => {
      throw new Error("socket hang up");
    },
  };
  const reader = createPrecompileAttestationReader(provider, `0x${"0".repeat(37)}fd3`, "finalized");
  const frontier = await reader.latestAttestation(3n);
  assert.equal(frontier.ok, false);
  assert.equal(frontier.error.code, "CHAININFO_READ_FAILED");
  assert.equal(frontier.error.retryable, true);
});

test("a return this ABI cannot read is a decode failure rather than a silent zero", async () => {
  const provider = { call: async () => "0x1234" };
  const reader = createPrecompileAttestationReader(provider, `0x${"0".repeat(37)}fd3`, "finalized");
  const frontier = await reader.latestAttestation(3n);
  assert.equal(frontier.ok, false);
  assert.equal(frontier.error.code, "CHAININFO_DECODE_FAILED");
});

test("the read is pinned to the tag it was built with", async () => {
  const seen = [];
  const encoded = CHAIN_INFO_INTERFACE.encodeFunctionResult("get_latest_attestation_height_and_hash", [
    [1n, `0x${"00".repeat(32)}`, true, true],
  ]);
  const provider = {
    call: async (request) => {
      seen.push(request.blockTag);
      return encoded;
    },
  };
  const reader = createPrecompileAttestationReader(provider, `0x${"0".repeat(37)}fd3`, "finalized");
  await reader.latestAttestation(1n);
  assert.deepEqual(seen, ["finalized"]);
});
