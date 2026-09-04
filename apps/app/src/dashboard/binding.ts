/**
 * The Agent binding flow, as `/register` drives it.
 *
 * ## What a binding actually proves, and why the flow has this shape
 *
 * `AgentRegistry` binds a Source Chain address to a Creditcoin Agent by **payment
 * rather than by signature**. The Agent asks for a nonce, the registry answers with
 * an exact Settlement amount whose low four decimal digits carry that nonce, and a
 * Verified Settlement of exactly that amount from exactly that address completes
 * the binding. Whoever holds the address and whoever holds the nonce must have
 * cooperated, and no component of Tab has to be trusted for it.
 *
 * That is why the page cannot shortcut to a signature, and why the middle of the
 * flow is a wait: the proof is a payment on another chain that has to be observed,
 * attested and verified before anything here changes.
 *
 * ## Everything here is a read except the one call the user signs
 *
 * The two view calls below let the page tell a reader exactly where they are: what
 * the required amount is, when the nonce expires, and whether the binding has
 * landed. `requestBinding` is the single write, and it is signed by the reader's
 * own wallet through EIP-1193 rather than by anything this project holds. There is
 * no key in this module and no path to one.
 *
 * ## No wallet library
 *
 * `window.ethereum` is an interface, not a dependency, and the three calls here are
 * two ABI words each. A wallet toolkit would be a large client bundle to encode six
 * words, so the encoding lives beside the calls that use it.
 *
 * Requirements: 24.5, 10.1, 10.4, 10.6
 */

import { err, ok, type Result } from "@tabai/shared";

import {
  addressArg,
  addressFromWord,
  selectorOf,
  uintArg,
  uintFromWord,
  wordAt,
  type ChainReader,
} from "./chain.js";

export const REQUEST_BINDING_SELECTOR = selectorOf("requestBinding(uint64,address)");
export const PENDING_BINDING_SELECTOR = selectorOf("pendingBinding(uint64,address,address)");
export const AGENT_OF_SELECTOR = selectorOf("agentOf(uint64,address)");

/** An open binding request, as `pendingBinding` reports it. */
export interface PendingBinding {
  readonly agent: string;
  readonly ethAddress: string;
  /** The exact Settlement amount, in Asset base units. Its low four digits are the nonce. */
  readonly requiredAmount: bigint;
  readonly nonce: number;
  readonly issuedAt: bigint;
  readonly open: boolean;
  /** Creditcoin timestamp the nonce stops being valid at, 24 hours after issue. */
  readonly expiresAt: bigint;
  /** False once the window has elapsed, as the contract itself computes it. */
  readonly alive: boolean;
}

/** The nine-word layout `pendingBinding` returns: seven struct words, then two. */
const PENDING_FIELD = {
  agent: 0,
  chainKey: 1,
  ethAddress: 2,
  requiredAmount: 3,
  nonce: 4,
  issuedAt: 5,
  open: 6,
  expiresAt: 7,
  alive: 8,
} as const;

const malformed = (what: string): Result<never> =>
  err({
    category: "UPSTREAM",
    code: "BINDING_RETURN_SHORT",
    message: `${what} returned too little data to decode`,
    retryable: false,
  });

/** Calldata for the one call a reader signs. */
export function encodeRequestBinding(chainKey: number, ethAddress: string): string {
  return `${REQUEST_BINDING_SELECTOR}${uintArg(chainKey)}${addressArg(ethAddress)}`;
}

/**
 * Reads the open request for one address and Agent.
 *
 * `PendingBinding` is entirely static, so the returned tuple of struct plus two
 * scalars is nine words laid out in place with no head offset.
 */
export async function readPendingBinding(
  chain: ChainReader,
  registryAddress: string,
  chainKey: number,
  ethAddress: string,
  agent: string,
  blockNumber: number,
): Promise<Result<PendingBinding>> {
  const data = `${PENDING_BINDING_SELECTOR}${uintArg(chainKey)}${addressArg(ethAddress)}${addressArg(agent)}`;
  const returned = await chain.call(registryAddress, data, blockNumber);
  if (!returned.ok) return returned;

  const words: string[] = [];
  for (let index = 0; index <= PENDING_FIELD.alive; index += 1) {
    const word = wordAt(returned.value, index);
    if (word === undefined) return malformed("pendingBinding");
    words.push(word);
  }

  return ok({
    agent: addressFromWord(words[PENDING_FIELD.agent] as string),
    ethAddress: addressFromWord(words[PENDING_FIELD.ethAddress] as string),
    requiredAmount: uintFromWord(words[PENDING_FIELD.requiredAmount] as string),
    nonce: Number(uintFromWord(words[PENDING_FIELD.nonce] as string)),
    issuedAt: uintFromWord(words[PENDING_FIELD.issuedAt] as string),
    open: uintFromWord(words[PENDING_FIELD.open] as string) === 1n,
    expiresAt: uintFromWord(words[PENDING_FIELD.expiresAt] as string),
    alive: uintFromWord(words[PENDING_FIELD.alive] as string) === 1n,
  });
}

/**
 * The Agent an address is bound to, or `undefined` where it is not bound.
 *
 * The contract returns the zero address for an unbound address, and that is
 * translated here rather than passed on: a caller comparing against the zero
 * address is one typo away from treating "unbound" as a real Agent.
 */
export async function readBoundAgent(
  chain: ChainReader,
  registryAddress: string,
  chainKey: number,
  ethAddress: string,
  blockNumber: number,
): Promise<Result<string | undefined>> {
  const data = `${AGENT_OF_SELECTOR}${uintArg(chainKey)}${addressArg(ethAddress)}`;
  const returned = await chain.call(registryAddress, data, blockNumber);
  if (!returned.ok) return returned;
  const word = wordAt(returned.value, 0);
  if (word === undefined) return malformed("agentOf");
  const agent = addressFromWord(word);
  return ok(/^0x0{40}$/i.test(agent) ? undefined : agent);
}

/** An address a reader typed, normalised, or a stated reason it is not one. */
export function parseAddress(raw: string, field: string): Result<string> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return err({
      category: "VALIDATION",
      code: "ADDRESS_MISSING",
      message: "Enter an address. It is 0x followed by 40 hexadecimal characters.",
      retryable: false,
      details: { field },
    });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return err({
      category: "VALIDATION",
      code: "ADDRESS_MALFORMED",
      message:
        "That is not an address. An address is 0x followed by exactly 40 hexadecimal characters.",
      retryable: false,
      details: { field },
    });
  }
  return ok(trimmed.toLowerCase());
}
