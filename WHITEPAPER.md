<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/readme/hero-light.png">
    <img alt="Tab" src="./assets/readme/hero-light.png" width="820">
  </picture>
</p>

# Tab: Post-Paid Billing and a Proved Credit Facility for Autonomous Agents

**Emad Qureshi**
Version 1.0 · September 2026 · Creditcoin CC3 Testnet, chain id 102031

---

## Abstract

Autonomous software agents cannot open bank accounts, hold cards, or sign contracts, so every commercial interface available to them today is a prepayment.
A prepayment is not billing.
It is a deposit, and it returns a human to the loop of a system built to run without one.

Post-paid billing requires credit; credit requires a repayment record; and a repayment record requires some party to confirm that repayments occurred.
Where the payment and the ledger live on different chains, that party has historically been a facilitator, an oracle, or a bridge: an entity whose signature, not whose evidence, is what the ledger accepts.

The Attestcoin Protocol removes the requirement for that party.
Creditcoin attests to finalized blocks of Source Chains, which allows a Creditcoin smart contract to verify a foreign transaction, its receipt, and its event logs against a Creditcoin attestation, inside the contract, for itself.

This paper describes **Tab**, a system built on that primitive.
A Service meters usage into an Open Tab held on Creditcoin.
The Agent settles that Tab in USDC on Ethereum using keys nobody else holds.
A Creditcoin contract verifies the Ethereum transaction through the BlockProver Precompile, and only then does the Open Tab fall.

The resulting Credit Limit is a pure function of settlement history that the chain itself proved, bounded above by capital the counterparties have staked.
There is no price feed, no rate, and no oracle anywhere in the system.

Tab is deployed and running end to end on Creditcoin CC3 Testnet.
Every address, transaction hash, and figure in this paper is checkable from the public repository with an RPC endpoint and no private key.

---

## Contents

1. [The problem](#1-the-problem)
2. [Background: what the Attestcoin Protocol provides](#2-background-what-the-attestcoin-protocol-provides)
3. [Design goals and the removal test](#3-design-goals-and-the-removal-test)
4. [System architecture](#4-system-architecture)
5. [Protocol mechanics](#5-protocol-mechanics)
6. [The credit model](#6-the-credit-model)
7. [Security analysis](#7-security-analysis)
8. [Empirical results from the live network](#8-empirical-results-from-the-live-network)
9. [Boundaries](#9-boundaries)
10. [Related work](#10-related-work)
11. [Roadmap](#11-roadmap)
12. [Conclusion](#12-conclusion)
13. [Appendix A: deployed addresses](#appendix-a-deployed-addresses)
14. [Appendix B: reproducing every claim](#appendix-b-reproducing-every-claim)

---

## 1. The problem

### 1.1 Agents cannot prepay their way to autonomy

An autonomous agent that must hold a funded wallet before it can call a tool has three problems, and all three are structural rather than incidental.

It must be funded in advance by somebody, which is a human decision made before the agent knows what it will need.
It must hold that balance in the asset each counterparty happens to accept, which is a treasury problem the agent cannot solve on its own.
And it cannot spend more than it holds, which means an agent's capability is bounded by its float rather than by its record.

Human commerce solved this long ago and did not solve it with prepayment.
It solved it with credit: you consume first, a record accrues, and the record is what earns you the right to consume more.
The mechanism that makes credit safe is not a balance check.
It is a repayment history that a third party can verify.

### 1.2 Why cross-chain credit has needed a trusted party

Put the ledger and the payment on the same chain and the problem is easy: the contract that records the debt can see the payment that clears it.

Put them on different chains and something must carry the fact of payment across.
Every mechanism used for this to date terminates in an assertion by a party:

- **A facilitator** signs a claim that funds landed and the ledger accepts the signature.
- **An oracle** reports a value and the ledger accepts the report.
- **A bridge** mints a representation and the ledger accepts the mint.

In each case, the ledger's guarantee is no stronger than that party's honesty and availability.
A credit facility built this way does not extend credit against a proved history.
It extends credit against an operator's word about a history, which is a different and much weaker thing.

This matters more for agents than for people.
An agent has no legal identity, no jurisdiction, and no recourse.
The only thing that can stand behind an agent's creditworthiness is evidence a machine can check.

---

## 2. Background: what the Attestcoin Protocol provides

The Attestcoin Protocol makes the finalized transaction history of Source Chains verifiable **inside a Creditcoin smart contract**.

Creditcoin observes finalized Source Chain blocks and commits to them.
Two native precompiles expose that commitment to contracts.

### 2.1 The BlockProver Precompile

At `0x0000000000000000000000000000000000000FD2`.

```solidity
function verifyAndEmit(
    uint64 chainKey,
    uint64 height,
    bytes calldata encodedTransaction,
    bytes32[] calldata merkleProof,
    bytes32[] calldata continuityProof
) external returns (bool);
```

Given an encoded Source Chain transaction, a Merkle inclusion proof placing it in a block, and a Continuity Proof linking that block to a Creditcoin attestation, the precompile returns `true` only if all three agree.
A `view` overload allows the same check as a keyless preflight, which costs nothing when it refuses.

`calculateTxIndex(merkleProof)` derives the transaction's index in the block from the laterality of the sibling path, so the index is never supplied by the caller.

### 2.2 The ChainInfo Precompile

At `0x0000000000000000000000000000000000000fd3`.

Eleven methods expose attestation metadata: which chains are attested, the current attested frontier and its digest, the bounds covering a height, the attestation genesis, and digest lookups.
Method names are `snake_case`, and a name is a selector: `get_supported_chains`, `get_latest_attestation_height_and_hash`, `get_attestation_bounds`, `get_attestation_genesis_height`.

### 2.3 The economics of the read direction

Readability, the capability described above, consumes Creditcoin gas and carries **no protocol fee**.
The cost of verifying a foreign payment is therefore denominated entirely in CTC, and it is a gas cost rather than a rent extracted by an intermediary.

This is what makes a per-settlement verification economically sane.
Tab's measured cost for verifying ten settlements in one Creditcoin transaction is 557,718 gas, which is 0.74 % of one 75,000,000 block.

### 2.4 The attestation grid

Attestations land on a **stride of 10** Source Chain blocks, advancing roughly every 2 minutes.
As a range ages, coverage migrates to a coarser **stride of 100** checkpoint grid.

Two consequences follow directly, and both shape the design in Section 5.

Most Settlement heights are never themselves an attestation endpoint, which is exactly what a Continuity Proof bridges.
And a Continuity Proof's length is the distance from the proved height up to the nearest endpoint at or above it, so **proof material perishes**: the same height that needed a 1-root proof when fresh needed 31 roots later.

---

## 3. Design goals and the removal test

### 3.1 Goals

| # | Goal | How it is met |
| --- | --- | --- |
| G1 | Nobody may assert that money arrived | Only `verifyAndEmit` returning `true` can reduce an Open Tab |
| G2 | The Agent holds its own keys, always | No component of Tab holds an Agent key, signs on its behalf, or can move its funds |
| G3 | A response is never withheld for payment | The Service delivers, then records the charge |
| G4 | Credit is bounded by capital at risk | Every credit path terminates in a `min` against 95 % of the counterparties' Bonds |
| G5 | No price, rate, or oracle anywhere | A Bond is denominated in the Asset it backs, so no conversion exists |
| G6 | Every claim is checkable without a key | Every read path runs keylessly; `pnpm tab:verify` proves it by stripping secrets from its own environment |

### 3.2 The removal test

A useful question to ask of any system claiming to be built on a protocol is what remains when the protocol is removed.

Remove the BlockProver Precompile from Tab and no path exists from an Ethereum payment to a reduced Open Tab.

The Watcher submits bytes and the proof builder supplies bytes; neither is trusted, and neither is permitted to assert that a settlement occurred.
What would be left is an off-chain operator signing a claim that funds landed.
That operator is a trusted facilitator, which is precisely the assumption Tab exists to remove.

**Tab therefore does not degrade without the protocol. It inverts into the product it replaces.**

That inversion, rather than a feature count, is the honest measure of whether a protocol is load-bearing in a system built on it.

---

## 4. System architecture

![One settlement, end to end](./assets/readme/pipeline.png)

### 4.1 On-chain components, all on Creditcoin

| Contract | Responsibility |
| --- | --- |
| `TabAscBase` | The verification gate and the log-scoped replay ledger. Nothing is written before `verifyAndEmit` returns `true` |
| `SettlementVerifier` | Log authentication against registered emitter pairs, payer resolution, and crediting |
| `TabBook` | Open Tabs, spending authorisations, Metered Delivery, and the Provisional Clearing lifecycle |
| `LimitLib` | Pure credit arithmetic. Zero storage reads, zero external calls |
| `Bond` | Per-Asset stake, reservation, slashing, and accounting release |
| `ServiceRegistry` | Services, tiers, prices, Collection Addresses, and authorised emitters, behind a 48-hour timelock |
| `AgentRegistry` | Binding a Source Chain address to a Creditcoin Agent, proved by a payment |
| `CurationMultisig` | A 2-of-3 multisig with an immutable owner set, for the one privileged role |

One contract is deployed to a Source Chain: `TabSettlement` on Ethereum Sepolia, which has no owner, no admin, no upgrade path, no balances and no tab state.
On Ethereum Mainnet, Tab deploys nothing at all, because a plain USDC transfer to a registered Collection Address already **is** the Settlement.

### 4.2 Off-chain components, none of them trusted

| Component | Responsibility | What it cannot do |
| --- | --- | --- |
| Watcher | Observe Source Chain logs, wait for attestation, fetch and re-derive proofs, batch and submit | Create a Verified Settlement, alter an amount, or credit the wrong Agent |
| Registry indexer | Index events and serve reads, including a Credit Limit only where an on-chain cross-check agrees | Change any figure it serves |
| Gateway | Meter delivery after the fact, against a `LimitWitness` rebuilt from logs | Charge outside the Agent's own authorisation |
| Proof Service | A metered Service, and itself an Agent on the rail | Anything the contracts do not permit any Service |

The Watcher is the component most systems would make trusted, and it is worth being precise about why it is not.
A Provisional Clearing it applies is covered by the Service's own Bond, deadline-bounded, and reversible by a **permissionless crank** that anyone may call.
Its liveness affects how quickly headroom returns.
It affects correctness not at all.

### 4.3 Client surface

The SDK ships payment strategies, an HTTP 402 client, a post-paid server plugin with Hono, Express and Next adapters, and an MCP server exposing four tools.
The four tools are the whole agent-facing interface: `tab_discover`, `tab_call`, `tab_status`, `tab_settle`.

**None of them throws.**
A failure returns `ok: false` with a `category`, a `code` and a `message`, so a language model can decide what to do next rather than parse an exception.

---

## 5. Protocol mechanics

### 5.1 Metered Delivery

An Agent first sets its own spending authorisation on `TabBook`: a Service, an Asset, a ceiling, and an expiry.
Only the Agent can set it, and it is the only thing standing between a Service operator's key and the Agent's whole credit line.

The Service then does the work, returns the result, and calls `recordDelivery`.

Two ordering rules are load-bearing.
The response is never withheld, because withholding it would make this a prepayment with extra steps.
And a delivery spends the Agent's prepaid credit **before** it raises the Open Tab, with the Credit Limit tested against the shortfall only, because prepaid credit is already paid for and borrows nothing.

A charge exceeding headroom returns HTTP `402` carrying the required and available figures.
That is a credit decision, not a demand for payment, and the correct client response is to settle rather than to retry.

### 5.2 Settlement

The Agent moves USDC on the Source Chain to the Collection Address the Service registered.

That transfer **is** the Settlement.
Nothing is escrowed, no Tab contract on the Source Chain is involved on Mainnet, and the Agent needs nobody's permission or cooperation to make it.

### 5.3 Observation and Provisional Clearing

The Watcher observes the unfinalized log and may apply a **Provisional Clearing**, which restores the Agent's headroom immediately, against pledged Bond.

The clearing lifecycle has four states: `None`, `Provisional`, `Confirmed`, `Reversed`.

A Provisional Clearing is bounded by a deadline sized above the attestation wait plus proof retrieval, batching and retry margin: 60 minutes on Ethereum Mainnet and 30 minutes on Ethereum Sepolia.
If the deadline passes unconfirmed, `reverseExpiredClearing` restores the tab and converts the Service's pledged Bond into prepaid credit for the Agent.
That crank is permissionless.

The result is that nothing in an Agent's request path ever waits for an attestation.

### 5.4 Proof and verification

Once ChainInfo reports the height covered, the Watcher fetches a Merkle Proof and a Continuity Proof from two independent sources: the Proof Builder API, and a local `RawProofBuilder` that rebuilds the block's transaction tree and digest chain from Source Chain RPC reads.

It then **re-derives the Merkle root locally** using the domain-separated tree, and submits only on an exact match.
It cross-checks the index derived from sibling laterality against `calculateTxIndex`.

`SettlementVerifier` then runs a fixed sequence, applying no state until the last step succeeds:

1. The `chainKey` must be 1 (Ethereum Sepolia) or 3 (Ethereum Mainnet), or the call reverts `UnsupportedChainKey`.
2. `verifyAndEmit` is called with the encoded transaction, its Merkle Proof, and its own Continuity Proof.
3. The transaction index is taken from `calculateTxIndex`, never from the caller.
4. The receipt must report `receiptStatus == 1`, or the submission reverts `SourceTransactionReverted` before any log is read.
5. Every log is authenticated against the `(chainKey, emitterAddress)` pair the `ServiceRegistry` authorised, and the handler is chosen by the log's own emitter and `topics[0]`, so **no caller-supplied selector exists**.
6. Each recognised log takes a replay key packed from `(chainKey, blockHeight, txIndex, logIndex)`, so a duplicate reverts `AlreadyClaimed`.
7. The payer is resolved from `topics[1]`, the Service from the Collection Address in `topics[2]`, and the Asset from the emitting contract.

A batch carries 1 to 10 members, each with its own Continuity Proof, spanning at most 1000 Source Chain blocks, and is all or nothing.

### 5.5 The replay key

A replay key packs four coordinates: `chainKey`, `blockHeight`, `txIndex`, and the **per-receipt log ordinal**.

The last of those is a subtlety worth stating explicitly, because it is easy to get wrong.
The block-wide `logIndex` would key a Settlement to its position among every log in the block, which changes with unrelated activity.
The per-receipt ordinal keys it to its position within its own transaction, which does not.

### 5.6 Reorganisation handling

The attested digest at height `h` is `keccak256(uint64(h) ‖ merkleRoot_h ‖ digest_(h-1))`, chained from the previous attestation endpoint.
A Source Chain block hash is **not in that digest space at all**.

A reorganisation check therefore cannot be a digest lookup, which is what the design originally proposed.
Instead, the Watcher compares the Source Chain block hash it recorded at Provisional Clearing time against the canonical block hash at that height, once ChainInfo reports the height covered.
A Confirmed Clearing superseded by a reorganisation slashes the Service's Bond to the Agent as prepaid credit.

---

## 6. The credit model

![How much credit, and what bounds it](./assets/readme/credit.png)

### 6.1 Purity is the verification story

`LimitLib` is `internal pure`.
It reads zero contract storage, makes zero external calls, and takes the evaluation timestamp as an argument rather than reading the block clock.

That is not a style preference.
It means a third party can recompute the same number off chain from published history and compare it against the on-chain read, bit for bit.
A single storage read would make that comparison unreproducible.

### 6.2 The computation

Given a Verified Settlement history, the Bond each counterparty Service has posted in the Asset, and an evaluation timestamp:

```
ageDays         = (evaluatedAt - settledAt) / 86400
weightBps       = 2500 + (7500 * min(ageDays, 30)) / 30
weighted_r      = (amount_r * weightBps_r) / 10000        per record
bucket_j        = Σ weighted_r                            per counterparty
contribution_j  = (bucket_j * growthFactorBps) / 10000
bondSum         = Σ bond amounts in the Asset
bondCap         = (bondSum * 9500) / 10000

limit = min(baseline + Σ contribution_j,
            concentrationCapped,
            bondCap)
```

Every division is unsigned integer division, so every rounding step rounds the limit **down**.
The order is fixed and multiply-before-divide at each step, so an independent reimplementation matches exactly.

### 6.3 What each bound is for

| Bound | Value | What it stops |
| --- | --- | --- |
| Age ramp | 25 % at day 0, rising to 100 % at day 30 | A burst of manufactured settlement weighing as much as seasoned history |
| Concentration cap | 25 % per counterparty | Any single Service carrying an Agent's whole limit |
| Minimum counterparties | 3 Curated Tier | A ring of two producing any credit at all |
| Bond cap | 95 % of the counterparties' Bond sum | Credit ever exceeding capital at risk |
| History bounds | 512 records, 32 counterparties | Unbounded gas; the contract reverts rather than truncating |

The age ramp uses floor division on the day count, which makes it a monotone non-decreasing step function.
Compressing the same settled value into a shorter window can therefore only lower every weight, and so can only lower the weighted total.
That is the property that makes burst-versus-spread resistance provable rather than argued.

### 6.4 Cold start, and why it is correct

An Agent with no settlement history has no counterparties, therefore a Bond sum of zero, therefore a bond cap of zero, therefore a Credit Limit of zero.

This is the rule rather than a fault.
Its first purchase must be a Settlement, which banks prepaid credit and creates the history a limit is computed from.
A system that gave a brand-new identity credit on the strength of nothing would be giving it away, since identities are free.

### 6.5 No price feed exists

A Bond is denominated in the same Asset as the credit it unlocks.
A Bond and the credit it backs are therefore the same unit, and no exchange rate can move the ceiling.

This is why there is no oracle in Tab.
Not because one was avoided as a matter of taste, but because the invariant was chosen so that none is definable.

---

## 7. Security analysis

### 7.1 The trusted set, and the bound on each member

The organising fact is that the trusted set contains parties who can slow the system down and no party who can make it lie.

| Component | Trust granted | Bound on the damage |
| --- | --- | --- |
| Curation authority | Promote a Service to the Curated Tier; queue changes to prices, Collections, Assets and Windows | Can admit a colluding Service into credit computation. Cannot mint credit beyond that Service's Bond, move Agent funds, or forge a Settlement. Every change is queued 48 hours in public, and the role is a constructor argument with no setter |
| Watcher operator | Apply Provisional Clearings, report reorganisations, submit proofs | Can apply a clearing no Settlement confirms, which slashes the **Service's own** Bond and never the Agent. Can delay credit. Cannot create a Verified Settlement, alter an amount, or credit the wrong Agent |
| Service operator | Record Metered Delivery against a tab | Can charge only inside an unexpired, Agent-set authorisation, at prices from its applied timelocked price list |
| Proof suppliers | Supply proof material | Can supply bad material, which costs nothing: the Watcher re-derives the root locally and the precompile refuses the rest |

### 7.2 Collusion is bounded, not eliminated

A bonded Curated Tier Service and an Agent under common control can manufacture settlement history.
This is true, and it is stated rather than hidden.

What the invariant buys is a ceiling.
The credit unlocked is strictly less than the sum of the counterparties' Bonds; a ring needs at least three distinct Curated Tier counterparties; no counterparty contributes more than 25 %; a burst weighs a quarter of seasoned history; and every counted Settlement must follow a real Metered Delivery recorded on Creditcoin.

A colluding ring's maximum extraction is therefore bounded by its own staked capital.
That is a bound, not a fix, and it is the honest way to describe it.

### 7.3 Replay resistance

Every recognised log is claimed exactly once per deployment, keyed on the packed replay key.
A duplicate submission reverts `AlreadyClaimed`.

One `TabSettlement.settle` call on Sepolia emits both a `Transfer` and a `TabSettled` for a single payment.
The verifier skips the `Transfer` that a `TabSettled` in the same receipt already accounts for, matched by count on `(payer, recipient, amount)`, so a genuine second payment in the same transaction is never suppressed.

### 7.4 The one privileged role

Tab has exactly one privileged role, and naming it plainly is part of the design.

A curation authority decides which Services hold the Curated Tier, and so which settlement history carries Credit Limit weight.
It has no power over metering, over any tab, or over any Bond.

Two things bound it.
Every change is queued and held for 48 hours behind a public `RegistryChangeQueued` event, so a promotion is contestable before it takes effect.
And the role cannot move: `ServiceRegistry` takes its authority as a constructor argument and exposes no setter, so it can change only at a deployment, by this project or by anyone.

A 2-of-3 `CurationMultisig` with an immutable owner set, a permissionless `execute`, and no payable function anywhere in it is deployed and takes the role at the next deployment of the registry.

---

## 8. Empirical results from the live network

![What Tab calls on the Attestcoin Protocol](./assets/readme/attestcoin.png)

Every item below was measured against the live network before it was built on, and several corrected the design.
This section exists because the difference between a system that reads a protocol's documentation and one that has run against it is usually invisible until something is wrong.

### 8.1 The payer is `topics[1]`, never the transaction `from` field

A historical Ethereum Mainnet USDC `Transfer` was proved end to end from a contract on CC3 Testnet.
The gas payer in the transaction's `from` field and the sender recorded in the log's `topics[1]` were **two different addresses in the same transaction**.

A design resolving the payer from `from` would have credited the recipient of the money.
`SettlementVerifier` resolves from `topics[1]` only, and excludes the `from` field from payer resolution entirely.

### 8.2 One Continuity Proof proves exactly one height

The precompile reads a Continuity Proof's first root as the root of the height being proved.
A proof built to span ten heights verified the lowest and reverted `Merkle root mismatch` for the rest.

Every batch member therefore carries its own Continuity Proof.
The batch bound of ten is a proof-availability and blast-radius bound rather than a gas bound: ten sequential calls cost 557,718 gas, or 0.74 % of one block.

### 8.3 The precompile reverts rather than returning false

A forged Merkle root and a one-byte-tampered transaction are both refused inside `verifyAndEmit` with `Error("Merkle proof validation failed")`.

Control never returns to the contract's `if (!ok)` branch on this network, so that branch is defensive and is exercised only by unit tests against a mock.
The Watcher keys its retry decision on the decoded revert message and treats an unrecognised `Error(string)` as skip-and-flag rather than as a retryable builder fault.

### 8.4 The Merkle tree is domain-separated

A leaf is `keccak256(0x00 ‖ encodedTransaction)` and an inner node is `keccak256(0x01 ‖ left ‖ right)`.

The design's original pseudocode omitted the tags and derived a completely different root from genuine Mainnet material.
The tags are what stop a leaf whose bytes happen to equal `left ‖ right` from hashing identically to the parent of those children.

### 8.5 ChainInfo names are `snake_case`, and a name is a selector

`supportedChains()`, `latestAttestedHeight(uint64)`, `attestedBlockDigest(uint64,uint64)` and `waitUntilHeightAttested(uint64,uint64)` all revert `Error("Unknown selector")`.

`waitUntilHeightAttested` exists only in the client libraries, as a poll, with a default one-minute timeout that would abandon most Mainnet Settlements.
Tab implements its own poll with the timeout sized to the documented wait.

### 8.6 The attested digest is not a block hash

The attested digest is `keccak256(uint64(h) ‖ merkleRoot_h ‖ digest_(h-1))`, reproduced byte for byte on Sepolia by chaining a Continuity Proof's lower endpoint digest up to the frontier.

`get_attestation_height_for_digest` resolves stride-10 endpoints only: five consecutive non-endpoint heights answered `exists: false` with correct digests in hand.
A Source Chain block hash answers `exists: false` on both chains.

This is the finding that rewrote the reorganisation check.

### 8.7 Proof material perishes, and only half of it does

The Merkle inclusion proof is durable, because a block's transaction tree never changes.
The Continuity Proof is not.

The recorded Mainnet target needed a 1-root proof when built and 31 roots later, and the stale 1-root proof was refused with `Error("Continuity proof does not match attestation or checkpoint")` while a fresh proof passed.

Continuity Proofs are therefore fetched close to submission and never cached across a long delay.
Settlement Windows default to 6 hours and are capped at 24, which keeps proof material inside the dense-attestation regime where proving costs are roughly a tenth of the sparse-checkpoint regime.

### 8.8 Frontier reads must be pinned to one block tag

One height past the tip, `is_height_attested` once answered differently on the two chains, most likely because Creditcoin `latest` runs ahead of `finalized`.
The disagreement did not reproduce once both reads were pinned to one block tag.

Every readiness decision in the Watcher therefore polls the height-returning read at a pinned tag and asks whether the frontier covers the height, never whether the height is an attestation.

A related consequence applies to writes: a read-back at the pinned `finalized` tag straight after a mined transaction can miss its own write.
Confirm at the block the write landed in.

### 8.9 What has run end to end

The whole loop has run on chain: meter, settle, observe, provisionally clear, prove, confirm.

So has every branch of the clearing state machine, including the reversal crank, where a clearing was left to expire and `reverseExpiredClearing` restored the tab and turned the pledge into prepaid credit for the Agent.

And the hardest case in Section 8.1 has run as a live end-to-end path: a Settlement broadcast from a Sepolia smart account credited the bound Agent and gave the sender nothing.

---

## 9. Boundaries

Every system has edges.
Naming each one with the bound that says how far it reaches is more useful than naming it alone, because a boundary without its bound reads as either worse or better than it is.

| Boundary | The bound |
| --- | --- |
| Attestation latency | 13 to 15 minutes documented for Mainnet, 7 to 8.6 measured. **Nothing in an Agent's request path waits for it**: Bond-covered Provisional Clearing restores headroom on observation |
| Value settles in Creditcoin accounting | An overpayment becomes prepaid credit; slashed Bond value is credited in the same Asset; a withdrawal releases in accounting. See Section 11 |
| One curation authority | Queued 48 hours in public, powerless over metering, tabs and Bonds, and unable to move without a redeployment |
| Collusion | Bounded by the colluding ring's own Bond sum, with at least 3 counterparties required and 25 % concentration |
| Credit history ceiling | 512 records and 32 counterparties. The contract reverts `HistoryTooLong` rather than quietly dropping records |
| Watcher liveness | Affects how fast headroom returns, never correctness. Reversal is a permissionless crank |
| Asset scope | USDC only today, on `chainKey` 1 and 3. The architecture is multi-asset and no price conversion exists anywhere |

Where Mainnet attestation is unavailable, discovery selects Sepolia on its own and the rail keeps running.
Configuration cannot force a chain the ChainInfo Precompile does not report, which is what stops a misconfiguration from becoming a false claim about where a Settlement happened.

---

## 10. Related work

**HTTP 402 payment protocols.** A growing family of schemes returns `402 Payment Required` and expects the client to pay before the response is released. Tab uses the same status code with the opposite semantics: the response has already been delivered, and `402` appears only when a *future* charge would exceed a credit limit. It is a credit decision, not a paywall.

**Streaming and channel payments.** Payment channels give low-latency micropayment but require capital locked in advance, per counterparty. That is a prepayment with better ergonomics, and it does not produce a portable credit record.

**Cross-chain oracles and bridges.** These are the incumbent answer to the problem in Section 1.2, and the assumption Tab removes. The distinction is not that Tab trusts a better party. It is that Tab's ledger accepts evidence rather than signatures.

**On-chain undercollateralised lending.** Existing protocols in this space typically rely on off-chain underwriting, legal recourse, or a whitelisted borrower set. None of those is available to an autonomous agent. Tab's substitute is a proved settlement history bounded by counterparty stake, which requires no identity, no jurisdiction and no underwriter.

---

## 11. Roadmap

### 11.1 Writability, and the seam already left for it

Everything Tab runs today runs on Readability, which is the correct thing to build against a live capability.

The Attestcoin Protocol's announced roadmap adds **Writability**: the direction in which Creditcoin writes to a Source Chain rather than only reading it.
The shape of the day it arrives is already visible, so Tab left the seam for it rather than the redesign.

`IOutboxAdapter` declares the three publications a credit facility would want to make onto a Source Chain, with the exact arguments each needs:

```solidity
function isAvailable() external view returns (bool available);
function publishCreditLimit(uint64 chainKey, address agent, address asset, uint256 limit)
    external returns (bytes32 receiptId);
function publishDelinquency(uint64 chainKey, address agent, address asset)
    external returns (bytes32 receiptId);
function publishBondWithdrawal(uint64 chainKey, address to, address asset, uint256 amount)
    external returns (bytes32 receiptId);
function receiptStatusOf(bytes32 receiptId) external view returns (uint8 status);
```

**It ships with zero implementation, and that is the requirement rather than an omission.**
A stub answering `true` from `isAvailable()` would be worse than nothing, because it would let a caller treat an unpublished limit as published.
Nothing in `SettlementVerifier`, `TabBook`, `AgentRegistry`, `ServiceRegistry`, `Bond` or `LimitLib` calls it, and no deployment wires an address into it.

`receiptStatusOf` returns a small integer rather than a boolean, deliberately.
A cross-chain write is not settled by the transaction that requests it, so a caller must be able to distinguish "not yet" from "never", and collapsing the two would let an unpublished figure read as a failed one or the reverse.

What the declaration buys is that enabling the path later is a **wiring task against a fixed shape** rather than a design task: the arguments each publication needs are settled now, while the reasons for them are still in view.

Two of the boundaries in Section 9 are the same missing capability seen from two sides, and both resolve the day it lands.
An overpayment becomes prepaid credit rather than a refund, and a Bond withdrawal releases in accounting rather than paying a Source Chain address.

### 11.2 Beyond that

Multi-asset expansion needs no new architecture: the Asset is already a parameter everywhere, and the payment-strategy seam is the extension point.
The rule a new strategy has to satisfy is not "move the money" but that **the payment must leave a log a Creditcoin contract can recognise, at an emitter and a Collection Address the registry already knows**.

Additional Source Chains follow the attested set rather than a configuration file, because discovery reads `get_supported_chains` and configuration cannot override it.

---

## 12. Conclusion

Credit for autonomous agents has been blocked on a verification problem rather than on a financial one.
The financial mechanism has been well understood for centuries: consume first, accrue a record, and let the record earn the right to consume more.

What has been missing is a way for the ledger holding the record to check the repayments for itself when they happen somewhere else.
Every substitute for that check has terminated in a trusted party, and a credit facility resting on a trusted party is extending credit against an operator's word rather than against a proved history.

The Attestcoin Protocol's Readability makes the check itself possible, in the contract, with no fee beyond gas.
Tab is what that primitive makes buildable: a post-paid billing rail whose repayment history is proved, whose credit ceiling is bounded by capital at risk, and which contains no price feed, no oracle, and no party permitted to say that money arrived.

It is deployed, it has run end to end, and every claim in this paper is checkable without a key.

---

## Appendix A: deployed addresses

All addresses were read back off the chain by a keyless verification script and are recorded in [`deployments.json`](./deployments.json).

### Creditcoin CC3 Testnet, chain id 102031

| Contract | Address |
| --- | --- |
| `SettlementVerifier` | [`0xDf4e7F76e5821ab351877C7862117fDdbC7a44a7`](https://creditcoin-testnet.blockscout.com/address/0xDf4e7F76e5821ab351877C7862117fDdbC7a44a7) |
| `TabBook` | [`0x047ECFB428FE706eA391B626872Ce8Deb8756c5f`](https://creditcoin-testnet.blockscout.com/address/0x047ECFB428FE706eA391B626872Ce8Deb8756c5f) |
| `Bond` | [`0xDbB6C19A4236ACdd8535E993C5fA93E6Ff1f173A`](https://creditcoin-testnet.blockscout.com/address/0xDbB6C19A4236ACdd8535E993C5fA93E6Ff1f173A) |
| `AgentRegistry` | [`0x4721f24974be89287F5C34aeE4D15D20389A2a8B`](https://creditcoin-testnet.blockscout.com/address/0x4721f24974be89287F5C34aeE4D15D20389A2a8B) |
| `ServiceRegistry` | [`0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC`](https://creditcoin-testnet.blockscout.com/address/0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC) |
| `CurationMultisig` | [`0x9fCe693cD68307a2450aB57f4654653643F01Bb6`](https://creditcoin-testnet.blockscout.com/address/0x9fCe693cD68307a2450aB57f4654653643F01Bb6) |
| `EvmV1Decoder` | [`0x10619F16E1ac73AAe41AA4C1619f1387687EED79`](https://creditcoin-testnet.blockscout.com/address/0x10619F16E1ac73AAe41AA4C1619f1387687EED79) |
| BlockProver Precompile | `0x0000000000000000000000000000000000000FD2` |
| ChainInfo Precompile | `0x0000000000000000000000000000000000000fd3` |

### Ethereum Sepolia, `chainKey` 1

| Contract | Address |
| --- | --- |
| `TabSettlement` | [`0x10619F16E1ac73AAe41AA4C1619f1387687EED79`](https://sepolia.etherscan.io/address/0x10619F16E1ac73AAe41AA4C1619f1387687EED79) |
| Test USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

### Ethereum Mainnet, `chainKey` 3

No Tab contract is deployed.
USDC at `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` is read as an authorised emitter.

---

## Appendix B: reproducing every claim

Each command needs an RPC endpoint and nothing else.
No private key, no funded account, no write.

```bash
pnpm install
pnpm env:bootstrap

# the whole deployment, read back from both ends of every wired slot
pnpm tab:verify

# the attestation grid, the perishability of proof material, and the tagged Merkle derivation
pnpm --filter @tabai/watcher probe:attestation

# the digest space, and the Source Chain block-hash comparison the reorganisation check uses
node --input-type=module < spike/verify-reorg.mjs

# the recorded negative-path cases, replayed over eth_call
pnpm tsx packages/contracts/test/live/run.mts --preflight --case forged-merkle-root

# 285 contract tests, including property tests and the live suite
cd packages/contracts && forge test
```

`pnpm tab:verify` removes every secret-shaped variable from its own environment before the first chain read and prints which ones it removed, so keylessness is a property of the run rather than a claim about it.

---

## References

1. Attestcoin Protocol. <https://attestcoin.org> · Documentation: <https://docs.attestcoin.org>
2. Creditcoin. <https://creditcoin.org>
3. ASC Dashboard, CC3 Testnet. <https://dashboard.cc3-testnet.creditcoin.network>
4. Proof Builder API, CC3 Testnet. <https://prover.cc3-testnet.creditcoin.network>
5. `@gluwa/usc-sdk` 0.18.0 and `@gluwa/usc-contracts` 0.1.2
6. Tab source, documentation and evidence. This repository, MIT licensed.

---

<p align="center">
  <sub>Tab · Emad Qureshi · BUIDL CTC 2026 Fall · MIT</sub>
</p>
