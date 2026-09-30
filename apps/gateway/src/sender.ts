/**
 * One queue for every transaction the operator key sends.
 *
 * The gateway sends from one key on three paths: metering (`recordDelivery`),
 * the settlement relay (`settleWithPermit2`) and the ERC-8004 feedback writer.
 * Each `sendTransaction` on a bare signer asks the node for the pending nonce,
 * so two sends that overlap can be handed the same nonce and one of them is
 * refused, which would fail a metered call that was otherwise sound. This
 * wrapper sends one transaction at a time and counts nonces itself: the first
 * send reads the pending nonce, each broadcast advances it, and a failure
 * forgets it so the next send reads it again.
 *
 * The key may also be used from outside this process, by a person running a
 * script with it, which moves the nonce under the count. A refusal that names
 * the nonce is therefore retried once with a fresh read, and any other failure
 * is returned to the caller unchanged.
 */

import type { Signer, TransactionRequest, TransactionResponse } from "ethers";

/** What the gateway's writers need from the operator key. */
export type OperatorSender = Pick<Signer, "getAddress" | "sendTransaction">;

/** A refusal caused by the nonce, as the node words it. */
const NONCE_REFUSAL = /nonce|replacement transaction underpriced|already known/i;

const messageOf = (error: unknown): string => {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${typeof code === "string" ? `${code} ` : ""}${error.message}`;
  }
  return String(error);
};

export function createSerialSender(signer: Signer): OperatorSender {
  let queue: Promise<unknown> = Promise.resolve();
  let next: number | undefined;

  const sendOnce = async (request: TransactionRequest): Promise<TransactionResponse> => {
    if (next === undefined) next = await signer.getNonce("pending");
    const nonce = next;
    try {
      const sent = await signer.sendTransaction({ ...request, nonce });
      next = nonce + 1;
      return sent;
    } catch (error) {
      next = undefined;
      throw error;
    }
  };

  const send = async (request: TransactionRequest): Promise<TransactionResponse> => {
    try {
      return await sendOnce(request);
    } catch (error) {
      if (!NONCE_REFUSAL.test(messageOf(error))) throw error;
      return sendOnce(request);
    }
  };

  return {
    getAddress: () => signer.getAddress(),
    sendTransaction(request) {
      const result = queue.then(
        () => send(request),
        () => send(request),
      );
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
