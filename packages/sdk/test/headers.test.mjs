/**
 * The Tab header contract: the grammar of every value, and the round trip between
 * the formatter the emitting side uses and the parser the client uses.
 *
 * The round trip is the point. Both halves of the wire protocol go through
 * `headers.ts`, so if the format ever changes on one side the assertion here fails
 * rather than a charge being mis-read in production.
 *
 * Requirements: 23.2, 21.5
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHARGE_RESPONSE_HEADERS,
  TAB_HEADER,
  agentRequestHeaders,
  chargedAssetKey,
  formatChargeHeaders,
  formatChargedAsset,
  headerReaderOf,
  parseBaseUnits,
  parseChargeHeaders,
  parseChargedAsset,
  sameChargedAsset,
} from "../dist/http/index.js";

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AGENT = "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37";
const SERVICE_ID = "0x7461622e70726f6f662d73657276696365000000000000000000000000000000";
/** `proof`, right-padded to a 32-byte word: the shape a `bytes32` tool key takes. */
const TOOL = `0x70726f6f66${"0".repeat(54)}`;
const AUTH_KEY = `0x${"ab".repeat(32)}`;

const block = (overrides = {}) => ({
  amount: 10_000n,
  asset: { chainKey: 3n, address: MAINNET_USDC.toLowerCase() },
  serviceId: SERVICE_ID,
  tool: TOOL,
  openTab: 40_000n,
  headroom: 960_000n,
  ...overrides,
});

const wire = (overrides = {}) => ({
  [TAB_HEADER.chargeAmount]: "10000",
  [TAB_HEADER.chargeAsset]: `3:${MAINNET_USDC.toLowerCase()}`,
  [TAB_HEADER.chargeService]: SERVICE_ID,
  [TAB_HEADER.chargeTool]: TOOL,
  [TAB_HEADER.openTab]: "40000",
  [TAB_HEADER.headroom]: "960000",
  ...overrides,
});

test("the charge block round-trips from the formatter through the parser unchanged", () => {
  const formatted = formatChargeHeaders(block());
  assert.equal(formatted.ok, true);
  assert.deepEqual(formatted.value, wire());

  const parsed = parseChargeHeaders(new Headers(formatted.value));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, block());

  // Every header the parser requires is a header the formatter writes.
  for (const name of CHARGE_RESPONSE_HEADERS) {
    assert.ok(name in formatted.value, `${name} is missing from the formatted block`);
  }
});

test("amounts beyond exact float range survive the round trip", () => {
  // 2^53 + 1: the first integer a double cannot represent. A `number` here would
  // come back as 9007199254740992 and still look like a plausible Open Tab.
  const huge = 9_007_199_254_740_993n;
  const formatted = formatChargeHeaders(block({ openTab: huge, amount: huge }));
  assert.equal(formatted.ok, true);
  assert.equal(formatted.value[TAB_HEADER.openTab], "9007199254740993");

  const parsed = parseChargeHeaders(headerReaderOf(formatted.value));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.openTab, huge);
  assert.equal(parsed.value.amount, huge);
  assert.notEqual(Number(huge).toString(), "9007199254740993");
});

test("a response carrying none of the six headers is simply not metered", () => {
  const parsed = parseChargeHeaders(new Headers({ "content-type": "application/json" }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value, undefined);
});

test("a partial charge block is an error, not a block with defaults", () => {
  for (const missing of CHARGE_RESPONSE_HEADERS) {
    const headers = wire();
    delete headers[missing];
    const parsed = parseChargeHeaders(new Headers(headers));
    assert.equal(parsed.ok, false, `${missing} was allowed to be absent`);
    assert.equal(parsed.error.code, "CHARGE_HEADERS_INCOMPLETE");
    assert.equal(parsed.error.category, "VALIDATION");
    assert.match(parsed.error.details.missing, new RegExp(missing));
  }
});

test("the base-unit grammar rejects every spelling that would be rounded or coerced", () => {
  for (const bad of ["1e6", "1.0", "1_000", "+1", "-1", "0x10", "1,000", "", "   ", "10 000", "NaN"]) {
    const parsed = parseChargeHeaders(new Headers(wire({ [TAB_HEADER.chargeAmount]: bad })));
    assert.equal(parsed.ok, false, `\`${bad}\` was accepted as an amount`);
    // An empty or blank value reads as an absent header, which makes the block partial.
    const expected = bad.trim().length === 0 ? "CHARGE_HEADERS_INCOMPLETE" : "CHARGE_AMOUNT_INVALID";
    assert.equal(parsed.error.code, expected);
  }

  const zero = parseChargeHeaders(new Headers(wire({ [TAB_HEADER.chargeAmount]: "0" })));
  assert.equal(zero.ok, true);
  assert.equal(zero.value.amount, 0n);

  const leadingZeros = parseBaseUnits("007", "X", "X_INVALID");
  assert.equal(leadingZeros.ok, true);
  assert.equal(leadingZeros.value, 7n);
});

test("the Asset header is a chainKey, a colon, and an address, and the address is lower-cased", () => {
  const parsed = parseChargedAsset(`3:${MAINNET_USDC}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.chainKey, 3n);
  assert.equal(parsed.value.address, MAINNET_USDC.toLowerCase());
  assert.equal(formatChargedAsset(parsed.value), `3:${MAINNET_USDC.toLowerCase()}`);
  assert.equal(chargedAssetKey(parsed.value), `3:${MAINNET_USDC.toLowerCase()}`);
  // Checksummed on one side, lower-case on the other: still one Asset, so a ledger
  // keyed by it reports one Open Tab rather than two.
  assert.equal(
    sameChargedAsset(parsed.value, { chainKey: 3n, address: MAINNET_USDC }),
    true,
  );

  for (const bad of [
    "3",
    MAINNET_USDC,
    `3:${MAINNET_USDC}:1`,
    "3:0xnotanaddress",
    `3:${MAINNET_USDC.slice(0, 20)}`,
    `0x3:${MAINNET_USDC}`,
    `-1:${MAINNET_USDC}`,
    // 2^64: one past the largest value the replay key's uint64 chainKey field holds.
    `18446744073709551616:${MAINNET_USDC}`,
  ]) {
    const rejected = parseChargedAsset(bad);
    assert.equal(rejected.ok, false, `\`${bad}\` was accepted as an Asset`);
    assert.equal(rejected.error.code, "CHARGE_ASSET_INVALID");
  }

  // uint64 max itself is in range: the bound is the field's bound, not a guess at
  // which chains exist.
  const edge = parseChargedAsset(`18446744073709551615:${MAINNET_USDC}`);
  assert.equal(edge.ok, true);
  assert.equal(edge.value.chainKey, 18_446_744_073_709_551_615n);
});

test("serviceId and the tool key must be whole 32-byte words", () => {
  const shortService = parseChargeHeaders(
    new Headers(wire({ [TAB_HEADER.chargeService]: "0x1234" })),
  );
  assert.equal(shortService.ok, false);
  assert.equal(shortService.error.code, "CHARGE_SERVICE_INVALID");

  const namedTool = parseChargeHeaders(new Headers(wire({ [TAB_HEADER.chargeTool]: "proof" })));
  assert.equal(namedTool.ok, false);
  assert.equal(namedTool.error.code, "CHARGE_TOOL_INVALID");
});

test("a repeated header fails loudly rather than resolving to one of its values", () => {
  const reader = headerReaderOf({ ...wire(), [TAB_HEADER.chargeAmount]: ["10000", "99999"] });
  const parsed = parseChargeHeaders(reader);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "CHARGE_AMOUNT_INVALID");
  assert.match(parsed.error.details.value, /10000, 99999/);
});

test("a plain header object is read case-insensitively", () => {
  const lowered = Object.fromEntries(Object.entries(wire()).map(([k, v]) => [k.toLowerCase(), v]));
  const parsed = parseChargeHeaders(lowered);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, block());
});

test("the formatter refuses a block it could not have produced", () => {
  for (const [overrides, code] of [
    [{ amount: -1n }, "CHARGE_AMOUNT_INVALID"],
    [{ openTab: -1n }, "OPEN_TAB_INVALID"],
    [{ headroom: -1n }, "HEADROOM_INVALID"],
    [{ amount: 10_000 }, "CHARGE_AMOUNT_INVALID"],
    [{ asset: { chainKey: 3n, address: "0x00" } }, "CHARGE_ASSET_INVALID"],
    [{ asset: { chainKey: -1n, address: MAINNET_USDC } }, "CHARGE_ASSET_INVALID"],
    [{ serviceId: "0x01" }, "CHARGE_SERVICE_INVALID"],
    [{ tool: "proof" }, "CHARGE_TOOL_INVALID"],
  ]) {
    const formatted = formatChargeHeaders(block(overrides));
    assert.equal(formatted.ok, false, `${JSON.stringify(code)} was formatted anyway`);
    assert.equal(formatted.error.code, code);
  }
});

test("the request headers carry the Agent, and the authKey only when there is one", () => {
  const both = agentRequestHeaders(AGENT, AUTH_KEY);
  assert.equal(both.ok, true);
  assert.deepEqual(both.value, {
    [TAB_HEADER.agent]: AGENT,
    [TAB_HEADER.authorisation]: AUTH_KEY,
  });

  const agentOnly = agentRequestHeaders(AGENT);
  assert.equal(agentOnly.ok, true);
  assert.deepEqual(agentOnly.value, { [TAB_HEADER.agent]: AGENT });

  const badAgent = agentRequestHeaders("0x1234");
  assert.equal(badAgent.ok, false);
  assert.equal(badAgent.error.code, "AGENT_INVALID");

  const badAuth = agentRequestHeaders(AGENT, "0xdead");
  assert.equal(badAuth.ok, false);
  assert.equal(badAuth.error.code, "AUTHORISATION_INVALID");
});
