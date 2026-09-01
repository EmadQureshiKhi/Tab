/**
 * The registration and resolution half of the seam.
 *
 * Requirements: 23.6
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

const USDC_SEPOLIA = {
  chainKey: 1n,
  address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  decimals: 6,
  symbol: "USDC",
};
const USDC_MAINNET = {
  chainKey: 3n,
  address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  decimals: 6,
  symbol: "USDC",
};

/** A strategy for one chainKey, written against no import of the package. */
function stubStrategy(id, chainKey, extra = {}) {
  return {
    id,
    chainKeys: [chainKey],
    supports: (asset) => asset.chainKey === chainKey,
    quote: async (request) => ({ ok: true, value: { amount: request.amount, asset: request.asset, feeNote: "" } }),
    settle: async () => ({ ok: false, error: { category: "INTERNAL", code: "STUB", message: "stub", retryable: false } }),
    watchHint: () => ({}),
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
  assert.equal(validatePaymentStrategy(stubStrategy("ok", 1n)).ok, true);

  const numericChainKey = validatePaymentStrategy({ ...stubStrategy("n", 1n), chainKeys: [1] });
  assert.equal(numericChainKey.ok, false);
  assert.equal(numericChainKey.error.category, "VALIDATION");
  assert.match(numericChainKey.error.message, /bigint/);

  const noSettle = { ...stubStrategy("s", 1n) };
  delete noSettle.settle;
  assert.equal(validatePaymentStrategy(noSettle).ok, false);
  assert.equal(validatePaymentStrategy(null).ok, false);
});

test("module-level registration is idempotent by id and replacement keeps the earlier position", () => {
  const logger = collectingLogger();
  const first = stubStrategy("first", 1n);
  const second = stubStrategy("second", 3n);

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
  const replacement = stubStrategy("first", 3n);
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
  const sepolia = stubStrategy("sepolia", 1n);
  const alsoSepolia = stubStrategy("also-sepolia", 1n);
  registerPaymentStrategy(sepolia);
  registerPaymentStrategy(alsoSepolia);

  assert.equal(resolvePaymentStrategy({ asset: USDC_SEPOLIA }).value.id, "sepolia");
  assert.equal(
    resolvePaymentStrategy({ asset: USDC_SEPOLIA, strategyId: "also-sepolia" }).value.id,
    "also-sepolia",
  );

  const unknown = resolvePaymentStrategy({ asset: USDC_SEPOLIA, strategyId: "nope" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "STRATEGY_NOT_FOUND");

  const mismatch = resolvePaymentStrategy({ asset: USDC_MAINNET, strategyId: "sepolia" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "STRATEGY_ASSET_MISMATCH");

  const none = resolvePaymentStrategy({ asset: USDC_MAINNET });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, "NO_STRATEGY_FOR_ASSET");
});

test("injected strategies resolve before module-level ones and an isolated registry ignores them", () => {
  registerPaymentStrategy(stubStrategy("module", 1n));
  const injected = createStrategyRegistry({ strategies: [stubStrategy("injected", 1n)] });

  assert.deepEqual(
    injected.list().map((s) => s.id),
    ["injected", "module"],
  );
  assert.equal(injected.resolve({ asset: USDC_SEPOLIA }).value.id, "injected");
  assert.equal(injected.get("module").id, "module");

  const isolated = createStrategyRegistry({ strategies: [stubStrategy("only", 1n)], inherit: false });
  assert.deepEqual(
    isolated.list().map((s) => s.id),
    ["only"],
  );
  assert.equal(isolated.get("module"), undefined);

  // Removing an injected strategy never reaches into the module-level registry.
  injected.unregister("injected");
  assert.equal(injected.resolve({ asset: USDC_SEPOLIA }).value.id, "module");
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
    strategies: [hostile, stubStrategy("sound", 1n)],
    inherit: false,
    logger,
  });

  assert.equal(registry.resolve({ asset: USDC_SEPOLIA }).value.id, "sound");
  assert.equal(
    logger.lines.some((line) => line.level === "warn" && line.fields.strategyId === "hostile"),
    true,
  );
});
