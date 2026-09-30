/**
 * The operator's one send queue: sends in order, counts nonces itself, and
 * recovers when the nonce moved under it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSerialSender } from "../dist/sender.js";

/** A signer whose sends settle when the test says, recording the nonce each carried. */
function fakeSigner({ pending = 7, refuseNonces = [] } = {}) {
  const sent = [];
  const nonceReads = [];
  const refusals = [...refuseNonces];
  let chainNonce = pending;
  return {
    sent,
    nonceReads,
    async getAddress() {
      return "0x00000000000000000000000000000000000000aa";
    },
    async getNonce(tag) {
      nonceReads.push(tag);
      return chainNonce;
    },
    async sendTransaction(request) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (refusals.includes(request.nonce)) {
        refusals.splice(refusals.indexOf(request.nonce), 1);
        const error = new Error("nonce too low: next nonce 9, tx nonce 7");
        error.code = "NONCE_EXPIRED";
        throw error;
      }
      if (request.to === "refuse") throw new Error("execution reverted: UnknownTool");
      sent.push({ to: request.to, nonce: request.nonce });
      chainNonce = Math.max(chainNonce, request.nonce + 1);
      return { hash: `0x${String(request.nonce).padStart(64, "0")}` };
    },
  };
}

test("overlapping sends go out one at a time with consecutive nonces, read once", async () => {
  const signer = fakeSigner();
  const sender = createSerialSender(signer);
  await Promise.all([sender.sendTransaction({ to: "a" }), sender.sendTransaction({ to: "b" }), sender.sendTransaction({ to: "c" })]);
  assert.deepEqual(signer.sent, [
    { to: "a", nonce: 7 },
    { to: "b", nonce: 8 },
    { to: "c", nonce: 9 },
  ]);
  assert.deepEqual(signer.nonceReads, ["pending"]);
});

test("a refusal is returned to its caller and the next send reads the nonce again", async () => {
  const signer = fakeSigner();
  const sender = createSerialSender(signer);
  await assert.rejects(sender.sendTransaction({ to: "refuse" }), /UnknownTool/);
  await sender.sendTransaction({ to: "a" });
  assert.deepEqual(signer.sent, [{ to: "a", nonce: 7 }]);
  assert.equal(signer.nonceReads.length, 2);
});

test("a nonce moved by someone else is read again and the send retried once", async () => {
  // The key sent elsewhere, so the count this process read is refused once.
  const signer = fakeSigner({ pending: 8, refuseNonces: [8] });
  const sender = createSerialSender(signer);
  await sender.sendTransaction({ to: "first" });
  assert.deepEqual(signer.sent, [{ to: "first", nonce: 8 }]);
  assert.equal(signer.nonceReads.length, 2, "read, refused on the nonce, read again");
});

test("a failed send does not stop the queue behind it", async () => {
  const signer = fakeSigner();
  const sender = createSerialSender(signer);
  const results = await Promise.allSettled([sender.sendTransaction({ to: "refuse" }), sender.sendTransaction({ to: "b" })]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.deepEqual(signer.sent, [{ to: "b", nonce: 7 }]);
});
