# Contributing to Tab

Everything here is the detail behind the gate table in the [README](./README.md).
It lives in its own file so the README stays something a reader can finish.

## Prerequisites

- Node `>= 20.10.0`
- pnpm `9.15.3`, pinned through the root `packageManager` field. Never npm.
- Foundry (`forge`, `cast`, `anvil`) for the Solidity work
- A Creditcoin CC3 Testnet RPC endpoint. The public one in `.env.example` is the default.

Pinned dependencies, asserted exactly in CI:

| Package | Version |
| --- | --- |
| `@gluwa/usc-sdk` | `0.18.0` |
| `@gluwa/usc-contracts` | `0.1.2` |
| `@openzeppelin/contracts` | `5.4.0` |
| `ethers` | `^6`, resolved to a single version in the lockfile |

## Getting set up

```bash
pnpm install
pnpm env:bootstrap        # .env from .env.example, with the recorded addresses filled in
pnpm hooks:install        # git config core.hooksPath .githooks
```

**Nothing loads `.env` for you.**
No process in this repository uses dotenv.
Run a driver as `node --env-file=.env <script>`, and a `tsx` entrypoint as `node --env-file=.env --import tsx <script.ts>`.
A driver started without it fails naming the first variable it could not read, which reads like a misconfiguration rather than a missing flag.

## The environment contract

`.env.example` is the tracked contract for every variable the workspace reads.
CI extracts every `process.env.*` and `vm.envOr` reference in the tree and fails the build when one is missing from that file.

It holds zero-address placeholders rather than values, deliberately: it is the contract for variable *names*, and a template that carried values would go stale silently the first time anything was redeployed.
`pnpm env:bootstrap` is what turns it into a working `.env`, by substituting the addresses `deployments.json` records.
It refuses to overwrite an existing `.env`, because that file holds private keys on any machine that has settled anything.

```bash
pnpm env:check            # every process.env read is declared
pnpm env:list             # print the declared set
pnpm deployments:check    # deployments.json and .env.example describe one deployment
```

## The vocabulary gate

The repository carries an editorial gate.
It fails the build when prohibited terminology appears anywhere git considers part of the tree, in file contents, in filenames, or in directory names, so every document, comment, identifier and string speaks about Creditcoin, the Attestcoin Protocol and Tab in Creditcoin's own vocabulary.

```bash
pnpm vocab:check                             # everything git tracks, plus untracked paths git does not ignore
node scripts/vocab-check.mjs --staged        # staged paths only, which is what the hook runs
node scripts/vocab-check.mjs --files a b c   # an explicit set
pnpm vocab:denylist                          # write the denylist file from VOCAB_DENYLIST
```

Exit codes are `0` clean, `1` at least one match, `2` the gate could not run.
Each match prints `path:line:column`, the term, and the offending line with the match marked; line `0` marks a match in the path itself.
Matching is case-insensitive on word boundaries.
Binary payloads are skipped by extension and by content sniffing, and every skip is listed in the summary rather than passing unseen.

The denylist is a secret and is never committed.
It lives in the gitignored `.vocabulary-denylist` file, one term per line.
In CI it is materialised at job start from the `VOCAB_DENYLIST` repository secret; locally, keep your own copy of that file or export the same variable and let the script write it.
**With no denylist in place the gate exits `2` rather than passing**, because a gate that passes vacuously is worse than no gate.

Lockfiles, the denylist file, `node_modules`, `.git`, `out`, `dist`, `.next`, `cache` and `broadcast` are out of scope, as is everything `.gitignore` excludes.

The pre-commit hook runs the same script over staged paths only, so a commit stays fast and a violation is caught before it enters history.

## The coverage gate

The Creditcoin contracts carry per-contract line-coverage floors, enforced in CI inside the `contracts` job rather than read off a terminal by hand.

| Tier | Contracts | Floor |
| --- | --- | --- |
| Money-handling | `SettlementVerifier`, `TabBook`, `LimitLib`, `Bond` | 90 % of lines |
| Setters and bookkeeping | `AgentRegistry`, `ServiceRegistry` | 75 % of lines |

The lower tier is a stated trade rather than an oversight: those two are predominantly setters and timelock bookkeeping, so the marginal safety of the last fifteen points does not justify the time.
The reason is recorded in the script itself, so a threshold never travels without it.

```bash
pnpm coverage                                     # measure, then gate. The one CI command
pnpm coverage:check                               # gate the report already on disk
pnpm coverage:floors                              # print the floor table and stop
node scripts/check-coverage.mjs --report PATH     # gate a report elsewhere
```

Exit codes are `0` every floored contract meets its floor, `1` at least one sits below it, and `2` the gate could not run, meaning no report, an unparseable report, or a floored contract missing from the report.
That last case matters: a gate that reports success because it could not find its subject is worse than no gate.
Every contract in the report is printed with its measured figure beside the floor that applies to it, whether it passes or fails, and the files that carry no floor are printed too, with the reason each is unfloored.

The gate reads lines only and never branches.
`ServiceRegistry` alone compiles through the Yul pipeline under the `coverage` profile, which is what stops the coverage decoder running out of stack, and branch attribution under that pipeline drops instrumentation it cannot place.
It understates and never overstates, so a line gate can fail earlier than the truth warrants but cannot be talked into passing a real gap, while a branch floor would fail on the compilation strategy instead of on a testing gap.

Measuring takes several minutes and the report is gitignored, so the two halves are separate commands: `pnpm coverage:check` re-gates an existing report in well under a second while you iterate, and `pnpm coverage` does both for CI.

## The README art

The eight figures in the README and the social card are generated, committed, and contrast-audited.
White paper, near-black ink, and one accent hue measured from the brand mark rather than chosen, plus the real brand mark itself, composited in its own colours from the 4k master.
Layout is measured from rendered text metrics rather than estimated, and the README figures export at twice their layout size so they stay sharp on a high-density display.

See [`assets/README.md`](./assets/README.md) for the palette derivation, the resolution model and the layout rules.

```bash
python3 -m venv tools/.venv                                        # one-time
tools/.venv/bin/python -m pip install -r tools/requirements.txt    # Scripts/python.exe on Windows
pnpm art                                                           # regenerate
pnpm art:check                                                     # detect drift, write nothing
```

Python is a local authoring tool here, not a build or CI dependency: the PNGs are committed because GitHub renders a README from the repository rather than from a build.
The generator refuses to run rather than substituting a font it cannot find, because every width in the layout is measured from the real face.

## Running the rail locally

```bash
pnpm --filter @tabai/registry db:apply && pnpm --filter @tabai/watcher db:migrate   # fresh DB, idempotent
pnpm --filter @tabai/registry index:once      # registry DB tests skip unless rows are indexed
pnpm --filter @tabai/watcher pipeline         # read-only. --persist writes, --clear and --submit spend CTC
pnpm --filter @tabai/gateway meter --agent 0x… --asset 0x…   # simulates. --broadcast records a delivery
pnpm --filter @tabai/app build:site           # next build, deliberately outside pnpm build
```

## Traps worth knowing before you spend gas

- **An exhausted gas limit looks exactly like a revert.** Estimates come from a warm simulation and underestimate cold writes. State gas explicitly and compare `gasUsed` against `gasLimit`.
- The Creditcoin RPC enforces a **10-second `eth_getLogs` timeout**, so a wide scan fails intermittently and worsens as the chain grows. Chunk every log scan.
- **Confirm a write at the block it landed in, never at the pinned `finalized` tag.** Creditcoin `finalized` lags `latest`, so a read-back straight after a mined transaction can miss its own write.
- One Continuity Proof proves exactly one height, and proofs perish as attestations age onto the checkpoint grid. Fetch close to submission.
- Replay keys pack the **per-receipt log ordinal**, never the block-wide `logIndex`.
- The Merkle tree is domain-separated: leaf `0x00‖bytes`, inner `0x01‖left‖right`.
- `forge script --broadcast` cannot sequence transactions on the CC3 RPC, which reports no `mixHash`. Confirm writes with `cast`.
- A registry change id from an `eth_call` preflight is **not** the one the broadcast produces. Take it from the `RegistryChangeQueued` event.
- **One Service has one operator key, fixed at registration.** There is no operator setter and no `Operator` change kind, so every process of the same Service must hold the same key. A keyless simulation passes with the operator as `from` and the broadcast reverts only after spending gas, so neither cheap check catches a wrong key; `checkOperatorKey` in `apps/gateway/src/witness.ts` refuses at startup and names both addresses.
- ChainInfo precompile names are `snake_case`, and a name is a selector. Every `camelCase` guess reverts `Unknown selector`. `waitUntilHeightAttested` is a client-library poll and does not exist on chain.
- The attested digest is `keccak256(uint64 height ‖ merkleRoot ‖ prevDigest)`, **not** a Source Chain block hash, and `get_attestation_height_for_digest` resolves stride-10 endpoints only. The reorganisation check therefore compares Source Chain block hashes.
- `EmitterKind` and `CollectionKind` both start at `None = 0`, and `IServiceRegistry.Service` has no leading `serviceId`. An off-by-one struct read is silent.
- Public Ethereum RPCs cap `eth_getLogs` ranges anywhere between 10 and 10,000 blocks, and several reject JSON-RPC batching outright. Rotate endpoints and set `RPC_BATCH_MAX_COUNT=1`.
- On `chainKey` 1, `TabSettlement.settle` emits both a `Transfer` and a `TabSettled` for one payment. The verifier skips the `Transfer` a `TabSettled` in the same receipt already accounts for, matched by count on `(payer, recipient, amount)`, so a genuine second payment is never suppressed.
- A Metered Delivery spends `tab.prepaid` **before** it raises the Open Tab, and the Credit Limit is tested against the shortfall only, because prepaid credit is already paid for and borrows nothing.
- **A refusal that omits `details.disposition` is delivered anyway.** The post-paid plugin reads that field to decide whether a refusal replaces the delivered response. Build refusals through the SDK's `revertMappingFor`, which is the single table for category, code, disposition and remedy.
- **A cold-start Agent has no Credit Limit at all, and that is the rule rather than a fault.** With no settlement history it has no counterparties, a bond cap of zero, and must settle before it can buy on credit. Expect a second Agent in the demo to be refused until it has settled once.
- **`kill` does not stop the Dashboard while a browser is on it.** `/api/stream` is an SSE connection that never completes, so graceful shutdown waits for it forever: the process stops listening but keeps serving what it already accepted, a fresh `serve` binds the port beside it, and the open tab talks to a build whose chunks are gone. Restart with `kill -9`, check `ss -ltnp | grep :3000` names the new pid, and hard-reload.
- The `.env` on a Windows-authored checkout carries CRLF and a BOM. Node's `--env-file` parses it correctly; **shell sourcing does not**, so strip `\r` first there.

## Traceability

Every module, contract and documentation page in this repository was written against a numbered specification, and each one closes by naming the requirements it satisfies:

```
/// Requirements: 24.1, 24.2, 24.9, 10.3
```

**272 files across every package carry one**, from the contracts through the SDK to the Dashboard. The marker is how a reader gets from a piece of behaviour back to the reason it exists, and how an edit that quietly changes what something is *for* becomes visible rather than invisible.

The specification itself is not published. It is a working document that records sourcing and provenance in plain terms, which belongs in working notes rather than in a released repository. What ships is the trace: the numbers say what each file answers to, and the behaviour they name is asserted by the tests beside it.

If you add a module, give it a marker. If you change what one does, change its marker with it.

## Commit conventions

A commit message says what changed and why, in prose, and never carries a machine-generated trailer.
Corrections found while building are appended to the specification as blockquotes rather than silently fixed, so the record shows what was believed and what replaced it.

## License

By contributing you agree that your contributions are licensed under the [MIT License](./LICENSE).
