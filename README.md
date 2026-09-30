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
  <img alt="179 contract tests passing" src="https://img.shields.io/badge/contract%20tests-179%20passing-2f8132">
  <img alt="Live on Monad Mainnet and Testnet" src="https://img.shields.io/badge/status-live%20on%20Mainnet%20%26%20Testnet-2f8132">
  <a href="https://www.npmjs.com/package/@tabai/sdk"><img alt="npm @tabai/sdk" src="https://img.shields.io/npm/v/@tabai/sdk?label=%40tabai%2Fsdk&color=0D7676"></a>
  <a href="./LICENSE"><img alt="Source-available licence" src="https://img.shields.io/badge/license-source--available-444"></a>
  <a href="https://x.com/TryTabAI"><img alt="Follow @TryTabAI on X" src="https://img.shields.io/badge/follow-%40TryTabAI-000000?logo=x&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://trytabai.vercel.app"><b>Website</b></a> ·
  <a href="https://trytabai-docs.vercel.app"><b>Docs</b></a> ·
  <a href="https://www.npmjs.com/package/@tabai/sdk"><b>@tabai/sdk</b></a> ·
  <a href="https://www.npmjs.com/package/@tabai/agent-wallet-plugin"><b>@tabai/agent-wallet-plugin</b></a> ·
  <a href="https://x.com/TryTabAI"><b>X @TryTabAI</b></a> ·
  <a href="#launch-video"><b>Launch video</b></a> ·
  <b>Demo video</b> (coming soon)<!-- demo-video: link goes here -->
</p>

# Tab

**Agents buy first and pay later, and nobody is trusted to say the money arrived.**

<a id="launch-video"></a>

https://github.com/user-attachments/assets/9c53db2f-0768-4019-9b2d-b0f44c7bd8da

A Service meters usage into an Open Tab held on Monad.
The Agent settles that tab in USDC or AUSD, with its own keys, whenever it likes.
`TabSettlement` moves the Asset to the Service and applies the Settlement to the tab in the same transaction, so the transfer and the ledger entry cannot disagree.
The Credit Limit is a pure function of the Settlements the chain has already applied.
No facilitator, oracle, bridge or API key sits between the payment and the ledger entry.

An autonomous agent cannot open a bank account or hold a card, so today every way it pays is a prepayment.
Post-paid billing needs a repayment record, and on Monad the payment and the record are the same state change.

Built by **Emad Qureshi**.

## Live

| | Where |
| --- | --- |
| Dashboard | [trytabai.vercel.app](https://trytabai.vercel.app), Mainnet or Testnet from the switch in the header |
| Documentation | [trytabai-docs.vercel.app](https://trytabai-docs.vercel.app) |
| X | [@TryTabAI](https://x.com/TryTabAI) |
| Launch video | [at the top of this README](#launch-video) |
| Demo video | coming soon |
| SDK, CLI and MCP server | [`@tabai/sdk`](https://www.npmjs.com/package/@tabai/sdk): `npx -y @tabai/sdk connect` |
| MetaMask Agent Wallet plugin | [`@tabai/agent-wallet-plugin`](https://www.npmjs.com/package/@tabai/agent-wallet-plugin): `mm plugins install @tabai/agent-wallet-plugin` (a first install on CLI 7.0.0 needs [the workaround in its README](packages/agent-wallet-plugin/README.md#install)) |
| Registry read API | Mainnet `https://registry-mainnet-production.up.railway.app`, Testnet `https://registry-testnet-production.up.railway.app` |
| Metering gateway (demo Service `tab.demo`) | Mainnet `https://gateway-mainnet-production.up.railway.app`, Testnet `https://gateway-testnet-production-a657.up.railway.app` |
| Delinquency keeper | Mainnet `https://keeper-mainnet-production-0f50.up.railway.app`, Testnet `https://keeper-testnet-production-e820.up.railway.app` |

Testnet is the free playground, priced in a mintable test token (`mUSDC`) and in Circle's Testnet USDC.
Mainnet uses real USDC and AUSD, so the Dashboard rate-limits Mainnet trial calls, each of which spends real gas.

## How it works

<img src="./assets/readme/loop.png" alt="How one Settlement works: the Agent authorises and calls on credit while the Service meters each delivery into the Open Tab; the Agent settles through TabSettlement, which applies the Settlement in TabBook and moves the Asset to the Collection address in one Monad transaction; LimitLib then recomputes the Credit Limit and headroom is back in the same block" width="960">

1. **Authorise.** The Agent sets its own ceiling on chain with `TabBook.authorise(serviceId, asset, maxCumulative, expiry)`.
2. **Call on credit.** The Service does the work, returns it, and only then records the charge with `TabBook.recordDelivery`, inside the Credit Limit.
3. **Settle on Monad.** The Agent calls `TabSettlement.settle(serviceId, asset, amount)` with its own key, or signs a Permit2 witness that anyone may submit through `settleWithPermit2`.
   In the same transaction `TabBook.applySettlement` lowers the Open Tab, banks any surplus as prepaid credit, and extends the Agent's history commitment.
4. **Credit follows.** The next call sees the new headroom in the same block, with nothing pending and nothing to reverse.

Anyone may mark a tab delinquent once its Settlement Window closes, which zeroes the Agent's Credit Limit in that Asset until it settles.
Only the settlement surface wired once at deployment may call `TabBook.applySettlement`, so no operator, indexer or off-chain process can reduce an Open Tab.
The full walk-through is [How the rail works](https://trytabai-docs.vercel.app/how-it-works).

### Every way an Agent pays

<img src="./assets/readme/settlement-paths.png" alt="Every way an Agent pays: direct settle with its own key, a gasless Permit2 Settlement relayed by the gateway, and funding first through Kuru or NEAR Intents all enter TabSettlement, which applies the Settlement in TabBook in the same transaction; an x402 payment on a credit refusal goes through Monad's x402 facilitator and stays outside the credit history" width="960">

## Credit, and what bounds it

<img src="./assets/readme/credit.png" alt="How a Credit Limit is computed: only same-Asset Settlements to Curated, bonded Services with an earlier delivery count; each is weighted from 25 to 100 percent over 30 days; the limit is the smallest of baseline plus growth, the 25 percent concentration cap and 95 percent of the counterparties' free Bond" width="960">

| Bound | Value | What it stops |
| --- | --- | --- |
| Baseline | 5,000,000 base units (5 USDC) on both networks, a deployment parameter | credit before any history exists |
| Age ramp | 25% to 100% weight over 30 days | a burst of fresh Settlements counting as seasoned history |
| Bond cap | 95% of the counterparties' free Bond, on every path | credit that nothing stands behind |
| Concentration cap | 25% per counterparty | one Service carrying an Agent's whole limit |
| Curated counterparties | at least 3 before any growth above the baseline | a ring of two buying credit from itself |
| History bound | 512 records, 32 counterparties | an unbounded witness |

A new Agent that authorises a bonded Service starts at `min(baseline, 95% of that Service's free Bond)`, and anything above the baseline is earned by settled history.
To unlock `X` of credit, a colluding ring must lock strictly more than `X` in Bonds on Curated Services; the derivation is in [the whitepaper](./WHITEPAPER.md#6-the-credit-model).

## Architecture

<img src="./assets/readme/architecture.png" alt="System architecture: the SDK, MCP server, MetaMask plugin and Dashboard on the left; the gateway, registry and keeper off chain in the middle; ServiceRegistry, Bond, TabBook, TabSettlement, LimitLib, MeteringDelegates and CurationMultisig on Monad on the right, the only layer that moves money or changes a tab" width="960">

The registry serves a Credit Limit only where its own recomputation agrees with the chain, and the Dashboard asks for a wallet only when you are about to sign.

## Deployed on chain

Every address below is read back off the chain by [`script/02_VerifyDeployment.s.sol`](./packages/contracts/script/02_VerifyDeployment.s.sol), which holds no key and sends nothing.
`MeteringDelegates` is wired to nothing, so it was deployed on its own by [`script/06_DeployMeteringDelegates.s.sol`](./packages/contracts/script/06_DeployMeteringDelegates.s.sol), which checks the recorded address when run again.
Every contract is source-verified through Monad's Sourcify: a full creation and runtime match on Mainnet, a runtime match on Testnet.

| | Monad Mainnet, chain id `143` | Monad Testnet, chain id `10143` |
| --- | --- | --- |
| `CurationMultisig` | `0x123c19F46C38d5b4E922D1297250a71A03DFFD17` | none, the deploying account holds the role |
| `ServiceRegistry` | `0x4F791F13F94944fCB2F884f8C7991cAa583884A6` | `0x3638DB35A76E5a22EA1E827636dA994be622c139` |
| `Bond` | `0xbA86C0D053ba88afDECbED8aBa5b2eC3973fb230` | `0x29aDfD90Fc7c9026563Fc60651f696ab089080E7` |
| `TabBook` | `0x0Dabf8E52280D0F128f546602a99b6DC4fbb80DC` | `0x87571030cCe27C84836bAfF85288eB1d85d908a4` |
| `TabSettlement` | `0x32A96bfEABe766B4898b961B333B7B89f079a9a9` | `0x654Fac48185e4B71779eEc2457B1F24aEdf46717` |
| `MeteringDelegates` | `0x32f04C3e19d6a39f1B8A513ad86Bd8d5c6486F98` | `0xD287900EE0D4415CE4d362Fe8b6a4D4d6413A1a9` |
| `MockUsdc` (`mUSDC`) | none | `0x480209747417f5c830fDA188a9b9AcFa70Bc4083` |
| Assets | USDC `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`, AUSD `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a` | Circle's USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3`, `mUSDC` |
| Permit2 (Uniswap, canonical) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | the same |
| ERC-8004 Identity, Reputation | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004A818BFB912233c491871b3d84c89A494BD9e`, `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Deployment block | `107094526` (multisig `107094289`, `MeteringDelegates` `109211361`) | `64554587` (`MeteringDelegates` `66860629`) |
| Demo Service `tab.demo` | Bond 1 USDC, accepts USDC and AUSD, ERC-8004 identity `10254` | Bond 50 mUSDC and 20 USDC, ERC-8004 identity `1913` |
| Demo Agent identity | `10255` | `1914` |
| RPC, explorer | `https://rpc.monad.xyz`, `https://monadvision.com` | `https://testnet-rpc.monad.xyz`, `https://testnet.monadvision.com`, faucet `https://faucet.monad.xyz` |

`tab.demo` prices `quote.generate` at 0.01 in each Asset, plus the fronted tools `apihub.run` and `nansen.query` at one base unit a unit, applied after the registry's 48-hour hold.
Both demo Agent identities are owned by the Agent address `0x3a3B6079e418C81a9dE08414Bb07ea817939e7Ce` itself, which is what lets `tab.demo` write reputation about it.
On Testnet, `tab.demo.b` and `tab.demo.c` are registered and bonded with 50 mUSDC each, and the Curated tier for all three is queued with eta `2026-10-02T02:44:06Z`.
Every transaction hash and applied change id is in [`deployments.json`](./deployments.json), under `networks`.

## On Monad, end to end

Every piece is in the tree and exercised by tests, and none of them changes what a Settlement is.
Each has its own section on [On Monad](https://trytabai-docs.vercel.app/on-monad).

| Piece | What Tab does with it | Where |
| --- | --- | --- |
| **x402, V2** | A `402 LimitExceeded` carries an offer for the same charge through Monad's facilitator; a paid call is delivered prepaid, off the Open Tab | `packages/sdk/src/x402`, `apps/gateway/src/x402.ts` |
| **Monad API Hub** | `/hub/apihub/run` fronts the Hub's providers on credit: the Service pays the x402 price and meters the Agent for it plus its margin | `packages/sdk/src/x402/hub.ts`, `apps/gateway/src/server.ts` |
| **Permit2** | Gasless Settlement: the Agent signs a bound witness and the gateway's `/relay/settle` submits it | `packages/contracts/src/TabSettlement.sol`, `apps/gateway/src/relay.ts` |
| **ERC-8004** | Identities indexed and shown; one Reputation entry per Settlement to `tab.demo`, naming its transaction | `apps/registry/src/erc8004.ts`, `apps/gateway/src/reputation.ts` |
| **Envio HyperSync** | The indexer's cold start, past the public RPC's 100-block `eth_getLogs` cap | `apps/registry/src/hypersync.ts` |
| **Nansen** | A weekly Agent profile bought over x402 for three cents; `/hub/nansen/*` fronts Nansen on credit | `apps/registry/src/nansen-profile.ts` |
| **Mera passkeys** | `/keys` on the Dashboard: one passkey yields an owner key and a session key per Agent runtime | `apps/app/components/passkey` |
| **MetaMask Agent Wallet** | `mm tab` with six commands; the wallet signs every write, and a metering delegate signs `call` | `packages/agent-wallet-plugin` |
| **Privy server wallets** | The Agent's key in a Privy wallet whose policy allows only Tab's calls on one chain | `packages/sdk/src/signers`, `scripts/privy-agent.mjs` |
| **Chainlink CRE** | The keeper's ten-minute schedule, compiled to WASM and run under the simulator | `apps/cre-keeper`, `apps/keeper` |
| **Kuru** | Swaps a shortfall in from another token before settling | `packages/sdk/src/payments/kuru.ts` |
| **NEAR Intents** | Brings a USDC shortfall from another chain through 1Click, then settles on Monad | `packages/sdk/src/payments/intents.ts` |
| **Agora AUSD** | A first-class Asset beside USDC on Mainnet | `packages/shared/src/chains.ts` |

x402 and Hub payments are prepaid and outside the credit history; the Credit Limit reads only Settlements applied on chain.

## What has run live

| Run | Network | Proof |
| --- | --- | --- |
| Four Settlements from three demo Agents on calls metered by the hosted gateway, two direct and two through its Permit2 relay | Mainnet | blocks `109111831` to `109112120`, on the Mainnet Dashboard |
| The MetaMask plugin end to end from a server wallet: `delegate`, `authorise`, a 0.01 USDC delegate-signed `call`, `settle` | Mainnet | Settlement in block `109352198`; every hash in [the plugin's README](packages/agent-wallet-plugin/README.md) |
| A 0.11132 USDC shortfall brought from Arbitrum through NEAR Intents, then a 0.20 USDC Settlement | Mainnet | block `109379821`, `0x863e9ae50961b38e7bf12e7ae14e7384bc543725ea51c8acdd9dc8bf9f817497` |
| A Privy server-wallet Agent: Privy's own `policy_violation` on a disallowed transfer, then the loop direct and gasless until the tabs settled to zero | Testnet | [`scripts/privy-agent.mjs`](./scripts/privy-agent.mjs) |
| One ERC-8004 reputation entry after each Settlement to `tab.demo` | both | the demo Agent's Dashboard page reads the count live |

## Status

| | |
| --- | --- |
| Live | Contracts on both networks, verified keylessly and on Sourcify; a hosted registry, gateway and keeper per network; the Dashboard and the docs; both npm packages |
| Pending | Credit growth above the baseline on Testnet once the queued Curated tier applies on 2026-10-02, when [`scripts/credit-growth.mjs`](./scripts/credit-growth.mjs) shows a fresh Agent rising from the 5 mUSDC baseline toward 20 mUSDC; the CRE workflow on a DON, which has run under the CRE simulator and waits on Chainlink deploy access |
| Tests | 179 contract tests, including property tests, and 808 TypeScript tests across eight packages |

Nothing is pinned to one network: `deployments.json` holds one entry per chain id, and `MONAD_CHAIN_ID` selects it.

## Quick start

Node `>= 20.10.0`, pnpm `9.15.3` (never npm), and Foundry for the Solidity work.

Verify the live Testnet deployment, keylessly:

```bash
pnpm install
pnpm env:bootstrap        # writes .env from .env.example plus the recorded Testnet addresses
cd packages/contracts && set -a && source ../../.env && set +a && forge script script/02_VerifyDeployment.s.sol:VerifyDeployment --rpc-url monad_testnet --sig "run()"
```

For Mainnet, `node scripts/env-bootstrap.mjs --print --chain 143` prints the same environment, and the same script verifies it with `--rpc-url monad`.

Put an agent on the rail:

```bash
npx -y @tabai/sdk connect      # merges an mcpServers.tab entry into your MCP client's config, never a key
npx -y @tabai/sdk doctor       # checks the installation against the live deployment, keylessly
npm install @tabai/sdk         # or use it as a library
```

The MCP server gives an agent four tools: `tab_discover` and `tab_status`, which need no key; `tab_call`, a metered call on credit that reports the x402 offer on a refusal; and `tab_settle`, which spends real funds, directly or `monad-relayed` through Permit2.
None of them throws; a failure returns `ok: false` with a `category`, a `code` and a `message`.
With `AGENT_ADDRESS` and `AGENT_PRIVATE_KEY` set, a fresh install calls the hosted demo Service and settles its tab with no configuration file.

Run the rail locally:

```bash
docker compose up -d db
DATABASE_URL=postgres://tab:tab@127.0.0.1:5432/tab pnpm --filter @tabai/registry db:apply
DATABASE_URL=postgres://tab:tab@127.0.0.1:5432/tab node --env-file=.env apps/registry/dist/main.js   # :8787
node --env-file=.env apps/gateway/dist/main.js                                                      # :8788
node --env-file=.env --import tsx apps/keeper/src/main.ts once                                      # lists overdue tabs
pnpm --filter @tabai/app build:site && pnpm --filter @tabai/app serve                               # :3000
pnpm --filter @tabai/docs dev                                                                       # :3001
```

The guides: [`packages/sdk/README.md`](./packages/sdk/README.md), [Integration](https://trytabai-docs.vercel.app/integration) and [Using the Dashboard](https://trytabai-docs.vercel.app/dashboard).

## Verify and test

CI runs every one of these.

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test   # 808 TypeScript tests; lint includes the WCAG AA contrast gate
cd packages/contracts && forge test                        # 179 contract tests, property tests, Permit2 against the canonical bytecode
pnpm coverage              # 90% of lines on the money-handling contracts, 75% on the registry and the multisig
pnpm lint:deps             # no import points the wrong way through the workspace
pnpm env:check             # every process.env read is declared in .env.example
pnpm deployments:check     # deployments.json and .env.example describe the same deployment
```

Contributor detail and the traps worth knowing before you spend gas are in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Security

- **Published security scan.** [Slither](https://github.com/crytic/slither) 0.11.6 ran all 102 detectors over the core contracts, and every result is triaged in [`packages/contracts/audit/slither.md`](./packages/contracts/audit/slither.md): none is an exploitable vulnerability.
  `pnpm --filter @tabai/contracts audit:slither` re-runs it.
- **Verified on Monad.** Every contract's source is verified through Monad's Sourcify, a full creation and runtime match on Mainnet and a runtime match on Testnet, and a keyless script reads every deployed address and setting back from the chain on both networks.
- **Checked on every push.** A secret scan over the whole git history and the working tree with a pinned, checksum-verified scanner; a dependency audit that reports no known vulnerabilities; property-based fuzz and invariant suites; coverage floors on the money-handling contracts; and a read-only reproduction job that holds no secrets.
- **Curation behind a multisig and a timelock.** On Mainnet the Curated tier is set by a 2-of-3 [`CurationMultisig`](./packages/contracts/src/CurationMultisig.sol), and every registry change waits 48 hours behind a public event before it applies.
- **Who is trusted, for what.** The [threat model](https://trytabai-docs.vercel.app/threat-model) and [the whitepaper's security analysis](./WHITEPAPER.md#7-security-analysis).

## Repository layout

<img src="./assets/readme/tree.png" alt="Repository layout: packages holds contracts (the deployed Solidity sources, deploy scripts and the Slither audit), the SDK, the MetaMask plugin and shared constants; apps holds the gateway, registry, keeper, CRE keeper, the Dashboard and the docs; plus scripts, deployments.json and the whitepaper" width="960">

The terms are defined in the [glossary](https://trytabai-docs.vercel.app/glossary), and the full design is in [`WHITEPAPER.md`](./WHITEPAPER.md).

## Author

**Emad Qureshi**. Design, contracts, off-chain rail, SDK, interfaces and documentation.

## License

Source-available, all rights reserved.
You may read, run and evaluate Tab, including judging and auditing it, and any other use needs written permission first.
The Solidity sources deployed on Monad stay under MIT, because their published source must match what is on chain.
See [LICENSE](./LICENSE) for the exact terms.
