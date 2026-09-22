/**
 * Four surfaces: chain reads, overdue tabs, `/api/health` and `/api/stream`.
 *
 * Every one of them is a pure function or takes its reader as an argument, so
 * nothing here needs a server, a chain or a clock. Two themes run through the
 * cases, and both are about the specific ways these particular surfaces could
 * mislead rather than about coverage for its own sake.
 *
 * **An unknown is never reported as a figure.** `/api/health` exists to say which
 * upstream is down, so a probe that failed must arrive as a stated reason and never
 * as a zero, an empty object or a default. A health endpoint that reports a dead
 * registry as "0 blocks indexed" is worse than one that fails outright, because it
 * will be believed.
 *
 * **A short answer is never a safe answer.** The overdue-tab list is the input
 * to somebody else's transaction, so a truncated scan reading as "nothing is
 * overdue" is the one wrong answer that costs a reader money. A malformed log
 * therefore fails the whole read rather than being skipped.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  createChainReader,
  parseQuantity,
  selectorOf,
  uintArg,
  addressArg,
  wordAt,
} from "../src/dashboard/chain";
import {
  DELIVERY_RECORDED_TOPIC0,
  SETTLEMENT_WINDOW_OF_SELECTOR,
  TAB_ID_OF_SELECTOR,
  TAB_OF_SELECTOR,
  TAB_REF_OF_SELECTOR,
  decodeTab,
  decodeTabRef,
  distinctCandidates,
  markCommand,
  overdueBy,
  readOverdueTabs,
  scanTabCandidates,
} from "../src/dashboard/overdue";
import { readBuildInfo, serveHealth } from "../src/dashboard/api-health";
import { sseFrame, streamTick, unsentRows } from "../src/dashboard/api-stream";
import { encodeAuthorise, parseAddress, parseWord, readAuthorisation } from "../src/dashboard/authorisation";

const TAB_BOOK = "0xba86c0d053ba88afdecbed8aba5b2ec3973fb230";
const SERVICE_REGISTRY = "0x123c19f46c38d5b4e922d1297250a71a03dffd17";
const AGENT = "0x1f6f797edc2eecb02bd54009b805fb2e99f80542";
const SERVICE = "0x7461622e64656d6f2d7365727669636500000000000000000000000000000000";
const ASSET = "0x5d519a1e8cf4edd7067fd631047e6869e9a7e4fe";

/** A `bigint` as one ABI word, for building fixture return data. */
const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value: string): string => value.slice(2).toLowerCase().padStart(64, "0");

/**
 * Six words in `Tab` order.
 *
 * `Tab` is entirely static, so the returned tuple is laid out in place with no
 * head offset, which is what the decoder relies on.
 */
function tabData(overrides: {
  open?: bigint;
  prepaid?: bigint;
  oldestUnsettledAt?: bigint;
  delinquent?: boolean;
}): string {
  return (
    "0x" +
    word(overrides.open ?? 3000n) +
    word(overrides.prepaid ?? 0n) +
    word(overrides.oldestUnsettledAt ?? 900n) +
    word(950) +
    word(2) +
    word(overrides.delinquent === true ? 1 : 0)
  );
}

/** Four words in `TabRef` order. */
function tabRefData(overrides: { agent?: string; serviceId?: string; exists?: boolean } = {}): string {
  return (
    "0x" +
    addressWord(overrides.agent ?? AGENT) +
    (overrides.serviceId ?? SERVICE).slice(2) +
    addressWord(ASSET) +
    word(overrides.exists === false ? 0 : 1)
  );
}

// ---------------------------------------------------------------- chain reads

test("parseQuantity accepts a JSON-RPC quantity and refuses anything else", () => {
  assert.equal(parseQuantity("0x10"), 16);
  assert.equal(parseQuantity("0x0"), 0);
  assert.equal(parseQuantity("16"), undefined, "a decimal string is not a quantity");
  assert.equal(parseQuantity(16), undefined, "a number is not a quantity");
  assert.equal(parseQuantity(undefined), undefined);
  assert.equal(parseQuantity("0xzz"), undefined);
});

test("a selector is the first four bytes of the signature hash", () => {
  // `tabOf(bytes32)` and `transfer(address,uint256)`. The second is the
  // canonical worked example, so a wrong hash shows up against a known value.
  assert.equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  assert.match(selectorOf("tabOf(bytes32)"), /^0x[0-9a-f]{8}$/);
});

test("arguments encode as one padded word each", () => {
  assert.equal(uintArg(1).length, 64);
  assert.equal(uintArg(1).endsWith("1"), true);
  assert.equal(addressArg("0xABCD").length, 64);
  assert.equal(addressArg("0xAbCd"), "0".repeat(60) + "abcd", "addresses are lowercased");
});

test("wordAt refuses to read past the end rather than returning a short word", () => {
  const data = `0x${word(7)}`;
  assert.equal(wordAt(data, 0), word(7));
  assert.equal(wordAt(data, 1), undefined, "a missing word is undefined, never a partial one");
});

test("a JSON-RPC error is reported as a refusal, not as unreachability", async () => {
  const chain = createChainReader({
    rpcUrl: "http://example.invalid",
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ error: { message: "query timeout of 10 seconds exceeded" } }),
    }),
  });
  const result = await chain.chainId();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RPC_ERROR", "the endpoint answered, so it is not unreachable");
  assert.match(result.error.message, /query timeout/);
});

test("a transport failure is reported as unreachable", async () => {
  const chain = createChainReader({
    rpcUrl: "http://example.invalid",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const result = await chain.chainId();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RPC_UNREACHABLE");
});

test("the log scan is chunked, and each window is bounded", async () => {
  const windows: { from: number; to: number }[] = [];
  const chain = createChainReader({
    rpcUrl: "http://example.invalid",
    logWindow: 100,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body) as { params: [{ fromBlock: string; toBlock: string }] };
      windows.push({
        from: Number.parseInt(body.params[0].fromBlock, 16),
        to: Number.parseInt(body.params[0].toBlock, 16),
      });
      return { status: 200, json: async () => ({ result: [] }) };
    },
  });

  const result = await chain.logs({ address: TAB_BOOK, topics: [], fromBlock: 1000, toBlock: 1250 });
  assert.equal(result.ok, true);
  assert.deepEqual(windows, [
    { from: 1000, to: 1099 },
    { from: 1100, to: 1199 },
    { from: 1200, to: 1250 },
  ]);
  assert.equal(
    windows.every((entry) => entry.to - entry.from < 100),
    true,
    "no window exceeds the configured size, which is what keeps it inside the endpoint's timeout",
  );
});

test("a refused window is halved and retried rather than ending the scan", async () => {
  // An endpoint may bound the query by time or by result size as well as by range,
  // so a window that is comfortable most of the time is refused some of the time.
  const windows: { from: number; to: number }[] = [];
  const chain = createChainReader({
    rpcUrl: "http://example.invalid",
    logWindow: 1000,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body) as { params: [{ fromBlock: string; toBlock: string }] };
      const from = Number.parseInt(body.params[0].fromBlock, 16);
      const to = Number.parseInt(body.params[0].toBlock, 16);
      windows.push({ from, to });
      // Refuse anything wider than 250 blocks, the way a slow endpoint does.
      if (to - from + 1 > 250) {
        return {
          status: 200,
          json: async () => ({ error: { message: "query timeout of 10 seconds exceeded" } }),
        };
      }
      return { status: 200, json: async () => ({ result: [] }) };
    },
  });

  const result = await chain.logs({ address: TAB_BOOK, topics: [], fromBlock: 0, toBlock: 499 });
  assert.equal(result.ok, true, "a slow endpoint should make the scan slower, not fail it");
  assert.deepEqual(
    windows.map((entry) => entry.to - entry.from + 1),
    [500, 250, 250],
    "the refused 500 is halved to 250, and the narrower width is carried forward rather than re-tried wide",
  );
  const last = windows[windows.length - 1];
  assert.equal(last?.to, 499, "the scan still reaches the requested end");
});

test("a window that fails even at the floor is reported rather than retried forever", async () => {
  let calls = 0;
  const chain = createChainReader({
    rpcUrl: "http://example.invalid",
    logWindow: 1000,
    fetchImpl: async () => {
      calls += 1;
      return {
        status: 200,
        json: async () => ({ error: { message: "query timeout of 10 seconds exceeded" } }),
      };
    },
  });

  const result = await chain.logs({ address: TAB_BOOK, topics: [], fromBlock: 0, toBlock: 999 });
  assert.equal(result.ok, false, "below the floor the endpoint is unavailable, not slow");
  // 1000, 500, 250, 125, 62, 31, 15, 10, then stop: halving below the floor would
  // turn one dead upstream into a long series of doomed requests.
  assert.ok(calls <= 9, `expected the climb down to stop at the floor, made ${calls} calls`);
});

test("a malformed log fails the scan rather than shortening it", async () => {
  const chain = createChainReader({
    rpcUrl: "http://example.invalid",
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ result: [{ address: TAB_BOOK, topics: [] }] }),
    }),
  });
  const result = await chain.logs({ address: TAB_BOOK, topics: [], fromBlock: 1, toBlock: 2 });
  assert.equal(result.ok, false, "a silently short list would read as 'nothing is overdue'");
  assert.equal(result.error.code, "RPC_MALFORMED");
});

// ---------------------------------------------------------------- overdue tabs

test("the delivery topic and the selectors are derived from the canonical signatures", () => {
  assert.match(DELIVERY_RECORDED_TOPIC0, /^0x[0-9a-f]{64}$/);
  for (const selector of [TAB_ID_OF_SELECTOR, TAB_OF_SELECTOR, TAB_REF_OF_SELECTOR, SETTLEMENT_WINDOW_OF_SELECTOR]) {
    assert.match(selector, /^0x[0-9a-f]{8}$/);
  }
});

test("a tab decodes field for field", () => {
  const decoded = decodeTab(tabData({ open: 4200n, prepaid: 7n, oldestUnsettledAt: 99n, delinquent: true }));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.value.open, 4200n);
  assert.equal(decoded.value.prepaid, 7n);
  assert.equal(decoded.value.oldestUnsettledAt, 99n);
  assert.equal(decoded.value.deliveryCount, 2);
  assert.equal(decoded.value.delinquent, true);

  const ref = decodeTabRef(tabRefData());
  assert.equal(ref.ok, true);
  assert.equal(ref.value.agent, AGENT);
  assert.equal(ref.value.serviceId, SERVICE);
  assert.equal(ref.value.asset, ASSET);
  assert.equal(ref.value.exists, true);
});

test("short return data is refused rather than decoded into zeroes", () => {
  const decoded = decodeTab(`0x${word(1)}`);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error.code, "TAB_RETURN_SHORT");
  assert.equal(decodeTabRef("0x").ok, false);
});

/**
 * A reader answering one head, one delivery log per tab, and the four reads the
 * scan makes per tab, keyed on the selector each one carries.
 */
function tabChain(options: {
  head: { number: number; timestamp: number };
  tabs: readonly { id: string; tab: string; ref?: string }[];
  windowSeconds?: number;
}) {
  const byId = new Map(options.tabs.map((entry) => [entry.id.toLowerCase(), entry]));
  return {
    async chainId() {
      return { ok: true as const, value: 10143 };
    },
    async latestBlock() {
      return { ok: true as const, value: options.head };
    },
    async call(to: string, data: string) {
      const selector = data.slice(0, 10);
      if (to === SERVICE_REGISTRY && selector === SETTLEMENT_WINDOW_OF_SELECTOR) {
        return { ok: true as const, value: `0x${word(options.windowSeconds ?? 100)}` };
      }
      if (selector === TAB_ID_OF_SELECTOR) {
        // The fixture names a tab by its service word, so the id is read back off it.
        const serviceWord = data.slice(10 + 64, 10 + 128);
        const entry = [...byId.values()].find((candidate) => (candidate.ref ?? tabRefData()).includes(serviceWord));
        return { ok: true as const, value: entry === undefined ? `0x${word(0)}` : entry.id };
      }
      const id = `0x${data.slice(10)}`;
      const entry = byId.get(id.toLowerCase());
      if (entry === undefined) throw new Error(`no fixture for ${id}`);
      if (selector === TAB_OF_SELECTOR) return { ok: true as const, value: entry.tab };
      if (selector === TAB_REF_OF_SELECTOR) return { ok: true as const, value: entry.ref ?? tabRefData() };
      throw new Error(`unexpected selector ${selector}`);
    },
    async logs() {
      return {
        ok: true as const,
        // Two deliveries per tab, so a scan that did not collapse them would
        // name every tab twice.
        value: options.tabs.flatMap((entry) => {
          const ref = entry.ref ?? tabRefData();
          const log = (logIndex: string) => ({
            address: TAB_BOOK,
            topics: [
              DELIVERY_RECORDED_TOPIC0,
              `0x${ref.slice(2, 66)}`,
              `0x${ref.slice(66, 130)}`,
              `0x${ref.slice(130, 194)}`,
            ],
            data: "0x",
            blockNumber: "0x1",
            transactionHash: "0x2",
            logIndex,
          });
          return [log("0x0"), log("0x1")];
        }),
      };
    },
  };
}

/** The candidates the fixture's tabs name, as the delivery feed would serve them. */
function candidatesOf(tabs: readonly { ref?: string }[]) {
  return tabs.map((entry) => {
    const ref = entry.ref ?? tabRefData();
    return { agent: `0x${ref.slice(26, 66)}`, serviceId: `0x${ref.slice(66, 130)}`, asset: `0x${ref.slice(154, 194)}` };
  });
}

test("the chain scan names each tab once, whatever it was delivered", async () => {
  const tabs = [
    { id: `0x${"11".repeat(32)}`, tab: tabData({}) },
    { id: `0x${"22".repeat(32)}`, tab: tabData({}), ref: tabRefData({ serviceId: `0x${"bb".repeat(32)}` }) },
  ];
  const scanned = await scanTabCandidates({ chain: tabChain({ head: { number: 50, timestamp: 1 }, tabs }), tabBook: TAB_BOOK, fromBlock: 1 });
  assert.equal(scanned.ok, true);
  assert.deepEqual(scanned.value.candidates, candidatesOf(tabs));
  assert.deepEqual(scanned.value.scanned, { fromBlock: 1, toBlock: 50 });

  // The feed can name a tab many times and in any case; the verdict reads it once.
  const doubled = [...candidatesOf(tabs), { ...candidatesOf(tabs)[0]!, agent: AGENT.toUpperCase().replace("0X", "0x") }];
  assert.equal(distinctCandidates(doubled).length, 2);
});

test("only an open, unmarked tab past its window is offered as markable", async () => {
  const overdue = `0x${"11".repeat(32)}`;
  const running = `0x${"22".repeat(32)}`;
  const marked = `0x${"33".repeat(32)}`;
  const settled = `0x${"44".repeat(32)}`;
  const serviceB = `0x${"bb".repeat(32)}`;
  const serviceC = `0x${"cc".repeat(32)}`;
  const serviceD = `0x${"dd".repeat(32)}`;

  const tabs = [
    // oldest delivery at 850, window 100: closed at 950, so markable at 1,000.
    { id: overdue, tab: tabData({ oldestUnsettledAt: 850n }) },
    // oldest delivery at 950: the window runs until 1,050.
    { id: running, tab: tabData({ oldestUnsettledAt: 950n }), ref: tabRefData({ serviceId: serviceB }) },
    // Already marked by somebody else. Listing it would send a reader to a
    // certain `AlreadyDelinquent` revert, which is the whole reason the state
    // is re-read rather than trusted from an index.
    { id: marked, tab: tabData({ oldestUnsettledAt: 100n, delinquent: true }), ref: tabRefData({ serviceId: serviceC }) },
    // Nothing open: `NothingUnsettled`.
    { id: settled, tab: tabData({ open: 0n, oldestUnsettledAt: 0n }), ref: tabRefData({ serviceId: serviceD }) },
  ];
  const report = await readOverdueTabs({
    chain: tabChain({ head: { number: 64_486_946, timestamp: 1_000 }, windowSeconds: 100, tabs }),
    tabBook: TAB_BOOK,
    serviceRegistry: SERVICE_REGISTRY,
    // The feed names the overdue tab twice; the verdict still reads it once.
    candidates: [...candidatesOf(tabs), ...candidatesOf(tabs).slice(0, 1)],
  });

  assert.equal(report.ok, true);
  assert.equal(report.value.candidates, 4);
  assert.deepEqual(report.value.overdue.map((view) => view.tabId), [overdue]);
  assert.deepEqual(report.value.pending.map((view) => view.tabId), [running]);
  assert.equal(report.value.overdue[0]?.windowEnd, 950n);
  assert.equal(report.value.overdue[0]?.settlementWindowSeconds, 100);
  assert.equal(report.value.at.blockNumber, 64_486_946, "the verdict names the block it used");
});

test("the window end is inclusive, matching the contract's own comparison", async () => {
  const id = `0x${"44".repeat(32)}`;
  const tabs = [{ id, tab: tabData({ oldestUnsettledAt: 900n }) }];
  const at = async (timestamp: number) =>
    readOverdueTabs({
      chain: tabChain({ head: { number: 1, timestamp }, windowSeconds: 100, tabs }),
      tabBook: TAB_BOOK,
      serviceRegistry: SERVICE_REGISTRY,
      candidates: candidatesOf(tabs),
    });

  // `markDelinquent` reverts while `block.timestamp < windowEnd`, so the
  // window-end second itself is markable.
  const before = await at(999);
  const exactly = await at(1_000);
  assert.equal(before.ok && before.value.overdue.length, 0);
  assert.equal(exactly.ok && exactly.value.overdue.length, 1);
});

test("overdueBy reads in units a person uses", () => {
  assert.equal(overdueBy(-30), "30s");
  assert.equal(overdueBy(-90), "1m");
  assert.equal(overdueBy(-3_700), "1h 1m");
  assert.equal(overdueBy(-90_000), "1d 1h");
});

test("the mark command names the contract and the tab, filled in", () => {
  const command = markCommand(TAB_BOOK, `0x${"11".repeat(32)}`);
  assert.match(command, /markDelinquent\(bytes32\)/);
  assert.ok(command.includes(TAB_BOOK), "a reader must not have to find the address themselves");
  assert.ok(command.includes("11".repeat(32)));
  assert.match(command, /MONAD_RPC_URL/);
});

// ---------------------------------------------------------------- health

const okChain = {
  async chainId() {
    return { ok: true as const, value: 10143 };
  },
  async latestBlock() {
    return { ok: true as const, value: { number: 64_486_946, timestamp: 1_000 } };
  },
  async call() {
    return { ok: true as const, value: "0x" };
  },
  async logs() {
    return { ok: true as const, value: [] };
  },
};

const failure = (code: string) => ({
  ok: false as const,
  error: { category: "UPSTREAM" as const, code, message: `${code} happened`, retryable: true },
});

test("health reports both upstreams up as ok", async () => {
  const result = await serveHealth({
    chain: okChain,
    registry: { probe: async () => ({ ok: true, value: { status: "ok", lastBlock: 64_486_945 } }) },
    now: () => new Date(0),
    env: {},
  });
  assert.equal(result.status, 200);
  const body = result.body as { status: string; upstreams: { name: string; reachable: boolean }[] };
  assert.equal(body.status, "ok");
  assert.deepEqual(body.upstreams.map((entry) => entry.reachable), [true, true]);
});

test("an unreachable registry is a stated reason, never a zero", async () => {
  const result = await serveHealth({
    chain: okChain,
    registry: { probe: async () => failure("REGISTRY_UNREACHABLE") },
    now: () => new Date(0),
    env: {},
  });

  assert.equal(result.status, 200, "a description answers even when degraded");
  const body = result.body as {
    status: string;
    upstreams: { name: string; reachable: boolean; detail?: unknown; unavailable?: { code: string } }[];
  };
  assert.equal(body.status, "degraded");
  const registry = body.upstreams.find((entry) => entry.name === "registry-read-api");
  assert.equal(registry?.reachable, false);
  assert.equal(registry?.unavailable?.code, "REGISTRY_UNREACHABLE");
  assert.equal(registry?.detail, undefined, "an unknown carries no figures at all");
});

test("both upstreams are probed even when the first one fails", async () => {
  let registryProbed = false;
  const result = await serveHealth({
    chain: {
      ...okChain,
      async chainId() {
        return failure("RPC_UNREACHABLE");
      },
    },
    registry: {
      probe: async () => {
        registryProbed = true;
        return { ok: true, value: { status: "ok", lastBlock: 1 } };
      },
    },
    now: () => new Date(0),
    env: {},
  });
  assert.equal(registryProbed, true, "which of the two is down is the question being answered");
  const body = result.body as { upstreams: { name: string; reachable: boolean }[] };
  assert.deepEqual(body.upstreams.map((entry) => entry.reachable), [false, true]);
});

test("a reachable endpoint whose head is unreadable still reports as reachable", async () => {
  const result = await serveHealth({
    chain: {
      ...okChain,
      async latestBlock() {
        return failure("RPC_MALFORMED");
      },
    },
    registry: { probe: async () => ({ ok: true, value: { status: "ok", lastBlock: 1 } }) },
    now: () => new Date(0),
    env: {},
  });
  const body = result.body as { upstreams: { name: string; reachable: boolean; detail?: Record<string, unknown> }[] };
  const rpc = body.upstreams.find((entry) => entry.name === "monad-rpc");
  assert.equal(rpc?.reachable, true);
  assert.equal(rpc?.detail?.["chainId"], 10143);
  assert.equal(rpc?.detail?.["latestBlock"], undefined, "an unknown height is omitted, not faked");
});

test("build info reports a missing commit as null rather than a placeholder", () => {
  assert.equal(readBuildInfo({}).commit, null);
  assert.equal(readBuildInfo({ TAB_BUILD_COMMIT: "  " }).commit, null);
  assert.equal(readBuildInfo({ TAB_BUILD_COMMIT: "17d164b" }).commit, "17d164b");
  assert.equal(readBuildInfo({}).version, "0.0.0");
});

test("the health body discloses no endpoint, path or key", async () => {
  const result = await serveHealth({
    chain: okChain,
    registry: { probe: async () => ({ ok: true, value: { status: "ok", lastBlock: 1 } }) },
    now: () => new Date(0),
    env: {},
  });
  const serialised = JSON.stringify(result.body).toLowerCase();
  for (const secret of ["http://", "https://", "private", "postgres", "/home/"]) {
    assert.equal(serialised.includes(secret), false, `the public body must not carry ${secret}`);
  }
});

// ---------------------------------------------------------------- stream

test("the first tick establishes what the reader has without replaying it", async () => {
  const rows = [{ settlementId: "0xaa" }, { settlementId: "0xbb" }];
  const result = await streamTick(
    async () => ({ ok: true, value: { index: {}, settlements: rows, nextCursor: null } } as never),
    new Set(),
    { first: true },
  );
  assert.equal(result.frames.length, 1);
  assert.match(result.frames[0] as string, /^event: hello/, "the page already rendered these rows");
  assert.deepEqual([...result.seen].sort(), ["0xaa", "0xbb"]);
});

test("a later tick frames only what is new, oldest first", async () => {
  const rows = [{ settlementId: "0xcc" }, { settlementId: "0xbb" }, { settlementId: "0xaa" }];
  const result = await streamTick(
    async () => ({ ok: true, value: { index: {}, settlements: rows, nextCursor: null } } as never),
    new Set(["0xaa"]),
    { first: false },
  );
  assert.equal(result.frames.length, 2);
  // The registry serves newest first; a stream appended in that order would run
  // backwards, so the new rows are reversed before framing.
  assert.match(result.frames[0] as string, /0xbb/);
  assert.match(result.frames[1] as string, /0xcc/);
});

test("a failed read emits an error frame rather than closing the stream", async () => {
  const result = await streamTick(async () => failure("REGISTRY_UNREACHABLE") as never, new Set(), {
    first: false,
  });
  assert.equal(result.frames.length, 1);
  assert.match(result.frames[0] as string, /^event: error/);
  assert.deepEqual([...result.seen], [], "a failed read adds nothing to what is known");
});

test("unsentRows keeps only what has not been sent", () => {
  const rows = [{ settlementId: "0xcc" }, { settlementId: "0xaa" }] as never;
  assert.deepEqual(
    unsentRows(rows, new Set(["0xaa"])).map((row) => row.settlementId),
    ["0xcc"],
  );
  assert.deepEqual(unsentRows(rows, new Set(["0xaa", "0xcc"])), []);
});

test("an SSE frame is a named event and one terminated data line", () => {
  const frame = sseFrame("settlement", { settlementId: "0xaa" });
  assert.equal(frame, 'event: settlement\ndata: {"settlementId":"0xaa"}\n\n');
});

// ---------------------------------------------------------------- authorisation

test("an address is parsed, or refused with the correction named", () => {
  assert.equal(parseAddress("  0xAbCdEf0123456789012345678901234567890123 ", "agent").ok, true);
  const empty = parseAddress("   ", "agent");
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "ADDRESS_MISSING");
  assert.match(empty.error.message, /40 hexadecimal/, "the message says what a correct value is");
  const short = parseAddress("0x1234", "agent");
  assert.equal(short.ok, false);
  assert.equal(short.error.code, "ADDRESS_MALFORMED");
  assert.equal(short.error.details?.["field"], "agent", "the error names its own field");

  assert.equal(parseWord(SERVICE, "serviceId").ok, true);
  assert.equal(parseWord("0x1234", "serviceId").ok, false);
});

test("the authorise call is four static words behind its selector, and reads back as it was written", async () => {
  const data = encodeAuthorise(SERVICE, ASSET, 5_000_000n, 1_800_000_000n);
  assert.equal(data.length, 10 + 4 * 64, "selector plus four words");
  assert.equal(`0x${data.slice(10, 74)}`, SERVICE);
  assert.equal(data.slice(74, 138), addressWord(ASSET));
  assert.equal(BigInt(`0x${data.slice(138, 202)}`), 5_000_000n);
  assert.equal(BigInt(`0x${data.slice(202, 266)}`), 1_800_000_000n);

  const chain = {
    ...okChain,
    async call(_to: string, calldata: string) {
      assert.equal(calldata.slice(0, 10), selectorOf("authorisationOf(address,bytes32,address)"));
      return {
        ok: true as const,
        value: `0x${word(5_000_000n)}${word(1_250_000n)}${word(1_800_000_000n)}${word(1)}`,
      };
    },
  };
  const read = await readAuthorisation(chain, TAB_BOOK, AGENT, SERVICE, ASSET, 1);
  assert.equal(read.ok, true);
  assert.equal(read.value.maxCumulative, 5_000_000n);
  assert.equal(read.value.spent, 1_250_000n);
  assert.equal(read.value.expiry, 1_800_000_000n);
  assert.equal(read.value.exists, true);
});

// ---------------------------------------------------------------- bond figures

/**
 * The Bond meter reads both ledger figures, not just the stake.
 *
 * A services page that wrote `withdrawn` as a literal zero would render a Service
 * whose stake had been withdrawn as though every unit of it were still free, and
 * free Bond is what caps the credit an Agent can be extended against that
 * Service, so overstating it is the direction that misleads a reader.
 *
 * This asserts on the mapping the page performs rather than on the rendered meter,
 * because a meter test would pass either way.
 */
test("the bond meter is built from both ledger figures", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "app", "services", "page.tsx"),
    "utf8",
  );
  assert.match(
    source,
    /withdrawnBaseUnits:\s*toBigInt\(row\.withdrawn\)/,
    "withdrawn must come from the row, never from a literal",
  );
  assert.equal(/withdrawnBaseUnits:\s*0n/.test(source), false, "no ledger figure is hardcoded to zero");
});
