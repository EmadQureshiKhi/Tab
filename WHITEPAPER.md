<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/readme/hero-light.png">
    <img alt="Tab" src="./assets/readme/hero-light.png" width="820">
  </picture>
</p>

# Tab: Post-Paid Billing and a Credit Facility for Autonomous Agents on Monad

**Emad Qureshi**
Version 2.0 · September 2026 · Monad Testnet, chain id 10143

---

## Abstract

Autonomous software agents cannot open bank accounts, hold cards, or sign contracts, so every commercial interface available to them today is a prepayment.
A prepayment is not billing; it is a deposit, and it returns a human to the loop of a system built to run without one.
Post-paid billing requires credit; credit requires a repayment record; and a repayment record requires some party to confirm that repayments occurred.
Wherever the payment and the ledger have lived in different places, that party has been a facilitator, an oracle, or a bridge: an entity whose signature, rather than the payment itself, is what the ledger accepts.

On Monad the payment and the ledger entry can be one state change: an EIP-20 transfer and a contract call compose in a single transaction that is final in under a second, so a contract can move an Asset and record that it moved with nobody in between.
This paper describes **Tab**, a system built on that fact.
A Service meters usage into an Open Tab held in `TabBook`.
The Agent settles that Tab in USDC, with keys nobody else holds, by calling `TabSettlement.settle`, and the same transaction moves the Asset to the Service and applies the Settlement to the tab, or reverts as a whole.
The resulting Credit Limit is a pure function of the Settlements the chain itself applied, bounded above by capital the counterparties have escrowed.
There is no price feed, no rate, and no oracle anywhere in the system, and there is no party permitted to say that money arrived.
Tab is deployed on Monad Testnet, and every address, transaction hash, and figure in this paper is checkable from the repository with an RPC endpoint and no private key.

---

## Contents

1. [The problem](#1-the-problem)
2. [Background: what Monad provides](#2-background-what-monad-provides)
3. [Design goals and the removal test](#3-design-goals-and-the-removal-test)
4. [System architecture](#4-system-architecture)
5. [Protocol mechanics](#5-protocol-mechanics)
6. [The credit model](#6-the-credit-model)
7. [Security analysis](#7-security-analysis)
8. [What runs on Monad Testnet](#8-what-runs-on-monad-testnet)
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

Human commerce solved this long ago, and not with prepayment but with credit: you consume first, a record accrues, and the record is what earns you the right to consume more.
The mechanism that makes credit safe is not a balance check but a repayment history that a third party can check for itself.

### 1.2 Why a repayment record has needed a trusted party

Put the ledger and the payment on the same chain and the problem is easy: the contract that records the debt can see the payment that settles it.

Almost no agent payment rail has been built that way.
The ledger has lived in an operator's database and the payment on a card network, in a bank, or on a chain the ledger cannot read, so something has had to carry the fact of payment across.
Every mechanism used for that terminates in an assertion by a party: a facilitator signs a claim that funds landed, an oracle reports a value, or a bridge mints a representation, and the ledger accepts the signature, the report, or the mint.

In each case, the ledger's guarantee is no stronger than that party's honesty and availability, and a credit facility built this way extends credit against an operator's word about a history rather than against the history.
This matters more for agents than for people, because an agent has no legal identity, no jurisdiction, and no recourse.
The only thing that can stand behind an agent's creditworthiness is a record a machine can check.

---

## 2. Background: what Monad provides

Monad is an EVM chain.
Contracts written in Solidity deploy to it unchanged, tooling built for the EVM works against it, and an EIP-20 token on it behaves the way an EIP-20 token behaves anywhere.
Three properties of the chain carry the design in this paper.

### 2.1 Finality in under a second

A block on Monad is final in under a second.
A Settlement is therefore final when its block is, and the next metered call sees the new headroom in the same block.
There is no window in which a tab has fallen for a payment that might not stand, so there is no interim state to hold and no reversal path to build.

### 2.2 Throughput, and gas paid in MON

Monad is built for high throughput, gas is paid in MON and is cheap, and that is what makes per-delivery metering on chain sane rather than merely possible: `recordDelivery` writes one tab, checks one witness and emits one event for every metered call, and the Service pays that gas as a cost of doing business rather than as a rent.
A delivery that would be refused is simulated first over a keyless `eth_call` and returns the same revert data a broadcast would, so the gas a Service spends is spent on deliveries that land.

### 2.3 A transfer and a contract call compose in one transaction

This is the property Tab is built on.
A contract on Monad can call `transferFrom` on an EIP-20 Asset and, in the same transaction, write another contract's storage, and either both happen or neither does.
`TabSettlement` is a contract that does exactly that and nothing else.
It moves the Asset from the Agent to the Service's Collection address and calls `TabBook.applySettlement`, and it holds no balance and keeps no state of its own.

Because the payment and the ledger are on the same chain, nothing has to report the payment to the ledger: no oracle, no bridge, no reporting layer, and no operator with a key that can say a tab was paid.
The question "did the money arrive?" is never asked, because the contract that lowers the tab is the contract that moved the money.

---

## 3. Design goals and the removal test

### 3.1 Goals

| # | Goal | How it is met |
| --- | --- | --- |
| G1 | Nobody may assert that money arrived | `TabBook.applySettlement` answers to one address, the wired `TabSettlement`, which calls it only inside the transaction that moves the Asset |
| G2 | The Agent holds its own keys, always | No component of Tab holds an Agent key, signs on its behalf, or can move its funds; `TabSettlement` pulls only what the Agent allowed, to a registered Collection address only |
| G3 | A response is never withheld for payment | The Service delivers, then records the charge; the metering path only ever raises a tab |
| G4 | Credit is bounded by capital at risk | Every path through `LimitLib.creditLimit` ends in a `min` against `BOND_CAP_BPS` of the counterparties' free Bond |
| G5 | No price, rate, or oracle anywhere | A Bond is denominated in the Asset it backs, so no conversion exists and none is definable |
| G6 | Every claim is checkable without a key | The deployment verifies through a `view` script, the registry serves a Credit Limit only where the chain agrees, and every Dashboard read works with no wallet |

### 3.2 The removal test

A useful question to ask of any system claiming to rest on a property is what remains when the property is removed.
Take `TabSettlement` away and there is still exactly one way a tab falls: `TabBook.applySettlement`, which only the wired settlement surface may call.
With no surface wired nothing can lower a tab, and nothing can be granted that power afterwards, because `setSettlementSurface` can be called once and reverts `AlreadyWired` forever after.
No operator, no indexer and no off-chain process can reduce an Open Tab, and the registry read API and the Dashboard describe what the chain did without being able to make it do anything.

Now suppose instead that the payment lived somewhere `TabBook` could not see: something would have to tell the book that the payment happened, and the book would have to believe it.
That something is a facilitator, which is precisely the party Tab exists to remove.

**Tab therefore does not degrade without the property.**
**It inverts into the product it replaces.**
That inversion, rather than a feature count, is the honest measure of whether a property is load-bearing in a system built on it.

---

## 4. System architecture

### 4.1 On-chain components, all on Monad

| Contract | Responsibility |
| --- | --- |
| `ServiceRegistry` | Who may meter, prices per tool per Asset, a Collection address per Asset, the Settlement Window, and the tier. Registration is permissionless; every later change sits behind a 48-hour timelock |
| `Bond` | Escrow for Service stake. `deposit` and `depositFor` pull the Asset in, `withdraw` pays it out, and `freeOf` is what the credit computation reads |
| `TabBook` | Open Tabs, prepaid credit, spending authorisations, Metered Delivery, delinquency, and the rolling history commitment the Credit Limit is computed from |
| `TabSettlement` | The one way a tab is paid. Moves the Asset and applies the Settlement in one transaction. Holds nothing |
| `LimitLib` | Pure credit arithmetic. Zero storage reads, zero external calls, linked at compile time |
| `CurationMultisig` | An m-of-n owner set with an immutable owner list, for the one privileged role |

Nothing in `TabBook`, `Bond` or `TabSettlement` is owned, pausable, or upgradeable; the one privileged act among them is the one-shot wiring of the settlement surface at deployment.

### 4.2 Off-chain components, none of them trusted for money

| Component | Responsibility | What it cannot do |
| --- | --- | --- |
| Registry indexer and read API | Index every event and serve reads, including a Credit Limit only where its own recomputation agrees with `TabBook.creditLimit` at the same block | Change any figure it serves, or feed any figure into a contract |
| Metering gateway | The Service side: rebuild the Agent's witness from `HistoryExtended` logs, check the fold against `TabBook.historyCommitment`, simulate `recordDelivery`, then broadcast | Charge outside the Agent's own authorisation, or lower a tab |
| SDK | Strategies, the 402 client, server plugins, the MCP server and the CLI | Hold a key it was not handed, or persist one |
| Dashboard | Keyless reads of every Service, Agent, Settlement and overdue tab; a wallet only to sign `authorise`, `registerService`, or the allowance and deposit that fund a Bond | Anything the connected wallet did not sign |

The gateway is the component most systems would make trusted, and it is not: every metering request it accepts must carry the Service operator's own signature over the Agent, the tool and the unit count, so the gateway is the operator's key and no more.
Its liveness affects whether a Service gets paid for a delivery, and the correctness of any tab or limit not at all.

### 4.3 Client surface

The SDK, `@tabai/sdk`, ships `createMonadStrategy`, which grants an EIP-20 allowance, calls `TabSettlement.settle`, and reads the Settlement back off the receipt.
Around it sit an HTTP 402 client, a post-paid server plugin with Hono, Express and Next adapters, proxy hooks, a CLI, and an MCP server exposing four tools.

The four tools are the whole agent-facing interface: `tab_discover`, `tab_call`, `tab_status`, `tab_settle`.
Three of them are keyless reads, and only `tab_settle` signs, through the same strategy seam a library caller uses.
**None of them throws.**
A failure returns `ok: false` with a `category`, a `code` and a `message`, so a language model can decide what to do next rather than parse an exception.

---

## 5. Protocol mechanics

### 5.1 Authorisation and Metered Delivery

An Agent first sets its own spending authorisation on `TabBook.authorise`: a Service, an Asset, a cumulative ceiling `maxCumulative`, and an `expiry`.
Only the Agent can set it, and it is the only thing standing between a Service operator's key and the Agent's whole credit line.
The authorisation is keyed by `tabIdOf(agent, serviceId, asset)`, which is `keccak256(abi.encode(agent, serviceId, asset))`, and `TabBook` derives that key itself, so no header, claim or argument a Service supplies can redirect a charge to a different tab.

The Service does the work, returns the result, and only then calls `recordDelivery`.
The call runs a fixed sequence, and the order is load-bearing:

1. **Operator check.** The caller must be the operator `ServiceRegistry` recorded for `serviceId`, or the call reverts `NotServiceOperator`.
2. **Delinquency check.** A tab that has been marked delinquent takes no further deliveries and reverts `TabIsDelinquent`.
3. **Price check.** The unit price the Agent was quoted travels with the call as `expectedUnitPrice`, and it must equal `ServiceRegistry.priceOf` at that moment, or the call reverts `PriceListChangedMidCall`. A Service cannot quote one number and meter another inside the same call.
4. **Authorisation consumption.** The charge is added to the authorisation's `spent`, reverting `AuthorisationMissing`, `AuthorisationExpired` or `AuthorisationExceeded` as the case may be.
5. **Headroom check.** Prepaid credit on the tab is spent before the Open Tab rises, and only the shortfall is tested against the Credit Limit. If the Agent's Open Tab across all Services in that Asset plus the shortfall would exceed the limit, the call reverts `LimitExceeded` carrying the requested amount and the headroom that remains.
6. **The tab write.** The tab's `open`, `oldestUnsettledAt`, `lastDeliveryAt` and `deliveryCount` are updated, the first delivery timestamp for the tab is recorded if it was unset, and `DeliveryRecorded` is emitted.

Two rules follow: the response is never withheld, because withholding it would make this a prepayment with extra steps, and prepaid credit borrows nothing, because it is already paid for, which is why it is spent before the limit is consulted.

A charge exceeding headroom reaches the Agent as HTTP `402` carrying the required and available figures in `Tab-Charge-*` headers, and it is the one refusal that maps to a `402`.
It is a credit decision, not a demand for payment, and the correct client response is to settle rather than to retry.

### 5.2 Settlement

The Agent grants `TabSettlement` an EIP-20 allowance for the Asset and calls `settle(serviceId, asset, amount)`.
Nothing is escrowed, no facilitator is asked, and the Agent needs nobody's permission or cooperation.

Inside `_settle`, effects come before interaction.
`TabSettlement` reads the Service's Collection address for that Asset from the registry, calls `TabBook.applySettlement`, emits `Settled`, and then executes `transferFrom(agent, collection, amount)` on the Asset.
A transfer that reverts unwinds the ledger entry with it, and a ledger entry the book refuses stops the transfer from ever starting, so the two are atomic in both directions.

`settleBatch` takes a list of instructions and runs the same path for each, so one transaction can settle several tabs in several Assets, each with its own `settlementId`.
Because the payment and the record are one transaction there is no second submission to guard against: a Settlement cannot be applied without moving the Asset again, and a plain token transfer to a Collection address is not a Settlement and does not lower a tab.

### 5.3 What `applySettlement` does

`applySettlement` may be called by exactly one address, the wired `settlementSurface`, and reverts `NotSettlementSurface` for any other caller.
Given an Agent, a Service, an Asset and an amount, it:

1. lowers the Open Tab by `applied = min(amount, open)`, zeroing `oldestUnsettledAt` if the tab reaches zero;
2. banks the excess, `toPrepaid = amount - applied`, as prepaid credit on the same tab;
3. assigns `settlementId = keccak256(abi.encode(block.chainid, address(this), ++_settlementNonce))`, unique per Settlement rather than per transaction, and stores the Settlement;
4. emits `SettlementApplied`;
5. lifts the delinquency mark if the tab is now settled, emitting `TabDelinquencyCleared`;
6. extends the Agent's history commitment.

Step 2 is why `applySettlement` never fails for want of a debt: a Settlement against a tab with nothing open is the intended way for a new Agent to buy in.

### 5.4 The history commitment

The history a Credit Limit is computed from is not stored as an array.
`TabBook` keeps one rolling commitment per Agent and Asset, `(root, count)`, and extends it on every Settlement with a `LimitLib.SettlementRecord`:

```
record = (serviceId, asset, amount, settledAt, firstDeliveryAt, curated, bonded)
root'  = keccak256(abi.encode(root, serviceId, asset, amount, settledAt, firstDeliveryAt, curated, bonded))
```

`curated` and `bonded` are snapshots of the counterparty's tier and Bond at settlement time, `firstDeliveryAt` is the timestamp of the earliest delivery ever recorded on that tab, and all three travel with the record because `LimitLib` performs no storage read.
The full record is emitted on `HistoryExtended`, so anyone with the logs can rebuild the history, and `TabBook` refuses any witness that does not fold back to the stored root.

### 5.5 Delinquency

A tab that stays open past its Service's Settlement Window can be marked delinquent by anyone, with `TabBook.markDelinquent(tabId)`.
The call is permissionless and succeeds once `oldestUnsettledAt + settlementWindow <= block.timestamp`, reverting `SettlementWindowOpen` before that and `NothingUnsettled` if the tab holds nothing.

The mark zeroes the Agent's Credit Limit in that Asset, with every Service, until the tab settles.
`TabBook` counts delinquent tabs per Agent and Asset, returns a limit of zero while the count is positive before any arithmetic runs, and emits `CreditLimitZeroed` naming the tab; no stake is taken from anyone and no funds move.
The Settlement Window is a registration parameter, `DEFAULT_SETTLEMENT_WINDOW` of 6 hours and `MAX_SETTLEMENT_WINDOW` of 24, so the longest any Service is exposed before it may stop extending credit is one day.

### 5.6 The registry and its timelock

Registration is permissionless and takes effect immediately.
One transaction records the operating account, the Assets accepted with a Collection address for each, a price per tool per Asset, and a Settlement Window, and the Service starts in the Permissionless tier with its bond account set to the registering account.

Every change after that, whether a price, a Collection address, an accepted Asset, the Settlement Window or the tier, goes through `queueChange`, is announced by `RegistryChangeQueued` with its `eta`, and can be applied no sooner than `TIMELOCK` of 48 hours later.
The payload is decoded at queue time exactly as it will be at apply time, so a change that cannot apply is refused when queued rather than two days later, and the curation authority's own tier changes are held to the same 48 hours.

### 5.7 The Bond

A Service's history carries Credit Limit weight only while the Service is bonded, and the credit any history can earn is capped strictly below the counterparties' free stake, so a Service that wants its repayment record to vouch for Agents has to put capital behind it.
`Bond` is real escrow: `deposit` and `depositFor` pull the Asset into the contract by `transferFrom` and credit the party's `staked`; `withdraw` increments `withdrawn` and pays the caller out, and only the account that staked can withdraw.
`freeOf(party, asset)` is `staked - withdrawn`, and it is the only figure `TabBook` reads.
Nothing in `Bond` is owned, pausable or upgradeable, and no other contract can move a party's stake.

---

## 6. The credit model

### 6.1 Purity is the verification story

`LimitLib.creditLimit` is `internal pure`.
It reads zero contract storage, makes zero external calls, and takes the evaluation timestamp as a `Params` field rather than reading the block clock.

That is not a style preference: it means a third party can recompute the same number off chain from published history and compare it against the on-chain read, bit for bit, and the registry does exactly that before it serves a figure.
A single storage read would make that comparison unreproducible.

### 6.2 The computation

Given a Settlement history, one `BondEntry` per counterparty, and `Params` carrying the Asset, `baseline`, `growthFactorBps` and `evaluatedAt`, the library runs six steps in a fixed order.

**Step 1: filter and bucket.**
A record is skipped if its `asset` is not the Asset in scope, if `curated` is false, if `bonded` is false, if `firstDeliveryAt` is zero, or if `firstDeliveryAt >= settledAt`.
Each surviving record is weighted by age and bucketed by counterparty, and a record whose weighted value floors to zero creates no bucket, so dust cannot count toward the counterparty threshold.

```
ageDays         = (evaluatedAt - settledAt) / 86400
weightBps       = MIN_WEIGHT_BPS + (RAMP_SPAN_BPS * min(ageDays, RAMP_DAYS)) / RAMP_DAYS
weighted_r      = (amount_r * weightBps_r) / BPS              per record
bucket_j        = Σ weighted_r                                 per counterparty j, a sum of floored terms
```

**Step 2: the bond cap, on every path.**

```
bondSum         = Σ bond amounts in the Asset                  summed before any scaling
bondCap         = (bondSum * BOND_CAP_BPS) / BPS               one division over the sum
```

**Step 3: below `MIN_COUNTERPARTIES`, the bond-capped baseline and nothing more.**

```
if n < MIN_COUNTERPARTIES:  limit = min(baseline, bondCap)
```

**Step 4: growth contributions.**

```
contribution_j  = (bucket_j * growthFactorBps) / BPS          one division per counterparty
uncapped        = baseline + Σ contribution_j
```

**Step 5: the concentration cap, in closed form.**
No single counterparty may contribute more than `CONCENTRATION_BPS` of the returned limit, and value above that share is discarded rather than redistributed.
The capped value is therefore the fixed point of `L = baseline + Σ min(c_j, L / 4)`, where `4` is `CONCENTRATION_DIVISOR = BPS / CONCENTRATION_BPS`.
At most three counterparties can sit at the cap, because four at the cap would give `L > L`, so with the contributions sorted descending there are four candidates and no iteration:

```
candidate_k     = (CONCENTRATION_DIVISOR * (baseline + tail_k)) / (CONCENTRATION_DIVISOR - k)     k in {0, 1, 2, 3}
```

where `tail_k` is the sum of contributions ranked `k + 1` and below.
The scan returns the first candidate whose top `k` contributions are at or above the cap and whose next contribution is at or below it, and falls back to the smallest candidate when integer flooring lands a tie, which keeps the rounding in the direction that never over-grants.

**Step 6: the smallest of the three.**

```
limit = min(uncapped, concentrationCapped, bondCap)
```

Every division is unsigned integer division, so every rounding step rounds the limit **down**.
The per-record weighted value is floored before bucketing, the growth factor is applied once per counterparty, and the bond cap is applied once over the whole sum; a reimplementation that divides inside either loop disagrees in the last base unit.

### 6.3 The constants

Every bound is a named constant in the library.

| Constant | Value | What it stops |
| --- | --- | --- |
| `BPS` | `10_000` | The denominator of every ratio; no percentage or fraction appears anywhere |
| `MIN_WEIGHT_BPS` | `2_500` | A Settlement weighing its full value on the day it settled |
| `MAX_WEIGHT_BPS` | `10_000` | Reached once a Settlement has aged the full ramp |
| `RAMP_DAYS` | `30` | The span of the age ramp |
| `RAMP_SPAN_BPS` | `7_500` | `MAX_WEIGHT_BPS - MIN_WEIGHT_BPS`, the growth earned across the ramp |
| `BOND_CAP_BPS` | `9_500` | Credit ever reaching the capital at risk; `floor(B * 9500 / 10000) < B` for every non-zero `B` |
| `CONCENTRATION_BPS` | `2_500` | Any single Service carrying more than a quarter of an Agent's limit |
| `CONCENTRATION_DIVISOR` | `BPS / CONCENTRATION_BPS`, which is `4` | Both the multiplier in the closed form and the ceiling on counterparties at the cap |
| `MIN_COUNTERPARTIES` | `3` | A ring of two producing any growth above the baseline |
| `MAX_HISTORY` | `512` | An unbounded witness; the library reverts `HistoryTooLong` rather than truncating |
| `MAX_COUNTERPARTIES` | `32` | The same, reverting `TooManyCounterparties` |

`baseline` and `growthFactorBps` are deployment parameters rather than library constants, held as the immutables `BASELINE` and `GROWTH_FACTOR_BPS` on `TabBook`.

The age ramp uses floor division on the day count, which makes it a monotone non-decreasing step function, so compressing the same settled value into a shorter window can only lower the weighted total; and because a new record either fails a filter or adds non-negative value to a bucket, a Settlement can never lower the limit it extends.

### 6.4 The witness

Every limit read on `TabBook`, whether `creditLimit`, `headroom` or the check inside `recordDelivery`, takes a `LimitWitness` from the caller: the Agent's full ordered history in that Asset, plus one `BondEntry` per counterparty.

Neither half is trusted: the history is folded from zero into the same rolling hash the Settlement path writes, and a record added, dropped, reordered or edited reverts `HistoryCommitmentMismatch`, while a history of the wrong length reverts `HistoryLengthMismatch`.
Every Bond amount in the witness is discarded and read from `Bond.freeOf` at the moment of the call, and an entry naming a Service the Agent has neither settled with nor authorised reverts `IneligibleBondEntry`.
The witness can therefore choose which counterparties to cite and nothing else, and omitting one can only lower the limit.

### 6.5 Cold start, and why it is correct

An Agent with no history and no authorisations has no counterparties, therefore a Bond sum of zero, therefore a bond cap of zero, therefore a Credit Limit of zero.

Authorising a bonded Service changes that, because `_isCounterparty` admits a Service the Agent has authorised as well as one it has settled with.
A brand-new Agent that authorises one bonded Service gets `min(BASELINE, 95 % of that Service's free Bond)`, which is a Service's own decision to carry a stranger up to the baseline, backed by its own stake.
Anything above the baseline is earned by settled history with at least `MIN_COUNTERPARTIES` Curated, bonded Services.
This is the rule rather than a fault: a system that gave a brand-new identity credit on the strength of nothing would be giving it away, since identities are free.

### 6.6 No price feed exists

A Bond is denominated in the same Asset as the credit it unlocks, so a Bond and the credit it backs are the same unit and no exchange rate can move the ceiling.
A `BondEntry` in another Asset is skipped, never converted.

This is why there is no oracle in Tab: not because one was avoided as a matter of taste, but because the invariant was chosen so that none is definable.

---

## 7. Security analysis

### 7.1 The trusted set, and the bound on each member

The organising fact is that the trusted set contains parties who can admit a counterparty, meter inside a ceiling, serve a stale figure, or waste their own Bond, and contains no party who can claim that money arrived.

| Component | Trust granted | Bound on the damage |
| --- | --- | --- |
| Curation authority | Move a Service to the Curated tier, and nothing else | Can admit a colluding Service into credit computation. Cannot mint credit beyond that Service's Bond, move Agent funds, apply a Settlement, or touch a tab. Every change is queued 48 hours in public, and the role is a constructor argument with no setter |
| Service operator | Record deliveries against an Agent's tab; queue changes to its own prices, Collections, Assets and Window; fund and withdraw its own Bond | Can charge only inside an unexpired, Agent-set authorisation, at prices from its applied timelocked price list. Cannot lower a tab, mark one delinquent early, or read an Agent's balance |
| Registry operator | Index events and serve them over the read API | Can serve a stale figure or withhold one. Cannot serve a wrong Credit Limit, because every figure is cross-checked against `TabBook.creditLimit`, and nothing it serves is an input to any contract |
| Gateway operator | Hold the operator key and meter on its behalf | The same bound as the Service operator, plus the ability to waste gas on deliveries that revert |
| Deployer | One-shot wiring at deployment | Can mis-wire once, in public. Cannot re-point a wired contract, and the verification script reads every address back keylessly |

There is deliberately no component that can assert a Settlement.

### 7.2 What a malicious Service can do, and what a delinquent Agent costs

A Service operator holds a key that can charge, so the question is how far that reaches.
It can meter deliveries the Agent did not receive, at its applied prices, up to the `maxCumulative` the Agent set and no further.
That ceiling is the Agent's: the Service cannot raise it, extend it, or meter without it, so an Agent that sets `maxCumulative` to what it is willing to lose to a dishonest Service has bounded its exposure exactly, and letting the authorisation expire ends the relationship with no further transaction.
It cannot charge more than the price on chain, cannot change that price in less than 48 hours, and cannot vouch for an Agent's credit beyond its own Bond.

An Agent that never settles costs the Service the balance it carried, for the length of a Settlement Window the Service chose, against a Credit Limit capped by Bonds the Service and its peers posted knowingly.
Once the window closes, anyone may call `markDelinquent`, and from that block the Agent's Credit Limit in that Asset is zero everywhere in the deployment, not only with the Service it stiffed.
A Settlement that brings the tab back to zero lifts the mark in the same transaction, and nothing is taken from the Agent beyond that, because nothing of the Agent's was ever held.

### 7.3 Collusion is bounded, not eliminated

A bonded Curated Service and an Agent under common control can manufacture Settlement history.
This is true, and it is stated rather than hidden.

What the invariant buys is a ceiling.
The credit unlocked by any history is at most `floor(bondSum * BOND_CAP_BPS / BPS)`, which is strictly less than the Bonds the counterparties escrowed, so to unlock `X` of credit a ring must lock strictly more than `X` in `Bond`, in the same Asset, on Services holding the Curated tier.
Four further terms compound the cost.

- At least `MIN_COUNTERPARTIES` distinct Curated, bonded counterparties are required before any growth above the baseline.
- No single counterparty may contribute more than `CONCENTRATION_BPS` of the limit, so a ring needs breadth and not only depth.
- Age weighting gives a burst of self-settlement `MIN_WEIGHT_BPS` of the weight the same value carries once seasoned `RAMP_DAYS`.
- A Settlement counts only where a delivery on that tab strictly predates it, so the ring must also produce real metered records on chain, and pay gas for each.

The pure library guarantees the inequality over whatever Bond set it is handed, and `TabBook` guarantees that the set is the real counterparties of that Agent, read from the `Bond` ledger and never supplied by the caller.
A colluding ring's maximum extraction is therefore bounded by its own escrowed capital, which is a bound rather than a fix, and the honest way to describe it.

### 7.4 The one privileged role

Tab has exactly one privileged role, and naming it plainly is part of the design.
A curation authority decides which Services hold the Curated tier, and so which Settlement history carries Credit Limit weight, and it has no power over metering, over any tab, over any Settlement, or over any Bond.

Two things bound it.
Every change is queued and held for 48 hours behind a public `RegistryChangeQueued` event, so a promotion is contestable before it takes effect.
And the role cannot move: `ServiceRegistry` takes its authority as a constructor argument and exposes no setter, so it can change only at a deployment, by this project or by anyone.

The intended holder is `CurationMultisig`: an m-of-n owner set with an immutable owner list, a proposal identifier that is the hash of the call so duplicates accumulate confirmations rather than splitting them, and no `receive` and no `payable` function anywhere, so it can hold no value and a mistake in it cannot cost money it does not have.

### 7.5 Network-exposed services

The registry read API and the Dashboard's routes are unauthenticated by decision, because every field they serve restates a public chain fact.
The gateway's metering endpoint is different: it must authenticate the Service operator by signature and identify the Agent by the `Tab-Agent` header, because an unauthenticated metering endpoint would let anyone charge any Agent up to its authorisation ceiling.
Inside the SDK, `Tab-Agent` and `Tab-Authorisation` are treated as claims and never as authentication; `TabBook` derives the authorisation key itself, so a header cannot redirect a charge.

---

## 8. What runs on Monad Testnet

### 8.1 The deployment

Five contracts were deployed to Monad Testnet on 2026-09-21, starting at block 64486362, by `script/01_Deploy.s.sol`.
The sequence is `ServiceRegistry` with the curation authority as its only constructor argument, `Bond`, `TabBook` over the two with the credit parameters, `TabSettlement` over the registry and the book, the one-shot `setSettlementSurface`, and `MockUsdc`, a mintable six-decimal test token shipped to Testnet only.
The recorded parameters are a `BASELINE` of `5000000` base units, which is 5.00 of a six-decimal Asset, and a `GROWTH_FACTOR_BPS` of `5000`.
On Testnet the curation authority is the deploying account, and the addresses are in Appendix A with every transaction hash in `deployments.json`.

### 8.2 The test suite

`forge test` in `packages/contracts` runs 128 tests across 9 suites, all passing:

| Suite | Tests | What it covers |
| --- | --- | --- |
| `TabBook.t.sol` | 44 | Authorisation, the ordered checks in `recordDelivery`, prepaid consumption, `applySettlement`, the history fold, witness refusal, delinquency and its exact boundary, batching |
| `LimitLib.t.sol` | 21 | Worked examples on every bound, the filters, the age ramp, monotone append, burst versus spread, and the 512 and 32 limits |
| `CurationMultisig.t.sol` | 16 | Proposal, confirmation, revocation, threshold, and execution |
| `ServiceRegistryTimelock.t.sol` | 14 | Queue, apply, cancel, the 48-hour hold, and refusal at queue time |
| `ServiceRegistryRegistration.t.sol` | 9 | Permissionless registration, prices, Collections, Windows |
| `Bond.t.sol` | 8 | Deposit, `depositFor`, withdrawal, and `freeOf` |
| `property/Concentration.t.sol` | 6 | The concentration cap across every share and count |
| `DeploymentScripts.t.sol` | 5 | The deploy and verify scripts against a local chain |
| `property/BondInvariant.t.sol` | 5 | Credit strictly under the Bond sum, and zero Bond yielding zero credit |

Six of those are property tests run at 256 fuzz runs each under the default profile, covering the claims the credit model rests on: the limit never exceeds the bond cap, the concentration and bond rules compose, a zero Bond sum yields zero credit for any history, and the escrow balance equals the sum of free stake.

### 8.3 Keyless verification

`script/02_VerifyDeployment.s.sol` is a `view` run that reads every wired slot of the recorded deployment from both ends, so `TabBook` must name the deployed `ServiceRegistry` and `Bond`, `TabSettlement` must name `TabBook`, and `TabBook.settlementSurface` must be `TabSettlement`, and it reverts on the first disagreement.
It needs no key and no funded account, which is what makes the address table in Appendix A checkable by anyone with an RPC endpoint rather than only by whoever deployed it.

### 8.4 Gas, as measured

The figures below come from `forge test --gas-report` under forge 1.7.1, over the suite in Section 8.2, and are gas units rather than a fee in MON.
They are measured in the test harness rather than read from Testnet transactions, and because the suite exercises reverts the median, not the minimum, is the cost of a call that lands.

| Call | Median | Max | Calls in the suite |
| --- | ---: | ---: | ---: |
| `TabSettlement.settle` | 285,672 | 363,225 | 29 |
| `TabSettlement.settleBatch`, two tabs in two Assets | 505,404 | 505,404 | 1 landing call |
| `TabBook.recordDelivery` | 230,448 | 262,843 | 50 |
| `TabBook.authorise` | 70,477 | 70,477 | 101 |
| `TabBook.markDelinquent` | 71,338 | 71,338 | 13 |
| `Bond.deposit` | 59,202 | 76,350 | 1,135 |
| `Bond.withdraw` | 63,455 | 63,489 | 523 |
| `ServiceRegistry.registerService` | 219,480 | 271,498 | 83 |
| `ServiceRegistry.queueChange` | 145,466 | 211,410 | 77 |
| `ServiceRegistry.applyChange` | 47,038 | 69,723 | 65 |

Two figures bound the witness.
The largest history the library accepts, 512 records, evaluates in 1,157,452 gas in the `LimitLibHarness`, and 32 distinct counterparties evaluate in 172,627; both are external calls carrying the whole witness in calldata, so they are an upper bound on what a `view` read of `TabBook.creditLimit` costs for the same history.
Deployment costs in the same report are 3,109,831 gas for `TabBook`, 1,878,826 for `ServiceRegistry`, 1,031,785 for `CurationMultisig`, 488,498 for `Bond` and 442,209 for `TabSettlement`.

---

## 9. Boundaries

Every system has edges, and naming each one with the bound that says how far it reaches is more useful than naming it alone, because a boundary without its bound reads as either worse or better than it is.

| Boundary | The bound |
| --- | --- |
| One chain per deployment | A Settlement is a transfer on the chain the deployment lives on, and the contracts can observe no payment made anywhere else. That is also the reason the design holds. Mainnet and Testnet are separate deployments with separate addresses |
| Credit is backed by Service Bonds, never by Agent balances | Nothing reads an Agent's balance. A new Agent has zero credit, authorising a bonded Service lifts it to the bond-capped baseline, and everything above that is earned |
| Delinquency zeroes credit rather than taking anything | The mark lasts until the tab settles. The Service carries the unsettled balance, for at most the 24-hour Window it chose, and collection beyond that is outside the contracts as it is for any post-paid arrangement |
| The witness is rebuilt from logs, and it is bounded | A caller that cannot reach `HistoryExtended` logs cannot read a limit. `MAX_HISTORY` of 512 and `MAX_COUNTERPARTIES` of 32 revert loudly, and an Agent at the bound needs compaction |
| One curation authority | Queued 48 hours in public, powerless over metering, tabs, Settlements and Bonds, and unable to move without a redeployment |
| Collusion | Bounded by the colluding ring's own Bond sum, with at least 3 counterparties required and 25 % concentration |
| Timelocked changes take 48 hours | The guarantee an Agent gets when it reads a price, and the wait a Service pays to rotate a compromised Collection address, during which `TabSettlement` pays the address on chain |
| A Settlement of a tab that is not open banks as prepaid credit | The intended way to buy in, and also what happens to money sent to the wrong Service. It is never lost, it is visible on the Agent's page, and there is no refund path in the contracts |
| The registry serves a Credit Limit only where the cross-check agrees | A Dashboard page can show no Credit Limit for a moment; it cannot show a wrong one |
| Asset scope | `MockUsdc` on Testnet; USDC and AUSD on Mainnet. Multi-asset by construction, with no conversion anywhere, so credit in one Asset says nothing about credit in another |

### 9.1 Where a Service is, and who gets to say

`ServiceRegistry` records an operator, a tier, a Settlement Window, a bond account, Collection addresses and a price list, and no URL, because an address on chain would mean paying gas to move house and a dead link would become a permanent record no one can retract.
An Agent reaches a Service through an address in its own `tab.config`, which its operator controls, and a wrong address there reaches a wrong host with no charge, because only the registered operator can meter to the Agent's tab.
A provider publishes their address wherever they publish anything else, and any Agent that wants them adds it.
What is narrower is the convenience layer: `service-endpoints.json`, published by this project, is what lets the Dashboard offer a run command beside a listing, and a Service absent from it is still listed in full, shown without one.
Entering that file is a change to this repository, which is a centralised step inside an otherwise permissionless system, affecting one button on one website rather than anyone's ability to be called.

---

## 10. Related work

**Prepaid pay-per-call over HTTP 402.**
A growing family of schemes, x402 among them, returns `402 Payment Required` and releases the response once a payment or a signed payment intent arrives, typically through a facilitator that verifies and settles on the client's behalf.
Tab uses the same status code with the opposite semantics: the response has already been delivered, `402` appears only when a future charge would exceed a Credit Limit, and there is no facilitator because the ledger and the payment are one transaction.

**Session keys and scoped spending permissions.**
A session key delegates a bounded spending right from a wallet to an agent for a period, which solves the custody problem and not the credit problem, because the agent still spends a balance a human funded in advance.
Tab's `authorise` is the same shape of bound pointed the other way: it caps what a Service may charge, not what an Agent may spend, and it is what makes it safe to let a Service raise a tab at all.

**Escrow-based agent payments.**
Streaming, channel and escrow designs lock capital per counterparty in advance and release it as work is delivered, which is a prepayment with better ergonomics and produces no portable repayment record.
Tab escrows nothing from the Agent, ever; the only escrow in the system is the Service's Bond, which stands behind the credit it extends.

**Traditional credit scoring.**
Consumer credit rests on a bureau that aggregates repayment reports from lenders, each trusted to report truthfully, and on legal recourse when a borrower defaults, and neither is available to an autonomous agent.
Tab's substitute is a repayment history the chain itself applied, bounded by counterparty stake, which requires no bureau, no identity, no jurisdiction and no underwriter.

---

## 11. Roadmap

### 11.1 Monad Mainnet, with USDC and AUSD

Nothing in the rail is pinned to a testnet, and this is now demonstrated rather than asserted.
The same contracts and the same deployment sequence were run against Monad Mainnet, chain id 143, with an address change and no code change; `deployments.json` records both networks and `MONAD_CHAIN_ID` selects which one a process serves.
On Mainnet the deploy script ships no token, the Assets are the canonical USDC and AUSD recorded in `deployments.json`, and because a Bond and the credit it unlocks are the same unit, AUSD is a second, independent credit line per Agent with no conversion.

### 11.2 `CurationMultisig` as the authority

On Testnet the curation authority is the deploying account.
The Mainnet deployment names a `CurationMultisig` in the `ServiceRegistry` constructor instead, deployed first because the authority has no setter and construction is the only moment the choice can be made.
Its owner set is immutable for the same reason, so the three owners of that deployment are its three owners for as long as it holds the role.
That they are all held by one project today is a property of who deployed it and not of the contract, and it is recorded as such rather than implied away.

### 11.3 Batch settlement at the tool surface

`TabSettlement.settleBatch` and the strategy's `settleBatch` already settle several tabs in one transaction; what remains is to surface that through `tab_settle` and the CLI, so an Agent that owes three Services at the end of a task pays all three with one signature.

### 11.4 Smart-account signers through the strategy seam

`createMonadStrategy` takes a structural signer, anything that can report an address and send a transaction, rather than a wallet class.
A smart account with a session-scoped key satisfies the same seam, which would let an Agent settle under a policy its operator set without holding an unrestricted key, and the seam exists so that this is a wiring task rather than a redesign.

### 11.5 An indexer-backed 402 flow

Today a `402` carries the required amount and the headroom in `Tab-Charge-*` headers, and the Agent reads its Open Tab and prepaid credit through `tab_status`.
The registry indexer already holds everything an Agent needs to go from the refusal to the Settlement that lifts it, so the next step is a `402` body that carries it, and a client that settles from the refusal alone.

---

## 12. Conclusion

Credit for autonomous agents has been blocked on a verification problem rather than on a financial one.
The financial mechanism has been well understood for centuries: consume first, accrue a record, and let the record earn the right to consume more.

What has been missing is a ledger that can see the repayments for itself; every substitute has terminated in a trusted party, and a credit facility resting on a trusted party is extending credit against an operator's word rather than against a repayment history.
On Monad the transfer and the ledger entry are one transaction, final in under a second, with gas cheap enough to meter every delivery on chain.
Tab is what that makes buildable: a post-paid billing rail whose repayment history is the chain's own record, whose credit ceiling is bounded by capital at risk, and which contains no price feed, no oracle, and no party permitted to say that money arrived.

It is deployed, its suite passes, and every claim in this paper is checkable without a key.

---

## Appendix A: deployed addresses

All addresses were read back off the chain by the keyless verification script and are recorded in `deployments.json`.

### Monad Testnet, chain id 10143

| Contract | Address |
| --- | --- |
| `ServiceRegistry` | `0x123c19F46C38d5b4E922D1297250a71A03DFFD17` |
| `Bond` | `0x4F791F13F94944fCB2F884f8C7991cAa583884A6` |
| `TabBook` | `0xbA86C0D053ba88afDECbED8aBa5b2eC3973fb230` |
| `TabSettlement` | `0x0Dabf8E52280D0F128f546602a99b6DC4fbb80DC` |
| `MockUsdc` | `0x5d519A1E8cF4Edd7067FD631047E6869E9a7e4fE` |

Deployed at block 64486362 on 2026-09-21; `LimitLib` is a pure library, linked at compile time, and holds no address of its own.
The curation authority on Testnet is the deploying account, `0x49472EF9ED99f30d4eaD45Ac9E1C16c31f70783A`.
RPC `testnet-rpc.monad.xyz`, explorer `testnet.monadvision.com`.

### Monad Mainnet, chain id 143

No Tab contract is deployed yet.
The Assets a Mainnet deployment settles in are the canonical USDC at `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` and AUSD at `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`.

---

## Appendix B: reproducing every claim

Each command needs an RPC endpoint and nothing else.
No private key, no funded account, no write.

```bash
pnpm install
pnpm env:bootstrap        # writes .env from .env.example plus the recorded addresses

# the whole deployment, read back from both ends of every wired slot
cd packages/contracts && set -a && source ../../.env && set +a
forge script script/02_VerifyDeployment.s.sol:VerifyDeployment --rpc-url monad_testnet --sig "run()"
cd ../..

# 128 contract tests, including the property tests; add --gas-report for Section 8.4
pnpm --filter @tabai/contracts test

# the whole workspace
pnpm test
```

The verification is a `view` run and reverts on the first wired slot that disagrees; the gas table in Section 8.4 is `forge test --gas-report` from `packages/contracts`, and the suite tally in Section 8.2 is the last line of `forge test`.

---

## References

1. EIP-20: Token Standard.
2. EIP-1193: Provider JavaScript API, the wallet interface the Dashboard signs through.
3. HTTP 402 Payment Required, as defined by the HTTP semantics specification.
4. Model Context Protocol, the interface `tab_discover`, `tab_call`, `tab_status` and `tab_settle` are served over.
5. Web Content Accessibility Guidelines (WCAG) 2.1, the contrast floor every interface colour pair is linted against.
6. Tab source, documentation and deployment record. This repository, MIT licensed.

---

<p align="center">
  <sub>Tab · Emad Qureshi · MIT</sub>
</p>
