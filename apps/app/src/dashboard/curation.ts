/**
 * What the curation authority actually is, asked of the chain rather than assumed.
 *
 * `ServiceRegistry` takes one address as its authority and never looks at what
 * sits there. It could be a person's account, or a multisig, or nothing at all
 * by the time anyone reads this, and the answer differs by network: Mainnet puts
 * a `CurationMultisig` in the role from the first block, while Testnet's is an
 * account. An answer written into the page would be true on one network and false
 * on the other.
 *
 * So the page asks. A `CurationMultisig` answers `THRESHOLD()` and `owners()`;
 * anything else reverts or returns nothing, and is reported as the plain
 * account it is. Both answers are facts about the address the registry holds,
 * checkable by any reader with an RPC endpoint, which is the standard every
 * other figure on these pages is held to.
 *
 * A read that fails is not an answer and is not dressed as one: the page says
 * the authority's address and that its shape could not be read, which is the
 * same rule the Bond meter and the Credit Limit follow.
 */

import type { ChainReader } from "./chain.js";

/** `CurationMultisig`'s two public reads, as 4-byte selectors. */
const THRESHOLD_SELECTOR = "0x785ffb37";
const OWNERS_SELECTOR = "0xaffe39c1";

/** What the authority turned out to be. */
export type CurationAuthorityKind = "multisig" | "account" | "unreadable";

export interface CurationAuthorityView {
  readonly address: string;
  readonly kind: CurationAuthorityKind;
  /** How many owners must approve, where the authority is a multisig. */
  readonly threshold?: number;
  /** The owner set, where the authority is a multisig. */
  readonly owners?: readonly string[];
  /** Why the shape could not be read, where it could not. */
  readonly unreadable?: string;
}

const isAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

/** One 32-byte word from returndata, as an index. */
const wordAt = (data: string, index: number): string => data.slice(2 + index * 64, 2 + (index + 1) * 64);

/**
 * Decodes `owners()`, an `address[]`: an offset word, a length, then the addresses.
 *
 * Returns nothing rather than a partial list when the data does not describe
 * one, because a page that printed two owners of a three-owner multisig would
 * be worse than one that printed none.
 */
function decodeOwners(data: string): readonly string[] | undefined {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || (data.length - 2) % 64 !== 0) return undefined;
  const words = (data.length - 2) / 64;
  if (words < 2) return undefined;
  const length = Number.parseInt(wordAt(data, 1), 16);
  if (!Number.isInteger(length) || length < 0 || words < 2 + length) return undefined;
  const owners: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const word = wordAt(data, 2 + index);
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) return undefined;
    owners.push(`0x${word.slice(24)}`.toLowerCase());
  }
  return owners;
}

/**
 * Reads the authority at a block, and says what it is.
 *
 * Both reads are made at the same height as everything else on the page, so
 * what is drawn is one view of the chain rather than several.
 */
export async function readCurationAuthority(
  reader: ChainReader,
  address: string,
  blockNumber: number,
): Promise<CurationAuthorityView> {
  if (!isAddress(address)) return { address, kind: "unreadable", unreadable: "the configured address is not a 20-byte address" };

  const threshold = await reader.call(address, THRESHOLD_SELECTOR, blockNumber);
  if (!threshold.ok) {
    // A revert is an answer: this address does not answer a multisig's reads,
    // so it is an ordinary account as far as the registry is concerned.
    return { address, kind: "account" };
  }
  const raw = threshold.value;
  if (raw === "0x" || raw.length < 66) return { address, kind: "account" };
  const value = Number.parseInt(raw.slice(2, 66), 16);
  if (!Number.isInteger(value) || value <= 0 || value > 255) return { address, kind: "account" };

  const owners = await reader.call(address, OWNERS_SELECTOR, blockNumber);
  if (!owners.ok) {
    return { address, kind: "unreadable", unreadable: `it answered a threshold of ${value} and its owner set could not be read` };
  }
  const decoded = decodeOwners(owners.value);
  if (decoded === undefined || decoded.length === 0) {
    return { address, kind: "unreadable", unreadable: `it answered a threshold of ${value} and an owner set this page could not decode` };
  }
  return { address, kind: "multisig", threshold: value, owners: decoded };
}
