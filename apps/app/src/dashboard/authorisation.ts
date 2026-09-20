/**
 * The spending authorisation flow, as `/authorise` drives it.
 *
 * ## What an authorisation is, and why the flow has this shape
 *
 * `TabBook.recordDelivery` refuses to meter an Agent that has not authorised the
 * Service (`AuthorisationMissing`), and it refuses once the cumulative charge
 * would pass the ceiling the Agent set (`AuthorisationExceeded`) or the expiry
 * has lapsed (`AuthorisationExpired`). So the first thing an Agent does with a
 * Service is not a payment: it is a signed statement of how much that Service may
 * put on its tab, in one Asset, until when. Nothing in Tab can raise that ceiling
 * on the Agent's behalf.
 *
 * ## Everything here is a read except the one call the user signs
 *
 * The view call below lets the page tell a reader exactly where they stand: the
 * ceiling, what has been spent against it, and when it lapses. `authorise` is the
 * single write, and it is signed by the reader's own wallet through EIP-1193
 * rather than by anything this project holds. There is no key in this module and
 * no path to one.
 *
 * ## No wallet library
 *
 * `window.ethereum` is an interface, not a dependency, and the calls here are a
 * handful of ABI words each. A wallet toolkit would be a large client bundle to
 * encode them, so the encoding lives beside the calls that use it.
 */

import { err, ok, type Result } from "@tabai/shared";

import { addressArg, bytes32Arg, selectorOf, uintArg, uintFromWord, wordAt, type ChainReader } from "./chain.js";

export const AUTHORISE_SELECTOR = selectorOf("authorise(bytes32,address,uint128,uint64)");
export const AUTHORISATION_OF_SELECTOR = selectorOf("authorisationOf(address,bytes32,address)");

/** One authorisation, as `authorisationOf` reports it. */
export interface AuthorisationRecord {
  /** The ceiling, in Asset base units. */
  readonly maxCumulative: bigint;
  /** Charged against the ceiling so far, in Asset base units. */
  readonly spent: bigint;
  /** Chain timestamp the authorisation lapses at. */
  readonly expiry: bigint;
  readonly exists: boolean;
}

/** The four-word layout `authorisationOf` returns, in the struct's own order. */
const FIELD = { maxCumulative: 0, spent: 1, expiry: 2, exists: 3 } as const;

const malformed = (what: string): Result<never> =>
  err({
    category: "UPSTREAM",
    code: "AUTHORISATION_RETURN_SHORT",
    message: `${what} returned too little data to decode`,
    retryable: false,
  });

/** Calldata for the one call a reader signs. */
export function encodeAuthorise(serviceId: string, asset: string, maxCumulative: bigint, expiry: bigint): string {
  return `${AUTHORISE_SELECTOR}${bytes32Arg(serviceId)}${addressArg(asset)}${uintArg(maxCumulative)}${uintArg(expiry)}`;
}

/**
 * Reads the authorisation one Agent holds for one Service in one Asset.
 *
 * `Authorisation` is entirely static, so the returned tuple is four words laid
 * out in place with no head offset.
 */
export async function readAuthorisation(
  chain: ChainReader,
  tabBook: string,
  agent: string,
  serviceId: string,
  asset: string,
  blockNumber: number,
): Promise<Result<AuthorisationRecord>> {
  const data = `${AUTHORISATION_OF_SELECTOR}${addressArg(agent)}${bytes32Arg(serviceId)}${addressArg(asset)}`;
  const returned = await chain.call(tabBook, data, blockNumber);
  if (!returned.ok) return returned;

  const words: string[] = [];
  for (let index = 0; index <= FIELD.exists; index += 1) {
    const word = wordAt(returned.value, index);
    if (word === undefined) return malformed("authorisationOf");
    words.push(word);
  }

  return ok({
    maxCumulative: uintFromWord(words[FIELD.maxCumulative] as string),
    spent: uintFromWord(words[FIELD.spent] as string),
    expiry: uintFromWord(words[FIELD.expiry] as string),
    exists: uintFromWord(words[FIELD.exists] as string) === 1n,
  });
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
      message: "That is not an address. An address is 0x followed by exactly 40 hexadecimal characters.",
      retryable: false,
      details: { field },
    });
  }
  return ok(trimmed.toLowerCase());
}

/** A 32-byte word a reader typed, normalised, or a stated reason it is not one. */
export function parseWord(raw: string, field: string): Result<string> {
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return err({
      category: "VALIDATION",
      code: "WORD_MALFORMED",
      message: "That is not a 32-byte identifier. It is 0x followed by exactly 64 hexadecimal characters.",
      retryable: false,
      details: { field },
    });
  }
  return ok(trimmed.toLowerCase());
}
