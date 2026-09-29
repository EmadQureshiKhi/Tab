# @tabai/cre-keeper

**A Chainlink CRE workflow that keeps Tab's delinquency marks flowing.**
Every ten minutes a cron trigger fires, under the CRE simulator today and on a Decentralized Oracle Network once deployed, and the workflow fetches the keeper's `GET /overdue`, decides which tabs to mark, and `POST`s `/tick` with the shared secret so the keeper sends the marks.
Every verdict is logged, one line per tab.

This is a standard CRE TypeScript project: `project.yaml` at the root, one workflow in `delinquency/` with its `workflow.yaml`, `main.ts` and `config.json`, and `secrets.yaml` naming the one secret.
It runs against `apps/keeper`, which must be reachable from wherever the workflow executes.
Today it runs under the CRE simulator; `config.production.json` needs a public keeper URL before it can be deployed to a DON.

## Layout

```
project.yaml                  targets: RPCs (listed for the EVM path; the HTTP path needs none)
secrets.yaml                  KEEPER_SHARED_SECRET, read with runtime.getSecret
delinquency/
  workflow.yaml               workflow-name, entry file, config file, secrets path, per target
  package.json                what `bun install` installs for the CRE CLI's compiler, plus cre-setup
  config.json                 staging: schedule, keeperUrl, requestTimeout, maxMarksPerTick
  config.production.json      the same for production-settings
  main.ts                     Runner.newRunner({ configSchema }) and runner.run(initWorkflow)
  workflow.ts                 the CRE wiring: CronCapability, HTTPClient, consensus, the secret
  tick.ts                     the tick as a function of three ports, testable without the SDK
  keeper-client.ts            the two HTTP calls, written for the node-level SendRequester
  overdue.ts                  parsing the keeper's answer and deciding what to mark
```

## The workflow's shape

```ts
const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};
```

`onCronTrigger` receives the DON-mode `Runtime` and runs one tick:

1. `GET /overdue` through `HTTPClient.sendRequest(runtime, fetchOverdue, consensusIdenticalAggregation())`.
   The value the nodes agree on is the decision, the sorted list of markable tab ids plus the counts, and not the block the keeper read at: two nodes a block apart still agree.
   The request also carries `cacheSettings`, so the first node's response is stored and the others read it.
2. `decideMarks`: a tab is asked for when the keeper judged it markable, it is not already marked, something is still open, and its window end has passed.
   Oldest window first, capped at `maxMarksPerTick`; the rest wait for the next tick.
3. `runtime.getSecret({ id: "KEEPER_SHARED_SECRET" })`, from the shell or `.env` in simulation and from the Vault DON when deployed.
4. `POST /tick` with `{ tabIds }` and `Authorization: Bearer <secret>`, under identical consensus and a ten-minute `cacheSettings` so one node posts and the rest reuse its answer.
5. One `runtime.log` line per action the keeper answered: `marked … in <tx>`, `skipped …: AlreadyDelinquent`, `would mark …` when the keeper holds no key, `failed …`.

A failed HTTP call, a rejected secret or a malformed answer fails the tick with its code, which is what CRE reports for the run; the next trigger tries again.

## Simulate

Install the CRE CLI and Bun, log in once (`cre login`, or set `CRE_API_KEY`), then:

```bash
pnpm install && pnpm --filter @tabai/shared build   # from the repository root, once
cd apps/cre-keeper/delinquency && bun install && cd ..   # the SDK for the CLI's compiler, and cre-setup
pnpm --filter @tabai/keeper serve                    # somewhere else, on KEEPER_PORT
cre workflow simulate delinquency --target staging-settings --env ../../.env
```

The workflow imports `Result` from `@tabai/shared`, which has no dependencies and no Node API and so runs inside the WASM sandbox; Bun resolves it from the workspace's own `node_modules` one level up, which is why the root install comes first.

The simulator compiles `main.ts` to WebAssembly and, since the workflow has one trigger, runs it at once.
`--env ../../.env` points it at the repository's `.env`, which carries `CRE_KEEPER_SHARED_SECRET` for the simulation and `KEEPER_SHARED_SECRET` for the keeper process.
They hold the same value under two names on purpose: the simulator warns when a secret's id and the variable carrying it are spelled the same, because a change to one then looks like a change to the other.
The simulator also wants `CRE_ETH_PRIVATE_KEY` in that file, a 64-hex key without the `0x` prefix, even for a workflow that writes nothing on chain; any funded-or-not key satisfies it.
Non-interactively: `cre workflow simulate delinquency --non-interactive --trigger-index 0 --target staging-settings --env ../../.env`.

`config.json` points `keeperUrl` at `http://localhost:8791`, which is reachable from a local simulation and from nothing else.
For a deployed workflow, `config.production.json` must name a public keeper, and the HTTP capability does not follow redirects, so the URL must be the final one.

This has been run, against Bun 1.4.2 and CRE CLI v1.35.0, with the keeper serving on `:8791`:

```
[SIMULATION] Running trigger trigger=cron-trigger@1.0.0
[USER LOG] tab keeper: reading http://localhost:8791/overdue
[USER LOG] tab keeper: 1 candidate tabs, 0 overdue, 1 inside their window; 0 to mark, 0 declined, 0 deferred
[USER LOG] tab keeper: nothing to mark
✓ Workflow Simulation Result: { candidates: 1, overdue: 0, pending: 1, requested: [] }
```

The simulator needs an account: `cre workflow simulate` refuses with `authentication required` until `cre login` has been completed or `CRE_API_KEY` is set, and it refuses before it compiles anything.

### Three things the sandbox enforces

Each of these failed the simulation before the workflow ran, and each is worth knowing before writing another one.

**The workflow needs its own `tsconfig.json`, not the workspace's.**
The compiler type-checks with the TypeScript that Bun bundles, which is older than the one this repository pins, and it refuses `target: ES2023` and `erasableSyntaxOnly` outright.
`delinquency/tsconfig.json` therefore stands alone with the same strictness written out.
Both it and `../tsconfig.json` must pass: one is what ships to the DON, the other is what the repository guarantees.

**There is no `URL` in the sandbox.**
A config field validated with `new URL(value)` fails for every value, because the global is simply absent.
Validation that has to survive the WASM boundary is a pattern, not a parser.

**`z.string().url()` is not the same check in the bundle as it is here.**
The bundle resolves its own Zod, and a later major's `url()` rejects a host with no dot, which rejects `http://localhost:8791`, which is the entire staging configuration.
`keeperUrl` is matched against a regex for that reason, and the reason is written where the field is.

Beside the simulation: `pnpm --filter @tabai/cre-keeper typecheck` against `@chainlink/cre-sdk@1.22.0`, and `pnpm --filter @tabai/cre-keeper test`, which exercises `overdue.ts`, `keeper-client.ts` and `tick.ts` under Node with fake requesters and fake ports.
`workflow.ts` and `main.ts` import the SDK's runtime surface, which loads only inside the WASM build, so they are type-checked and simulated rather than unit-tested.

## Why the chain write goes through the keeper

CRE supports Monad Mainnet from CLI v1.29.0 and TypeScript SDK v1.18.0, and Monad Testnet from CLI v1.30.0 and SDK v1.19.0, with `monad-mainnet` and `monad-testnet` as the chain names and `MonadTestnet` among the SDK's chain constants.
Reads through the EVM client are therefore possible today, and `project.yaml` already lists the Monad RPCs.

The write still goes through the keeper for a different reason.
CRE writes to a chain by generating a DON-signed report with `runtime.report(...)` and handing it to `EVMClient.writeReport(...)`, which submits it to a Chainlink `KeystoneForwarder`; the forwarder verifies the signatures and calls `onReport(bytes metadata, bytes report)` on a consumer contract.
`TabBook.markDelinquent(bytes32)` is a plain permissionless function with no `onReport` entry point, so no CRE EVM write can reach it directly.
Until Tab ships a receiver, the keeper is the receiver: this workflow decides and the keeper sends, simulating each mark first.

### When the write moves into CRE

1. Deploy a small receiver in `packages/contracts`, say `TabDelinquencyReceiver`, that implements `IReceiver.onReport(bytes, bytes)`, checks `msg.sender` is the forwarder, decodes `bytes32[] tabIds` from the report, and calls `TabBook.markDelinquent` for each, catching the four known reverts so one settled tab does not fail the batch.
   The forwarder addresses are in CRE's forwarder directory; Monad Testnet's mock forwarder for simulation differs from the production one.
2. In `workflow.ts`, replace the `POST /tick` port with `encodeAbiParameters(parseAbiParameters("bytes32[] tabIds"), [tabIds])`, `runtime.report({ encodedPayload: hexToBase64(data), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" })`, and `new EVMClient(getNetwork({ chainFamily: "evm", chainSelectorName: "monad-testnet", isTestnet: true }).chainSelector.selector).writeReport(runtime, { receiver, report, gasConfig })`.
3. Optionally replace the `GET /overdue` port with EVM reads of `tabOf` and `settlementWindowOf` through `evmClient.callContract`, keeping the registry's delivery feed as the source of candidates, since nothing on chain enumerates tabs.
4. `cre workflow simulate delinquency --broadcast` then needs `CRE_ETH_PRIVATE_KEY` funded with Testnet MON, and deployment needs deploy access and a linked key.

The keeper's `/overdue` stays useful either way: it is the same verdict the Dashboard shows, read at one block, for anyone who wants to check the workflow's decisions against something a person can see.

## Configuration

`config.json` and `config.production.json`, validated by a Zod schema at startup:

| Key | Meaning |
| --- | --- |
| `schedule` | a 5 or 6 field cron expression; `0 */10 * * * *` is every ten minutes at second 0 |
| `keeperUrl` | where the keeper serves `/overdue` and `/tick` |
| `requestTimeout` | the HTTP capability's per-request timeout, `"8s"` by default; its ceiling is `"10s"` |
| `maxMarksPerTick` | how many marks one tick asks for; `25` by default |

The one secret is `KEEPER_SHARED_SECRET`, declared in `secrets.yaml` under the same name the keeper reads.

```bash
pnpm --filter @tabai/cre-keeper test
```
