# @tabai/sdk

**Post-paid billing for autonomous agents.** Your agent calls a priced tool, gets the result immediately, and settles the bill later with its own keys. No prepayment, no held responses, no API key bought in advance.

This package is three things in one: an **MCP server** exposing four tools to any MCP client, a **CLI**, and a **TypeScript library** for building on the rail directly.

```bash
npx -y @tabai/sdk connect
```

That is the whole setup step. It finds your MCP client's configuration file, backs it up, merges one entry, and prints the diff before it writes.

---

## What is behind it

A Service meters your agent's usage into an **Open Tab** held on [Creditcoin](https://creditcoin.org) CC3 Testnet. Your agent settles that tab in USDC on Ethereum, whenever it likes, signing with keys nobody else holds.

A Creditcoin contract then verifies that Ethereum transaction **itself**, through the [Attestcoin Protocol](https://attestcoin.org)'s BlockProver Precompile at `0x…0FD2`. Creditcoin attests to finalized Ethereum blocks, so a contract can check a foreign transaction, its receipt and its event logs against an attestation, on chain, with no facilitator, no oracle and no bridge in the path.

Nobody is trusted to say the money arrived. That is the entire point, and it is why a credit limit here is computed from a settlement history the chain proved rather than one an operator reported.

**Costs.** Creditcoin gas is paid in CTC. Reading Source Chain history through the protocol carries gas cost and no protocol fee, so there is no token to acquire beyond the CTC that pays for the write and the USDC that settles the bill. Tab itself adds no fee: each Service sets its own price per tool, in integer base units of one asset.

---

## Install

Requires Node `>= 20.10.0`.

```bash
npx -y @tabai/sdk connect              # wire it into an MCP client
npx -y @tabai/sdk doctor               # check the whole installation, keylessly
```

Or as a dependency:

```bash
npm install @tabai/sdk
```

`connect` supports `claude-code`, `claude-desktop`, `cursor`, `windsurf` and `vscode`, and takes `--client <id>`, `--config <path>` or `--dry-run`. Run it twice and the second run writes nothing: the merge is idempotent and leaves no second backup.

**It never writes a private key.** Signing keys are read from the environment at the moment a Settlement is broadcast, and nothing about them is copied into a client configuration file.

`doctor` reports what it could reach and warns rather than failing on what it could not. A missing agent address is a warning, not an error, because every read-only tool works without one.

---

## The four MCP tools

Each tool declares a JSON Schema for its input and its output, and validates its own input against the schema it published.

| Tool | What it does | Spends |
| --- | --- | --- |
| `tab_discover` | Lists Services, the assets each accepts, what each tool costs, and the Bond each has staked | nothing, and needs no key |
| `tab_call` | Calls a metered tool. The charge lands on the Open Tab and is settled later | nothing at call time |
| `tab_status` | Credit limit, Open Tab, prepaid credit and headroom, per asset | nothing, and needs no key |
| `tab_settle` | Pays down an Open Tab by broadcasting a Settlement with the agent's own key | real funds |

Start with `tab_discover`, because `tab_call` needs a `serviceId` from its list.

### Nothing throws

Every fallible call returns `ok: false` with a `category`, a `code` and a `message`, so a model can decide what to do next rather than parse an exception.

The one failure worth handling by name is an agent with no headroom:

```json
{
  "ok": false,
  "category": "LIMIT",
  "code": "LIMIT_EXCEEDED",
  "message": "the charge exceeds the Agent's headroom in this Asset",
  "requiredBaseUnits": "10000",
  "headroomBaseUnits": "2500"
}
```

Both figures are present only on `LIMIT_EXCEEDED`, and they are there so the answer is actionable. **The correct response is to settle, not to retry**: retrying a call that exceeded a credit limit produces the same refusal at the same cost.

### A new agent has no credit, and that is the rule

A credit limit is capped by the Bonds of counterparties the agent already has proven settlement history with. An agent with no history has no counterparties, so it has no limit and must settle before it can buy on credit. Its first Settlement banks prepaid credit and creates the history a limit is computed from.

---

## The CLI

The same package is a CLI. Every command reads the chain; one of them writes to it, and it says so before it does.

| Command | What it does | Spends |
| --- | --- | --- |
| `connect` | Writes the `tab` entry into your MCP client's configuration | nothing |
| `mcp` | Serves the four tools over MCP. This is what a client launches | nothing |
| `doctor` | Checks the installation against the live deployment | nothing, and needs no key |
| `status` | What an agent owes, may still spend, and has settled | nothing, and needs no key |
| `settle` | Pays down an Open Tab | real funds, and only with `--broadcast` |

`settle` is a dry run unless you ask otherwise. It builds the Settlement, resolves the collection address, reports the attestation wait, and stops:

```bash
npx -y @tabai/sdk settle \
  --agent 0x1f6f…0542 \
  --asset 1:0x1c7d…7238 \
  --service 0x7461…0000 \
  --amount 47000
```

```
Dry run. Nothing was broadcast.
  chain key   1
  amount      47000
  collection  0x952acc70e6f54ce87dca963193a5957bcb27729e
  attestation about 30 minutes

Add --broadcast to send it. This spends real funds.
```

**Amounts are always base units.** USDC has six decimals, so `47000` is 0.047 USDC. Nothing in this system takes a decimal, holds a price, or consults a rate.

`mcp` serves over stdio by default, and over streamable HTTP with `--http [--port <n>] [--host <h>] [--endpoint <p>]`.

---

## Configuration

`doctor` warns when two things are missing, and both live in a config file rather than the environment, because neither is a secret: the agent whose Open Tab a call meters to, and where a Service can be reached.

Put a `tab.config.mjs` beside your project, or in any parent directory:

```js
import { Wallet, JsonRpcProvider } from "ethers";
import { createEthereumUsdcStrategy } from "@tabai/sdk";

export default {
  // Whose Open Tab a metered call lands on.
  agent: process.env.AGENT_ADDRESS,

  registryUrl: "https://registry-production-847c.up.railway.app",

  // The chain records no URL for a Service, deliberately, so the address lives here.
  services: [
    {
      serviceId: "0x7461622e70726f6f662d73657276696365000000000000000000000000000000",
      name: "tab.proof-service",
      endpoint: "https://gateway-production-3ea6.up.railway.app",
    },
  ],

  // A factory, not an object: the signer is built only if something settles,
  // so every read stays keyless.
  strategies: [
    () =>
      createEthereumUsdcStrategy({
        signer: new Wallet(
          process.env.AGENT_ETHEREUM_PRIVATE_KEY,
          new JsonRpcProvider(process.env.ETHEREUM_SEPOLIA_RPC_URL),
        ),
        assets: {
          "1:0x1c7d4b196cb0c7b01d743fbc6116a902379c7238": {
            chainKey: 1n,
            address: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
            decimals: 6,
            symbol: "USDC",
          },
        },
      }),
  ],
};
```

The key is read at the moment a Settlement is built, and never from this file. `tab_discover`, `tab_status` and `doctor` never call the factory, which is what keeps every read on this rail keyless.

**A factory may decline.** Returning `undefined`, as the one above does when no key is set, means "not available here" rather than "this config is broken": the strategy is skipped and everything else in the file stands. That is the whole reason the entry is a factory rather than an object, and it lets one config file serve a read-only process and a settling one without branching.

### Environment

| Variable | Needed for |
| --- | --- |
| `CREDITCOIN_RPC_URL` | every read. The MCP server and `doctor` need only this |
| `TAB_BOOK_ADDRESS`, `SERVICE_REGISTRY_ADDRESS`, `AGENT_REGISTRY_ADDRESS`, `BOND_ADDRESS` | resolving credit, Services and Bond |
| `NEXT_PUBLIC_REGISTRY_API_URL` | the Service directory and an agent's history, if you use the read API rather than the chain |
| `ETHEREUM_SEPOLIA_RPC_URLS` | broadcasting a Settlement. Comma-separated, because endpoints disagree about `eth_getLogs` ranges |
| `AGENT_ETHEREUM_PRIVATE_KEY` | broadcasting a Settlement, and nothing else. Never written to a configuration file |

---

## As a library

144 exports, all typed, with the types shipped in the package. It carries no workspace dependency, so it installs and type-checks on its own.

```ts
import { settlementReplayKey, createTabToolset, createTab402Client } from "@tabai/sdk";

// The four coordinates that identify a Verified Settlement, packed into one key.
const key = settlementReplayKey({
  chainKey: 1n,
  blockHeight: 11649148n,
  txIndex: 93n,
  logIndex: 0n,
});
```

The main surfaces:

| Import | What it is |
| --- | --- |
| `createTabToolset` | The four tools as plain functions, for embedding without MCP |
| `createTabMcpServer` | The MCP server itself |
| `createTab402Client` | An HTTP client that understands the post-paid `402` and its charge headers |
| `tabPostPaid`, `honoTabPostPaid`, `expressTabPostPaid`, `withTabPostPaid` | Server plugins that meter a route after it has already responded |
| `createTabProxy` | A reverse proxy that meters an upstream you do not control |
| `createEthereumUsdcStrategy`, `createStrategyRegistry` | Payment strategies, and the registry that resolves them |
| `createAttestcoinProofHook` | The proof hook, for supplying your own proof material |
| `revertMappingFor` | The single table mapping a contract revert to a category, code, disposition and remedy |

### Running a metered Service

Deliver first, charge after. The plugin adds exactly one status code to your surface, a `402` when a charge would exceed the caller's credit limit.

```ts
import { honoTabPostPaid } from "@tabai/sdk";

app.use("/tools/*", honoTabPostPaid({ serviceId, priceOf, tabBook }));
```

### Adding an asset

Tab does not know how to move money. It knows how to recognise that money moved, which is a different thing, and it is why this seam is small.

A strategy is five methods. The rule a new one has to satisfy is not "move the money", it is that **the payment must leave a log a Creditcoin contract can recognise, at an emitter and a collection address the registry already knows**. Anything satisfying that works; anything else cannot be verified and is therefore not a Settlement.

```ts
export interface PaymentStrategy {
  readonly id: string;
  readonly chainKeys: readonly bigint[];
  supports(asset: AssetRef): boolean;
  quote(request: ChargeRequest): Promise<Result<ChargeQuote>>;
  settle(request: SettleRequest): Promise<Result<SettlementReceipt>>;
  settleBatch?(requests: readonly SettleRequest[]): Promise<Result<readonly SettlementReceipt[]>>;
  watchHint(receipt: SettlementReceipt): SettlementHint;
}
```

`settleBatch` is optional and should stay undefined where the surface has no batch form. A plain asset `Transfer` has none, and faking one would mean claiming a guarantee the chain does not give.

---

## Live deployment

Everything below is running now and needs nothing installed.

| | |
| --- | --- |
| Dashboard | [trytabai.vercel.app](https://trytabai.vercel.app) |
| Documentation | [trytabai-docs.vercel.app](https://trytabai-docs.vercel.app) |
| Registry read API | [`registry-production-847c.up.railway.app`](https://registry-production-847c.up.railway.app/services) |
| Source | [github.com/EmadQureshiKhi/Tab](https://github.com/EmadQureshiKhi/Tab) |

## Network

| | |
| --- | --- |
| Network | Creditcoin CC3 Testnet |
| Chain id | `102031` |
| RPC | `https://rpc.cc3-testnet.creditcoin.network` |
| Explorer | [creditcoin-testnet.blockscout.com](https://creditcoin-testnet.blockscout.com) |
| BlockProver Precompile | `0x0000000000000000000000000000000000000FD2` |
| ChainInfo Precompile | `0x0000000000000000000000000000000000000fd3` |

Source chains are Ethereum Sepolia as `chainKey 1` and Ethereum Mainnet as `chainKey 3`.

The contracts this package talks to, all live:

| Contract | Address |
| --- | --- |
| `TabBook` | [`0x047ECFB428FE706eA391B626872Ce8Deb8756c5f`](https://creditcoin-testnet.blockscout.com/address/0x047ECFB428FE706eA391B626872Ce8Deb8756c5f) |
| `SettlementVerifier` | [`0xDf4e7F76e5821ab351877C7862117fDdbC7a44a7`](https://creditcoin-testnet.blockscout.com/address/0xDf4e7F76e5821ab351877C7862117fDdbC7a44a7) |
| `ServiceRegistry` | [`0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC`](https://creditcoin-testnet.blockscout.com/address/0xF6Bb0d068698e504e2F21ca61c48167634a1fcAC) |
| `AgentRegistry` | [`0x4721f24974be89287F5C34aeE4D15D20389A2a8B`](https://creditcoin-testnet.blockscout.com/address/0x4721f24974be89287F5C34aeE4D15D20389A2a8B) |
| `Bond` | [`0xDbB6C19A4236ACdd8535E993C5fA93E6Ff1f173A`](https://creditcoin-testnet.blockscout.com/address/0xDbB6C19A4236ACdd8535E993C5fA93E6Ff1f173A) |

Attestation of an Ethereum Mainnet block takes roughly 13 to 15 minutes. **Nothing in an agent's request path waits for it**: a metered call completes immediately, and headroom is restored the moment a Settlement is observed, against the Service's staked Bond.

---

## Built by

Emad Qureshi, for the BUIDL CTC 2026 Fall hackathon. MIT licensed.

Tab is an original Creditcoin-native build. The Attestcoin Protocol is not incidental to it: remove the precompile and no path remains from an Ethereum payment to a reduced Open Tab, and what is left is an off-chain operator signing a claim that funds landed, which is the trusted facilitator this exists to remove.
