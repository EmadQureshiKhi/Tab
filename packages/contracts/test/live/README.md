# Live negative-path harness

Runs the negative-path suite of design section 15.4 against the **deployed** contracts on Creditcoin
CC3 Testnet, with real proof material from the Proof Builder, and records every outcome to
[`results.json`](./results.json) with the Creditcoin transaction hash and the observed revert data.

Requirement 27.3 asks for a negative-path suite executed against the live BlockProver Precompile. This
directory is that suite. Task 13.1 built the machinery and registered two cases to establish it works
end to end; task 13.2 registers the remaining eight, which cover the remaining seven requirement
cases plus the second live shape of 27.12.

---

## How it is gated

It touches a live chain and, in one mode, spends real testnet CTC. Three separate things keep it out
of anybody's default run.

**1. It is not a Foundry test.** Nothing here is Solidity, so `forge test` neither compiles nor runs
it. The default suite still spends nothing, and `forge test` output is unchanged by this directory's
existence.

**2. There is no default mode.** Invoked bare, the driver prints its command surface and exits
non-zero. A mode has to be typed. That is deliberate: a suite that spends money whenever somebody
runs the tests is a suite nobody can run, and a suite that silently does nothing is worse, because it
passes.

**3. Only `--broadcast` spends anything.** `--preflight` holds no key, sends no transaction, and needs
no funded account. It puts the identical calldata to the identical deployment over `eth_call` and
records the same revert data, for nothing.

No package script and no workflow invokes either mode. Adding one should be a decision somebody makes
on purpose.

## Running it

From the repository root, after `forge build` in `packages/contracts`:

```
pnpm tsx packages/contracts/test/live/run.mts --list         # registered cases, then stop
pnpm tsx packages/contracts/test/live/run.mts --preflight    # keyless. Costs nothing
pnpm tsx packages/contracts/test/live/run.mts --broadcast    # real transactions, real testnet CTC
pnpm tsx packages/contracts/test/live/run.mts --preflight --case forged-merkle-root

# A case built on a Settlement somebody had to create first, pointed at it by hash:
pnpm tsx packages/contracts/test/live/run.mts --preflight --case two-recognised-logs \
  --tx two-recognised-logs=0xec55fa40...58dff7a
# ...or from a file mapping hand-off keys to transactions:
pnpm tsx packages/contracts/test/live/run.mts --preflight --handoff ../path/to/settlements.json
```

The signing key for `--broadcast` is read from `WATCHER_PRIVATE_KEY`, which names the *slot* rather
than the account. The task 13.2 runs passed the deployer's key in that variable so the Watcher's own
nonce sequence was never touched, and the submitting address is recorded on every run, so the record
says which account actually signed.

Exit code 0 means every case that ran was refused the way its expectation says. Anything else is 1.

`forge build` is a prerequisite because both the error dictionary and the calldata encoding are taken
from the compiled artefacts in `out/`, never from signatures written out by hand here. A signature
copied into a test file drifts silently; an ABI read from the artefact cannot.

Every address, endpoint, and key is read from the environment. Nothing is written down in these files.
Before anything is submitted the environment is checked against the tracked `deployments.json`, and a
disagreement stops the run — a live result aimed at the wrong contract reads as evidence, which makes
it worse than no result. The variables are `CREDITCOIN_RPC_URL`, `CREDITCOIN_CHAIN_ID`,
`CREDITCOIN_EXPLORER_URL`, `SETTLEMENT_VERIFIER_ADDRESS`, `BLOCKPROVER_PRECOMPILE`,
`PROOF_BUILDER_URL`, `MAINNET_USDC_ADDRESS`, `ETHEREUM_MAINNET_RPC_URLS`, `RPC_BATCH_MAX_COUNT`, and
— for `--broadcast` alone — `WATCHER_PRIVATE_KEY`. All ten are already declared in `.env.example`; the
harness introduces none of its own.

## What is recorded

`results.json` keys records by case identifier and merges on write, so running one case leaves the
other records untouched. That matters because the nine cases cannot all run in one sitting: one waits
on Ethereum attestation, roughly a quarter of an hour, and another needs a Source Chain transaction
created first. `lastRun` describes the most recent run only.

Each case record carries:

| Field | What it holds |
| --- | --- |
| `target` | the genuine, already-attested Source Chain Settlement the case was built from |
| `mutation` | the one field the case changed, as genuine and submitted values |
| `keylessControls` | the unmutated material and the submitted material, each put to the precompile over `eth_call` |
| `submitted` | the full `SourceTx` that went on the wire, replayable by hand |
| `submission` | recipient, selector, calldata length, calldata digest, stated gas limit |
| `keylessPreflight` | raw revert bytes and the decoded error, from `eth_call` before anything was spent |
| `onChain` | Creditcoin transaction hash, block, receipt status, gas used against the limit, fee, explorer link, and the raw revert bytes read back from the block the transaction landed in |
| `verdict` | refused as expected, refused differently, accepted, or exhausted gas |

**The revert data is bytes first.** `raw` is the returndata exactly as the node produced it; `decoded`
is what those bytes are — selector, name, full signature, every argument. The bytes are the evidence
and the decoding is a convenience, so anybody holding the file can decode them again against the ABI
in `out/` and check the harness rather than trust it. The dictionary spans the collaborators as well
as the entrypoint, because a submission can revert inside `TabBook`, `AgentRegistry`, `Bond`, or
`ServiceRegistry`, and those errors are not in `SettlementVerifier`'s own ABI.

**Every mutated case carries a keyless control.** The unmutated material is put to the precompile
first. A control that verifies is what tells "the deployment refused the forgery" apart from "our
proof material was malformed all along", and without it a rejection proves nothing.

## Adding a case

Append one entry to `CASES` at the bottom of `cases.mts`. A case is an identity, the requirements it
answers, the refusals it would accept, and a `prepare` function returning the `SourceTx` it wants to
submit. Everything else — connecting, submitting, capturing, recording, the verdict — is already
done, and does not change when a case is added.

---

## Measured on this network, and load-bearing for task 13.2

Everything below was observed against the live chain rather than reasoned about.

**A forged root and a tampered payload are refused by the precompile, not by the contract.** Both
cases revert `Error(string)` with the message `Merkle proof validation failed`, raw returndata
`0x08c379a0…`, from inside `verifyAndEmit`. They do **not** reach `ProofRejected`, which is the error
`TabAscBase` raises when the precompile *returns* `false` — on this network it reverts instead of
returning, so the `false` branch is not reachable through bad proof material. Design section 15.4
predicts `ProofRejected` for these two cases; the accurate statement is that the submission is refused
and the refusal comes one layer lower. Both shapes are listed in each case's `expectedRefusals` and the
raw bytes are recorded either way, so the record is honest about which one happened. Task 13.2 should
expect the same for the wrong-chainKey case, where section 15.4 already allows either shape.

**Transactions are broadcast with ethers v6, not with `forge script`.** This RPC returns blocks with
no `mixHash`, and Foundry's provider treats the field as required, so `forge script --broadcast`
cannot reliably sequence more than one transaction here: it sends the first and then dies retrying the
block read. `cast send` and ethers are both unaffected. The harness uses ethers, with providers
constructed `{batchMaxCount: 1, staticNetwork: true}` because several endpoints in play reject
JSON-RPC batching outright.

**Gas limits are stated, never estimated.** Estimation on this network comes from a warm simulation
and understates a cold-storage write, so a submission sized from an estimate can run out of gas and
look exactly like a revert. Every submission carries an explicit 3,000,000 limit and every receipt is
checked for `gasUsed == gasLimit`, which is recorded as `outOfGas` rather than being left for the
reader to infer. Measured: a refused submission of this shape uses about 190,000 gas, well clear of
the limit, and a refusal unwinds and refunds the remainder, so an ample limit costs nothing.

**`sent.wait()` cannot be used here.** ethers v6 throws on a receipt with status 0, which for a
negative-path case is the outcome under test. The harness waits on the provider instead, which returns
the receipt for a reverted transaction the same as for a successful one.

**A receipt never carries returndata.** The bytes come from replaying the identical `eth_call` pinned
to the block the transaction landed in, which this public endpoint serves. Pinning is what makes the
recorded bytes belong to the state the transaction actually met rather than to the head of the chain.

**No Ethereum transaction is sent, ever.** Targets are historical Ethereum Mainnet transactions that
already exist, selected a fixed margin below the attested frontier. The harness spends no Ethereum
gas and creates no Source Chain state.

---

## Results, as measured

Ten case identities cover the nine requirement cases, because 27.12 has two live shapes: the skip,
reachable from Mainnet history today, and the ingestion, which needs a Sepolia Settlement carrying an
anonymous log.

| Case | R | Outcome | Refusal observed | Creditcoin transaction |
| --- | --- | --- | --- | --- |
| `forged-merkle-root` | 27.4 | refused as expected | `Error(string)` `Merkle proof validation failed` | `0xe452970f…c1ac64` |
| `tampered-encoded-transaction` | 27.5 | refused as expected | `Error(string)` `Merkle proof validation failed` | `0x68617e35…74c3ca` |
| `wrong-chain-key` | 27.6 | refused as expected | `Error(string)` `Continuity proof does not match attestation or checkpoint` | `0xdf44cc96…9d0ebc` |
| `reverted-source-transaction` | 27.8 | refused as expected | `SourceTransactionReverted(3, 25916730, 130)` | `0x788aa125…d96b54` |
| `unregistered-recipient` | 27.9 | refused as expected | `UnknownCollectionAddress(3, 0x0668c9bf…f2f9b, USDC)` | `0x1142cc74…afe653` |
| `zero-topic-log-skipped` | 27.12 skip | refused as expected | `UnknownCollectionAddress` from the *Transfer* handler | `0x343932c0…79938b` |
| `replayed-settlement` | 27.7 | refused as expected | `AlreadyClaimed(chainKey 1, height 11645848, index 75, log 0)` | `0xce103794…d313cd` |
| `two-recognised-logs` | 27.11 | accepted as expected | two logs ingested, two distinct keys, all assertions hold | `0xb8f26a24…d96874` |
| `payer-from-topic` | 27.10 | accepted as expected | credited the `topics[1]` agent, the `from` agent unchanged | `0x1eb4298d…f95bb` |
| `zero-topic-log-ingested` | 27.12 ingest | accepted as expected | anonymous log skipped, the log after it ingested | `0x9ec33223…24ba11` |

**All ten case identities have now run and every one met its expectation.** The seven refusal cases
were refused in a shape their `expectedRefusals` allows, and the three acceptance cases were accepted
with every assertion holding.

**Spend: 0.001098699 CTC across five transactions**, from the deployer account, against a stated
3,000,000 gas limit each. Measured gas used was 186,900, 375,522, 540,330, 560,490, and 534,156 - no
receipt showed `gasUsed == gasLimit`, so none was an exhausted limit wearing a revert's clothes. Task
13.1's two earlier transactions cost a further 0.00019 CTC.

**The three acceptance cases cost a further 0.001604722 CTC across three transactions**, again from
the deployer, using 1,070,916, 1,086,932, and 1,051,596 gas of the same stated limit. None was
exhausted. **The whole suite is therefore 0.002893421 CTC across ten Creditcoin transactions.** On
Ethereum Sepolia the three acceptance cases cost about 0.000456 ETH in gas and moved 0.281001 USDC,
out of 1.0 USDC staged into the helper contract described below.

### The three acceptance cases, and the helper they needed

The seven refusal cases are built from historical Ethereum Mainnet transactions that already exist.
The three acceptance cases could not be, because each needs a Settlement shape an externally owned
account cannot produce and this deployment must actually credit. They are served by
[`SourceRelay.sol`](./SourceRelay.sol), deployed once to Ethereum Sepolia at
`0x623B7059c9E67C690594085D280d50449Eb7D1d9` and bound in the `AgentRegistry` to the deployer's
Creditcoin account.

**Every shape it produces is a plain ERC-20 `Transfer`, and that is the point rather than a
convenience.** On chainKey 1 a `TabSettlement.settle` call emits the `Transfer` that funded it *and*
its own `TabSettled`, and the deployed registry authorises both the Asset and the settlement contract
as emitters, so one payment presents two creditable logs. A `settleBatch` of two instructions would
therefore present four for two payments. That is the emitter-registration defect recorded as task
10.12, and a `two-recognised-logs` case built on it would have recorded a defect as a pass. Moving
the Asset directly produces exactly one recognised log per Settlement, so the counts these cases
assert mean what requirement 4.3 says they mean.

**`payer-from-topic` is the strongest form the claim has, because both addresses are bound to
different agents.** The relay holds the USDC, so `topics[1]` is the relay, bound to
`0xE5eaB26C…2b37`. The Agent's own Ethereum account sends the transaction, so `from` is
`0xa302940d…d728`, bound to a *different* agent, `0x1F6f797E…0542`. The deployment credited the agent
bound to `topics[1]`, and the agent bound to `from` finished the run with the history count it
started with, 1 before and 1 after. Had the verifier resolved the payer from the transaction sender,
as the canonical Attestcoin base pattern does, the wrong agent would have been credited and the
assertion would say so.

**`zero-topic-log-ingested` proves the continuation through the ordinal itself.** The relay emits a
`log0` with no topics and then transfers, so the anonymous log takes receipt ordinal 0 and the
`Transfer` takes ordinal 1. The replay key the deployment recorded ends
`…0000000000000001`, which is the sweep having stepped over the topicless log and credited the one
after it. The ordinal is the evidence; no separate assertion has to be believed.

`replayed-settlement` was run against the rail's first accepted Verified Settlement, Creditcoin
transaction `0x81aad88d…15de32`, which proved Sepolia source transaction `0x8f84eb8a…21ebe6` at block
11,645,848, index 75, log 3195. Resubmitting that transaction with freshly built proof material is
refused `AlreadyClaimed` carrying the packed key
`0x00000000000000010000000000b1b398000000000000004b0000000000000000`, whose fields decode to exactly
that coordinate. The proof verifies a second time and the replay guard still holds, which is the
distinction requirement 4.2 draws.

### Three things these runs established

**The wrong-chainKey case is refused by the precompile, not by the contract.** Design section 15.4
allows either shape and the case accepts both. What actually answers is
`Error(string) "Continuity proof does not match attestation or checkpoint"`, because the Sepolia
attestation registry holds no digest a Mainnet Continuity Proof can chain to, so the submission never
reaches `SettlementVerifier._isRecognised` and never raises `UnauthorizedSourceChain`. The contract's
own chainKey defence is therefore **unexercised by this case on this network**, and that is recorded
rather than papered over: it is reachable only by an emitter authorised on one chainKey and proven on
another, which needs a Source Chain where both are attested.

**The refusal depth is visible in the gas.** 186,900 gas for a proof the precompile rejects, against
375,522 once the receipt decodes and the status gate fires, 540,330 once the log sweep reaches a
handler, and 560,490 when a zero-topic log is skipped on the way. The rising figures are the
submission getting further into the pipeline before it is turned away, which is the ordering design
section 15.1 specifies, observed rather than asserted.

**One `settle()` call presents two creditable Settlements, and that is a defect rather than a passing
case.** Pointed at a single Sepolia `TabSettlement.settle`, the harness reads the deployed registry
and finds *both* of its logs recognised with a registered Collection Address: the ERC-20 `Transfer` at
receipt ordinal 0, because Sepolia USDC is an authorised `Asset` emitter on chainKey 1, and the
`TabSettled` at ordinal 1 from the settlement contract. They spend two distinct replay keys, so one
payment of 101,000 base units is credited twice, and a keyless preflight of `submitSettlement` against
the deployed verifier confirms the deployment would accept it.

That is an **emitter-registration defect, recorded as task 10.12**, not evidence for requirement
27.11. The sweep is behaving exactly as requirement 4.3 specifies - every recognised log is ingested
under its own key - and the fault is that one payment presents two recognised shapes on a chain where
Tab deploys a settlement contract. `two-recognised-logs` was therefore **not** built on a `settle()`
call, and it was not built on a `settleBatch` either, because a batch of two instructions presents
four creditable logs for the same reason. It is built instead on two plain `Transfer` logs from
`SourceRelay`, which are two genuinely distinct Settlements and nothing else, and the case records
exactly two creditable logs spending exactly two replay keys. Pointing it at a `settle()` would have
recorded a defect as a pass.

## One constraint worth naming

`foundry.toml` grants `fs_permissions` read access to `./test/fixtures` and write access to nothing.
A Foundry test therefore could not write `results.json`, which is why the results are written from
this Node driver instead. That is the better arrangement anyway — the driver is what holds the key,
the Proof Builder client, and the receipt handling — so no configuration change is being asked for.
Should a future task want a Solidity test in this directory to write here, it would need
`{access = "write", path = "./test/live"}` added to `fs_permissions`, and that is a change to a file
this directory does not own.
