# `@tabai/agent-demo`

Two agents trading over the rail, end to end, against the deployed contracts on Creditcoin CC3 Testnet and Ethereum Sepolia.

Nothing here is a mock.
The tabs are real tabs, the settlements are real USDC, and the proof that a settlement happened is a Continuity Proof the chain checks for itself.

The demo is a story in four acts.
Each act reads the chain before and after itself and prints what moved, so the claim it makes is visible rather than asserted.

**It is read-only by default.**
Without `--broadcast` every act reads, simulates what it would submit, and spends nothing.
That is not caution for its own sake.
A refused `recordDelivery` costs real CTC and returns the same revert data a free `eth_call` returns, so paying for it first would be paying for information already available.

---

## The four acts

**Act one. Each Agent states what it is willing to owe.**
An Agent sets its own spending authorisation on `TabBook`: a Service, an Asset, a ceiling and an expiry.
Only the Agent can set it, and it is the only thing standing between a Service's operator key and the Agent's whole credit line.

**Act two. The agents buy something and pay for none of it.**
Each Agent makes an ordinary HTTP request to the Service's metered endpoint.
The Service does the work, returns the response, and *then* records the charge against the Open Tab.
No caller prepays and no response is withheld.
The one status the rail adds is a `402` when a charge would exceed the Credit Limit, which is a credit decision rather than a demand for payment.

**Act three. Each Agent pays its own tab, with its own key.**
The Agent moves USDC on Sepolia to the Collection Address the Service registered.
That transfer *is* the settlement.
Nothing is escrowed, no contract on the Source Chain is involved, and the Agent needs nobody's permission.
The Watcher then observes the log, waits for the height to be attested, folds a Continuity Proof and submits it, and the Open Tab falls.

**Act four. The account that pays is not the account that sends.**
A smart account holding USDC settles on one Agent's behalf while a *different* Agent's wallet sends the transaction.
Credit must land on the Agent bound to `topics[1]` and on nobody else.

---

## Why act four is the interesting one

An ERC-20 `Transfer` puts the **token holder** in `topics[1]`.
For a wallet moving its own tokens the holder and the transaction sender are the same account, so the two can never be told apart, and a verifier that reads either one looks correct.

A contract that holds the Asset and moves it on somebody else's instruction separates them.
The contract is `topics[1]`; whoever called is `from`.
That is the relayer case, the sponsored-gas case and the smart-account case, and it is the reason requirement 8 exists at all.

This act stages the strongest form of the claim, where **both** addresses are bound and to different agents:

| role | address | bound to |
| --- | --- | --- |
| `topics[1]`, the token holder | the smart account | Bex |
| `from`, the transaction sender | Ada's own wallet | Ada |

The verdict has two halves and both must hold.
The Agent this settlement credited is Bex, and the whole amount moved reached it.
The Agent that sent the transaction, Ada, is not the Agent it credited.

The negative half carries most of the weight.
A verifier resolving the payer from the transaction sender, as the canonical Attestcoin base pattern does, would fail it while quite possibly satisfying the positive half by accident.

**The verdict reads this settlement's own event, not a before-and-after of two tabs.**
`TabBook.SettlementApplied` carries the replay key and the credited Agent in indexed topics, so it is the rail stating in public which Agent one specific settlement paid for.
That distinction is not pedantry.
An earlier version of this demo compared readings taken before and after, and duly failed itself when Ada's own unrelated act-three settlement was proved while act four was waiting: a window cannot tell one settlement from another that landed inside it.
The act still prints both agents' deltas, but as colour rather than as evidence, and says so.

The contract is [`SourceRelay.sol`](../../packages/contracts/test/live/SourceRelay.sol), already deployed to Sepolia for the live negative-path suite.
It is reused rather than replaced: Tab deploys exactly one contract to a Source Chain and a second would misrepresent the deployment surface.

---

## Running it

```bash
pnpm --filter @tabai/agent-demo build
node --env-file=.env examples/agent-demo/dist/main.js --help
```

A first look, which reads the chain and writes nothing:

```bash
node --env-file=.env examples/agent-demo/dist/main.js --act stage
```

That prints both agents' positions and names every precondition that is not met, together with the act it would have broken.
Start there.
A demo that fails halfway because one address was never bound teaches nobody anything.

The whole story, still read-only:

```bash
node --env-file=.env examples/agent-demo/dist/main.js
```

One act, for real:

```bash
node --env-file=.env examples/agent-demo/dist/main.js --act settle --agent Ada --broadcast
```

Narration goes to stderr and a machine-readable result goes to stdout, so a run can be watched by a person and piped into `jq` at the same time.

### Flags

| flag | meaning |
| --- | --- |
| `--act <id\|n\|all>` | one act, or all four. `stage`, `authorise`, `consume`, `settle`, `smart-account`, and the setup act `bind`. |
| `--broadcast` | submit transactions. Without it nothing is spent. |
| `--agent <name>` | restrict to one Agent by short name. |
| `--units N` | units of the priced tool to buy in act two. |
| `--amount N` | settlement size, in Asset base units. Never a decimal. |
| `--ceiling N` | authorisation ceiling, in base units. |
| `--ttl N` | seconds until the authorisation expires. |
| `--wait N` | seconds to wait for the Watcher to prove a settlement. |
| `--gas N` | override a stated gas limit. |

Exit codes: `0` every act made its claim, `1` an act did not, `2` the run could not start.

---

## Setting the stage

Nothing works until each Agent's Source Chain addresses are bound to it.
A tab is keyed by an Agent's Creditcoin address, a settlement arrives as a log on another chain, and the only thing joining the two is a binding.
An unbound address resolves to nobody and the payment credits nobody.

The proof of control is a payment of an **exact odd amount**.
The registry issues a nonce, the amount encodes it, and the address being bound must be the one that pays it.
Nobody signs a challenge and no oracle is trusted: the ability to move that address's money is the evidence, checked through the same Continuity Proof path as every other settlement.

```bash
node --env-file=.env examples/agent-demo/dist/main.js --act bind --agent Bex --broadcast
```

`bind` is not part of the story and is excluded from `--act all`, because it spends a nonce and should never happen because somebody ran the demo twice.
It is idempotent: an address already bound is left alone, and a request already open is reported with the amount still owed rather than replaced.

The binding completes only once the Watcher proves the payment:

```bash
node --env-file=.env --import tsx apps/watcher/src/bin/pipeline.ts --persist --submit
```

Attestation lands on a ten-block stride, so this can take minutes through nobody's fault.

---

## A cold-start Agent has to settle before it can buy

`LimitLib` caps an Agent's credit by the Bonds of the counterparties it already has proven settlement history with.
An Agent with no history has no counterparties, a bond cap of zero, and therefore a Credit Limit of zero.
That is the rule rather than a fault: curation tier gates how much history weighs, and the Bond gates whether credit exists at all.

So a brand-new Agent meets a `402` in act two, and act two says so in those words rather than reporting a broken call.
Its first settlement banks prepaid credit and creates the history a limit is computed from, and from then on it buys on credit like anybody else.
Running acts one, three, then two in that order is the cold-start path; the story order in `--act all` is the established-Agent path.

The binding payment of the setup act is itself a settlement, so an Agent that has just been bound has usually crossed that line already.

## Three behaviours worth watching for

**A metered delivery spends banked credit before it raises the Open Tab.**
An Agent holding prepaid credit from an over-payment sees that balance fall and its tab stay flat.
The act prints the split rather than reporting only the tab, because reporting only the tab would make a working charge look like a charge that never happened.

**One `settle` call emits two logs.**
On chainKey 1 a `TabSettlement.settle` emits the `Transfer` that funded it *and* its own `TabSettled`, and the deployed registry authorises both the Asset and the settlement contract as emitters.
Both the verifier and the Watcher de-duplicate that pair, so one payment is credited once.
This demo settles by moving the Asset directly, which produces exactly one recognised log per settlement and keeps the counts it prints meaning what they say.

**A settlement the Watcher cleared first reports `applied = 0`.**
A Provisional Clearing takes the amount off the Open Tab immediately, against the Service's pledged Bond, so that by the time the proof lands there is nothing left to apply and only the excess is banked.
`SettlementApplied` therefore carries `applied = 0` and `toPrepaid = amount - reduced`, and the covered part is on the clearing record rather than in the event.
The acts read both and print all three figures, because `applied + toPrepaid` alone looks like a settlement that lost money.

---

## What the demo holds, and what it does not

A read-only pass touches **no key at all**.
Every claim it prints can be checked by somebody holding nothing but the repository and an RPC URL.
Only `--broadcast` reaches for a key, and it reaches for exactly the role that act needs.

Act two is the exception worth stating plainly.
The gateway holds the operator key that can charge any Agent up to its whole ceiling, so it refuses an unsigned metered request.
That signature is the **Service** saying "I delivered this and I am charging for it"; the Agent signs nothing.
A single-machine walkthrough therefore has to play both parts, and this act mints that signature the way the Service's own front door would.
In a real deployment the two halves sit on different machines and the Agent never sees the operator key.

The digest that signature covers is a second copy of the gateway's own, because this package may not depend on the gateway.
It is defended by a test that pins the exact string, so a change on the gateway's side that this package did not follow becomes a failing assertion here rather than an unexplained `401` in a live run.

---

## Environment

Everything comes from `.env`, and `.env.example` is the tracked contract.
The demo's own variables are in the `Agent demo` block at the end of it.

Each Agent's addresses are declared rather than derived from a key, unlike `AGENT_CREDITCOIN_PRIVATE_KEY` elsewhere in the workspace.
That is deliberate: the default mode must work for somebody holding no key, and deriving an address from a key they do not have would make the keyless path impossible.

The demo refuses to start on the zero address, because the deployment slots in `.env.example` ship as zero and an unfilled copy would otherwise fail much later as a call to an account with no code.

---

## Tests

```bash
pnpm --filter @tabai/agent-demo test
```

The tests cover the parts with a claim in them and no chain at all: resolving the cast and every way it refuses, the ledger arithmetic, the payer-resolution verdict of act four, naming one settlement out of a receipt, the readiness assessment, the authorisation judgement, the smart-account casting, the metering digest, the command line, and both waiting loops with their clock, sleep and reader injected.

`resolvePayerVerdict` is the one to read first.
Its cases are the ones a live run can never stage on demand: the sending Agent credited, a third Agent credited, a partial credit, and the degenerate casting where one Agent plays both roles.
A claim that is only ever observed once, live, on the happy path is not a tested claim.

`locateSettlement` is the second.
A replay key packs the log's position within its **own receipt**, never the block-wide `logIndex`, and the two agree only for the first transaction in a block.
Taking the wrong one produces a key that names a different settlement or none, and nothing in the output would look wrong.
