/**
 * The command line, where the defaults are the argument.
 *
 * Two of these matter more than the rest. An amount is always an integer count of
 * base units and never a decimal, because a demo that accepted `0.01` would be
 * teaching the wrong thing about a rail where nothing is ever a float. And the
 * default act list excludes the binding act, because binding is stage-setting that
 * spends a nonce and should never happen because somebody ran the demo twice.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULTS, HELP, parseCommand, parseOptions, selectActs, STORY } from "../dist/story.js";

test("an empty command line is every default", () => {
  const options = parseOptions([]);
  assert.equal(options.ok, true);
  assert.equal(options.value.broadcast, false);
  assert.equal(options.value.units, DEFAULTS.units);
  assert.equal(options.value.amount, DEFAULTS.amount);
  assert.equal(options.value.ceiling, DEFAULTS.ceiling);
  assert.equal(options.value.ttlSeconds, DEFAULTS.ttlSeconds);
  assert.equal(options.value.waitSeconds, DEFAULTS.waitSeconds);
  assert.equal(options.value.gas, undefined);
  assert.equal(options.value.onlyAgent, undefined);
});

test("nothing broadcasts unless it is asked to", () => {
  assert.equal(parseOptions(["--broadcast"]).value.broadcast, true);
});

test("every numeric flag is read", () => {
  const options = parseOptions([
    "--units", "4",
    "--amount", "25000",
    "--ceiling", "2000000",
    "--ttl", "600",
    "--wait", "30",
    "--gas", "500000",
    "--agent", "Bex",
  ]).value;
  assert.equal(options.units, 4);
  assert.equal(options.amount, 25_000n);
  assert.equal(options.ceiling, 2_000_000n);
  assert.equal(options.ttlSeconds, 600);
  assert.equal(options.waitSeconds, 30);
  assert.equal(options.gas, 500_000n);
  assert.equal(options.onlyAgent, "Bex");
});

test("a decimal amount is refused rather than rounded", () => {
  const refused = parseOptions(["--amount", "0.01"]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_FLAG_NOT_BASE_UNITS");
  assert.match(refused.error.message, /never a decimal/);
});

test("a non-numeric count is refused and quoted back", () => {
  const refused = parseOptions(["--units", "many"]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_FLAG_NOT_A_NUMBER");
  assert.match(refused.error.message, /`many`/);
});

test("buying zero units is refused, because it would demonstrate nothing", () => {
  const refused = parseOptions(["--units", "0"]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_UNITS_TOO_FEW");
});

test("the default act list is the story and never the binding act", () => {
  const acts = selectActs([]).value;
  assert.deepEqual(acts.map((act) => act.id), ["stage", "authorise", "consume", "settle", "smart-account"]);
  assert.equal(acts.some((act) => act.id === "bind"), false);
});

test("all is the same as no selection", () => {
  assert.deepEqual(
    selectActs(["--act", "all"]).value.map((act) => act.id),
    selectActs([]).value.map((act) => act.id),
  );
});

test("an act can be chosen by id or by number, and the binding act only by name", () => {
  assert.deepEqual(selectActs(["--act", "settle"]).value.map((a) => a.id), ["settle"]);
  assert.deepEqual(selectActs(["--act", "SMART-ACCOUNT"]).value.map((a) => a.id), ["smart-account"]);
  assert.deepEqual(selectActs(["--act", "4"]).value.map((a) => a.id), ["smart-account"]);
  assert.deepEqual(selectActs(["--act", "0"]).value.map((a) => a.id), ["stage"]);
  assert.deepEqual(selectActs(["--act", "bind"]).value.map((a) => a.id), ["bind"]);
});

test("an act nobody has is refused, and the message lists the ones that exist", () => {
  const refused = selectActs(["--act", "settlement"]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "DEMO_NO_SUCH_ACT");
  for (const act of STORY) assert.match(refused.error.message, new RegExp(act.id));
});

test("the whole command parses together, and help is a flag rather than an act", () => {
  const command = parseCommand(["--act", "consume", "--broadcast", "--help"]);
  assert.equal(command.ok, true);
  assert.equal(command.value.help, true);
  assert.equal(command.value.options.broadcast, true);
  assert.deepEqual(command.value.acts.map((a) => a.id), ["consume"]);
  assert.equal(parseCommand(["-h"]).value.help, true);
  assert.equal(parseCommand([]).value.help, false);
});

test("a bad option fails the whole command before any act is chosen", () => {
  const refused = parseCommand(["--units", "-1", "--act", "settle"]);
  assert.equal(refused.ok, false);
});

test("the help text names every act and every flag it documents", () => {
  for (const act of STORY) assert.match(HELP, new RegExp(act.id));
  for (const flag of ["--act", "--broadcast", "--agent", "--units", "--amount", "--ceiling", "--ttl", "--wait", "--gas"]) {
    assert.match(HELP, new RegExp(flag.replace("--", "\\-\\-")));
  }
});

test("every act in the story has a distinct id and a synopsis", () => {
  const ids = STORY.map((act) => act.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const act of STORY) {
    assert.equal(typeof act.title, "string");
    assert.ok(act.synopsis.length > 40, `${act.id} needs a synopsis worth reading`);
    assert.equal(typeof act.run, "function");
  }
});
