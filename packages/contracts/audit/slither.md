# Slither static analysis

Slither reports 56 results over the five deployed contracts and `LimitLib`.
None of them is an exploitable vulnerability.
One is a true positive, a gas optimization with no security impact; 29 are false positives; 26 are accepted by design.
A manual read of the same code, done to triage the results, found one liveness limit Slither does not model, described under [Beyond the detectors](#beyond-the-detectors).

The raw machine output is [`slither.json`](./slither.json), and every result in it is triaged below.

## What was run

| | |
| --- | --- |
| Date | 2026-09-30 |
| Source | `packages/contracts/src` at commit `6430db9`, the source the Mainnet and Testnet contracts were deployed from |
| Tool | `slither-analyzer` 0.11.6 with `crytic-compile` 0.4.2, Python 3.14.7, all 102 detectors |
| Compiler | solc 0.8.23 through Foundry 1.8.1, optimizer on at 200 runs, EVM `shanghai`, as in `foundry.toml` |
| Command | `pnpm --filter @tabai/contracts audit:slither`, which runs [`tools/slither.mjs`](../tools/slither.mjs) |
| Configuration | [`slither.config.json`](../slither.config.json) |

`tools/slither.mjs` compiles once with the OpenZeppelin remapping made absolute and hands Slither that build.
With the relative remapping in `foundry.toml`, forge names each OpenZeppelin file twice in the build info, and Slither then cannot resolve references such as `IERC20`.
The findings are identical either way; the script exists so the published analysis is one in which every reference resolved.

## Scope

In scope: `Bond.sol`, `CurationMultisig.sol`, `LimitLib.sol`, `ServiceRegistry.sol`, `TabBook.sol`, `TabSettlement.sol`.

Out of scope, filtered by `slither.config.json`: `lib/` (Permit2 interfaces, forge-std), OpenZeppelin under `node_modules/`, `test/`, `script/`, and `src/test/MockUsdc.sol`.
`MockUsdc` is a Testnet-only mock that is not deployed on Mainnet.
A separate pass over it alone reports 4 results (`unused-return`, `timestamp`, `low-level-calls`, `naming-convention`), all test-only and none affecting the in-scope contracts.

## Summary

| Detector | Impact | Confidence | Count | Verdict |
| --- | --- | --- | --- | --- |
| `divide-before-multiply` | Medium | Medium | 1 | Accepted by design |
| `incorrect-equality` | Medium | High | 8 | False positive |
| `uninitialized-local` | Medium | Medium | 8 | False positive |
| `calls-loop` | Low | Medium | 8 | Accepted by design |
| `reentrancy-events` | Low | Medium | 3 | False positive |
| `timestamp` | Low | Medium | 16 | 6 accepted by design, 10 false positive |
| `cyclomatic-complexity` | Informational | High | 1 | Accepted by design |
| `low-level-calls` | Informational | High | 1 | Accepted by design |
| `naming-convention` | Informational | High | 9 | Accepted by design |
| `immutable-states` | Optimization | High | 1 | True positive, no security impact |
| **Total** | | | **56** | **1 true positive, 29 false positive, 26 by design** |

No detector of High impact fired.
No `reentrancy-eth`, `reentrancy-no-eth` or `reentrancy-benign` result exists, because no function in scope writes state after an external call.
No `arbitrary-send-erc20` result exists, because every `safeTransferFrom` names `msg.sender` as the source, and the Permit2 path binds the source to the Agent's own signature.

## Findings

### divide-before-multiply (1)

**Location:** `LimitLib.ageWeightBps`, `src/LimitLib.sol:282` and `:287`.

**Slither:** `ageDays = (evaluatedAt - settledAt) / 86400` is later multiplied in `MIN_WEIGHT_BPS + (RAMP_SPAN_BPS * ageDays) / RAMP_DAYS`.

**Verdict: accepted by design.**
The age is floored to whole days on purpose, so the weight is a step ramp that changes once a day.
The documented rounding convention (`src/LimitLib.sol:23-42`) fixes that order so the off-chain reimplementation matches bit for bit, and every truncation rounds the Credit Limit down.
Within line 287 the multiplication already precedes the division.

### incorrect-equality (8)

**Locations:** `src/ServiceRegistry.sol:214` (`kind == ChangeKind.Tier` in `_authoriseChange`), `:243`, `:245`, `:248`, `:254` (the `kind` dispatch in `_writeChange`), `:279` (`window == 0`), `:290` and `:342` (`baseUnits == 0`).

**Slither:** a strict equality on a value it considers dangerous.

**Verdict: false positive.**
The detector fires on `==` over values it believes derive from `block.timestamp` or a balance.
None of these do: each compares an enum or a caller-supplied payload field against a constant.
The taint comes from `applyChange` (`src/ServiceRegistry.sol:194`), which loads a `PendingChange` whose `eta` field was computed from `block.timestamp` at line 186; Slither's data dependency is not field-sensitive, so `kind` and `payload` in the same struct inherit the taint.
No balance is compared anywhere in `ServiceRegistry`.

### uninitialized-local (8)

**Locations:** `src/LimitLib.sol:197` (`ids`), `:198` (`buckets`), `:199` (`n`), `:247` (`contributions`), `:248` (`total`), `:307` (`sum`), `:371` (`prefix`); `src/TabBook.sol:595` (`root`).

**Slither:** a local variable never initialized.

**Verdict: false positive.**
Each is an accumulator or a fixed-size memory array that relies on Solidity's zero default, which is the value it must start at.
`root` in `_requireWitness` must start at `bytes32(0)` because `_extendHistory` folds the stored commitment from the zero default of `_historyRoot` (`src/TabBook.sol:532`), and the witness is accepted only if the two folds agree.

### calls-loop (8)

**Locations:** `TabBook._stakedOf`, `src/TabBook.sol:646-647`, reached from the loop in `_resolveBonds` (`:614`) on the `recordDelivery`, `creditLimit` and `headroom` paths (6 results); `TabSettlement._apply`, `src/TabSettlement.sol:194-195`, reached from the loop in `settleBatch` (`:126`) (2 results).

**Slither:** external calls inside a loop.

**Verdict: accepted by design.**
Every call targets an immutable, trusted contract of the same deployment (`REGISTRY`, `BOND`, `BOOK`), none of which calls out to anything else.
The `_resolveBonds` loop is bounded at 32 entries (`src/TabBook.sol:612`), and a revert inside it, for example `UnknownService` for a bogus entry, fails only the caller's own witness.
`settleBatch` is the caller's own batch, paid for by the caller, and is atomic on purpose: one refused Settlement reverts the whole batch rather than leaving it half applied.
Neither loop lets one party block another.

### reentrancy-events (3)

**Locations:** `TabSettlement._apply`, `src/TabSettlement.sol:195-196`; `TabSettlement.settleWithPermit2`, `src/TabSettlement.sol:157-158`; `CurationMultisig.execute`, `src/CurationMultisig.sol:172-177`.

**Slither:** an event is emitted after an external call.

**Verdict: false positive.**
In `TabSettlement` the call before each event is `BOOK.applySettlement`, the immutable `TabBook`, which calls only the registry and `Bond` views and cannot re-enter.
The events carry the `settlementId`, `applied` and `toPrepaid` that call returns, so they cannot be emitted before it.
The ordering that matters is effects before interaction, and it holds: `_apply` updates the book first and the token moves last, in `settle` (`:114-115`), `settleBatch` (`:128-130`) and `settleWithPermit2` (`:157-159`).
A token that re-entered during the transfer would find `TabSettlement` holding no state and no balance; the most it could do is start another complete Settlement, paired with its own transfer, which `TabBook` records like any other.
A transfer that reverts unwinds the ledger entry in the same transaction.
In `CurationMultisig.execute`, `executed` is set before the call (`src/CurationMultisig.sol:170`), so a re-entering target finds a terminal record; the event follows the call because it carries the call's return data.

### timestamp (16)

**Slither:** `block.timestamp` is used in a comparison.

**Accepted by design (6):**

| Location | Comparison | Why the clock is the right input |
| --- | --- | --- |
| `ServiceRegistry.applyChange`, `src/ServiceRegistry.sol:196` | `block.timestamp < change.eta` | the 48-hour timelock on every registry change; a timestamp skew of seconds is immaterial against 48 hours |
| `TabBook.authorise`, `src/TabBook.sol:262` | `expiry <= nowTs` | refuses an authorisation that is already expired |
| `TabBook._consumeAuthorisation`, `src/TabBook.sol:453` | `auth.expiry < nowTs` | the expiry the Agent set on its own authorisation |
| `TabBook.markDelinquent`, `src/TabBook.sol:340` | `block.timestamp < windowEnd` | the Settlement Window, up to 24 hours, closing on the chain's own clock |
| `TabBook.headroom`, `src/TabBook.sol:412` | `limit > open` | the limit ages Settlements in whole days through `evaluatedAt = _now()` |
| `TabBook._requireHeadroom`, `src/TabBook.sol:471-472` | `projected > limit`, `limit > open` | the same limit, on the metering path |

The last two are genuinely time-dependent through the age weighting.
The most a block producer's timestamp latitude can do there is move one Settlement across a day boundary, a single step of 250 basis points in that record's weight, in either direction.

**False positive (10):** `ServiceRegistry._authoriseChange` (`:214`), `_writeChange` (`:243`, `:245`, `:248`, `:254`), `_decodeTier` (`:270`), `_decodeWindow` (`:278-280`), `_decodePrice` (`:289-290`), `_decodeEntry` (`:300`), `_decodeMove` (`:311`), `_acceptAsset` (`:335`), `_setToolPrice` (`:342`), and `TabBook._requireWitness` (`src/TabBook.sol:600`).
None of these comparisons involves time.
The `ServiceRegistry` results share the root cause of the `incorrect-equality` results above: the `PendingChange` loaded in `applyChange` carries a timestamp-derived `eta`, and the taint spreads to its other fields.
In `_requireWitness`, `root != stored` compares two hashes; `stored` is tainted only because `_extendHistory` folds the settlement time into it.

### cyclomatic-complexity (1)

**Location:** `LimitLib.creditLimit`, `src/LimitLib.sol:189-262`, complexity 16.

**Verdict: accepted by design.**
The function is six documented steps with four independent history filters, each closing a distinct way of manufacturing credit.
It is pure, bounded at 512 records and 32 counterparties, and covered by unit and property tests, including the bond-cap invariant and the concentration cap.

### low-level-calls (1)

**Location:** `CurationMultisig.execute`, `src/CurationMultisig.sol:172`.

**Verdict: accepted by design.**
A multisig makes an arbitrary call by definition.
The call is reachable only once the threshold of owner confirmations is recorded, the success flag is checked, and the target's revert data is carried out in `CallReverted` (`:175`).
The contract has no `receive` and no `payable` function, so no value is ever forwarded.

### naming-convention (9)

**Locations:** `CurationMultisig.THRESHOLD` (`src/CurationMultisig.sol:66`); `TabBook.WIRING_AUTHORITY`, `REGISTRY`, `BOND`, `BASELINE`, `GROWTH_FACTOR_BPS` (`src/TabBook.sol:204-210`); `TabSettlement.REGISTRY`, `BOOK`, `PERMIT2` (`src/TabSettlement.sol:49-52`).

**Verdict: accepted by design.**
Immutables are named in upper case throughout, the same as constants, because neither can change after deployment.
The names are also the public getters of the deployed ABI.

### immutable-states (1)

**Location:** `ServiceRegistry.curationAuthority`, `src/ServiceRegistry.sol:129`.

**Slither:** the variable should be immutable.

**Verdict: true positive, optimization only.**
It is assigned once in the constructor (`:140`) and has no setter, so `immutable` would be correct.
The cost is one storage read in `_authoriseChange` for Tier changes and in the public getter.
There is no security impact: no code path can write the slot after construction.
Changing it needs a new deployment, so it is recorded for the next one.

## Beyond the detectors

These come from reading the code to triage the results above, not from Slither.

**History bound locks metering after 512 Settlements (Medium, liveness; not exploitable by a third party).**
`TabBook` requires the witness to carry the Agent's full history in an Asset (`src/TabBook.sol:592`), and `LimitLib` refuses more than 512 records (`src/LimitLib.sol:194`).
`recordDelivery` reads the limit on every call (`src/TabBook.sol:285`), even when prepaid credit covers the whole charge.
So from an Agent's 513th Settlement in an Asset, every delivery to that Agent in that Asset reverts `HistoryTooLong`, and any prepaid credit left on its tabs in that Asset can no longer be spent.
The deployed contracts have no way to compact a history, so the remedy is a new Agent address.
Settlements themselves still apply, and no funds are taken or locked.
Only the Agent can reach the bound: `settle` settles for `msg.sender`, and `settleWithPermit2` needs the Agent's own signature.
A throwaway Foundry test on the repository's own `TabBook` fixture confirmed it: at 512 records a delivery succeeds, using about 3.27 million gas and a 114,944-byte witness, and after the 513th Settlement the same delivery reverts `HistoryTooLong(513, 512)`.
The documentation already states the bound; this records its consequence.

**Bond credits the nominal amount (Informational).**
`Bond._deposit` credits `amount` and then pulls it (`src/Bond.sol:75-77`), and accepts any token address (`:72`).
With a token that charges a fee on transfer, a depositor would be credited more than the escrow received and could withdraw the difference from other parties' deposits of the same token.
USDC, AUSD and the Testnet mock charge no such fee, so the deployed Bond is not exposed.

**A multisig call can execute only once (Informational).**
`CurationMultisig` keys a proposal by the hash of its target and calldata, and execution is terminal (`src/CurationMultisig.sol:106-108`, `:123`).
Queuing an identical Tier change a second time, for example re-curating a Service after demoting it, therefore reverts `AlreadyExecuted`.
The ABI decoder ignores trailing calldata, so appending a byte to the calldata gives a distinct proposal with the same effect.

**A comment overstates the curation role (Informational).**
The NatSpec at `src/CurationMultisig.sol:7-9` says the curation authority can queue changes to prices, Collection addresses, accepted Assets and Settlement Windows.
The code is narrower: `ServiceRegistry._authoriseChange` (`src/ServiceRegistry.sol:214-218`) gives it Tier changes only, and every other kind of change answers to the Service operator.

## How to reproduce

Slither is not a dependency of this repository; install it isolated from PyPI.

```bash
git submodule update --init
pnpm install --frozen-lockfile
python3 -m venv ~/.venvs/slither && ~/.venvs/slither/bin/pip install slither-analyzer==0.11.6
cd packages/contracts
SLITHER_BIN=~/.venvs/slither/bin/slither node tools/slither.mjs
```

The script prints Slither's human-readable report, rewrites `audit/slither.json` with repository-relative paths, and ends with a count per detector.
`git diff audit/slither.json` then shows any change against the results triaged here.
