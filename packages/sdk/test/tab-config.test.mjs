/**
 * Config-file discovery: the zero-code registration mechanism.
 *
 * Requirements: 23.6
 */

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearPaymentStrategies,
  createStrategyRegistry,
  defineTabConfig,
  findTabConfig,
  listPaymentStrategies,
  loadTabConfig,
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONSUMER = join(HERE, "fixtures", "consumer");
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => clearPaymentStrategies());
after(() => clearPaymentStrategies());

test("defineTabConfig is identity, so the types cost nothing at runtime", () => {
  const config = { strategies: [] };
  assert.equal(defineTabConfig(config), config);
});

test("discovery finds the nearest config file walking upwards", () => {
  const found = findTabConfig({ cwd: CONSUMER });
  assert.equal(found.ok, true);
  assert.equal(found.value, join(CONSUMER, "tab.config.mjs"));

  // A directory with no config above it anywhere is not an error.
  const none = findTabConfig({ cwd: HERE, fileNames: ["tab.config.absent.mjs"] });
  assert.equal(none.ok, true);
  assert.equal(none.value, undefined);
});

test("loading a config registers every strategy it names, module-wide", async () => {
  const loaded = await loadTabConfig({ cwd: CONSUMER, logger: silent });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.path, join(CONSUMER, "tab.config.mjs"));
  assert.deepEqual(
    loaded.value.strategies.map((strategy) => strategy.id),
    ["plugin-strategy"],
  );
  assert.deepEqual(
    loaded.value.registrations.map((registration) => registration.action),
    ["registered"],
  );
  assert.deepEqual(
    listPaymentStrategies().map((strategy) => strategy.id),
    ["plugin-strategy"],
  );

  // A strategy for a chainKey this package ships no support for now resolves.
  const resolved = createStrategyRegistry({ logger: silent }).resolve({
    asset: { chainKey: 7n, address: `0x${"cd".repeat(20)}`, decimals: 8, symbol: "XYZ" },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.value.id, "plugin-strategy");
});

test("loading twice is idempotent, and a private registry leaves the module registry alone", async () => {
  await loadTabConfig({ cwd: CONSUMER, logger: silent });
  const again = await loadTabConfig({ cwd: CONSUMER, logger: silent });
  assert.equal(again.ok, true);
  // The factory ran again, so this is a distinct object under a live id.
  assert.equal(again.value.registrations[0].action, "replaced");
  assert.equal(listPaymentStrategies().length, 1);

  clearPaymentStrategies();
  const isolated = createStrategyRegistry({ inherit: false, logger: silent });
  const intoIsolated = await loadTabConfig({ cwd: CONSUMER, registry: isolated, logger: silent });
  assert.equal(intoIsolated.ok, true);
  assert.equal(isolated.list().length, 1);
  assert.equal(listPaymentStrategies().length, 0);

  const validateOnly = await loadTabConfig({ cwd: CONSUMER, registry: false, logger: silent });
  assert.equal(validateOnly.value.strategies.length, 1);
  assert.equal(validateOnly.value.registrations.length, 0);
  assert.equal(listPaymentStrategies().length, 0);
});

test("no config file at all is success with nothing to register", async () => {
  const loaded = await loadTabConfig({
    cwd: CONSUMER,
    fileNames: ["tab.config.absent.mjs"],
    logger: silent,
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.path, undefined);
  assert.deepEqual(loaded.value.strategies, []);
});

test("an explicitly named config that is missing is a NOT_FOUND result", async () => {
  const loaded = await loadTabConfig({
    cwd: CONSUMER,
    configPath: "tab.config.absent.mjs",
    logger: silent,
  });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.code, "CONFIG_NOT_FOUND");
  assert.equal(loaded.error.category, "NOT_FOUND");
});

test("a config naming a module that resolves to nothing reports the specifier", async () => {
  const loaded = await loadTabConfig({
    cwd: CONSUMER,
    configPath: join(HERE, "fixtures", "broken", "tab.config.mjs"),
    logger: silent,
  });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.code, "STRATEGY_MODULE_NOT_FOUND");
  assert.match(loaded.error.message, /@acme\/tab-strategy-nowhere/);
});

test("a factory that declines leaves the rest of the config standing", async () => {
  // The documented keyless pattern: the strategy needs a signer, there is none,
  // so the factory returns undefined. Every read on this rail is keyless,
  // so that is an ordinary environment and not a broken config. Before this was
  // handled, `undefined` reached the strategy validator, the whole file was
  // discarded, and `doctor` reported "no Agent address is configured" against a
  // config file that configured one.
  delete globalThis.__tabKeylessFixtureSigner;
  const loaded = await loadTabConfig({
    cwd: join(HERE, "fixtures", "keyless"),
    registry: false,
    logger: silent,
  });

  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.value.strategies, []);
  assert.equal(loaded.value.config.agent, "0x1f6f797edc2eecb02bd54009b805fb2e99f80542");
  assert.equal(loaded.value.config.registryUrl, "http://registry.example");
  assert.equal(loaded.value.config.services.length, 1);
});

test("the same factory produces its strategy once the signer is there", async () => {
  globalThis.__tabKeylessFixtureSigner = true;
  try {
    const loaded = await loadTabConfig({
      cwd: join(HERE, "fixtures", "keyless"),
      registry: false,
      logger: silent,
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value.strategies.length, 1);
    assert.equal(loaded.value.strategies[0].id, "fixture-usdc");
  } finally {
    delete globalThis.__tabKeylessFixtureSigner;
  }
});

test("a bare undefined written into the array is still a typo, not a decision", async () => {
  // A factory declining says something: no key here. A literal `undefined` in the
  // list says nothing at all, so it stays a validation failure.
  const loaded = await loadTabConfig({
    cwd: join(HERE, "fixtures", "keyless"),
    configPath: join(HERE, "fixtures", "keyless", "tab.config.bare.mjs"),
    registry: false,
    logger: silent,
  });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.code, "STRATEGY_INVALID");
});
