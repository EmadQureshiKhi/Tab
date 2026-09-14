import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";

import { createHost } from "../dist/host-context.js";
import { parseExpiryDays, runAuthorise } from "../dist/tab/authorise.js";
import { AGENT, ENV, fakeContext, fakeIo, SERVICE_ID, SETTINGS, TAB_BOOK, USDC } from "./fixtures.mjs";

const NOW = 1_800_000_000_000;
const deps = (context) => ({
  host: createHost({ ctx: context.ctx, io: fakeIo({}), commandId: "tab:authorise" }),
  settings: SETTINGS,
  env: ENV,
  now: () => NOW,
});
const iface = new Interface(["function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry)"]);

test("a dry run builds TabBook.authorise with the expiry counted in whole days from now", async () => {
  const context = fakeContext();
  const result = await runAuthorise(deps(context), { service: SERVICE_ID, asset: USDC, ceiling: "5000000", expiryDays: "30", broadcast: false });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  const report = result.value;
  assert.equal(report.agent, AGENT);
  assert.equal(report.transaction.to, TAB_BOOK);
  assert.equal(report.expiry, Math.floor(NOW / 1000) + 30 * 86_400);
  assert.equal(report.expiryIso, new Date(report.expiry * 1000).toISOString());
  const decoded = iface.decodeFunctionData("authorise", report.transaction.data);
  assert.equal(decoded.serviceId, SERVICE_ID);
  assert.equal(decoded.asset.toLowerCase(), USDC);
  assert.equal(decoded.maxCumulative, 5_000_000n);
  assert.equal(decoded.expiry, BigInt(report.expiry));
  assert.equal(context.requests.length, 0);
  assert.equal(context.executorCalls.length, 0);
});

test("--broadcast hands the one transaction to the wallet", async () => {
  const context = fakeContext({ status: "CONFIRMED" });
  const result = await runAuthorise(deps(context), { service: SERVICE_ID, asset: `10143:${USDC}`, ceiling: "5000000", expiryDays: "1", broadcast: true });
  assert.ok(result.ok);
  assert.equal(result.value.broadcast, true);
  assert.equal(context.requests.length, 1);
  assert.equal(context.requests[0].request.transaction.to, TAB_BOOK);
  assert.match(context.requests[0].request.intent.summary, /Authorise Service 0x7461622e…0000 to meter up to 5000000 mUSDC base units/);
  assert.equal(result.value.tx.txHash, `0x${"0".repeat(63)}1`);
});

test("the day count is a positive whole number with a ceiling", () => {
  assert.deepEqual(parseExpiryDays("30"), { ok: true, value: 30 });
  assert.equal(parseExpiryDays("0").error.code, "EXPIRY_DAYS_MALFORMED");
  assert.equal(parseExpiryDays("1.5").error.code, "EXPIRY_DAYS_MALFORMED");
  assert.equal(parseExpiryDays("99999").error.code, "EXPIRY_DAYS_TOO_FAR");
});
