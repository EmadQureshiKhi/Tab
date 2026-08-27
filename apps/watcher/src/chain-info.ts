/**
 * Reader for the ChainInfo Precompile at
 * `0x0000000000000000000000000000000000000fd3`.
 *
 * This is the read that decides which Source Chains the Watcher monitors, so it
 * is written against the ABI confirmed by raw `eth_call` on CC3 Testnet rather
 * than against the shape a hand-written interface would take.
 *
 * ## Three properties of this ABI are load-bearing
 *
 * 1. **Method names are `snake_case`.** `get_supported_chains()` and
 *    `get_latest_attestation_height_and_hash(uint64)` are the real names. The
 *    camelCase spellings an EVM developer would reach for first —
 *    `supportedChains()` and `latestAttestedHeight(uint64)` — were both called
 *    directly against the live precompile and both reverted with
 *    `"Unknown selector"`. A name is a selector here, so aliasing is not
 *    cosmetic: it makes every call fail. {@link ASSUMED_NAMES_THAT_DO_NOT_EXIST}
 *    records the negative result next to the code, so nobody has to rediscover it.
 * 2. **Every non-trivial return is a struct, and field order is wire order.**
 *    Decoding below is positional for exactly that reason. Reordering a field
 *    still compiles and silently mis-decodes.
 * 3. **`chainName` is `bytes`, not `string`**, and `chainEncoding` is `uint8`.
 *    Both feed the selector. The names decode as clean variable-length UTF-8
 *    (`"Ethereum"`, 8 bytes; `"Sepolia ethereum"`, 16 bytes) and are neither
 *    zero-padded nor truncated.
 *
 * ## Two flags that are not the same question
 *
 * `HeightHashResult` carries both `exists` and `isAttestation`. `exists: false`
 * means no record at all. `isAttestation: false` means the record is a
 * *checkpoint* rather than an attestation — checkpoints sit on a coarser grid and
 * live in a separate registry. A frontier that is a checkpoint is not a frontier
 * a proof can be built against, so discovery requires both flags.
 *
 * Every read is taken at one pinned block tag (see `rpc.ts`).
 *
 * Requirements: 20.1, 20.12
 */

import { Interface, type BlockTag, type JsonRpcProvider } from "ethers";

import { causeOf, err, ok, type Result, type TabError } from "@tabai/shared";

/**
 * Names probed against the live precompile that do **not** exist, each having
 * reverted with `"Unknown selector"`, paired with the name that does. Kept beside
 * the working ABI so a future reader finds the correction before repeating the
 * call.
 */
export const ASSUMED_NAMES_THAT_DO_NOT_EXIST: Readonly<Record<string, string>> = {
  "supportedChains()": "get_supported_chains()",
  "latestAttestedHeight(uint64)": "get_latest_attestation_height_and_hash(uint64)",
  "attestedBlockDigest(uint64,uint64)":
    "no equivalent — use get_attestation_height_for_digest(uint64,bytes32) digest-first, or get_attestation_bounds(uint64,uint64) when only a height is known",
};

/**
 * The two methods discovery needs. Component order is wire order and must match
 * `packages/contracts/src/interfaces/IChainInfo.sol` exactly.
 */
export const CHAIN_INFO_ABI = [
  {
    type: "function",
    name: "get_supported_chains",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "chains",
        type: "tuple[]",
        components: [
          { name: "chainKey", type: "uint64" },
          { name: "chainId", type: "uint64" },
          { name: "chainName", type: "bytes" },
          { name: "chainEncoding", type: "uint8" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "get_latest_attestation_height_and_hash",
    stateMutability: "view",
    inputs: [{ name: "chainKey", type: "uint64" }],
    outputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "height", type: "uint64" },
          { name: "hash", type: "bytes32" },
          { name: "isAttestation", type: "bool" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** One entry of `get_supported_chains()`. */
export interface SupportedChain {
  /** Attestation-side identifier, used in every other ChainInfo call. */
  readonly chainKey: bigint;
  /** The chain's own native chain id, distinct from its chainKey. */
  readonly chainId: bigint;
  /** `chainName` decoded as UTF-8, or the raw hex when the bytes are not UTF-8. */
  readonly chainName: string;
  /** `chainName` exactly as returned, so nothing is lost to decoding. */
  readonly chainNameHex: string;
  readonly chainEncoding: number;
}

/** The attested frontier of one chain. */
export interface AttestationFrontier {
  readonly height: bigint;
  readonly digest: string;
  /** False when the record is a checkpoint rather than an attestation. */
  readonly isAttestation: boolean;
  /** False when the chain has no attestation record at all. */
  readonly exists: boolean;
}

/**
 * The precompile surface discovery depends on, narrow enough that a test can
 * supply a stand-in without a network.
 */
export interface ChainInfoReader {
  getSupportedChains(): Promise<Result<readonly SupportedChain[]>>;
  getLatestAttestation(chainKey: bigint): Promise<Result<AttestationFrontier>>;
}

/** A revert naming an unknown selector means the ABI has drifted, not that the node is down. */
function readError(method: string, error: unknown): TabError {
  const cause = causeOf(error);
  const unknownSelector = /unknown selector/i.test(cause.message);
  return {
    category: unknownSelector ? "CHAIN" : "UPSTREAM",
    code: unknownSelector ? "CHAININFO_SELECTOR_UNKNOWN" : "CHAININFO_READ_FAILED",
    message: unknownSelector
      ? `the ChainInfo Precompile does not expose \`${method}\`, so the pinned ABI no longer matches the chain`
      : `the ChainInfo Precompile did not answer \`${method}\``,
    retryable: !unknownSelector,
    cause,
  };
}

function decodeError(method: string, detail: string): TabError {
  return {
    category: "CHAIN",
    code: "CHAININFO_DECODE_FAILED",
    message: `\`${method}\` returned a shape this ABI cannot read: ${detail}`,
    retryable: false,
  };
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return undefined;
}

function asHex(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) ? value : undefined;
}

/**
 * Decodes `bytes` that is expected to be a human-readable name.
 *
 * The round trip is the test: bytes that re-encode to the same hex were valid
 * UTF-8, and anything else is returned as hex rather than as replacement
 * characters, so a name is never silently corrupted into something printable.
 */
function decodeName(hex: string): string {
  const body = hex.slice(2);
  if (body.length === 0) return "";
  const bytes = Buffer.from(body, "hex");
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").toString("hex") === body.toLowerCase() ? text : hex;
}

/**
 * Reads the precompile through `ethers` at a fixed block tag.
 *
 * The calls go through `Interface` and `provider.call` rather than a `Contract`
 * proxy. Two reasons: the block tag rides on the same object as the calldata, so a
 * read at the wrong tag is not expressible here; and decoding stays positional and
 * explicit, which is what wire-order-is-load-bearing demands.
 *
 * @param provider a provider built by `createJsonRpcProvider`, so batching is off
 * @param address the precompile address, from configuration
 * @param blockTag one tag for every read; see `CREDITCOIN_BLOCK_TAG`
 */
export function createPrecompileChainInfoReader(
  provider: JsonRpcProvider,
  address: string,
  blockTag: BlockTag,
): ChainInfoReader {
  const iface = new Interface(CHAIN_INFO_ABI);

  /** One `eth_call` at the pinned tag, decoded to the function's output tuple. */
  const call = async (name: string, args: readonly unknown[]): Promise<Result<readonly unknown[]>> => {
    let returnData: string;
    try {
      returnData = await provider.call({
        to: address,
        data: iface.encodeFunctionData(name, args),
        blockTag,
      });
    } catch (error) {
      return err(readError(name, error));
    }
    try {
      return ok(iface.decodeFunctionResult(name, returnData).toArray());
    } catch (error) {
      return err(decodeError(name, causeOf(error).message));
    }
  };

  return {
    async getSupportedChains(): Promise<Result<readonly SupportedChain[]>> {
      const method = "get_supported_chains";
      const outputs = await call(method, []);
      if (!outputs.ok) return err(outputs.error);

      const raw = outputs.value[0];
      if (!Array.isArray(raw)) return err(decodeError(method, "the result is not an array"));

      const chains: SupportedChain[] = [];
      for (const [position, entry] of raw.entries()) {
        if (!Array.isArray(entry) || entry.length < 4) {
          return err(decodeError(method, `entry ${position} is not a 4-field tuple`));
        }
        const chainKey = asBigInt(entry[0]);
        const chainId = asBigInt(entry[1]);
        const chainNameHex = asHex(entry[2]);
        const chainEncoding = asBigInt(entry[3]);
        if (
          chainKey === undefined ||
          chainId === undefined ||
          chainNameHex === undefined ||
          chainEncoding === undefined
        ) {
          return err(decodeError(method, `entry ${position} carries a field of the wrong type`));
        }
        chains.push({
          chainKey,
          chainId,
          chainName: decodeName(chainNameHex),
          chainNameHex,
          chainEncoding: Number(chainEncoding),
        });
      }
      return ok(chains);
    },

    async getLatestAttestation(chainKey: bigint): Promise<Result<AttestationFrontier>> {
      const method = "get_latest_attestation_height_and_hash";
      const outputs = await call(method, [chainKey]);
      if (!outputs.ok) return err(outputs.error);

      const raw = outputs.value[0];
      if (!Array.isArray(raw) || raw.length < 4) {
        return err(decodeError(method, "the result is not a 4-field tuple"));
      }
      const height = asBigInt(raw[0]);
      const digest = asHex(raw[1]);
      const isAttestation = raw[2];
      const exists = raw[3];
      if (
        height === undefined ||
        digest === undefined ||
        typeof isAttestation !== "boolean" ||
        typeof exists !== "boolean"
      ) {
        return err(decodeError(method, "a field carries the wrong type"));
      }
      return ok({ height, digest, isAttestation, exists });
    },
  };
}
