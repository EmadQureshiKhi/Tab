<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/hero-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./assets/readme/hero-light.png">
    <img alt="Tab - post-paid billing and a credit facility for autonomous agents" src="./assets/readme/hero-light.png" width="960">
  </picture>
</p>

<p align="center">
  <img alt="Networks: Monad Mainnet and Monad Testnet" src="https://img.shields.io/badge/networks-Monad%20Mainnet%20%2B%20Testnet-0D7676">
  <img alt="Settlement: same chain, one transaction" src="https://img.shields.io/badge/settlement-one%20transaction-0D7676">
  <img alt="165 contract tests passing" src="https://img.shields.io/badge/contract%20tests-165%20passing-2f8132">
  <img alt="Live on Monad Mainnet and Testnet" src="https://img.shields.io/badge/status-live%20on%20Mainnet%20%26%20Testnet-2f8132">
  <a href="https://www.npmjs.com/package/@tabai/sdk"><img alt="npm @tabai/sdk" src="https://img.shields.io/npm/v/@tabai/sdk?label=%40tabai%2Fsdk&color=0D7676"></a>
  <a href="./LICENSE"><img alt="Source-available licence" src="https://img.shields.io/badge/license-source--available-444"></a>
</p>

# Tab

**Agents buy first and pay later, and nobody is trusted to say the money arrived.**

A Service meters usage into an Open Tab held on Monad.
The Agent settles that Tab in USDC or AUSD, with its own keys, whenever it likes.
The transfer and the ledger entry are one Monad transaction: `TabSettlement` moves the Asset to the Service and applies the Settlement to the tab in the same block, atomically.

No facilitator, no oracle, no bridge, and no API key sits between the payment and the ledger entry.
The chain applies the payment.

Tab sits on the rest of Monad's agent stack rather than beside it: an Agent that runs out of credit is offered the same charge over x402, the API Hub's pay-per-request services are fronted on credit, Agents and Services carry ERC-8004 identities, and a Settlement can be signed with a Permit2 witness so the Agent never needs gas.
The section [On Monad, end to end](#on-monad-end-to-end) lists every piece.

Built by **Emad Qureshi**.

## Live

| | Where |
| --- | --- |
| Dashboard | [trytabai.vercel.app](https://trytabai.vercel.app). The switch in the header picks Mainnet or Testnet, and every page, figure, link and the Try it button follow it |
| Documentation | [trytabai-docs.vercel.app](https://trytabai-docs.vercel.app) |
| SDK, CLI and MCP server | [`@tabai/sdk`](https://www.npmjs.com/package/@tabai/sdk) on npm: `npx -y @tabai/sdk connect` |
| MetaMask Agent Wallet plugin | [`@tabai/agent-wallet-plugin`](https://www.npmjs.com/package/@tabai/agent-wallet-plugin): `mm plugins install @tabai/agent-wallet-plugin` |
| Registry read API | Mainnet `https://registry-mainnet-production.up.railway.app`, Testnet `https://registry-testnet-production.up.railway.app` |
| Metering gateway (demo Service `tab.demo`) | Mainnet `https://gateway-mainnet-production.up.railway.app`, Testnet `https://gateway-testnet-production-a657.up.railway.app` |

Testnet is the free playground: its demo Service prices in a mintable test token and in Circle's Testnet USDC.
On Mainnet the Assets are real USDC and AUSD, so the Dashboard rate-limits Mainnet trial calls, each of which spends real gas.

---

## The problem

An autonomous agent cannot open a bank account, cannot hold a card, and cannot sign a contract.
So every way it currently pays for a service is a prepayment: a funded wallet, a held response, an API key bought by a human in advance.
That is not billing, it is a deposit, and it puts a person back in the loop of an autonomous system.

Post-paid billing needs credit, credit needs a repayment record, and a repayment record needs somebody to confirm the repayments.
Until now that somebody has been a facilitator, an oracle, or a bridge: a party you have to trust to say that money moved.

On Monad the payment and the record are the same state change.
Tab is what you build once that is true: **a credit facility whose entire repayment history is the chain's own record, and whose credit limit is a pure function of it.**

---

## How one settlement works

1. **The Agent calls a priced tool.** No prepayment, no wallet connection, no held response. The Service does the work, returns the result, and *then* records the charge with `TabBook.recordDelivery`. This path only ever raises a tab.
2. **The Agent settles on Monad, with its own keys.** It approves the Asset and calls `TabSettlement.settle(serviceId, asset, amount)`. Nothing is escrowed and nobody's permission is needed. An Agent holding no MON signs a Permit2 witness instead and anyone may submit it through `settleWithPermit2`; the gateway's `/relay/settle` does exactly that.
3. **The same transaction applies it.** `TabSettlement` moves the Asset to the Collection address the Service registered, then calls `TabBook.applySettlement`. The Open Tab falls, the surplus banks as prepaid credit, and the Agent's history commitment advances, all before the transaction returns.
4. **Headroom is back in the same block.** The next metered call sees the new limit. There is nothing to wait for, no pending state, and no reversal path, because there is nothing to reverse.

### The removal test

Take `TabSettlement` away and there is still exactly one way a tab falls: `TabBook.applySettlement`, which only the wired settlement surface may call.
No operator, no indexer and no off-chain process can reduce an Open Tab.
The registry read API and the Dashboard describe what the chain did; they cannot make it do anything.

---

## Credit, and what bounds it

A Credit Limit is a pure function of the Settlements the chain already applied.
`LimitLib` reads no external state at all: it is fuzzed as a pure function, and every other bound below is a named constant in the library.

| Bound | Value | What it stops |
| --- | --- | --- |
| Baseline | `CREDIT_BASELINE_BASE_UNITS`, a deployment parameter | credit before any history exists |
| Age ramp | 25 % to 100 % weight over 30 days | a burst of fresh settlement counting as seasoned history |
| Bond cap | 95 % of the counterparties' free Bond | credit that nothing stands behind |
| Concentration cap | 25 % per counterparty | one Service carrying an Agent's whole limit |
| Curated counterparties | at least 3 before any growth above the baseline | a ring of two buying credit from itself |
| History bound | 512 records, 32 counterparties | an unbounded witness |

A new Agent that authorises a bonded Service starts at `min(baseline, 95 % of that Service's free Bond)`: the Service's own decision to carry a stranger up to the baseline, backed by its own stake.
Anything above the baseline is earned, by settled history with at least three Curated, bonded Services.

The history is not stored as an array.
`TabBook` keeps a rolling commitment per Agent and Asset, emits every record on `HistoryExtended`, and refuses any witness that does not fold back to the commitment.
A colluding ring cannot manufacture credit without locking strictly more Bond than the credit it unlocks.

### Delinquency is permissionless

A tab that stays open past its Service's Settlement Window can be marked delinquent by anyone, with `TabBook.markDelinquent(tabId)`.
The mark zeroes the Agent's Credit Limit in that Asset until it settles.
The Dashboard lists every markable tab with the exact `cast send` line, so the guarantee does not depend on the Service that metered the tab or on this project being up.

---

## Deployed on chain

Everything below was read back off the chain by [`script/02_VerifyDeployment.s.sol`](./packages/contracts/script/02_VerifyDeployment.s.sol), which holds no key and sends nothing, so this table is checkable by anyone with an RPC endpoint rather than only by whoever deployed it.

### Monad Mainnet, chain id `143`

| Contract | Address |
| --- | --- |
| `CurationMultisig` | `0x123c19F46C38d5b4E922D1297250a71A03DFFD17` |
| `ServiceRegistry` | `0x4F791F13F94944fCB2F884f8C7991cAa583884A6` |
| `Bond` | `0xbA86C0D053ba88afDECbED8aBa5b2eC3973fb230` |
| `TabBook` | `0x0Dabf8E52280D0F128f546602a99b6DC4fbb80DC` |
| `TabSettlement` | `0x32A96bfEABe766B4898b961B333B7B89f079a9a9` |

The Assets are the canonical USDC and AUSD, and no token was shipped.
The curation role is held by a 2-of-3 `CurationMultisig` (see [the one privileged role](#the-one-privileged-role)).
The demo Service is registered with a 1 USDC Bond and holds ERC-8004 identity `10254`; the demo Agent holds `10255`.
It accepts USDC and AUSD and prices `quote.generate` at 0.01 in each, plus the two fronted tools `apihub.run` and `nansen.query` at one base unit a unit, all applied on 2026-09-25 after the registry's 48-hour hold.
The ERC-8004 Identity and Reputation registries on Mainnet are `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` and `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`.
Deployment block `107094526` (the `CurationMultisig` at `107094289`), every transaction hash and the applied change ids are in [`deployments.json`](./deployments.json), under `networks.143`.
RPC `https://rpc.monad.xyz`, explorer `https://monadvision.com`.

### Monad Testnet, chain id `10143`

| Contract | Address |
| --- | --- |
| `ServiceRegistry` | `0x3638DB35A76E5a22EA1E827636dA994be622c139` |
| `Bond` | `0x29aDfD90Fc7c9026563Fc60651f696ab089080E7` |
| `TabBook` | `0x87571030cCe27C84836bAfF85288eB1d85d908a4` |
| `TabSettlement` | `0x654Fac48185e4B71779eEc2457B1F24aEdf46717` |
| `MockUsdc` | `0x480209747417f5c830fDA188a9b9AcFa70Bc4083` |

`LimitLib` is a pure library, linked at compile time, and holds no address of its own.
`MockUsdc` is a mintable six-decimal test token shipped to Testnet only, with EIP-3009 under the same EIP-712 domain as Circle's USDC so the x402 `exact` scheme runs against it; the rail names it `mUSDC` to keep it apart from the real one.
The demo Service also prices its tool in Circle's Testnet USDC, `0x534b2f3A21130d7a60830c2Df862319e593943A3`.

Three contracts Tab reads but did not deploy: Uniswap's Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3` (the same on both networks), and the Testnet ERC-8004 Identity and Reputation registries at `0x8004A818BFB912233c491871b3d84c89A494BD9e` and `0x8004B663056A597Dffe9eCcC1965A193B7388713`.
The demo Service is ERC-8004 agent `1913` and the demo Agent is `1914`.

The deployment block (`64554587`), every transaction hash, the demo Service and the curation authority are in [`deployments.json`](./deployments.json), under `networks.10143`.
RPC `https://testnet-rpc.monad.xyz`, explorer `https://testnet.monadvision.com`, faucet `https://faucet.monad.xyz`.

---

## On Monad, end to end

Every piece below is in the tree and exercised by tests; the registry, the gateway and the Dashboard are live in the hosted deployment, and the keeper runs locally with its CRE workflow under the CRE simulator.

| Piece | What Tab does with it | Where |
| --- | --- | --- |
| **x402, V2** | A credit refusal (`402 LimitExceeded`) carries a `PAYMENT-REQUIRED` offer for the same charge through Monad's facilitator, `exact` scheme over EIP-3009. A request carrying `PAYMENT-SIGNATURE` is verified, settled and delivered prepaid, and never touches the Open Tab. Credit first, pay-per-request as the fallback | `packages/sdk/src/x402`, `apps/gateway/src/x402.ts` |
| **Monad API Hub** | Buy now, pay later for the Hub's pay-per-request data services. `POST /hub/apihub/run` fronts any provider: the Service pays the Hub's x402 price with its own key and meters the Agent's Open Tab for that price plus its published margin. `/hub/nansen/*` fronts Nansen's x402 endpoints the same way | `packages/sdk/src/x402/hub.ts`, `apps/gateway/src/server.ts` |
| **Permit2, gasless settlement** | `TabSettlement.settleWithPermit2` verifies a `PermitWitnessTransferFrom` whose witness binds Service, Asset, amount, surface and chain. The Agent signs; `POST /relay/settle` on the gateway simulates from the operator and submits, so an Agent needs USDC and nothing else | `packages/contracts/src/TabSettlement.sol`, `packages/sdk/src/payments/permit2.ts`, `apps/gateway/src/relay.ts` |
| **ERC-8004** | The demo Service and Agent are registered on Monad's Identity Registry. The registry indexes the Identity Registry's events, reads each agent's registration file and reputation summary, and serves them on `/agents/:address` and `/services/:id`; the Dashboard shows them | `packages/contracts/script/03_RegisterIdentity.s.sol`, `apps/registry/src/erc8004.ts` |
| **Envio HyperSync** | An alternative log source for the indexer: whole block ranges in one request, so a cold start is not bound by the public RPC's 100-block `eth_getLogs` cap | `apps/registry/src/hypersync.ts` |
| **Nansen** | Address labels served beside an Agent's identity, stated as an offchain signal that changes nothing in the Credit Limit | `apps/registry/src/nansen.ts` |
| **Mera passkeys** | `/keys` on the Dashboard is a passkey account: a seed from the WebAuthn PRF extension, an owner key that is never shown, and session keys revealed once each for the runtime they will be the Agent for | `apps/app/components/passkey` |
| **MetaMask Agent Wallet** | `mm tab discover`, `status`, `call`, `settle` and `authorise` as a plugin: each builds the transaction and hands it to the wallet with a one-sentence intent, so the wallet's policy decides what is signed | `packages/agent-wallet-plugin` |
| **Privy server wallets** | The Agent's key held in a Privy server wallet instead of its environment: metering claims by `personal_sign`, Permit2 Settlements by `eth_signTypedData_v4`, and `authorise`, `approve` and `settle` by `eth_signTransaction`, each checked by a Privy policy that allows only those calls on Tab's contracts on one chain. The owner key that can change the policy is never on the Agent's machine. Needs a Privy app; tested against a Privy double, not yet run against Privy itself | `packages/sdk/src/signers`, `scripts/privy-agent.mjs` |
| **Chainlink CRE** | A cron workflow, compiled to WASM and run under the CRE simulator, that calls the delinquency keeper every ten minutes; the keeper confirms each overdue tab on chain and submits the permissionless `markDelinquent` | `apps/cre-keeper`, `apps/keeper` |
| **Kuru** | A settlement strategy that reads the Agent's balance of the Asset and, when it is short, swaps the shortfall in from another token through Kuru's router before settling | `packages/sdk/src/payments/kuru.ts` |
| **Agora AUSD** | A first-class Asset beside USDC on Mainnet: in the shared table, so every page and tool that prints an Asset names it | `packages/shared/src/chains.ts` |

None of these change what a Settlement is.
The Credit Limit is still computed only from Settlements applied on chain, and the x402 and Hub payments are stated on every page as what they are: prepaid, per request, and outside the credit history.

---

## Run it

### Prerequisites

Node `>= 20.10.0`, pnpm `9.15.3` (pinned through `packageManager`, never npm), and Foundry for the Solidity work.

### In three commands, keylessly

```bash
pnpm install
pnpm env:bootstrap        # writes .env from .env.example plus the recorded Testnet addresses
cd packages/contracts && set -a && source ../../.env && set +a && forge script script/02_VerifyDeployment.s.sol:VerifyDeployment --rpc-url monad_testnet --sig "run()"
```

For Mainnet, `node scripts/env-bootstrap.mjs --print --chain 143` prints the same environment with Mainnet's chain id, RPC and addresses, and the same script verifies it with `--rpc-url monad`.

The verification is a `view` run.
It reads every wired slot of the recorded deployment from both ends and reverts on the first disagreement, and it needs no key and no funded account.

### The Dashboard

```bash
pnpm --filter @tabai/app build:site
pnpm --filter @tabai/app serve            # http://localhost:3000
pnpm --filter @tabai/docs dev             # http://localhost:3001
```

Every read-only route works with no wallet: browse Services and their prices, look up any Agent's Open Tab and Credit Limit, open any Settlement in the explorer by its `settlementId`, and see which tabs are overdue.
Connecting a wallet is only ever asked for when you are about to sign: authorising a Service, registering one, or funding its Bond.

### The registry and the gateway

```bash
docker compose up -d db
DATABASE_URL=postgres://tab:tab@127.0.0.1:5432/tab pnpm --filter @tabai/registry db:apply
DATABASE_URL=postgres://tab:tab@127.0.0.1:5432/tab node --env-file=.env apps/registry/dist/main.js     # indexes and serves on :8787
node --env-file=.env apps/gateway/dist/main.js                                                        # meters on :8788, relays Permit2 Settlements, fronts the Hub
pnpm --filter @tabai/gateway meter --agent 0x…                                                        # simulates one delivery; --broadcast records it
node --env-file=.env --import tsx apps/keeper/src/main.ts once                                        # lists overdue tabs; --broadcast marks them delinquent
```

The gateway rebuilds the Agent's witness from `HistoryExtended` logs, checks it against `TabBook.historyCommitment`, simulates `recordDelivery` over a keyless `eth_call`, and only then broadcasts.
A refused delivery costs real gas and returns the same revert data a free simulation returns, so paying for it first would be paying for information already available.

### From the SDK and CLI

One line puts an agent on the rail.

```bash
npx -y @tabai/sdk connect      # merges an `mcpServers.tab` entry into your MCP client's config
npx -y @tabai/sdk doctor       # checks the whole installation against the live deployment, keylessly
```

`connect` finds your client's configuration file, backs it up, merges one entry, and prints the diff before it writes.
Run it twice and the second run writes nothing.
**It never writes a private key.**

| Command | What it does | Spends |
| --- | --- | --- |
| `connect` | Writes the `tab` entry into your MCP client's configuration | nothing |
| `mcp` | Serves the four tools over MCP. This is what a client launches | nothing |
| `doctor` | Checks the installation against the live deployment | nothing, and needs no key |
| `status` | What an Agent owes, may still spend, and has settled | nothing, and needs no key |
| `settle` | Pays down an Open Tab, with the Agent's key or, with `--strategy monad-relayed`, by a Permit2 signature the gateway submits | real funds, and only with `--broadcast` |

The four MCP tools an agent actually sees:

| Tool | What it does | Spends |
| --- | --- | --- |
| `tab_discover` | Lists Services, accepted Assets, tool prices, and each Service's Bond | nothing, and needs no key |
| `tab_call` | Calls a metered tool. The charge lands on the Open Tab and is settled later. A credit refusal reports the x402 offer it carried | nothing at call time |
| `tab_status` | Credit Limit, Open Tab, prepaid credit and headroom, per Asset, with recent Settlements | nothing, and needs no key |
| `tab_settle` | Pays down an Open Tab by sending a Settlement with the Agent's own key | real funds |

**None of them throws.** A failure returns `ok: false` with a `category`, a `code` and a `message`, so a model can decide what to do next rather than parse an exception.

As a library:

```bash
npm install @tabai/sdk
```

```ts
import { createMonadStrategy, createTabToolset, honoTabPostPaid } from "@tabai/sdk";
```

The package ships its own types and carries no workspace dependency, so it installs and type-checks on its own.
The full guide is in [`packages/sdk/README.md`](./packages/sdk/README.md) and [`integration.mdx`](./apps/docs/content/docs/integration.mdx).

---

## What is in this repository

| Path | What it is responsible for |
| --- | --- |
| `packages/contracts/src/ServiceRegistry.sol` | Who may meter, prices per tool per Asset, Collection addresses, Settlement Window, tiers. Every change after registration sits behind a 48-hour timelock |
| `packages/contracts/src/Bond.sol` | Escrow for Service stake. Deposits pull the Asset in, withdrawals pay it out, and `freeOf` is what the credit computation reads |
| `packages/contracts/src/TabBook.sol` | Open Tabs, prepaid credit, delivery metering, delinquency, and the rolling history commitment |
| `packages/contracts/src/TabSettlement.sol` | The one way a tab is paid. Moves the Asset and applies the Settlement in one transaction. Holds nothing |
| `packages/contracts/src/LimitLib.sol` | Pure credit arithmetic |
| `packages/contracts/src/CurationMultisig.sol` | The intended curation authority |
| `apps/registry` | Indexes every event, ERC-8004 identities included, serves the read API, and serves a Credit Limit only where its own recomputation agrees with the chain |
| `apps/gateway` | The Service side: rebuilds the witness, simulates, meters delivery after the fact, offers x402 on a refusal, fronts the API Hub and relays Permit2 Settlements |
| `apps/keeper` | Marks overdue tabs delinquent, once or as a service a scheduler calls |
| `apps/cre-keeper` | The Chainlink CRE workflow that schedules the keeper |
| `apps/app` | The Dashboard. No wallet to read, a passkey to sign |
| `apps/docs` | The documentation site |
| `packages/sdk` | Strategies, the 402 client, x402, server plugins, the MCP server and the CLI |
| `packages/agent-wallet-plugin` | `mm tab`, the MetaMask Agent Wallet plugin |
| `packages/shared` | Chain constants, ABIs, typed data, event topics and the `Result` type |

Dependency direction is linted, in this direction only: apps depend on packages; the SDK and the plugin depend on shared; shared depends on nothing.

---

## The one privileged role

A curation authority decides which Services hold the Curated Tier, and so which Settlement history carries Credit Limit weight.
It has no power over metering, over any tab, over any Settlement, or over any Bond.

Two things bound it.
Every change it makes is queued and held for **48 hours** behind a public `RegistryChangeQueued` event before it can apply, so a promotion is contestable before it takes effect and you can watch the countdown on the Service directory.
And the role cannot move: `ServiceRegistry` takes its authority as a constructor argument and exposes no setter, so nobody, this project included, can reassign it without a new deployment.

On Testnet the role is held by the deploying account.
On Mainnet it is held by a 2-of-3 [`CurationMultisig`](./packages/contracts/src/CurationMultisig.sol) at `0x123c19F46C38d5b4E922D1297250a71A03DFFD17`, deployed before the registry because the authority is fixed at construction.
It has an immutable owner set, a permissionless `execute`, and no `receive` and no `payable` function anywhere in it, so it can hold no value.
All three of its owners are held by this project today.
A one-person deployment cannot honestly present that as three parties, and [`deployments.json`](./deployments.json) says so beside the address: what the contract enforces is 2-of-3, and who holds the three is a separate question.
The Service directory does not take any of this on trust either.
It asks the address the registry actually checks for its threshold and its owners, and draws whichever answer it gets, so a reader sees what is there rather than what this page claims.

---

## Verify any of this yourself

Seven gates guard this repository, and CI runs every one of them.

| Gate | Command | What it refuses to let through |
| --- | --- | --- |
| Build, types, lint, tests | `pnpm build && pnpm typecheck && pnpm lint && pnpm test` | the ordinary four |
| Contract tests | `forge test` in `packages/contracts` | **165 tests**, including property tests and Permit2 signatures against the canonical bytecode |
| Coverage floors | `pnpm coverage` | 90 % of lines on the money-handling contracts, 75 % on the registry and the multisig |
| Dependency direction | `pnpm lint:deps` | an import that points the wrong way through the workspace |
| Environment contract | `pnpm env:check` | a `process.env` read that `.env.example` does not declare |
| Deployment record | `pnpm deployments:check` | `deployments.json` and `.env.example` describing two different deployments, or a `MONAD_CHAIN_ID` with nothing deployed under it |
| Contrast | `pnpm --filter @tabai/app lint` | any interface colour pair under WCAG AA |

And keylessly, against the live chain, the verification script above.

Contributor detail lives in [`CONTRIBUTING.md`](./CONTRIBUTING.md): the coverage floors and the traps worth knowing before you spend gas.

---

## Status

**Live on Monad Mainnet and on Monad Testnet.**

| | |
| --- | --- |
| Contracts | Deployed and verified from both ends of every wired slot on **both** networks: five on Testnet, four plus a 2-of-3 curation multisig on Mainnet. The keyless verification script passes on each |
| Mainnet demo Service | Bonded, accepting USDC and AUSD, with `quote.generate` and both fronted tools priced; the demo Agent has authorised it |
| Hosted rail | A registry and a metering gateway per network on Railway, each registry with its own Postgres and Envio HyperSync; the Dashboard and the docs on Vercel |
| Dashboard | One deployment serving both networks, chosen in the header, with passkey accounts and a rate-limited Try it on Mainnet |
| Client tooling | `@tabai/sdk` (SDK, CLI, MCP server with four tools) and `@tabai/agent-wallet-plugin` on npm |
| Tests | 165 contract tests, including property tests, and 679 across the eight TypeScript packages |

Nothing in the rail is pinned to one network: `deployments.json` holds one entry per chain id, `MONAD_CHAIN_ID` selects it, and the same contracts, scripts and services run on both.

---

## Author

**Emad Qureshi**. Design, contracts, off-chain rail, SDK, interfaces and documentation.

## License

Source-available, all rights reserved.
You may read, run and evaluate Tab, including judging and auditing it, and any other use needs written permission first.
The Solidity sources deployed on Monad stay under MIT, because their published source must match what is on chain.
See [LICENSE](./LICENSE) for the exact terms.
