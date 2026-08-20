/**
 * Minimal hexadecimal primitives.
 *
 * `@tabai/shared` carries no runtime dependency, so the few byte-level helpers the
 * replay key and the chain constants need are written here against native
 * `bigint`. Nothing in this file allocates a buffer or touches the network.
 */

/** A `0x`-prefixed hexadecimal string of any length. */
export type Hex = `0x${string}`;

/** A `0x`-prefixed 32-byte word: exactly 64 hexadecimal digits. */
export type Bytes32 = Hex;

/** A `0x`-prefixed 20-byte address: exactly 40 hexadecimal digits. */
export type Address = Hex;

const HEX_SHAPE = /^0x[0-9a-fA-F]*$/;

/** Largest value a `uint64` field can hold: `2^64 - 1`. */
export const UINT64_MAX = 18_446_744_073_709_551_615n;

/** One past the largest `uint64` value: `2^64`. */
export const UINT64_CEILING = 18_446_744_073_709_551_616n;

/** Largest value a 32-byte word can hold: `2^256 - 1`. */
export const UINT256_MAX =
  115_792_089_237_316_195_423_570_985_008_687_907_853_269_984_665_640_564_039_457_584_007_913_129_639_935n;

export const isHex = (value: unknown): value is Hex =>
  typeof value === "string" && HEX_SHAPE.test(value);

export const isBytes32 = (value: unknown): value is Bytes32 => isHex(value) && value.length === 66;

export const isAddress = (value: unknown): value is Address => isHex(value) && value.length === 42;

/**
 * Renders an unsigned integer as a lower-case 32-byte word.
 *
 * @throws RangeError when `value` is negative or exceeds `2^256 - 1`.
 */
export function toBytes32(value: bigint): Bytes32 {
  if (value < 0n || value > UINT256_MAX) {
    throw new RangeError(`toBytes32: value must be in [0, 2^256 - 1], received ${value}`);
  }
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/**
 * Reads a 32-byte word back into an unsigned integer.
 *
 * @throws TypeError when `value` is not exactly 64 hexadecimal digits behind `0x`.
 */
export function fromBytes32(value: string): bigint {
  if (!isBytes32(value)) {
    throw new TypeError(
      `fromBytes32: expected a 0x-prefixed 32-byte word (66 characters), received ${JSON.stringify(value)}`,
    );
  }
  return BigInt(value);
}
