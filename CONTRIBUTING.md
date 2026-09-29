# Contributing to Tab

Everything here is the detail behind the gate table in the [README](./README.md).
It lives in its own file so the README stays something a reader can finish.

## Prerequisites

- Node `>= 20.10.0`
- pnpm `9.15.3`, pinned through the root `packageManager` field. Never npm.
- Foundry (`forge`, `cast`, `anvil`) for the Solidity work
- A Monad Testnet RPC endpoint. The public one in `.env.example` is the default, and it caps `eth_getLogs` at 100 blocks per request.

Pinned dependencies, asserted exactly in CI:

| Package | Version |
| --- | --- |
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
That file holds one entry per network, keyed by chain id, and `MONAD_CHAIN_ID` selects which one is read; `--chain 143` writes a `.env` for the other network without editing anything first.
It refuses to overwrite an existing `.env`, because that file holds private keys on any machine that has settled anything.

```bash
pnpm env:check            # every process.env read is declared
pnpm env:list             # print the declared set
pnpm deployments:check    # the deployment MONAD_CHAIN_ID names, joined against .env.example
```

## The vocabulary gate

A vocabulary check runs in CI and in the pre-commit hook, so every document, comment, identifier and string uses the project's own terms consistently.

```bash
pnpm vocab:check                             # everything git tracks
node scripts/vocab-check.mjs --staged        # staged paths only, which is what the hook runs
```

Its term list comes from the `VOCAB_DENYLIST` setting; with no list configured it exits `2` rather than passing.

## The coverage gate

The contracts carry per-contract line-coverage floors, enforced in CI inside the `contracts` job rather than read off a terminal by hand.

| Tier | Contracts | Floor |
| --- | --- | --- |
| Money-handling | `TabSettlement`, `TabBook`, `LimitLib`, `Bond` | 90 % of lines |
| Setters and bookkeeping | `ServiceRegistry`, `CurationMultisig` | 75 % of lines |

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

The two hero figures and the social card under `assets/readme/` are committed, because GitHub renders a README from the repository rather than from a build.
The brand marks under `assets/brand/` are the source, and `assets/palette.json` holds the palette the figures follow.
There is no generator in the tree; a figure that changes is re-exported by hand from the 4k mark and checked against the same rules.

## Running the rail locally

```bash
pnpm --filter @tabai/registry db:apply        # fresh DB, idempotent
pnpm --filter @tabai/registry index:once      # index from REGISTRY_START_BLOCK to the head once, then exit
pnpm --filter @tabai/gateway meter --agent 0x…   # simulates. --broadcast records a delivery and spends MON
pnpm --filter @tabai/app build:site           # next build, deliberately outside pnpm build
node --env-file=.env scripts/agent-loop.mjs   # one Agent through authorise, tab_call, tab_status and tab_settle; --broadcast settles
node --env-file=.env scripts/x402-prepaid.mjs # the other door: one call paid up front over x402, never metered
node --env-file=.env scripts/nansen-x402.mjs  # one Nansen call paid per request in Mainnet USDC, no API credits
```

The registry's route tests need a PostgreSQL server and run against a database of their own, `<database>_test` beside the one `DATABASE_URL` names, created on first run; `REGISTRY_TEST_DATABASE_URL` overrides it.
Without a server they skip and say so.

## Traps worth knowing before you spend gas

- **Monad charges the gas limit, not the gas used, and it reports the limit as `gasUsed`.** A delivery sent with a flat 2,000,000 comes back with `gasUsed` of exactly 2,000,000; the same contract's Settlements, sent with an estimate, come back with 319,695. A generous limit is spent rather than reserved, so every write states an estimate plus a margin, floored against the cold-write undercount a warm simulation misses and capped against an estimate gone wrong. The one place this costs is that `gasUsed == gasLimit` no longer distinguishes an exhausted limit from a refusal on a failed transaction, so a failure is read as the cheaper-to-fix of the two.
- **Monad's public RPC caps `eth_getLogs` at 100 blocks per request.** Chunk every log scan, and narrow on a refusal rather than stepping past the chunk; a skipped chunk is a dropped `HistoryExtended` record and a witness that cannot fold.
- **`TabBook.setSettlementSurface` is one-shot.** It can be called once, by the deployer, and the deploy script reads the broadcaster with `vm.readCallers()` rather than `msg.sender`.
- **The witness must fold to `historyCommitment` exactly.** The fold is `keccak256(abi.encode(previousRoot, serviceId, asset, amount, settledAt, firstDeliveryAt, curated, bonded))`. One field out of order compiles, runs, and reverts `HistoryCommitmentMismatch` after the gas is spent.
- **Bond amounts in a witness are ignored.** `TabBook` replaces every entry with `Bond.freeOf` for the Service's bond account, so a witness only has to name the right `(serviceId, asset)` pairs, each once, and each a genuine counterparty. An authorised Service is a counterparty before any Settlement.
- **A cold-start Agent has no Credit Limit at all, and that is the rule rather than a fault.** With no history and no authorisation it has no counterparties and a bond cap of zero. Authorising a bonded Service lifts the cap to that Service's free Bond, and the first Settlement creates the history the limit grows from.
- A registry change id from an `eth_call` preflight is **not** the one the broadcast produces. Take it from the `RegistryChangeQueued` event.
- **One Service has one operator key, fixed at registration.** There is no operator setter and no `Operator` change kind, so every process of the same Service must hold the same key. A keyless simulation passes with the operator as `from` and the broadcast reverts only after spending gas, so neither cheap check catches a wrong key; `checkOperatorKey` in `apps/gateway/src/witness.ts` refuses at startup and names both addresses.
- `IServiceRegistry.Service` has no leading `serviceId`. An off-by-one struct read is silent.
- A Metered Delivery spends `tab.prepaid` **before** it raises the Open Tab, and the Credit Limit is tested against the shortfall only, because prepaid credit is already paid for and borrows nothing.
- **A refusal that omits `details.disposition` is delivered anyway.**
  The post-paid plugin reads that field to decide whether a refusal replaces the delivered response.
  Build refusals through the SDK's `revertMappingFor`, which is the single table for category, code, disposition and remedy.
- **`kill` does not stop the Dashboard while a browser is on it.**
  `/api/stream` is an SSE connection that never completes, so graceful shutdown waits for it forever: the process stops listening but keeps serving what it already accepted, a fresh `serve` binds the port beside it, and the open tab talks to a build whose chunks are gone.
  Restart with `kill -9`, check the port names the new pid, and hard-reload.
- The `.env` on a Windows-authored checkout carries CRLF and a BOM.
  Node's `--env-file` parses it correctly; **shell sourcing does not**, so strip `\r` first there.

## Commit conventions

A commit message says what changed and why, in prose, and never carries a machine-generated trailer.

## License

By contributing you agree to the contribution terms in [LICENSE](./LICENSE): the copyright holder may use, modify and license your contribution under any terms.
