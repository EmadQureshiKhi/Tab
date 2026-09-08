/**
 * Keys, and the fact that nothing here ever returns one by accident.
 *
 * The point of the accessor is that a read-only run touches no key at all, and
 * that a run which needs one is refused by the **name of the variable** rather
 * than by a stack trace from `ethers`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSecrets, creditcoinRoleFor, ethereumRoleFor, ROLE_ENV_NAME } from "../dist/secrets.js";

const KEY = `0x${"11".repeat(32)}`;

test("a present key is returned and reported as present", () => {
  const secrets = createSecrets({ AGENT_CREDITCOIN_PRIVATE_KEY: KEY });
  assert.equal(secrets.has("agent-one-creditcoin"), true);
  assert.equal(secrets.keyFor("agent-one-creditcoin").value, KEY);
});

test("an absent key is refused by the name of the variable", () => {
  const secrets = createSecrets({});
  assert.equal(secrets.has("service-operator"), false);
  const refused = secrets.keyFor("service-operator");
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_KEY_ABSENT");
  assert.match(refused.error.message, /GATEWAY_PRIVATE_KEY/);
});

test("a blank value counts as absent rather than as a malformed key", () => {
  const secrets = createSecrets({ GATEWAY_PRIVATE_KEY: "   " });
  assert.equal(secrets.has("service-operator"), false);
  assert.equal(secrets.keyFor("service-operator").error.code, "DEMO_KEY_ABSENT");
});

test("a value that is not a 32-byte key is refused as malformed", () => {
  for (const bad of ["0x1234", "not-a-key", `0x${"11".repeat(31)}`, `${"11".repeat(32)}`]) {
    const secrets = createSecrets({ GATEWAY_PRIVATE_KEY: bad });
    const refused = secrets.keyFor("service-operator");
    assert.equal(refused.ok, false, `${bad} should be refused`);
    assert.equal(refused.error.code, "DEMO_KEY_MALFORMED");
  }
});

test("a refusal never carries the key it was given", () => {
  const secrets = createSecrets({ GATEWAY_PRIVATE_KEY: "0xdeadbeef" });
  const refused = secrets.keyFor("service-operator");
  assert.equal(refused.error.message.includes("deadbeef"), false);
});

test("every role names a distinct variable", () => {
  const names = Object.values(ROLE_ENV_NAME);
  assert.equal(new Set(names).size, names.length);
});

test("the cast index selects the signing role for each chain", () => {
  assert.equal(creditcoinRoleFor(0), "agent-one-creditcoin");
  assert.equal(creditcoinRoleFor(1), "agent-two-creditcoin");
  assert.equal(ethereumRoleFor(0), "agent-one-ethereum");
  assert.equal(ethereumRoleFor(1), "agent-two-ethereum");
});
