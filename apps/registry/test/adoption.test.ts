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
 * The second is the network an entry holds on. One allowlist covers Mainnet and
 * Testnet, and the classifier is built for the chain the registry indexes, so an
 * address listed for one network alone must not count as ours on the other.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { computeAdoption, createClassifier, loadTeamAddresses, type TeamAddresses } from "../src/adoption.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST = join(HERE, "..", "..", "..", "team-addresses.json");

const MAINNET = 143;
const TESTNET = 10143;

const DEPLOYER = "0x49472EF9ED99f30d4eaD45Ac9E1C16c31f70783A";
const OPERATOR = "0xAaaAaAAaaAaAaaaaAaAaaaAAaAAAaaaAAAAaaAa1";
const DEMO_AGENT = "0xAaaAaAAaaAaAaaaaAaAaaaAAaAAAaaaAAAAaaAa2";
const MAINNET_ONLY = "0xAaaAaAAaaAaAaaaaAaAaaaAAaAAAaaaAAAAaaAa3";
const STRANGER = "0x1111111111111111111111111111111111111111";
const USDC = "0x754704bc059f8c67012fed69bc8a327a5aafb603";

const team: TeamAddresses = {
  network: "test",
  chainIds: [MAINNET, TESTNET],
  internal: [
    { address: OPERATOR.toLowerCase(), role: "operator", why: "ours", chainIds: [MAINNET, TESTNET] },
    { address: DEMO_AGENT.toLowerCase(), role: "demo agent", why: "ours", chainIds: [MAINNET, TESTNET] },
    { address: MAINNET_ONLY.toLowerCase(), role: "multisig", why: "ours, deployed on Mainnet only", chainIds: [MAINNET] },
  ],
};

/** Writes an allowlist to a scratch directory, loads it, and cleans up. */
async function loadFrom(contents: unknown): Promise<Awaited<ReturnType<typeof loadTeamAddresses>>> {
  const dir = await mkdtemp(join(tmpdir(), "tab-team-addresses-"));
  try {
    const path = join(dir, "team-addresses.json");
    await writeFile(path, JSON.stringify(contents));
    return await loadTeamAddresses(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the committed allowlist parses, and every entry explains itself", async () => {
  const loaded = await loadTeamAddresses(ALLOWLIST);
  assert.equal(loaded.ok, true, JSON.stringify(loaded.ok ? {} : loaded.error));
  if (!loaded.ok) return;
  assert.ok(loaded.value.internal.length > 0, "an empty allowlist would call every address external");
  for (const entry of loaded.value.internal) {
    assert.match(entry.address, /^0x[0-9a-f]{40}$/, "addresses are stored lowercased");
    assert.ok(entry.role.length > 0);
    assert.ok(entry.why.length > 0, `${entry.address} must say why it is ours`);
    assert.ok(entry.chainIds.length > 0, `${entry.address} must hold on at least one network`);
  }
});

test("the committed allowlist names the deployer and covers only Monad networks", async () => {
  const loaded = await loadTeamAddresses(ALLOWLIST);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  // The deployer signs the deployment and the curation changes. Omitting it would
  // report our own traffic as adoption.
  const deployer = loaded.value.internal.find((entry) => entry.address === DEPLOYER.toLowerCase());
  assert.ok(deployer !== undefined, "the deployer is ours");
  assert.ok(deployer.chainIds.includes(TESTNET), "the deployer is ours on Testnet");
  for (const chainId of loaded.value.chainIds) {
    assert.ok([MAINNET, TESTNET].includes(chainId), `chain ${chainId} is not a Monad network`);
  }
});

test("a missing allowlist is an internal error, not a caller's", async () => {
  const loaded = await loadTeamAddresses(join(HERE, "does-not-exist.json"));
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.code, "TEAM_ADDRESSES_UNREADABLE");
  assert.equal(loaded.error.category, "INTERNAL", "a missing allowlist is our bug, not a caller's");
});

test("an entry with no reason is refused", async () => {
  const loaded = await loadFrom({ networks: [TESTNET], internal: [{ address: OPERATOR, role: "operator", why: "" }] });
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.code, "TEAM_ADDRESSES_UNEXPLAINED");
});

test("per-entry chain ids override the file-wide networks", async () => {
  const loaded = await loadFrom({
    networks: [MAINNET, TESTNET],
    internal: [
      { address: OPERATOR, role: "operator", why: "ours" },
      { address: MAINNET_ONLY, chainIds: [MAINNET], role: "multisig", why: "ours" },
    ],
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.ok ? {} : loaded.error));
  if (!loaded.ok) return;
  assert.deepEqual(loaded.value.chainIds, [MAINNET, TESTNET]);
  assert.deepEqual(loaded.value.internal.map((entry) => entry.chainIds), [[MAINNET, TESTNET], [MAINNET]]);
});

test("a single top-level chainId still reads as a one-network allowlist", async () => {
  const loaded = await loadFrom({ chainId: TESTNET, internal: [{ address: OPERATOR, role: "operator", why: "ours" }] });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.ok ? {} : loaded.error));
  if (!loaded.ok) return;
  assert.deepEqual(loaded.value.chainIds, [TESTNET]);
  assert.deepEqual(loaded.value.internal[0]?.chainIds, [TESTNET]);
});

test("an entry that holds on no network is refused rather than dropped", async () => {
  const loaded = await loadFrom({ internal: [{ address: OPERATOR, role: "operator", why: "ours" }] });
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.equal(loaded.error.code, "TEAM_ADDRESSES_MALFORMED");

  const empty = await loadFrom({ networks: [TESTNET], internal: [{ address: OPERATOR, chainIds: [], role: "operator", why: "ours" }] });
  assert.equal(empty.ok, false, "an empty chainIds list scopes the entry to nothing");
});

test("an address absent from the allowlist is external", () => {
  const classifier = createClassifier(team, TESTNET);
  assert.equal(classifier.isExternal(STRANGER), true);
  assert.equal(classifier.isInternal(STRANGER), false);
  assert.equal(classifier.roleOf(STRANGER), undefined);
});

test("an address listed for one network is external on the other", () => {
  assert.equal(createClassifier(team, MAINNET).isInternal(MAINNET_ONLY), true);
  assert.equal(createClassifier(team, TESTNET).isExternal(MAINNET_ONLY), true);
  assert.equal(createClassifier(team, MAINNET).internalCount, 3);
  assert.equal(createClassifier(team, TESTNET).internalCount, 2);
});

test("classification ignores address casing", () => {
  const classifier = createClassifier(team, TESTNET);
  assert.equal(classifier.isInternal(OPERATOR), true, "a checksummed address is the same address");
  assert.equal(classifier.isInternal(OPERATOR.toLowerCase()), true);
  assert.equal(classifier.roleOf(OPERATOR), "operator");
});

test("volume and Settlement counts split by who was credited", () => {
  const metrics = computeAdoption(
    createClassifier(team, TESTNET),
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
    createClassifier(team, TESTNET),
    [{ agent: STRANGER, asset: USDC, amount: huge, settlementCount: 1 }],
    [],
    ALLOWLIST,
  );
  assert.equal(metrics.volumeByAsset[0]?.externalBaseUnits, huge.toString());
  assert.equal(typeof metrics.volumeByAsset[0]?.totalBaseUnits, "string", "a settled amount through a float is a wrong number");
});

test("Metered Deliveries are counted exactly and split by the Agent charged", () => {
  const metrics = computeAdoption(
    createClassifier(team, TESTNET),
    [],
    [
      { agent: DEMO_AGENT, asset: USDC, deliveryCount: 2 },
      { agent: STRANGER, asset: USDC, deliveryCount: 1 },
      { agent: STRANGER, asset: "0x2222222222222222222222222222222222222222", deliveryCount: 3 },
    ],
    ALLOWLIST,
  );

  assert.equal(metrics.externalDeliveryCount, 4);
  assert.equal(metrics.internalDeliveryCount, 2);
  assert.match(metrics.basis.deliveries, /DeliveryRecorded/, "the basis names the event counted");
});

test("an empty index reports zeroes rather than nothing", () => {
  const metrics = computeAdoption(createClassifier(team, TESTNET), [], [], ALLOWLIST);
  assert.equal(metrics.externalAgentCount, 0);
  assert.equal(metrics.externalSettlementCount, 0);
  assert.equal(metrics.externalDeliveryCount, 0);
  assert.deepEqual(metrics.volumeByAsset, []);
  assert.equal(metrics.allowlist.internalCount, 2, "the allowlist size is served so the split is checkable");
  assert.equal(metrics.allowlist.chainId, TESTNET, "and the chain it was scoped to");
});

test("volume is grouped per Asset and ordered stably", () => {
  const other = "0x2222222222222222222222222222222222222222";
  const metrics = computeAdoption(
    createClassifier(team, TESTNET),
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
  const metrics = computeAdoption(createClassifier(team, TESTNET), [], [], ALLOWLIST);
  for (const [name, basis] of Object.entries(metrics.basis)) {
    assert.equal(typeof basis, "string");
    assert.ok(basis.length > 40, `${name} needs a basis a third party can act on`);
  }
  assert.match(metrics.basis.classification, /absent from the `internal` list/);
});
