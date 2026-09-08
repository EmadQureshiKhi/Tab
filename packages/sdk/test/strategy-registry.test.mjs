/**
 * The registration and resolution half of the seam.
 */

import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  clearPaymentStrategies,
  createStrategyRegistry,
  listPaymentStrategies,
  registerPaymentStrategy,
  resolvePaymentStrategy,
  validatePaymentStrategy,
} from "../dist/index.js";

const USDC_TESTNET = {
  chainId: 10143n,
  address: "0x5d519A1E8cF4Edd7067FD631047E6869E9a7e4fE",
  decimals: 6,
  symbol: "USDC",
};
const USDC_MAINNET = {
  chainId: 143n,
  address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  decimals: 6,
  symbol: "USDC",
};

/** A strategy for one chainId, written against no import of the package. */
function stubStrategy(id, chainId, extra = {}) {
  return {
    id,
    chainIds: [chainId],
    supports: (asset) => asset.chainId === chainId,
    quote: async (request) => ({ ok: true, value: { amount: request.amount, asset: request.asset, feeNote: "" } }),
    settle: async () => ({ ok: false, error: { category: "INTERNAL", code: "STUB", message: "stub", retryable: false } }),
    ...extra,
  };
}

function collectingLogger() {
  const lines = [];
  const push = (level) => (message, fields) => lines.push({ level, message, fields });
  return { lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

beforeEach(() => clearPaymentStrategies());
after(() => clearPaymentStrategies());

test("a structurally valid strategy passes validation and a malformed one is a VALIDATION result", () => {
  assert.equal(validatePaymentStrategy(stubStrategy("ok", 10143n)).ok, true);

  const numericChainId = validatePaymentStrategy({ ...stubStrategy("n", 10143n), chainIds: [1] });
  assert.equal(numericChainId.ok, false);
  assert.equal(numericChainId.error.category, "VALIDATION");
  assert.match(numericChainId.error.message, /bigint/);

  const noSettle = { ...stubStrategy("s", 10143n) };
  delete noSettle.settle;
  assert.equal(validatePaymentStrategy(noSettle).ok, false);
  assert.equal(validatePaymentStrategy(null).ok, false);
});

test("module-level registration is idempotent by id and replacement keeps the earlier position", () => {
  const logger = collectingLogger();
  const first = stubStrategy("first", 10143n);
  const second = stubStrategy("second", 143n);

  assert.equal(registerPaymentStrategy(first, { logger }).value.action, "registered");
  assert.equal(registerPaymentStrategy(second, { logger }).value.action, "registered");

  // The same object again changes nothing and warns about nothing.
  const again = registerPaymentStrategy(first, { logger });
  assert.equal(again.value.action, "unchanged");
  assert.deepEqual(
    listPaymentStrategies().map((s) => s.id),
    ["first", "second"],
  );
  assert.equal(logger.lines.filter((line) => line.level === "warn").length, 0);

  // A different object under a live id replaces it, in place, with a warning.
  const replacement = stubStrategy("first", 143n);
  const replaced = registerPaymentStrategy(replacement, { logger });
  assert.equal(replaced.value.action, "replaced");
  assert.equal(replaced.value.previous, first);
  assert.deepEqual(
    listPaymentStrategies().map((s) => s.id),
    ["first", "second"],
  );
  assert.equal(logger.lines.filter((line) => line.level === "warn").length, 1);
});

test("resolution takes an explicit id first, then registration order", () => {
  const testnet = stubStrategy("testnet", 10143n);
  const alsoTestnet = stubStrategy("also-testnet", 10143n);
  registerPaymentStrategy(testnet);
  registerPaymentStrategy(alsoTestnet);

  assert.equal(resolvePaymentStrategy({ asset: USDC_TESTNET }).value.id, "testnet");
  assert.equal(
    resolvePaymentStrategy({ asset: USDC_TESTNET, strategyId: "also-testnet" }).value.id,
    "also-testnet",
  );

  const unknown = resolvePaymentStrategy({ asset: USDC_TESTNET, strategyId: "nope" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "STRATEGY_NOT_FOUND");

  const mismatch = resolvePaymentStrategy({ asset: USDC_MAINNET, strategyId: "testnet" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "STRATEGY_ASSET_MISMATCH");

  const none = resolvePaymentStrategy({ asset: USDC_MAINNET });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, "NO_STRATEGY_FOR_ASSET");
});

test("injected strategies resolve before module-level ones and an isolated registry ignores them", () => {
  registerPaymentStrategy(stubStrategy("module", 10143n));
  const injected = createStrategyRegistry({ strategies: [stubStrategy("injected", 10143n)] });

  assert.deepEqual(
    injected.list().map((s) => s.id),
    ["injected", "module"],
  );
  assert.equal(injected.resolve({ asset: USDC_TESTNET }).value.id, "injected");
  assert.equal(injected.get("module").id, "module");

  const isolated = createStrategyRegistry({ strategies: [stubStrategy("only", 10143n)], inherit: false });
  assert.deepEqual(
    isolated.list().map((s) => s.id),
    ["only"],
  );
  assert.equal(isolated.get("module"), undefined);

  // Removing an injected strategy never reaches into the module-level registry.
  injected.unregister("injected");
  assert.equal(injected.resolve({ asset: USDC_TESTNET }).value.id, "module");
  assert.deepEqual(
    listPaymentStrategies().map((s) => s.id),
    ["module"],
  );
});

test("a supports() that throws is read as unsupported rather than taking down the resolution", () => {
  const logger = collectingLogger();
  const hostile = stubStrategy("hostile", 1n, {
    supports: () => {
      throw new Error("consumer code");
    },
  });
  const registry = createStrategyRegistry({
    strategies: [hostile, stubStrategy("sound", 10143n)],
    inherit: false,
    logger,
  });

  assert.equal(registry.resolve({ asset: USDC_TESTNET }).value.id, "sound");
  assert.equal(
    logger.lines.some((line) => line.level === "warn" && line.fields.strategyId === "hostile"),
    true,
  );
});
