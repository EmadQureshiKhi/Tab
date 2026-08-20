/**
 * Replay-key packing: the identity of one ingested Settlement log.
 *
 * A replay key is the tuple `(chainKey, blockHeight, txIndex, logIndex)` packed
 * into a single 32-byte word. Every field is a `uint64`, the four fields fill
 * the word exactly, so the map from tuple to key is injective by construction
 * and no hash is involved.
 *
 * ## Bit layout — this comment is the contract
 *
 * The Solidity side is written against this diagram, and a differential test
 * asserts the two implementations agree over generated tuples. Changing an
 * offset here is a consensus-breaking change on both sides.
 *
 * ```text
 *  byte  0                8               16               24              31
 *        |----------------|----------------|----------------|----------------|
 *  bits  255          192 191          128 127           64 63             0
 *        |   chainKey     |  blockHeight   |    txIndex     |    logIndex    |
 *        |    uint64      |     uint64     |     uint64     |     uint64     |
 *        |  << 192        |  << 128        |  << 64         |  << 0          |
 * ```
 *
 * chainKey occupies the most significant word, logIndex the least. Rendering is
 * big-endian, matching `bytes32` on chain: the leading 16 hexadecimal digits of
 * the key are chainKey, the trailing 16 are logIndex.
 *
 * ## Input type
 *
 * Every field is taken as a `bigint`, never a `number`. A `uint64` exceeds
 * `Number.MAX_SAFE_INTEGER`, so accepting `number` would let a silently rounded
 * block height produce a valid-looking key. A caller holding a small numeric
 * chainKey converts explicitly: `replayKey(BigInt(chainKey), ...)`.
 *
 * Requirements: 4.1
 */

import { UINT64_MAX, fromBytes32, toBytes32, type Bytes32 } from "./hex.js";

/** Bit offset of each field within the packed word. */
export const CHAIN_KEY_OFFSET = 192n;
export const BLOCK_HEIGHT_OFFSET = 128n;
export const TX_INDEX_OFFSET = 64n;
export const LOG_INDEX_OFFSET = 0n;

/** All 64 low bits set. Numerically `2^64 - 1`, used here as an extraction mask. */
const UINT64_MASK = UINT64_MAX;

/** The four fields a replay key carries, unpacked. */
export interface ReplayKeyFields {
  readonly chainKey: bigint;
  readonly blockHeight: bigint;
  readonly txIndex: bigint;
  readonly logIndex: bigint;
}

/**
 * @throws RangeError naming the field and the offending value.
 */
function assertUint64(field: keyof ReplayKeyFields, value: bigint): void {
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError(
      `replayKey: ${field} must be a uint64 in [0, 2^64 - 1], received ${value}`,
    );
  }
}

/**
 * Packs the four `uint64` fields into one 32-byte word.
 *
 * @throws RangeError when any field falls outside `[0, 2^64 - 1]`.
 */
export function replayKey(
  chainKey: bigint,
  blockHeight: bigint,
  txIndex: bigint,
  logIndex: bigint,
): Bytes32 {
  assertUint64("chainKey", chainKey);
  assertUint64("blockHeight", blockHeight);
  assertUint64("txIndex", txIndex);
  assertUint64("logIndex", logIndex);

  return toBytes32(
    (chainKey << CHAIN_KEY_OFFSET) |
      (blockHeight << BLOCK_HEIGHT_OFFSET) |
      (txIndex << TX_INDEX_OFFSET) |
      (logIndex << LOG_INDEX_OFFSET),
  );
}

/**
 * The inverse of {@link replayKey}.
 *
 * @throws TypeError when `key` is not a 32-byte word.
 */
export function unpackReplayKey(key: string): ReplayKeyFields {
  const word = fromBytes32(key);
  return {
    chainKey: (word >> CHAIN_KEY_OFFSET) & UINT64_MASK,
    blockHeight: (word >> BLOCK_HEIGHT_OFFSET) & UINT64_MASK,
    txIndex: (word >> TX_INDEX_OFFSET) & UINT64_MASK,
    logIndex: (word >> LOG_INDEX_OFFSET) & UINT64_MASK,
  };
}

/** Convenience form of {@link replayKey} taking the fields as an object. */
export const packReplayKey = (fields: ReplayKeyFields): Bytes32 =>
  replayKey(fields.chainKey, fields.blockHeight, fields.txIndex, fields.logIndex);
