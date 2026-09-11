# @tabai/keeper

**The permissionless `markDelinquent` cranker.**
`TabBook.markDelinquent` may be called by anyone once a tab's Settlement Window has closed with the tab still open, and the mark zeroes the Agent's Credit Limit in that Asset until it settles.
The reason it is permissionless is in the contract: the Service that metered the tab is also the party whose Credit Limit weight benefits from the Agent staying in good standing, so liveness must not depend on it.
This process is one outsider that makes the call.

## What a tick does

1. Walks the registry's delivery feed, `GET <NEXT_PUBLIC_REGISTRY_API_URL>/deliveries?limit=100&cursor=…`, to its end.
   A tab exists from its first delivery, so the distinct `(agent, serviceId, asset)` triples are every tab there is.
2. Reads each tab's state from `TabBook.tabOf(tabIdOf(…))` and its Service's `settlementWindowOf` from `ServiceRegistry`, at one block.
   The verdict compares the window end against that block's timestamp, never against the machine's clock.
3. Simulates `markDelinquent(tabId)` with `eth_call` for every tab the chain would accept, and skips by name on `AlreadyDelinquent`, `NothingUnsettled`, `SettlementWindowOpen` or `UnknownTab`.
4. Sends the marks that simulate clean, with `KEEPER_PRIVATE_KEY`, and waits for each receipt.

Steps 2 and 3 are `src/chain.ts` and `src/overdue.ts`, copied verbatim from the Dashboard (`apps/app/src/dashboard/`) because apps may not depend on apps and the keeper must judge a tab exactly as the page a person reads does.
`test/copies.test.mjs` fails when the two diverge.

## CLI

```bash
pnpm --filter @tabai/keeper once               # judge and simulate; send nothing
pnpm --filter @tabai/keeper once -- --broadcast  # send the marks; spends gas in MON
pnpm --filter @tabai/keeper once -- --json       # the report on stdout, and nothing else there
pnpm --filter @tabai/keeper serve                # the HTTP surface on KEEPER_PORT
```

`once` is a dry run unless `--broadcast` is given.
Because it simulates either way, a dry run reports `would-mark` only for tabs the chain would accept right now.

```
Block 64560012 at 2026-09-22T10:00:00.000Z
  candidates  14 distinct tabs from 211 deliveries over 3 pages
  overdue     2
  pending     9
  would-mark  0x3f…a1
  skipped     0x9c…07 (AlreadyDelinquent)

Dry run. Nothing was sent. Add --broadcast to mark them; that spends gas in MON.
```

## HTTP

| Route | Guard | Answers |
| --- | --- | --- |
| `GET /healthz` | none | `{ status, chainId, canBroadcast, tickProtected }` |
| `GET /overdue` | none | the verdicts, recomputed at one block on every request: `{ at, candidates, feed, overdue[], pending[] }` |
| `POST /tick` | `KEEPER_SHARED_SECRET` as `Authorization: Bearer <secret>` or `X-Keeper-Secret` | judges, simulates and marks; `{ …verdicts, broadcast, actions[], notMarkable[] }` |

`POST /tick` is refused outright (503) when no secret is configured, because a mark spends this process's gas.
The body may carry `{ "tabIds": [...] }` to restrict the marks; the verdicts are recomputed either way, and a requested tab that is no longer markable is listed under `notMarkable` rather than sent to a certain revert.
A server started without `KEEPER_PRIVATE_KEY` serves `/overdue` and answers `/tick` with a dry run; a caller cannot turn broadcasting on from the request.

Every failure is `{ error: { category, code, message } }` under the category's status, the same shape the rest of the workspace answers with.

## Environment

| Variable | Purpose |
| --- | --- |
| `MONAD_RPC_URL`, `MONAD_CHAIN_ID` | the chain every read and every mark goes to |
| `TAB_BOOK_ADDRESS`, `SERVICE_REGISTRY_ADDRESS` | the contracts, from `deployments.json` (`pnpm env:bootstrap` fills them) |
| `NEXT_PUBLIC_REGISTRY_API_URL` | the registry read API; `/deliveries` names the candidate tabs |
| `KEEPER_PRIVATE_KEY` | read only when a mark is sent; needs MON for gas and holds no Asset |
| `KEEPER_PORT` | `serve` listens here; `8791` by default |
| `KEEPER_SHARED_SECRET` | guards `POST /tick` |
| `KEEPER_MAX_FEED_PAGES` | how many feed pages one tick walks before it refuses to judge; `200` by default |

A feed that runs past the page bound, a malformed row, or an unreachable node is a stated failure, never a shorter list of overdue tabs: a silently short list reads as "none overdue", the one wrong answer this process must never give.

## Who calls `/tick`

Anything with the secret and a clock.
`apps/cre-keeper` is a Chainlink CRE workflow that reads `/overdue` every ten minutes, decides which tabs to mark, and posts `/tick` for exactly those, so the decision runs under a DON's consensus and the gas-spending call stays here.

```bash
pnpm --filter @tabai/keeper test
```
