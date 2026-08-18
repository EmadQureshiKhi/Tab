# Spike 1.3 — BlockProver Precompile: the Ethereum Mainnet path verifies end to end

Probed against `https://rpc.cc3-testnet.creditcoin.network` (Creditcoin chainId `102031`) on
**2026-08-30**, submitting one deployment and one proof to CC3 Testnet. Precompiles
`0x0000000000000000000000000000000000000FD2` (BlockProver) and
`0x0000000000000000000000000000000000000fd3` (ChainInfo). Proof material from
`https://prover.cc3-testnet.creditcoin.network`.

No Ethereum transaction was sent. The proved transfer is a **historical** Ethereum Mainnet USDC
`Transfer` that already existed on chain.

Raw machine output: [`probe-transcript.json`](./probe-transcript.json).
Contract: [`Probe.sol`](./Probe.sol). Driver: [`blockprover-probe.ts`](./blockprover-probe.ts).

---

## 1. The headline answer

**The Ethereum Mainnet path (chainKey 3) verifies end to end. All eight assertions passed.**

| Assertion | Result |
| --- | --- |
| `verifyAndEmit` returned true | yes |
| emitted payer equals the log's `topics[1]` | yes |
| emitted payer differs from the transaction `from` field | yes |
| emitted `txFrom` equals the `from` field read from a mainnet RPC | yes |
| `calculateTxIndex` agrees with the index derived independently from mainnet | yes |
| the emitted `txIndex` agrees with that same index | yes |
| the proof's `headerNumber` equals the chosen height | yes |
| the chosen height sits below the attested frontier | yes |

Consequence for the plan: the demo path is Ethereum Mainnet, chainKey 3. Tasks 12 through 29 stand
as planned. The Sepolia-only degraded mode stays a documented fallback rather than the operating
condition.

## 2. The target, and why it qualifies

- Height **25870230**, block `0x4151a1bf82ae3eb7bfd37987e8f5020c35fb5449660b30d7dc0014fc32a46dbe`
- Transaction `0x73851592942e6283ed87836cee8dc7b0b68a451e91cbc0221c0d78602dd29f28`, index **76**,
  type 2, one USDC `Transfer` among 2 logs
- Transaction `from` — the gas payer: **`0xf70da97812CB96acDF810712Aa562db8dfA3dbEF`**
- Log `topics[1]` — the sender the Asset recorded: **`0x4cD00E387622C35bDDB9b4c962C136462338BC31`**
- Log `topics[2]` — the recipient: `0xf70da97812CB96acDF810712Aa562db8dfA3dbEF`
- Amount: `103290116759` base units, **103,290.116759 USDC**
- Selector called: `0x2d9fb478`, sent to `0x4cD00E387622C35bDDB9b4c962C136462338BC31` rather than to
  the Asset

The two addresses are different, which is the whole point. An EOA called an intermediary contract;
the contract moved its own USDC balance out to that EOA, so the Asset recorded the **contract** in
`topics[1]` while the transaction `from` field names the **EOA that paid the gas**. A design that
resolved the payer from `from` would credit the recipient of the money. The probe contract enforces
the distinction itself: `Probe.probe` reverts with `PayerEqualsTxFrom` if the two match, so it cannot
report success on a target that proves nothing.

Target selection is deliberate and reproducible: the driver walks back from a fixed margin below the
attested frontier and takes the first qualifying `Transfer`, preferring the transaction with the
fewest logs. `eth_getLogs` is never called — its mainnet range limits are severe and unnecessary
here, because `eth_getBlockReceipts` answers the same question in one round-trip.

## 3. Attestation frontier and the chosen height

- `get_latest_attestation_height_and_hash(3)` reported height **25870330** at probe time.
- The chosen height, 25870230, sits **100 blocks below** the frontier, roughly 20 minutes of mainnet
  time.
- `is_height_attested(3, 25870230)` returned **true**, and `get_attestation_bounds(3, 25870230)`
  returned the surrounding endpoints. 25870230 *is* a multiple of 10, so on this occasion the chosen
  height happened to be an attestation endpoint itself; the stride of 10 confirmed in spike 1.2 means
  most heights are not, which is what the Continuity Proof exists for. The Continuity Proof returned
  for this target carried **1 root**, and the surrounding endpoints came back as 25870220 → 25870230
  with `isAttested: true`.
- The Merkle inclusion proof carried **8 siblings** for a block of **134 transactions**. 48 of the
  transactions in that block carried a qualifying USDC `Transfer`, so a target of this shape is not
  rare or cherry-picked — roughly a third of the block would have served.

## 4. Measured figures

| Figure | Value |
| --- | --- |
| Gas consumed by the single `verifyAndEmit` call | **6,745** |
| Total gas for the whole probe transaction | 131,264 |
| Gas for the probe deployment | 1,015,369 |
| Encoded transaction submitted | 2,752 bytes |
| Creditcoin gas price | 0.5 gwei |
| Creditcoin block gas limit at probe time | 75,000,000 |

The `verifyAndEmit` figure is a `gasleft()` delta taken either side of the precompile call inside the
contract, so it excludes the probe's own decoding and event work. **Task 1.4 should take 6,745 as the
per-proof figure** and treat the remaining ~124,000 as caller-side cost that a real
`SettlementVerifier` will incur differently. At that rate the precompile calls themselves are nowhere
near a constraint against a 75,000,000 block gas limit; whatever limits a batch of ten will be the
calldata and the caller's own work, not the precompile. Task 1.4 should confirm that rather than
assume it.

## 5. What the SDK provides for proof building

`@gluwa/usc-sdk@0.18.0` ships a proof-building client, so nothing was hand-rolled against the Proof
Builder API:

- **`proofProvider.service.ProofBuilder(chainKey, builderUrl, timeoutMs)`** — an axios client over
  `GET /api/v1/proof-by-tx/{chainKey}/{txHash}`, `POST /api/v1/proof-batch-by-tx/{chainKey}`, and
  `GET /api/v1/attested-height/{chainKey}`. `getProof` returns
  `{ chainKey, headerNumber, txIndex, txHash, txBytes, continuityProof, merkleProof, cached, generatedAt }`.
- **`ProofBuilder.waitUntilHeightAttested`** polls the *service's* attested-height cache rather than
  the precompile, with a default 15-minute ceiling and a deliberate extra delay to absorb
  load-balancer inconsistency between Proof Builder instances. The Watcher should use this, not just
  the precompile read, because the precompile can be ahead of the service.
- **`proofProvider.mergeProofs`** merges per-height Continuity Proofs into one shared proof for a
  batch, and throws if the inputs are not contiguous. Task 1.4 needs it.
- **`blockProver.PrecompileBlockProver`** wraps the precompile with `verifySingle`,
  `verifyAndEmitSingle`, `computeTransactionIndex`, and the batch variants. The probe calls the
  precompile through its own contract instead, because the point was to prove a *contract* can do it.

## 6. Notes that product code should carry forward

**`verify` is a genuine keyless preflight.** The precompile's `view` `verify` overload returned true
for this proof material over a plain `eth_call`, with no key and no gas, and `calculateTxIndex`
likewise returned 76. Both are worth running before spending a transaction, and both are what the
keyless reproduction path can lean on.

**`EvmV1Decoder` needs no deployment or linking if only its `internal` helpers are called.**
`Probe.sol` reads the transaction type from the first 32-byte word of the encoding itself and then
calls `_decodeCommonTxChunk` and `_decodeReceiptChunk`, which inline. Calling the library's `public`
`getTransactionType` or `decodeReceiptFields` instead would force the library to be deployed and
linked. The compiled probe has zero link references.

**The receipt's log array is per-transaction.** `logIndexInTx` is the index within the proved
transaction's own logs, not the block-wide `logIndex`. For this target those were 0 and 466. Product
code that conflates them will read the wrong log.

**Passing the proof as separate parameters does not compile.** Eight parameters including a Merkle
path of structs and a Continuity Proof exhausts the legacy code generator's addressable stack. The
probe passes one calldata struct and sets `via_ir = true` in its own throwaway
[`foundry.toml`](./foundry.toml). `SettlementVerifier` will face the same pressure and should plan on
a struct argument rather than on `via_ir`, since the product project compiles with `via_ir = false`.

**Several mainnet endpoints reject JSON-RPC batching.** Every provider in the driver is constructed
as `new JsonRpcProvider(url, chainId, { batchMaxCount: 1, staticNetwork: true })`. Without that,
drpc answers HTTP 500.

**Client-side encoding trap.** A `FunctionFragment` built from a bare type signature has unnamed
tuple components, and ethers refuses to encode a named object against one. Raw precompile calls must
pass positional arrays. An earlier run of this driver hit exactly that, failing both the `verify` and
the `calculateTxIndex` preflight with `INVALID_ARGUMENT` while the typed contract path succeeded. It
is worth recording because the failure looks like a chain problem and is not: the request never left
the process. The retained transcript is from the corrected run, where both preflights answer.

## 7. Not covered by this spike

- One proof, one height, one chain. Batch behaviour and the block gas limit are task 1.4.
- The Sepolia control did not need to run, because the mainnet path passed. The driver keeps it and
  will run it automatically on any future mainnet failure, so a later regression can still be
  attributed.
- Nothing here exercises `AgentRegistry` binding, so requirement 8.2's `UnboundPayer` path is
  untested. The probe establishes only that `topics[1]` is available and distinguishable from `from`.
