// Independent check of task 14.2's central claim: is the attested digest the same
// word as the Source Chain block hash at that height? If it is not, the design's
// digest-first reorg check fires on every healthy Settlement.
import { Interface, JsonRpcProvider } from "ethers";

const CC = new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL, 102031, { batchMaxCount: 1 });
const FD3 = "0x0000000000000000000000000000000000000fd3";
const TAG = "finalized";

const iface = new Interface([
  "function get_latest_attestation_height_and_hash(uint64) view returns (tuple(uint64 height, bytes32 hash, bool isAttestation, bool exists))",
  "function get_attestation_height_for_digest(uint64,bytes32) view returns (tuple(uint64 height, bool exists))",
]);

const call = async (name, args) => {
  const data = await CC.call({ to: FD3, data: iface.encodeFunctionData(name, args), blockTag: TAG });
  return iface.decodeFunctionResult(name, data)[0];
};

const sources = {
  3: (process.env.ETHEREUM_MAINNET_RPC_URLS ?? "").split(",")[0]?.trim(),
  1: (process.env.ETHEREUM_SEPOLIA_RPC_URLS ?? "").split(",")[0]?.trim(),
};

for (const chainKey of [3, 1]) {
  const frontier = await call("get_latest_attestation_height_and_hash", [BigInt(chainKey)]);
  const height = frontier[0];
  const attestedDigest = frontier[1];

  // Does the attested digest resolve in the precompile's own digest space?
  const selfLookup = await call("get_attestation_height_for_digest", [BigInt(chainKey), attestedDigest]);

  const url = sources[chainKey];
  let blockHash = "NO SOURCE ENDPOINT";
  let hashLookup = null;
  if (url) {
    const src = new JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
    try {
      const block = await src.send("eth_getBlockByNumber", [`0x${height.toString(16)}`, false]);
      blockHash = block?.hash ?? "NO BLOCK";
      if (block?.hash) {
        hashLookup = await call("get_attestation_height_for_digest", [BigInt(chainKey), block.hash]);
      }
    } finally {
      src.destroy();
    }
  }

  console.log(`\n=== chainKey ${chainKey} ===`);
  console.log(`  attested height        : ${height}`);
  console.log(`  attested digest        : ${attestedDigest}`);
  console.log(`  source block hash      : ${blockHash}`);
  console.log(`  SAME WORD?             : ${String(attestedDigest).toLowerCase() === String(blockHash).toLowerCase()}`);
  console.log(`  lookup(attestedDigest) : height=${selfLookup[0]} exists=${selfLookup[1]}`);
  if (hashLookup) {
    console.log(`  lookup(blockHash)      : height=${hashLookup[0]} exists=${hashLookup[1]}`);
    console.log(`  VERDICT: ${hashLookup[1] === false ? "design check WOULD FIRE on a healthy Settlement" : "design check is safe"}`);
  }
}
CC.destroy();
