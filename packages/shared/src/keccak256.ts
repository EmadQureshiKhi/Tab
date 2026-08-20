/**
 * Keccak-256, written against native `bigint`.
 *
 * `@tabai/shared` carries zero runtime dependencies, and Keccak-256 is not
 * SHA3-256 — the two differ in their padding byte, so the platform hash
 * primitives cannot stand in for it. The permutation below is therefore
 * implemented here: 24 rounds of Keccak-f[1600] over 25 64-bit lanes, rate 136
 * bytes, capacity 64 bytes, `0x01` domain padding.
 *
 * Correctness is pinned by published digests in `test/keccak256.test.mjs`: the
 * empty-input digest, the `abc` digest, and the ERC-20 `Transfer` and `Approval`
 * event topics any chain explorer shows. The permutation was additionally
 * cross-checked against the platform SHA3-256 — same permutation, same rate,
 * different padding byte — at input lengths spanning the 136-byte block
 * boundary. It is used only to derive a handful of event topic hashes at module
 * load, so the `bigint` lane representation costs nothing that matters.
 */

import type { Bytes32 } from "./hex.js";

const LANE_MASK = (1n << 64n) - 1n;

/** Rate in bytes for a 256-bit digest: 200 - 2 * 32. */
const RATE_BYTES = 136;

/** Lanes of the state absorbed per block: RATE_BYTES / 8. */
const RATE_LANES = RATE_BYTES / 8;

/** Iota round constants. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

/**
 * Rho rotation offsets, in lane-permutation order: `((t + 1)(t + 2) / 2) mod 64`
 * for step `t`, which is the offset of the lane the walk sits on at that step.
 */
const ROTATIONS: readonly number[] = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];

/** Pi lane permutation. */
const LANE_ORDER: readonly number[] = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

const rotl = (lane: bigint, bits: number): bigint => {
  const shift = BigInt(bits);
  return ((lane << shift) | (lane >> (64n - shift))) & LANE_MASK;
};

/** Applies Keccak-f[1600] to `state` in place. */
function permute(state: bigint[]): void {
  const column = new Array<bigint>(5).fill(0n);

  for (let round = 0; round < 24; round += 1) {
    // theta
    for (let x = 0; x < 5; x += 1) {
      column[x] =
        state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x += 1) {
      const parity = column[(x + 4) % 5]! ^ rotl(column[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) state[y + x] = state[y + x]! ^ parity;
    }

    // rho and pi
    let carried = state[1]!;
    for (let step = 0; step < 24; step += 1) {
      const target = LANE_ORDER[step]!;
      const displaced = state[target]!;
      state[target] = rotl(carried, ROTATIONS[step]!);
      carried = displaced;
    }

    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) column[x] = state[y + x]!;
      for (let x = 0; x < 5; x += 1) {
        state[y + x] = state[y + x]! ^ ((column[(x + 1) % 5]! ^ LANE_MASK) & column[(x + 2) % 5]!);
      }
    }

    // iota
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/** Hashes raw bytes and renders the digest as a 32-byte word. */
export function keccak256(data: Uint8Array): Bytes32 {
  const state = new Array<bigint>(25).fill(0n);

  const blocks = Math.ceil((data.length + 1) / RATE_BYTES);
  const padded = new Uint8Array(blocks * RATE_BYTES);
  padded.set(data);
  padded[data.length] = 0x01;
  const finalByte = padded.length - 1;
  padded[finalByte] = padded[finalByte]! | 0x80;

  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_LANES; lane += 1) {
      let word = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) {
        word = (word << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      }
      state[lane] = state[lane]! ^ word;
    }
    permute(state);
  }

  let digest = "";
  for (let lane = 0; lane < 4; lane += 1) {
    const word = state[lane]!;
    for (let byte = 0; byte < 8; byte += 1) {
      digest += ((word >> BigInt(byte * 8)) & 0xffn).toString(16).padStart(2, "0");
    }
  }
  return `0x${digest}`;
}

/**
 * Hashes an ASCII string. Event and function signatures are ASCII by
 * construction, so refusing anything above `0x7f` keeps encoding out of the
 * picture entirely.
 *
 * @throws RangeError when `text` carries a non-ASCII code unit.
 */
export function keccak256Ascii(text: string): Bytes32 {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw new RangeError(
        `keccak256Ascii: expected ASCII only, found code unit ${code} at index ${i}`,
      );
    }
    bytes[i] = code;
  }
  return keccak256(bytes);
}
