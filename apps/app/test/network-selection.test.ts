/**
 * The visitor's network choice and the Mainnet trial-call limits.
 *
 * Both are pure: the cookie is parsed from a string and the limiter runs on an
 * injected clock, so neither needs a server, a browser or a wait.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NETWORK_COOKIE,
  NETWORK_COOKIE_MAX_AGE_SECONDS,
  chainIdForNetwork,
  cookieFromHeader,
  networkCookieAssignment,
  parseNetworkCookie,
  selectChainId,
} from "../src/dashboard/network";
import {
  MAINNET_TRIAL_DEFAULTS,
  clientAddressOf,
  createTrialLimiter,
  limitFromEnv,
} from "../src/dashboard/trial-limit";

/* ------------------------------------------------------------------ the cookie */

test("the cookie holds one of two words, and anything else is no choice", () => {
  assert.equal(parseNetworkCookie("testnet"), "testnet");
  assert.equal(parseNetworkCookie("mainnet"), "mainnet");
  assert.equal(parseNetworkCookie(" Mainnet "), "mainnet");
  for (const bad of [undefined, null, "", " ", "143", "10143", "main", "mainnet;", "testnet,mainnet"]) {
    assert.equal(parseNetworkCookie(bad), undefined, `for ${String(bad)}`);
  }
});

test("a choice selects its chain, and no choice leaves the deployment's default", () => {
  assert.equal(chainIdForNetwork("testnet"), 10143);
  assert.equal(chainIdForNetwork("mainnet"), 143);
  assert.equal(selectChainId("mainnet", 10143), 143);
  assert.equal(selectChainId("testnet", 143), 10143);
  assert.equal(selectChainId(undefined, 143), 143);
  assert.equal(selectChainId("garbage", 10143), 10143);
});

test("the cookie is read out of a Cookie header by exact name", () => {
  assert.equal(cookieFromHeader(`${NETWORK_COOKIE}=mainnet`, NETWORK_COOKIE), "mainnet");
  assert.equal(cookieFromHeader(`theme=dark; ${NETWORK_COOKIE}=testnet; other=1`, NETWORK_COOKIE), "testnet");
  assert.equal(cookieFromHeader(`x-${NETWORK_COOKIE}=mainnet`, NETWORK_COOKIE), undefined);
  assert.equal(cookieFromHeader("theme=dark", NETWORK_COOKIE), undefined);
  assert.equal(cookieFromHeader(null, NETWORK_COOKIE), undefined);
  assert.equal(cookieFromHeader(`${NETWORK_COOKIE}=%6Dainnet`, NETWORK_COOKIE), "mainnet");
  assert.equal(cookieFromHeader(`${NETWORK_COOKIE}=%E0`, NETWORK_COOKIE), "%E0", "a bad escape is kept, then refused by the parser");
});

test("a choice is written for the whole site, for a year, and sent on a link followed in", () => {
  const assignment = networkCookieAssignment("mainnet");
  assert.match(assignment, new RegExp(`^${NETWORK_COOKIE}=mainnet;`));
  assert.match(assignment, /; Path=\/;/);
  assert.match(assignment, new RegExp(`; Max-Age=${NETWORK_COOKIE_MAX_AGE_SECONDS};`));
  assert.equal(NETWORK_COOKIE_MAX_AGE_SECONDS, 31_536_000);
  assert.match(assignment, /; SameSite=Lax$/);
});

/* ------------------------------------------------------------- the trial limit */

test("an address gets its per-minute allowance, then a refusal that says when to come back", () => {
  let now = 1_000_000;
  const limiter = createTrialLimiter({ perAddressPerMinute: 3, perDay: 100 }, () => now);
  for (let call = 0; call < 3; call += 1) {
    assert.deepEqual(limiter.take("198.51.100.7"), { ok: true });
    now += 1_000;
  }
  const refused = limiter.take("198.51.100.7");
  assert.equal(refused.ok, false);
  if (refused.ok || refused.scope === "off") throw new Error("expected a timed refusal");
  assert.equal(refused.scope, "address");
  assert.equal(refused.retryAfterSeconds, 57, "the first call leaves the window 60s after it was made");

  // Another address is not held up by the first one's limit.
  assert.deepEqual(limiter.take("203.0.113.9"), { ok: true });

  // The window slides: once the first call is a minute old there is room for one more.
  now = 1_000_000 + 60_000;
  assert.deepEqual(limiter.take("198.51.100.7"), { ok: true });
  assert.equal(limiter.take("198.51.100.7").ok, false);
});

test("the site's daily cap holds across addresses, and a refused call spends nothing", () => {
  let now = 0;
  const limiter = createTrialLimiter({ perAddressPerMinute: 2, perDay: 3 }, () => now);
  assert.equal(limiter.take("a").ok, true);
  assert.equal(limiter.take("a").ok, true);
  // Refused on its own limit, so the site's allowance is untouched.
  assert.equal(limiter.take("a").ok, false);
  assert.equal(limiter.take("b").ok, true);

  const capped = limiter.take("c");
  assert.equal(capped.ok, false);
  if (capped.ok || capped.scope === "off") throw new Error("expected a timed refusal");
  assert.equal(capped.scope, "site");
  assert.equal(capped.retryAfterSeconds, 24 * 60 * 60);

  now = 24 * 60 * 60 * 1000;
  assert.equal(limiter.take("c").ok, true, "a day later the first call has left the window");
});

test("no daily cap means only the per-address limit applies, and zero switches calls off", () => {
  const open = createTrialLimiter({ perAddressPerMinute: 1, perDay: undefined }, () => 0);
  assert.equal(open.take("a").ok, true);
  assert.equal(open.take("b").ok, true);
  assert.equal(open.take("a").ok, false);

  assert.deepEqual(createTrialLimiter({ perAddressPerMinute: 0, perDay: 100 }).take("a"), { ok: false, scope: "off" });
  assert.deepEqual(createTrialLimiter({ perAddressPerMinute: 3, perDay: 0 }).take("a"), { ok: false, scope: "off" });
});

test("limits come from the environment as whole numbers, else the defaults", () => {
  assert.deepEqual(MAINNET_TRIAL_DEFAULTS, { perAddressPerMinute: 3, perDay: 100 });
  assert.equal(limitFromEnv(undefined, 3), 3);
  assert.equal(limitFromEnv("", 3), 3);
  assert.equal(limitFromEnv(" 10 ", 3), 10);
  assert.equal(limitFromEnv("0", 3), 0);
  for (const bad of ["-1", "1.5", "ten", "1e3"]) assert.equal(limitFromEnv(bad, 3), 3, `for ${bad}`);
});

test("the client address is the first hop the proxy reports", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  assert.equal(clientAddressOf(headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" })), "198.51.100.7");
  assert.equal(clientAddressOf(headers({ "x-real-ip": "203.0.113.9" })), "203.0.113.9");
  assert.equal(clientAddressOf(headers({})), "unknown");
});
