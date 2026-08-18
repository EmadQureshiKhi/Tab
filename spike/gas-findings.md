# Spike 1.4 — batch gas headroom: ten proofs fit easily, but requirement 9.2 as written does not verify

Probed against `https://rpc.cc3-testnet.creditcoin.network` (Creditcoin chainId `102031`) on
**2026-08-30**, submitting one deployment and four proof submissions to CC3 Testnet. BlockProver
Precompile `0x0000000000000000000000000000000000000FD2`, ChainInfo Precompile
`0x0000000000000000000000000000000000000fd3`, proof material from
`https://prover.cc3-testnet.creditcoin.network`.

No Ethereum transaction was sent. The ten proved transfers are **historical** Ethereum Mainnet USDC
`Transfer`s that already existed on chain, at heights 25870427 through 25870436.

Raw machine output: [`gas-transcript.json`](./gas-transcript.json).
Contract: [`BatchProbe.sol`](./BatchProbe.sol). Driver: [`gas-probe.ts`](./gas-probe.ts).
Builds on spike 1.3: [`blockprover-findings.md`](./blockprover-findings.md).

---

## 1. The headline answers

**Ten proofs fit one Creditcoin transaction with enormous room to spare: 557,718 gas against a
75,000,000 block gas limit, or 0.74% of one block.** Gas headroom is not a constraint on this design
and never gets close to being one.

**But the batch shape requirement 9.2 describes does not verify on this precompile build.** Ten
sequential single-transaction `verifyAndEmit` calls sharing one Continuity Proof revert with
`"Merkle root mismatch"` on the second call. The submission is on chain, mined and reverted, at
[`0x67682095…c57fd1`](https://creditcoin-testnet.blockscout.com/tx/0x67682095d197191160da72a5f7a3e5349bf9b9d9f8023c2004782b16b0c57fd1).

That is a plan-changing result and it is the most important thing in this document.

| Question | Answer |
| --- | --- |
| Do ten proofs fit one Creditcoin transaction? | Yes, twice over — two different shapes both work |
| Gas for the ten-proof transaction | **557,718** sequential / **525,448** array-shaped |
| Share of the block gas limit | **0.74%** / 0.70% |
| Is the ten-proof bound of requirement 9.1 safe? | Yes, by a factor of roughly 130 |
| Does requirement 9.2's shared-proof shape verify? | **No.** `"Merkle root mismatch"` on item 2 |
| Can a batch share one Continuity Proof at all? | Yes, but only through the array-shaped overload |

## 2. Measured figures

Every figure below comes from a real submitted CC3 Testnet transaction.

| Figure | Value | Transaction |
| --- | --- | --- |
| One `verifyAndEmit`, `gasleft()` delta | **6,991** | [`0x6d6ea7cb…24e5d9`](https://creditcoin-testnet.blockscout.com/tx/0x6d6ea7cb5481f9367d14567cccfae19b2bde0845b8412a80a5dd322ce724e5d9) |
| Whole one-proof transaction | 158,662 | same |
| Ten `verifyAndEmit` calls, sum of the ten deltas | **73,643** | [`0x5bfc3f29…0eab97`](https://creditcoin-testnet.blockscout.com/tx/0x5bfc3f29c03ebb14218b4b39eb94786a91ff73a1631ec0250a1cecf2730eab97) |
| Whole ten-proof transaction | **557,718** | same |
| Gas inside `probeSequentialOwnProofs` | 263,620 | same |
| Intrinsic plus calldata charge | 235,004 | same |
| Array-shaped ten-proof transaction | **525,448** | [`0xc556b443…7600fc`](https://creditcoin-testnet.blockscout.com/tx/0xc556b443c3eb88be799426fc59fee043093d837d9fc347e6f15c2d9a197600fc) |
| Array-shaped precompile call, one delta for ten proofs | 66,557 | same |
| Requirement 9.2 as written | reverted, 488,992 gas burned | [`0x67682095…c57fd1`](https://creditcoin-testnet.blockscout.com/tx/0x67682095d197191160da72a5f7a3e5349bf9b9d9f8023c2004782b16b0c57fd1) |
| `BatchProbe` deployment | 1,633,189 | [`0x5828c34f…5b164d`](https://creditcoin-testnet.blockscout.com/tx/0x5828c34f627f8211173d4a5e366d110325e99e8c296b89a99d948b180c5b164d) |
| Block gas limit, read from block 5402304's header | **75,000,000** | — |

Deployed probe: `0x80118aA246d8AD663Db2Fe3bC95720C943d63F59`. Submitter:
`0xb67c73fd513adF5d270d1102F04eb8327F218FE7`.

### Against spike 1.3's control

1.3 measured 6,745 for one `verifyAndEmit`. This probe measured **6,991** on its own control, 246 gas
higher, and the ten per-item deltas ranged 6,982 to 7,794 with a mean of 7,364.

The figure is therefore **not a constant**. It moves with the proof material: 1.3's target carried a
1-root Continuity Proof, while these targets carried 1 to 10 roots each, and the deltas spread about
12% across the batch. The variation does not track root count cleanly on its own — the 1-root item
cost 6,982 and the 10-root item cost 7,794, but the 2-root item cost 7,206 — so sibling count and
encoded size are in it too. **Treat roughly 7,000 ± 800 as the per-proof precompile cost rather than
6,745 as an exact figure.** Every per-item delta, root count, and sibling count is in the transcript
for anyone who wants to fit it properly.

## 3. Ratios, and whether it is linear

| Ratio | Value |
| --- | --- |
| Precompile: ten deltas over the control's one | **10.53** |
| Whole transaction: ten proofs over one proof | **3.52** |
| Marginal gas per additional proof | **44,340** |
| Fixed gas per transaction | 114,322 |

**The precompile side is linear.** Ten calls cost ten charges; the ratio exceeds 10 only because the
control happened to be the batch's cheapest item, and the mean-based ratio is 10.53 for the same
reason. There is no batching discount inside the precompile and none was expected.

**The transaction total is strongly sublinear**, 3.52× rather than 10×, because the 21,000 base
charge, the dispatch, and the contract's fixed work are paid once per transaction rather than once
per proof. This is the whole case for batching: the marginal cost of the tenth proof is 44,340 gas
against 158,662 for a proof submitted alone, so batching cuts the per-Settlement cost by about 72%.

The figure that governs batch size is that marginal 44,340, not either ratio.

## 4. Where the gas actually goes, and it is calldata

For the ten-proof sequential submission:

| Term | Gas | Share |
| --- | --- | --- |
| Intrinsic plus calldata | 235,004 | **42.1%** |
| Caller-side work inside the function | 189,977 | 34.1% |
| `verifyAndEmit` calls, all ten | 73,643 | 13.2% |
| Dispatch and the outer ABI decode | 59,094 | 10.6% |

**The precompile is 13% of the bill. Calldata is 42%.** Spike 1.3's guess that caller cost dominates
was right, and its ratio understated it: the thing to design against is bytes on the wire.

Calldata detail for the ten-proof submission: **28,772 bytes** total, of which 20,529 zero bytes at 4
gas and 8,243 non-zero bytes at 16 gas, giving 214,004 gas for calldata plus the 21,000 base charge.
The ten encoded transactions account for 17,344 of those bytes — smaller than 1.3's 2,752-byte target
would suggest, because the driver ranks candidates by log count and these targets are leaner.

The array-shaped submission carries 26,308 bytes because one shared Continuity Proof replaces ten,
removing 41 roots and nine struct headers: 2,464 fewer bytes, 29,404 less gas. **A Continuity Proof
root costs about 512 gas of calldata each**, being 32 near-random bytes.

## 5. Headroom, and the largest batch that fits

- Ten proofs occupy **0.74%** of a 75,000,000 block. 74,442,282 gas remains.
- **134 batches of ten** fit in one block, i.e. 1,340 Settlements per Creditcoin block.
- Extrapolating from the two measured points, the largest single batch that fits one block is about
  **1,688 proofs**: `floor((75,000,000 − 114,322) / 44,340)`.

That extrapolation is arithmetic on two submissions, not a measurement. A real batch that size would
also have to fit whatever per-transaction gas ceiling the node applies, and its calldata alone would
run to roughly 4.8 MB. **Requirement 9.1's bound of ten is safe by two orders of magnitude, and it is
not a gas bound — it is a proof-availability and failure-blast-radius bound.** Nothing in the gas
data argues for raising it, and nothing argues for lowering it.

## 6. The negative finding, exactly

The precompile locates a height's root inside a Continuity Proof **by treating the proof's first root
as the root of the height being proved**. A proof that spans a batch therefore verifies for the
batch's lowest height and nothing else.

Evidence, all keyless and free, recorded in the transcript under `preflight`:

| Check | Result |
| --- | --- |
| Each of the ten targets against **its own** Continuity Proof | all ten `true` |
| Each of the ten targets against the **shared** Continuity Proof | lowest height `true`, other nine revert |
| The **array-shaped** `verify` over all ten against the shared proof | `true` |

The revert is a plain `Error(string)`:

```
0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000
000000000000000000000000000000000000000000000000000000144d65726b6c652072
6f6f74206d69736d61746368000000000000000000000000
```

which decodes to `"Merkle root mismatch"`. The same revert was then produced by a real submitted
transaction, so the finding is reproducible from a transaction hash rather than from an argument.

**Consequence for requirements 9.1, 9.2, and 9.6.** Read together they specify a batch of 1 to 10
Merkle Proofs with exactly one Continuity Proof, verified by one sequential `verifyAndEmit` call per
Merkle Proof. Those two clauses cannot both hold. A decision is needed, and both options fit the
block gas limit comfortably, so the choice is about failure attribution and calldata rather than
about headroom:

| | Sequential, own proof per item | Array-shaped, one shared proof |
| --- | --- | --- |
| Gas for ten | 557,718 | **525,448**, 5.8% cheaper |
| Calldata | 28,772 bytes | **26,308 bytes** |
| Continuity Proofs in calldata | 10 | **1** |
| `TransactionVerified` events | 10 | 10 |
| Failure attribution | **per Settlement**, by item index | batch-wide only |
| Runs the same code path as a lone submission | **yes** | no |
| Satisfies "exactly one Continuity Proof" | no | **yes** |
| Satisfies "one call per Merkle Proof, sequentially" | **yes** | no |

One asymmetry in those numbers is worth naming: the array shape spends *more* gas inside the contract,
314,875 against 263,620, because the calldata items have to be copied into memory arrays before the
single precompile call can take them. It still wins overall, by 32,270 gas, purely because one shared
Continuity Proof is 2,464 fewer bytes on the wire. Calldata beats memory at this size.

The 5.8% gas difference is not worth a design decision. Per-Settlement failure attribution probably
is: requirement 9.5 reverts the whole batch on any failure, and the Watcher's documented fallback is
individual resubmission, which needs to know *which* Settlement failed. The sequential shape names
the failing item in a custom error; the array shape returns one boolean for ten proofs.

`SettlementVerifier` will also need whichever overload is chosen declared in
`packages/contracts/src/interfaces/INativeQueryVerifier.sol`. That file currently declares the
single-transaction overload only, and its comment stating that batching is N sequential calls sharing
one Continuity Proof is now known to be unachievable.

## 7. Building the shared Continuity Proof

Both SDK routes work and **they agree exactly** — same `lowerEndpointDigest`, same 14 roots in the
same order:

- **`proofProvider.mergeProofs`** over the ten per-height proofs. It folds them and throws when they
  are not contiguous.
- **`ProofBuilder.getBatchProof`**, which requirement 9.6 names as the Watcher's path, in one HTTP
  round trip that also returns every Merkle Proof and every encoded transaction.

Since the two agree, `getBatchProof` is the better choice for product code: one request instead of
ten, and no client-side folding to get wrong.

**A shared Continuity Proof is a dense object, and this constrains batch composition more tightly
than requirement 9.4's 1000-block ceiling suggests.** The roots must cover *every* block from the
lowest target up to the attested endpoint above the highest, because the proof is a digest chain with
no gaps. For these ten targets spanning 9 blocks the shared proof carried 14 roots. Scaled to the
1000-block ceiling that is upwards of 1,000 roots, about 32 KB of calldata and roughly 512,000 gas
before a single proof is verified — affordable against 75,000,000, but it doubles the cost of the
transaction and it grows linearly with the span.

`mergeProofs` also refuses inputs whose windows do not touch: a per-height proof runs from its own
height to the next attested endpoint, so the next target must sit at or below that endpoint plus one.
Batching widely separated heights is therefore not merely expensive, it is undefined. **The Watcher
should group by proximity, not just by the 1000-block bound.** This probe assembles its targets from
a run of consecutive heights for exactly that reason.

## 8. Two smaller notes for product code

**A proof's root count depends on where its height sits in its attestation window, and that is why the
per-proof gas figure moves.** The per-height root counts run 4, 3, 2, 1 across 25870427 to 25870430 and
then 10, 9, 8, 7, 6, 5 across 25870431 to 25870436, which places the endpoints at 25870430 and
25870440 — consistent with the stride of 10 confirmed in spike 1.2. A Settlement landing just above an
endpoint therefore carries ten times the Continuity Proof of one landing on it. Product code should
take the proof the builder returns rather than reason about endpoint positions, and should not treat
any single measured per-proof figure as the cost of the next one.

**The array-shaped overload emits one `TransactionVerified` event per proof**, ten for ten, the same
as the sequential shape. Log-level replay resistance is available under either shape.

## 9. Not covered by this spike

- The 1000-block span of requirement 9.4 is not measured, only extrapolated. The measured batch spans
  9 blocks. A 1000-block batch needs a ~1,000-root Continuity Proof and should be measured before the
  bound is relied on.
- No batch larger than ten was submitted. The 1,688-proof ceiling is arithmetic on two points.
- Nothing here touches tab, credit, or Bond state; requirement 9.5's all-or-nothing behaviour is a
  contract-level property and belongs to the `SettlementVerifier` task.
- `BatchProbe` compiles with `via_ir = true`, as the 1.3 probe does. The product project compiles
  without it, so `SettlementVerifier` should plan on a single nested calldata struct argument rather
  than on the code generator.
