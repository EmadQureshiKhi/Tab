/**
 * The four surfaces added in wave 20: chain reads, overdue clearings, `/api/health`
 * and `/api/stream`.
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
 * **A short answer is never a safe answer.** The overdue-clearing list is the input
 * to somebody else's transaction, so a truncated scan reading as "nothing is
 * overdue" is the one wrong answer that costs a reader money. A malformed log
 * therefore fails the whole read rather than being skipped.
 *
 * Requirements: 24.8, 24.9, 24.6, 15.5, 14.6
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
  CLEARING_STATE_BY_ORDINAL,
  PROVISIONAL_CLEARING_APPLIED_TOPIC0,
  crankCommand,
  decodeClearing,
  overdueBy,
  readClearings,
} from "../src/dashboard/clearings";
import { readBuildInfo, serveHealth } from "../src/dashboard/api-health";
import { sseFrame, streamTick, unsentRows } from "../src/dashboard/api-stream";
import { parseAddress } from "../src/dashboard/binding";

const TAB_BOOK = "0x047ecfb428fe706ea391b626872ce8deb8756c5f";

/** A `bigint` as one ABI word, for building fixture return data. */
const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value: string): string => value.slice(2).toLowerCase().padStart(64, "0");

/**
 * Eleven words in `Clearing` order.
 *
 * `Clearing` is entirely static, so the returned tuple is laid out in place with no
 * head offset, which is what the decoder relies on.
 */
function clearingData(overrides: {
  agent?: string;
  amount?: bigint;
  deadline?: bigint;
  state?: number;
}): string {
  return (
    "0x" +
    addressWord(overrides.agent ?? "0x1f6f797edc2eecb02bd54009b805fb2e99f80542") +
    word(1) +
    addressWord("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238") +
    word(overrides.amount ?? 3000n) +
    word(3000) +
    word(1) +
    word(1788715845) +
    word(overrides.deadline ?? 1788717645n) +
    word(0xabc) +
    word(0) +
    word(overrides.state ?? 1)
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
  // `clearingOf(bytes32)` and `transfer(address,uint256)`. The second is the
  // canonical worked example, so a wrong hash shows up against a known value.
  assert.equal(selectorOf("transfer(address,uint256)"), "0xa9059cbb");
  assert.match(selectorOf("clearingOf(bytes32)"), /^0x[0-9a-f]{8}$/);
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
  // The endpoint's ceiling is a ten-second wall clock, not a block count, so a window
  // that is comfortable most of the time is refused some of the time. Observed live on
  // the explorer, which then said it could not read the chain at all.
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
  // 1000, 500, 250, then stop: halving below the floor would turn one dead upstream
  // into a long series of doomed requests.
  assert.ok(calls <= 4, `expected the climb down to stop at the floor, made ${calls} calls`);
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

// ---------------------------------------------------------------- clearings

test("the clearing state ordinals match the contract, with Declined before Superseded", () => {
  // The enum is None, Applied, Confirmed, Reversed, Declined, Superseded. The last
  // two are the easy pair to transpose, and doing so would report a slashed
  // clearing as a reorganised one.
  assert.deepEqual([...CLEARING_STATE_BY_ORDINAL], [
    "None",
    "Applied",
    "Confirmed",
    "Reversed",
    "Declined",
    "Superseded",
  ]);
});

test("the applied topic is derived from the canonical signature", () => {
  assert.match(PROVISIONAL_CLEARING_APPLIED_TOPIC0, /^0x[0-9a-f]{64}$/);
});

test("a clearing decodes field for field", () => {
  const decoded = decodeClearing(clearingData({ amount: 4200n, deadline: 99n, state: 1 }));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.value.amount, 4200n);
  assert.equal(decoded.value.deadline, 99n);
  assert.equal(decoded.value.state, "Applied");
  assert.equal(decoded.value.agent, "0x1f6f797edc2eecb02bd54009b805fb2e99f80542");
});

test("short return data is refused rather than decoded into zeroes", () => {
  const decoded = decodeClearing(`0x${word(1)}`);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error.code, "CLEARING_RETURN_SHORT");
});

test("a state ordinal this build has no name for is refused, not guessed at", () => {
  const decoded = decodeClearing(clearingData({ state: 9 }));
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error.code, "CLEARING_STATE_UNKNOWN");
});

/** A reader answering one head, one log per id, and one `clearingOf` per call. */
function clearingChain(options: {
  head: { number: number; timestamp: number };
  ids: readonly string[];
  answers: Readonly<Record<string, string>>;
}) {
  return {
    async chainId() {
      return { ok: true as const, value: 102031 };
    },
    async latestBlock() {
      return { ok: true as const, value: options.head };
    },
    async call(_to: string, data: string) {
      const id = `0x${data.slice(10)}`;
      const answer = options.answers[id];
      if (answer === undefined) throw new Error(`no fixture for ${id}`);
      return { ok: true as const, value: answer };
    },
    async logs() {
      return {
        ok: true as const,
        value: options.ids.map((id) => ({
          address: TAB_BOOK,
          topics: [PROVISIONAL_CLEARING_APPLIED_TOPIC0, id],
          data: "0x",
          blockNumber: "0x1",
          transactionHash: "0x2",
          logIndex: "0x0",
        })),
      };
    },
  };
}

test("only an applied clearing past its deadline is offered as crankable", async () => {
  const overdue = `0x${"11".repeat(32)}`;
  const running = `0x${"22".repeat(32)}`;
  const reversed = `0x${"33".repeat(32)}`;

  const report = await readClearings({
    chain: clearingChain({
      head: { number: 5_441_946, timestamp: 1_000 },
      ids: [overdue, running, reversed],
      answers: {
        [overdue]: clearingData({ deadline: 900n, state: 1 }),
        [running]: clearingData({ deadline: 1_500n, state: 1 }),
        // Already reversed by somebody else. Listing it would send a reader to a
        // certain `ClearingNotInState` revert, which is the whole reason the state
        // is re-read rather than trusted from an index.
        [reversed]: clearingData({ deadline: 500n, state: 3 }),
      },
    }),
    tabBook: TAB_BOOK,
    fromBlock: 1,
  });

  assert.equal(report.ok, true);
  assert.equal(report.value.candidates, 3);
  assert.deepEqual(report.value.overdue.map((view) => view.clearingId), [overdue]);
  assert.deepEqual(report.value.pending.map((view) => view.clearingId), [running]);
  assert.equal(report.value.at.blockNumber, 5_441_946, "the verdict names the block it used");
});

test("the deadline is inclusive, matching the contract's own comparison", async () => {
  const id = `0x${"44".repeat(32)}`;
  const at = async (timestamp: number) =>
    readClearings({
      chain: clearingChain({
        head: { number: 1, timestamp },
        ids: [id],
        answers: { [id]: clearingData({ deadline: 1_000n, state: 1 }) },
      }),
      tabBook: TAB_BOOK,
      fromBlock: 1,
    });

  // `reverseExpiredClearing` reverts while `block.timestamp < deadline`, so the
  // deadline second itself is crankable.
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

test("the crank command names the contract and the clearing, filled in", () => {
  const command = crankCommand(TAB_BOOK, `0x${"11".repeat(32)}`);
  assert.match(command, /reverseExpiredClearing\(bytes32\)/);
  assert.ok(command.includes(TAB_BOOK), "a reader must not have to find the address themselves");
  assert.ok(command.includes("11".repeat(32)));
});

// ---------------------------------------------------------------- health

const okChain = {
  async chainId() {
    return { ok: true as const, value: 102031 };
  },
  async latestBlock() {
    return { ok: true as const, value: { number: 5_441_946, timestamp: 1_000 } };
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
    registry: { probe: async () => ({ ok: true, value: { status: "ok", lastBlock: 5_441_945 } }) },
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
  const rpc = body.upstreams.find((entry) => entry.name === "creditcoin-rpc");
  assert.equal(rpc?.reachable, true);
  assert.equal(rpc?.detail?.["chainId"], 102031);
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
  const rows = [{ replayKey: "0xaa" }, { replayKey: "0xbb" }];
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
  const rows = [{ replayKey: "0xcc" }, { replayKey: "0xbb" }, { replayKey: "0xaa" }];
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
  const rows = [{ replayKey: "0xcc" }, { replayKey: "0xaa" }] as never;
  assert.deepEqual(
    unsentRows(rows, new Set(["0xaa"])).map((row) => row.replayKey),
    ["0xcc"],
  );
  assert.deepEqual(unsentRows(rows, new Set(["0xaa", "0xcc"])), []);
});

test("an SSE frame is a named event and one terminated data line", () => {
  const frame = sseFrame("settlement", { replayKey: "0xaa" });
  assert.equal(frame, 'event: settlement\ndata: {"replayKey":"0xaa"}\n\n');
});

// ---------------------------------------------------------------- binding

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
});

// ---------------------------------------------------------------- bond figures

/**
 * The Bond meter reads all four ledger figures, not just the stake.
 *
 * The services page built its meter with `reserved`, `slashed` and `released` written
 * as literal zeros, so a Service whose Bond had been slashed rendered as though every
 * unit of it were still free. The read API carried the right numbers throughout and
 * the page simply did not ask for them, which is why nothing failed: it disagreed with
 * `/analytics` and with `Bond.ledgerOf` about the same ledger while both of those were
 * right. Free Bond is what covers the next Provisional Clearing, so overstating it is
 * the direction that misleads a reader deciding whether to trust a Service.
 *
 * This asserts on the mapping the page performs rather than on the rendered meter,
 * because the defect was in the mapping and a meter test would have passed either way.
 */
test("the bond meter is built from all four ledger figures", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "app", "services", "page.tsx"),
    "utf8",
  );
  for (const field of ["reserved", "slashed", "released"] as const) {
    assert.match(
      source,
      new RegExp(`${field}BaseUnits:\\s*toBigInt\\(row\\.${field}\\)`),
      `${field} must come from the row, never from a literal`,
    );
  }
  assert.equal(
    /(?:reserved|slashed|released)BaseUnits:\s*0n/.test(source),
    false,
    "no ledger figure is hardcoded to zero",
  );
});
