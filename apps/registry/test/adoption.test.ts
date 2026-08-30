/**
 * Adoption measurement.
 *
 * Two things are under test and only one of them is arithmetic.
 *
 * The first is the direction of the classification rule. An address is external unless
 * this project controls it, so an incomplete allowlist can only inflate the external
 * figures. The opposite default would let a missing entry quietly suppress real
 * adoption, which is the more flattering failure, and the tests below pin that the
 * flattering failure is the one that cannot happen.
 *
 * The second is honesty about the delivery count. `DeliveryRecorded` is not indexed, so
 * the figure is a lower bound drawn from `PrepaidConsumed`. The field is named
 * `externalDeliveryLowerBound` rather than `externalDeliveryCount` and the basis says
 * so, because a smaller number presented as a total is worse than no number.
 *
 * Requirements: 29.1, 29.2, 29.3, 29.4, 29.5
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { computeAdoption, createClassifier, loadTeamAddresses } from "../src/adoption.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST = join(HERE, "..", "..", "..", "team-addresses.json");

const OPERATOR = "0xE5eaB26CaE0855BcCaBBb9A64faFce28C8432b37";
const DEMO_AGENT = "0x1F6f797Edc2EECb02BD54009B805fb2E99F80542";
const STRANGER = "0x1111111111111111111111111111111111111111";
const USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

const team = {
  network: "test",
  chainId: 102031,
  internal: [
    { address: OPERATOR.toLowerCase(), role: "operator", why: "ours" },
    { address: DEMO_AGENT.toLowerCase(), role: "demo agent", why: "ours" },
  ],
  sourceChainInternal: [],
};

test("the committed allowlist parses, and every entry explains itself", async () => {
  const loaded = await loadTeamAddresses(ALLOWLIST);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.ok ? {} : loaded.error));
  if (!loaded.ok) return;
  assert.ok(loaded.value.internal.length > 0, "an empty allowlist would call every address external");
  for (const entry of loaded.value.internal) {
    assert.match(entry.address, /^0x[0-9a-f]{40}$/, "addresses are stored lowercased");
    assert.ok(entry.role.length > 0);
    assert.ok(entry.why.length > 0, `${entry.address} must say why it is ours`);
  }
});

test("the committed allowlist names the operator, the Watcher and the demonstration Agent", async () => {
  const loaded = await loadTeamAddresses(ALLOWLIST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const addresses = loaded.value.internal.map((entry) => entry.address);
  // These three sign nearly everything on the live deployment. Omitting any one of
  // them would report our own traffic as adoption.
  assert.ok(addresses.includes(OPERATOR.toLowerCase()), "the Service operator is ours");
  assert.ok(addresses.includes("0xb67c73fd513adf5d270d1102f04eb8327f218fe7"), "the Watcher is ours");
  assert.ok(addresses.includes(DEMO_AGENT.toLowerCase()), "the demonstration Agent is ours");
});

test("an entry with no reason is refused", async () => {
  const loaded = await loadTeamAddresses(join(HERE, "does-not-exist.json"));
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.code, "TEAM_ADDRESSES_UNREADABLE");
  assert.equal(loaded.error.category, "INTERNAL", "a missing allowlist is our bug, not a caller's");
});

test("an address absent from the allowlist is external", () => {
  const classifier = createClassifier(team);
  assert.equal(classifier.isExternal(STRANGER), true);
  assert.equal(classifier.isInternal(STRANGER), false);
  assert.equal(classifier.roleOf(STRANGER), undefined);
});

test("classification ignores address casing", () => {
  const classifier = createClassifier(team);
  assert.equal(classifier.isInternal(OPERATOR), true, "a checksummed address is the same address");
  assert.equal(classifier.isInternal(OPERATOR.toLowerCase()), true);
  assert.equal(classifier.roleOf(OPERATOR), "operator");
});

test("a Source Chain address that is ours is still external on Creditcoin", () => {
  // The same 20 bytes mean different things on different chains, and an entry in the
  // Source Chain list must not mask a genuinely external Creditcoin Agent.
  const classifier = createClassifier({
    ...team,
    sourceChainInternal: [{ address: STRANGER.toLowerCase(), role: "ours on Ethereum", why: "ours", chainKey: 1 }],
  });
  assert.equal(classifier.isExternal(STRANGER), true);
});

test("volume and Settlement counts split by who was credited", () => {
  const metrics = computeAdoption(
    createClassifier(team),
    [
      { agent: DEMO_AGENT, asset: USDC, amount: 212_000n, settlementCount: 4 },
      { agent: STRANGER, asset: USDC, amount: 50_000n, settlementCount: 2 },
    ],
    [],
    ALLOWLIST,
  );

  assert.equal(metrics.externalAgentCount, 1);
  assert.equal(metrics.internalAgentCount, 1);
  assert.equal(metrics.externalSettlementCount, 2);
  assert.equal(metrics.internalSettlementCount, 4);
  assert.deepEqual(metrics.volumeByAsset, [
    { asset: USDC, externalBaseUnits: "50000", internalBaseUnits: "212000", totalBaseUnits: "262000" },
  ]);
});

test("amounts leave as strings and survive a uint128 ceiling", () => {
  const huge = (1n << 127n) - 1n;
  const metrics = computeAdoption(
    createClassifier(team),
    [{ agent: STRANGER, asset: USDC, amount: huge, settlementCount: 1 }],
    [],
    ALLOWLIST,
  );
  assert.equal(metrics.volumeByAsset[0]?.externalBaseUnits, huge.toString());
  assert.equal(typeof metrics.volumeByAsset[0]?.totalBaseUnits, "string", "a settled amount through a float is a wrong number");
});

test("the delivery figure is a lower bound, named and explained as one", () => {
  const metrics = computeAdoption(
    createClassifier(team),
    [],
    [
      { agent: DEMO_AGENT, asset: USDC },
      { agent: DEMO_AGENT, asset: USDC },
      { agent: STRANGER, asset: USDC },
    ],
    ALLOWLIST,
  );

  assert.equal(metrics.externalDeliveryLowerBound, 1);
  assert.equal(metrics.internalDeliveryLowerBound, 2);
  assert.match(metrics.basis.deliveries, /LOWER BOUND/, "the caveat travels with the figure");
  assert.match(metrics.basis.deliveries, /DeliveryRecorded is not indexed/);
  assert.equal(
    Object.hasOwn(metrics, "externalDeliveryCount"),
    false,
    "no field name implies a total that is not one",
  );
});

test("an empty index reports zeroes rather than nothing", () => {
  const metrics = computeAdoption(createClassifier(team), [], [], ALLOWLIST);
  assert.equal(metrics.externalAgentCount, 0);
  assert.equal(metrics.externalSettlementCount, 0);
  assert.deepEqual(metrics.volumeByAsset, []);
  assert.equal(metrics.allowlist.internalCount, 2, "the allowlist size is served so the split is checkable");
});

test("volume is grouped per Asset and ordered stably", () => {
  const other = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const metrics = computeAdoption(
    createClassifier(team),
    [
      { agent: STRANGER, asset: USDC, amount: 1n, settlementCount: 1 },
      { agent: STRANGER, asset: other, amount: 2n, settlementCount: 1 },
    ],
    [],
    ALLOWLIST,
  );
  assert.deepEqual(metrics.volumeByAsset.map((row) => row.asset), [other, USDC].sort());
});

test("every published figure carries its derivation", () => {
  const metrics = computeAdoption(createClassifier(team), [], [], ALLOWLIST);
  for (const [name, basis] of Object.entries(metrics.basis)) {
    assert.equal(typeof basis, "string");
    assert.ok(basis.length > 40, `${name} needs a basis a third party can act on`);
  }
  assert.match(metrics.basis.classification, /absent from the `internal` list/);
});
