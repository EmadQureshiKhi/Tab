# Spike 1.2 — ChainInfo Precompile: verified ABI and attestation liveness

Probed against `https://rpc.cc3-testnet.creditcoin.network` (Creditcoin chainId `102031`, latest
block `5400321`, finalized `5400319`) starting **2026-08-30T12:37:18Z**, second sample
**2026-08-30T12:40:00Z**. Precompile address
`0x0000000000000000000000000000000000000fd3`, confirmed as the value of
`chainInfo.CHAIN_INFO_PRECOMPILE_ADDRESS` exported by `@gluwa/usc-sdk@0.18.0`.

Read-only throughout. No transaction was sent and no key was used.
Raw machine output: [`chaininfo-transcript.json`](./chaininfo-transcript.json).
Probe script: [`chaininfo-probe.ts`](./chaininfo-probe.ts).

---

## 1. The headline answer

**Is chainKey 3 (Ethereum Mainnet) present and actively attesting? Yes.**

- `get_supported_chains()` reports chainKey `3` with native `chainId 1` and name bytes
  `0x457468657265756d` = `"Ethereum"`.
- Latest attestation: height **25868090**, digest
  `0x6c98dd10d6d8b1d666176913eff6bb0085d3a4afd75a60e63f005b0fb6537f47`, `isAttestation: true`,
  `exists: true`.
- Mainnet head from `https://ethereum-rpc.publicnode.com` (which self-reported `chainId 1`):
  **25868130**. **Gap: 40 blocks**, roughly 8 minutes of mainnet time.
- Not stale: across two reads 158 s apart the attested tip moved `25868090 → 25868100`. An earlier
  run of the same script 3 minutes prior saw `25868070 → 25868090` (that run's transcript was
  overwritten by the retained one).
- The Proof Builder agrees exactly. `GET /api/v1/attested-height/3` returned HTTP 200 with
  `{"attestedHeight":25868090}`, identical to the precompile.

**Is chainKey 1 (Sepolia) present and attesting? Yes.**

- chainKey `1`, native `chainId 11155111`, name bytes `0x5365706f6c696120657468657265756d` =
  `"Sepolia ethereum"`.
- Latest attestation: height **11598820**, digest
  `0xcaf085cd462b8d5d85e34f8dcb10f18d25952b95134fd177c6abffd9b3c0466e`, `exists: true`.
- Sepolia head from `https://ethereum-sepolia-rpc.publicnode.com`: **11598863**. **Gap: 43 blocks**,
  roughly 8.6 minutes.
- Attested tip moved `11598820 → 11598830` over the same 158 s window.
- `GET /api/v1/attested-height/1` returned `{"attestedHeight":11598820}`, again identical.

Only these two chains are reported. `get_supported_chains()` returned exactly 2 entries, so there is
no BNB, Polygon, or other Source Chain available on this network. Both chains use
`chainEncoding: 1`.

### Consequence for the degraded-mode rule (design 8.1)

Mainnet attestation is live, so Sepolia-only degraded mode is **not** the current operating
condition. The rule still holds and still needs implementing — a chain absent from
`get_supported_chains()` cannot be monitored — but as of this probe the Watcher will discover and
monitor both chainKey 1 and chainKey 3.

---

## 2. Observed attestation cadence and stride

Every attested height seen in either run was a multiple of 10: `11598800, 11598810, 11598820,
11598830` and `25868060, 25868070, 25868080, 25868090, 25868100`. Checkpoints sit on a coarser
grid — `get_latest_checkpoint_height_and_hash` returned `11598700` and `25867900`, both multiples of
100, both with `isAttestation: false`.

The tip advanced 10 heights per ~155 s sample on both chains (mainnet showed 20 in one sample).
Both Ethereum networks produce blocks every ~12 s, so **an attestation lands roughly every 2
minutes and covers 10 source-chain blocks**, keeping pace with the source chain rather than falling
behind. The steady-state distance from head is 35–43 blocks on both chains, i.e. **7 to 8.6 minutes**.

Design section 8.3 documents an expected Mainnet wait of roughly 13 to 15 minutes. The observed
head-to-attested lag is about half that. The design figure is therefore conservative rather than
wrong, and no requirement needs changing — but the Watcher's attestation-wait timeouts should not be
tuned tighter than the documented figure on the strength of one probe.

`get_attestation_genesis_height` returned **0** for both chains. The SDK documents 0 as "unsupported
or no configured genesis height"; since both chains are supported, this is the second case. Code
must not treat 0 as "chain unsupported".

---

## 3. Verified ABI

The precompile's real ABI is shipped inside the SDK at
`@gluwa/usc-sdk/src/chain-info/chain_info.json` and every method below was independently confirmed
by raw `eth_call` against `0x...0fd3`. **All method names are `snake_case` and every non-trivial
return is a struct, not a bare scalar.**

| Method | Selector | Returns |
| --- | --- | --- |
| `get_supported_chains()` | `0x69e18c3c` | `ChainInfo[]` — `(uint64 chainKey, uint64 chainId, bytes chainName, uint8 chainEncoding)[]` |
| `get_chain_by_key(uint64)` | — | `ChainInfoResult` — `(ChainInfo info, bool exists)` |
| `get_latest_attestation_height_and_hash(uint64)` | `0x809112da` | `HeightHashResult` — `(uint64 height, bytes32 hash, bool isAttestation, bool exists)` |
| `get_latest_checkpoint_height_and_hash(uint64)` | `0xd773a786` | `HeightHashResult` |
| `get_attestation_bounds(uint64,uint64)` | — | `BoundsCheckResult` — `(uint64 parentHeight, bytes32 parentHash, bool parentIsAttestation, uint64 childHeight, bytes32 childHash, bool childIsAttestation, bool isAttested)` |
| `get_attestation_genesis_height(uint64)` | — | `uint64 genesisHeight` |
| `get_attestation_height_for_digest(uint64,bytes32)` | — | `HeightResult` — `(uint64 height, bool exists)` |
| `get_checkpoint_for_height(uint64,uint64)` | — | `HashResult` — `(bytes32 hash, bool exists)` |
| `is_height_attested(uint64,uint64)` | `0x9c68eccf` | `bool isAttested` |
| `find_highest_attested_before(uint64,uint64)` | `0x981266c7` | `HeightHashResult` |
| `find_lowest_attested_after(uint64,uint64)` | `0x38bd95a7` | `HeightHashResult` |

Struct field ordering above is the wire ordering and was confirmed by decoding raw return data, not
taken from the SDK's TypeScript wrappers.

`chainName` is `bytes`, not `string`, and it is **not** zero-padded and **not** broken. The SDK
carries a stale `TODO` claiming name decoding yields all zeros; both names decoded cleanly as UTF-8
(`"Ethereum"`, 8 bytes; `"Sepolia ethereum"`, 16 bytes). Treat `chainName` as variable-length UTF-8
bytes.

---

## 4. Design assumptions that turned out to be wrong

Section 3.1 of the design declares `IChainInfo` with three functions. **All three do not exist.**
Each was called directly against the precompile and each reverted with the revert string
`"Unknown selector"`:

| Assumed in design 3.1 | Selector probed | Result | Real equivalent |
| --- | --- | --- | --- |
| `supportedChains() returns (uint64[])` | `0x816949b5` | reverted, `"Unknown selector"` | `get_supported_chains()` returning a struct array, not a `uint64[]` |
| `latestAttestedHeight(uint64) returns (uint64)` | `0xcd7c4760` | reverted, `"Unknown selector"` | `get_latest_attestation_height_and_hash(uint64)` returning a 4-field struct |
| `attestedBlockDigest(uint64,uint64) returns (bytes32)` | `0xd2f4ed07` | reverted, `"Unknown selector"` | **no direct equivalent** — see below |

Three further corrections follow from this.

**a. There is no "digest at an arbitrary height" method.** Design 8.11 (reorg digest comparison)
depends on `attestedBlockDigest(chainKey, height)`, which does not exist. Two real paths were
verified as replacements:

- `get_attestation_bounds(chainKey, height)` returns the surrounding attestation endpoints. At an
  attested height it returns `childHeight == height` with `childHash` equal to that height's
  attested digest and `isAttested: true`.
- `get_attestation_height_for_digest(chainKey, digest)` round-trips correctly: passing the mainnet
  tip digest returned `{ height: 25868090, exists: true }`. For reorg detection this is the better
  primitive — feed in the *observed* digest and a reorg shows up as `exists: false`, with no need to
  guess which height to query.

`get_checkpoint_for_height(chainKey, attestedTipHeight)` returned
`{ hash: 0x00…00, exists: false }` on both chains. Attestations and checkpoints are **separate
registries**; an attested height is not automatically a checkpoint. Do not use
`get_checkpoint_for_height` to fetch an attested digest.

**b. Attested heights are sparse, so `isAttested` is not "this block is attested".** With a stride
of 10, most source-chain heights are never themselves an attestation endpoint. A Settlement at an
arbitrary height therefore sits *between* two attestation endpoints, which is precisely why the
Continuity Proof exists. Any code that asks "is the block containing this log attested?" must ask it
as "is this height covered by the attested frontier", not "is this height an attestation".

The exact semantics of `is_height_attested` are **not yet pinned down** and should be settled before
`IChainInfo.sol` is finalised. Evidence is mixed: on mainnet, `is_height_attested(3, tip+1)` returned
`false`, consistent with "height ≤ attested frontier". On Sepolia, `is_height_attested(1, tip+1)`
returned `true` while the frontier read said `tip`. The likely explanation is a block-tag difference
rather than differing semantics (see point c) — the frontier had already advanced at `latest` while
the SDK read reported `finalized`. Reading it as "covered by the attested frontier" is the
interpretation the evidence supports, but it is an inference, not a confirmed fact.

**c. Every SDK read pins `blockTag: 'finalized'`.** `PrecompileChainInfoProvider` passes
`{ blockTag: 'finalized' }` on all calls; the raw probes in this spike used the default `latest`.
At probe time the Creditcoin `latest` block was 2 ahead of `finalized`. Mixing the two produces two
different attested frontiers within one process, which is very likely what produced the
Sepolia/mainnet discrepancy above. The Watcher must pick one block tag and use it consistently, and
`IChainInfo` consumers on-chain implicitly read at the current block.

---

## 5. What this means for task 4.1 (`IChainInfo.sol`)

- Declare the `snake_case` names and the structs above. The interface in design 3.1 will revert on
  every call as written.
- Solidity permits these names, so the interface can mirror the precompile exactly; no aliasing is
  needed.
- Drop `attestedBlockDigest`. Model the reorg check in design 8.11 on
  `get_attestation_height_for_digest`, with `get_attestation_bounds` as the fallback when a height
  rather than a digest is the starting point.
- `chainName` is `bytes`.
- `chainEncoding` is `uint8`, not `uint64`.
- Struct field order is load-bearing for ABI decoding and must match the table in section 3 exactly.

## 6. Not covered by this spike

- The `NativeQueryVerifier` precompile at `0x...0fd2` was not probed. `verifyAndEmit` and
  `calculateTxIndex` in design 3.1 remain unverified assumptions.
- Attestation cadence is inferred from two samples about 155 s apart on one day. It establishes
  liveness and stride, not a guaranteed service level.
