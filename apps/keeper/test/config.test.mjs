import assert from "node:assert/strict";
import { test } from "node:test";

import { loadKeeperConfig, requireKeeperKey } from "../dist/config.js";

const BASE = {
  MONAD_RPC_URL: "http://node.test",
  MONAD_CHAIN_ID: "10143",
  TAB_BOOK_ADDRESS: `0x${"b0".repeat(20)}`,
  SERVICE_REGISTRY_ADDRESS: `0x${"c0".repeat(20)}`,
  NEXT_PUBLIC_REGISTRY_API_URL: "http://registry.test/",
};

test("a complete environment loads, with defaults for the port and the page bound", () => {
  const config = loadKeeperConfig(BASE);
  assert.ok(config.ok, config.ok ? "" : config.error.message);
  assert.equal(config.value.port, 8791);
  assert.equal(config.value.maxFeedPages, 200);
  assert.equal(config.value.registryUrl, "http://registry.test");
  assert.equal(config.value.keeperKey, undefined);
  assert.equal(config.value.sharedSecret, undefined);
  assert.equal(requireKeeperKey(config.value).error.code, "KEEPER_KEY_MISSING");
});

test("the template's key placeholder is treated as no key", () => {
  const config = loadKeeperConfig({ ...BASE, KEEPER_PRIVATE_KEY: "0xREPLACE_WITH_YOUR_OWN_64_HEX_CHARACTER_KEY" });
  assert.ok(config.ok);
  assert.equal(config.value.keeperKey, undefined);
  const real = loadKeeperConfig({ ...BASE, KEEPER_PRIVATE_KEY: `0x${"11".repeat(32)}`, KEEPER_SHARED_SECRET: " s ", KEEPER_PORT: "9000", KEEPER_MAX_FEED_PAGES: "5" });
  assert.ok(real.ok);
  assert.equal(real.value.keeperKey, `0x${"11".repeat(32)}`);
  assert.equal(real.value.sharedSecret, "s");
  assert.equal(real.value.port, 9000);
  assert.equal(real.value.maxFeedPages, 5);
});

test("every missing or malformed variable is named", () => {
  const cases = [
    [{ ...BASE, MONAD_RPC_URL: "" }, "MONAD_RPC_URL"],
    [{ ...BASE, MONAD_CHAIN_ID: "x" }, "MONAD_CHAIN_ID"],
    [{ ...BASE, TAB_BOOK_ADDRESS: `0x${"0".repeat(40)}` }, "TAB_BOOK_ADDRESS"],
    [{ ...BASE, SERVICE_REGISTRY_ADDRESS: "0x12" }, "SERVICE_REGISTRY_ADDRESS"],
    [{ ...BASE, NEXT_PUBLIC_REGISTRY_API_URL: "registry.test" }, "NEXT_PUBLIC_REGISTRY_API_URL"],
    [{ ...BASE, KEEPER_PORT: "70000" }, "KEEPER_PORT"],
  ];
  for (const [env, variable] of cases) {
    const config = loadKeeperConfig(env);
    assert.ok(!config.ok, variable);
    assert.equal(config.error.details.variable, variable);
  }
});
