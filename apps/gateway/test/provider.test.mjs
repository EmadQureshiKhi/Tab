/**
 * The gateway's provider retries a read the node failed to answer, and nothing else.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { RPC_REQUEST_TIMEOUT_MS, RetryingJsonRpcProvider } from "../dist/provider.js";

/** A JSON-RPC node that answers from a script, one entry per request it receives. */
async function node(script, retry = {}) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const payload = JSON.parse(body);
      const first = Array.isArray(payload) ? payload[0] : payload;
      seen.push(first.method);
      const step = script.shift() ?? { result: "0x1" };
      // A connection the far side dropped while idle: the request is taken and never answered.
      if (step.hang === true) return;
      if (step.status !== undefined) {
        response.writeHead(step.status).end("unavailable");
        return;
      }
      const answer = step.error === undefined ? { jsonrpc: "2.0", id: first.id, result: step.result } : { jsonrpc: "2.0", id: first.id, error: step.error };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(payload) ? [answer] : answer));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const provider = new RetryingJsonRpcProvider(url, 10143, { staticNetwork: true, batchMaxCount: 1 }, { sleep: async () => {}, ...retry });
  const close = () => {
    provider.destroy();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  };
  return { provider, seen, close };
}

test("a read the node failed to answer is sent again, and succeeds", async () => {
  const { provider, seen, close } = await node([{ status: 503 }, { result: "0x2a" }]);
  try {
    assert.equal(await provider.getBlockNumber(), 42);
    assert.deepEqual(seen, ["eth_blockNumber", "eth_blockNumber"]);
  } finally {
    await close();
  }
});

test("a node that says it is rate limited is asked again", async () => {
  const { provider, seen, close } = await node([{ error: { code: -32005, message: "limit exceeded" } }, { result: "0x7" }]);
  try {
    assert.equal(await provider.getBlockNumber(), 7);
    assert.equal(seen.length, 2);
  } finally {
    await close();
  }
});

test("a revert is an answer, so it is not asked again", async () => {
  const { provider, seen, close } = await node([{ error: { code: 3, message: "execution reverted", data: "0x" } }]);
  try {
    await assert.rejects(provider.call({ to: "0x0000000000000000000000000000000000000001", data: "0x" }));
    assert.deepEqual(seen, ["eth_call"]);
  } finally {
    await close();
  }
});

test("a transaction is never sent twice, whatever the node says", async () => {
  const { provider, seen, close } = await node([{ status: 503 }, { result: "0x" + "ab".repeat(32) }]);
  try {
    await assert.rejects(provider.send("eth_sendRawTransaction", ["0x02"]));
    assert.deepEqual(seen, ["eth_sendRawTransaction"]);
  } finally {
    await close();
  }
});

test("a read that keeps failing gives up after the last retry", async () => {
  const { provider, seen, close } = await node([{ status: 503 }, { status: 503 }, { status: 503 }, { result: "0x1" }]);
  try {
    await assert.rejects(provider.getBlockNumber());
    assert.equal(seen.length, 3, "one try and two retries");
  } finally {
    await close();
  }
});

test("a request the node never answers times out and is sent again, rather than holding the call for minutes", { timeout: 10_000 }, async () => {
  const { provider, seen, close } = await node([{ hang: true }, { result: "0x2a" }], { requestTimeoutMs: 300 });
  try {
    const started = Date.now();
    assert.equal(await provider.getBlockNumber(), 42);
    assert.ok(Date.now() - started < 3_000, "answered within a few timeouts, not after ethers' five-minute default");
    assert.deepEqual(seen, ["eth_blockNumber", "eth_blockNumber"]);
  } finally {
    await close();
  }
});

test("a transaction the node never answers fails at the timeout and is not sent twice", { timeout: 10_000 }, async () => {
  const { provider, seen, close } = await node([{ hang: true }, { result: "0x" + "ab".repeat(32) }], { requestTimeoutMs: 300 });
  try {
    const started = Date.now();
    await assert.rejects(provider.send("eth_sendRawTransaction", ["0x02"]));
    assert.ok(Date.now() - started < 3_000);
    assert.deepEqual(seen, ["eth_sendRawTransaction"], "it may have landed, so it is never resent");
  } finally {
    await close();
  }
});

test("without an explicit timeout, a request is given the gateway's default rather than ethers' five minutes", () => {
  const provider = new RetryingJsonRpcProvider("http://127.0.0.1:9", 10143, { staticNetwork: true });
  try {
    assert.equal(provider._getConnection().timeout, RPC_REQUEST_TIMEOUT_MS);
    assert.ok(RPC_REQUEST_TIMEOUT_MS <= 30_000);
  } finally {
    provider.destroy();
  }
});
