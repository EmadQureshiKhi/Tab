# @tabai/sdk

**Post-paid billing for autonomous agents on Monad.** Your agent calls a priced tool, gets the result in the block its charge is recorded in, and settles the bill later with its own keys. No prepayment, no held responses, no API key bought in advance.

This package is three things in one: an **MCP server** exposing four tools to any MCP client, a **CLI**, and a **TypeScript library** for building on the rail directly.

```bash
npx -y @tabai/sdk connect
```

That is the whole setup step. It finds your MCP client's configuration file, backs it up, merges one entry, and prints the diff before it writes.

---

## What is behind it

A Service meters your agent's usage into an **Open Tab** held in `TabBook` on Monad. Your agent settles that tab in USDC or AUSD on the same chain, whenever it likes, signing with keys nobody else holds.

Settlement is one transaction. `TabSettlement.settle` moves the Asset to the Service's collection address and applies the Settlement to the Open Tab in the same block, atomically. There is no facilitator, no oracle, no bridge and no waiting: the transfer and the credit are the same state change, so nobody has to be trusted to say the money arrived.

That is why a credit limit here is a pure function of onchain history. It is computed from the Settlements the chain itself recorded and the Bonds the agent's counterparties have escrowed, and nothing an operator reports enters the figure.

**Costs.** Gas is paid in MON. Tab itself adds no fee: each Service sets its own price per tool, in integer base units of one asset, and the amount charged is the amount transferred.

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
| `tab_call` | Calls a metered tool. The charge lands on the Open Tab and is settled later. With an x402 signer configured, a refusal that carries an x402 offer is prepaid instead | nothing at call time, unless it prepays |
| `tab_status` | Credit limit, Open Tab, prepaid credit and headroom, per asset, with recent Settlements | nothing, and needs no key |
| `tab_settle` | Pays down an Open Tab by sending a Settlement with the agent's own key, or a Permit2 signature through the relay | real funds |

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

Both figures are present only on `LIMIT_EXCEEDED`, and they are there so the answer is actionable. **The correct response is to settle, not to retry**: retrying a call that exceeded a credit limit produces the same refusal at the same cost. A Settlement restores headroom in the block it lands.

### A new agent starts at the baseline, and earns the rest

A credit limit is capped by the Bonds of the Services the agent deals with, and a Service the agent has authorised counts as one before any Settlement.
So a brand-new agent that authorises a bonded Service starts at `min(baseline, 95% of that Service's free Bond)`: the Service's own decision to carry a stranger, backed by its own stake.
Anything above the baseline is earned, by settled history with at least three Curated, bonded Services.
An agent that has authorised nobody has no counterparties and no limit.

---

## The CLI

The same package is a CLI. Every command reads the chain; one of them writes to it, and it says so before it does.

| Command | What it does | Spends |
| --- | --- | --- |
| `connect` | Writes the `tab` entry into your MCP client's configuration | nothing |
| `mcp` | Serves the four tools over MCP. This is what a client launches | nothing |
| `doctor` | Checks the installation against the live deployment | nothing, and needs no key |
| `status` | What an agent owes, may still spend, and has settled | nothing, and needs no key |
| `settle` | Pays down an Open Tab, with the agent's key or, with `--strategy monad-relayed`, by a Permit2 signature the gateway submits | real funds, and only with `--broadcast` |

`settle` is a dry run unless you ask otherwise. It checks the Service accepts the Asset, quotes the amount, and stops:

```bash
npx -y @tabai/sdk settle \
  --agent 0x1f6f…0542 \
  --asset 10143:0x4802…4083 \
  --service 0x7461…0000 \
  --amount 47000
```

```
Dry run. Nothing was broadcast.
  chain id    10143
  amount      47000

Add --broadcast to send it. This spends real funds.
```

**Amounts are always base units.** USDC has six decimals, so `47000` is 0.047 USDC. Nothing in this system takes a decimal, holds a price, or consults a rate.

`mcp` serves over stdio by default, and over streamable HTTP with `--http [--port <n>] [--host <h>] [--endpoint <p>]`.

---

## Configuration

Two things are yours to name, and both live in a config file rather than the environment, because neither is a secret: the agent whose Open Tab a call meters to, and any Service beyond the hosted demo one. `doctor` warns when the agent is missing.

Put a `tab.config.mjs` beside your project, or in any parent directory:

```js
import { Wallet, JsonRpcProvider } from "ethers";
import { createMonadStrategy } from "@tabai/sdk";

export default {
  // Whose Open Tab a metered call lands on.
  agent: process.env.AGENT_ADDRESS,

  registryUrl: process.env.NEXT_PUBLIC_REGISTRY_API_URL,

  // The chain records no URL for a Service, deliberately, so the address lives here.
  services: [
    {
      serviceId: "0x7461622e64656d6f000000000000000000000000000000000000000000000000",
      name: "tab.demo",
      endpoint: "https://gateway-testnet-production-a657.up.railway.app",
    },
  ],

  // The prepaid fallback, a factory for the same reason the strategies are.
  // Called only when a Service has refused a call on credit and offered x402
  // for it. Returning undefined declines, and the refusal stands as LIMIT_EXCEEDED.
  x402: () =>
    process.env.AGENT_PRIVATE_KEY === undefined
      ? undefined
      : new Wallet(process.env.AGENT_PRIVATE_KEY, new JsonRpcProvider(process.env.MONAD_RPC_URL)),

  // A factory, not an object: the signer is built only if something settles,
  // so every read stays keyless.
  strategies: [
    () => {
      if (process.env.AGENT_PRIVATE_KEY === undefined) return undefined;
      return createMonadStrategy({
        signer: new Wallet(process.env.AGENT_PRIVATE_KEY, new JsonRpcProvider(process.env.MONAD_RPC_URL)),
        tabSettlement: process.env.TAB_SETTLEMENT_ADDRESS,
        assets: {
          "10143:0x480209747417f5c830fda188a9b9acfa70bc4083": {
            chainId: 10143n,
            address: "0x480209747417f5c830fda188a9b9acfa70bc4083",
            decimals: 6,
            symbol: "mUSDC",
          },
        },
      });
    },
  ],
};
```

The key is read at the moment a Settlement is built, and never from this file. `tab_discover`, `tab_status` and `doctor` never call the factory, which is what keeps every read on this rail keyless.

**A factory may decline.** Returning `undefined`, as the one above does when no key is set, means "not available here" rather than "this config is broken": the strategy is skipped and everything else in the file stands. That is the whole reason the entry is a factory rather than an object, and it lets one config file serve a read-only process and a settling one without branching.

### Environment

| Variable | Needed for |
| --- | --- |
| `MONAD_RPC_URL` | `doctor`'s chain checks and a Settlement signer, the network's public endpoint when unset. The MCP tools read through the registry API |
| `MONAD_CHAIN_ID` | `143` for Mainnet, `10143` for Testnet. Defaults to Testnet |
| `TAB_BOOK_ADDRESS`, `TAB_SETTLEMENT_ADDRESS`, `SERVICE_REGISTRY_ADDRESS`, `BOND_ADDRESS` | resolving credit, Services and Bond |
| `NEXT_PUBLIC_REGISTRY_API_URL` | the Service directory and an agent's history. Defaults to the project's hosted registry for the chosen network |
| `TAB_HOSTED_DEFAULTS` | `off` stops the hosted registry and demo Service from filling in what you did not configure |
| `AGENT_ADDRESS` | the Agent a metered call lands on, when `tab.config` names none. Public, so `connect` copies it into the MCP stanza |
| `AGENT_PRIVATE_KEY` | broadcasting a Settlement, signing a Permit2 witness, paying an x402 offer, or signing a call to the hosted demo Service, and nothing else. Never written to a configuration file |
| `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID`, `PRIVY_AUTHORIZATION_KEY` | the Agent's key in a Privy server wallet instead of `AGENT_PRIVATE_KEY`, read by the repository's `tab.config.mjs`. The secret and the authorization key are never written to a configuration file |

---

## As a library

Every export is typed, with the types shipped in the package. It carries no workspace dependency, so it installs and type-checks on its own.

```ts
import { createTabToolset, createTab402Client, createMonadStrategy } from "@tabai/sdk";
```

The main surfaces:

| Import | What it is |
| --- | --- |
| `createTabToolset` | The four tools as plain functions, for embedding without MCP |
| `createTabMcpServer` | The MCP server itself |
| `createTab402Client` | An HTTP client that understands the post-paid `402` and its charge headers |
| `tabPostPaid`, `honoTabPostPaid`, `expressTabPostPaid`, `withTabPostPaid` | Server plugins that meter a route after it has already responded |
| `createTabProxy` | A reverse proxy that meters an upstream you do not control |
| `createX402Client`, `signExactPayment` | The x402 side of the Agent: sign an EIP-3009 authorization for an `exact` requirement and repeat the request with it |
| `handlePrepaidRequest`, `exactRequirementFor`, `createX402Facilitator` | The x402 side of a Service: offer a payment on a `402`, and take one through a facilitator |
| `createX402FrontedProxy`, `createX402UpstreamPricing` | Buy now, pay later: front an x402 upstream, pay it, and meter the Agent |
| `fetchHubManifest` | Monad's API Hub manifest, as tools of the Service fronting a provider |
| `createMonadStrategy`, `createStrategyRegistry` | The Monad payment strategy, and the registry that resolves strategies |
| `createRelayedMonadStrategy`, `signSettlementPermit` | Gasless settlement: a Permit2 witness the Agent signs and a relay submits |
| `createKuruFundedStrategy`, `createKuruOnchainRouter` | Settle in any asset: swap the shortfall in through Kuru before the Monad strategy settles |
| `createIntentsFundedStrategy`, `createOneClickClient` | Fund from another chain: bring a USDC shortfall to Monad through NEAR Intents before the Monad strategy settles |
| `createPrivyAgentSigner`, `buildPrivyAgentPolicy`, `createPrivyAgentWallet` | An Agent key in a Privy server wallet, the policy that bounds it, and the wallet created under that policy |
| `revertMappingFor` | The single table mapping a contract revert to a category, code, disposition and remedy |

### Running a metered Service

Deliver first, charge after.
The plugin adds three status codes to your surface: a `402` when a charge would exceed the caller's credit limit, a `403` when the Agent's spending authorisation is missing, lapsed or spent, and a `409` when the tab is delinquent.

```ts
import { honoTabPostPaid, tabPostPaid } from "@tabai/sdk";

app.use("/meter/*", honoTabPostPaid(tabPostPaid({ serviceId, asset, priceOf, tabBook })));
```

Mount it under `/meter/`: `tab_call` sends a call to `<endpoint>/meter/<tool>`, so the endpoint in `tab.config` is the Service's root and `/hub/<prefix>` sits beside the tools.

A gateway anyone can reach requires a signature on every metered call, and the Agent gives its own: put `headers: agentSignedMetering(agentSigner)` on the Service entry in `tab.config` and `tab_call` signs a digest of the method, path, Agent, tool, units and a timestamp with the Agent's key, sent as `Tab-Agent-Signature`. The key is built per call and never for a read, and it signs only when it is the Agent the call is metered against; for anyone else it adds nothing and the Service decides. A Service's own front can sign the same digest with the operator key instead.

An Agent whose wallet cannot sign a message can name a session key in `MeteringDelegates` once, on chain, and put `headers: delegateSignedMetering(() => ({ agent, signer }))` on the entry instead.
The key signs the same digest, sent as `Tab-Delegate-Signature` beside `Tab-Delegate`, and the gateway accepts it only while the chain says the Agent registered that key.
A delegate signs claims and nothing else, cannot move funds, and stays within the Agent's `TabBook.authorise` ceilings.
`METERING_DELEGATES` carries the contract's address on each network, and it is deployed on both.
Both hosted gateways accept delegate signatures and read the contract on every delegate-signed call, so a revocation takes effect on the next call.

### Adding a strategy

A strategy is how an agent pays. On Monad a tab is paid through `TabSettlement`, by `settle` with the Agent's key or by `settleWithPermit2` with its signature, and the shipped strategies do one each. The seam exists so that a different signer, a smart account, a session key, or a test double can stand behind the same call without the SDK caring which.

```ts
export interface PaymentStrategy {
  readonly id: string;
  readonly chainIds: readonly bigint[];
  supports(asset: AssetRef): boolean;
  quote(request: ChargeRequest): Promise<Result<ChargeQuote>>;
  settle(request: SettleRequest): Promise<Result<SettlementReceipt>>;
  settleBatch?(requests: readonly SettleRequest[]): Promise<Result<readonly SettlementReceipt[]>>;
}
```

A receipt carries the transaction hash and, once the receipt is read, the `settlementId`, `applied` and `toPrepaid` figures straight off the `Settled` event. `settleBatch` maps onto `TabSettlement.settleBatch`, which settles several tabs in one transaction.

### An Agent key in a Privy server wallet

`createPrivyAgentSigner` is an ethers signer whose key lives in a Privy server wallet, so the key never sits in the Agent's environment.
Every signature is a request to Privy's wallet API, and Privy's policy engine decides whether to sign it, so a compromised Agent process can sign only what the policy allows.
It goes wherever this package takes a signer: `createMonadStrategy`, `createRelayedMonadStrategy`, `agentSignedMetering` and the x402 client.

```ts
import { JsonRpcProvider } from "ethers";
import { agentSignedMetering, createMonadStrategy, createPrivyAgentSigner } from "@tabai/sdk";

const privy = createPrivyAgentSigner({
  appId: process.env.PRIVY_APP_ID,
  appSecret: process.env.PRIVY_APP_SECRET,          // never logged
  walletId: process.env.PRIVY_WALLET_ID,
  authorizationKey: process.env.PRIVY_AUTHORIZATION_KEY, // the Agent's signer key, `wallet-auth:...`
  chainId: 10143n,
  provider: new JsonRpcProvider("https://testnet-rpc.monad.xyz", 10143, { staticNetwork: true }),
});
if (!privy.ok) throw new Error(privy.error.message);

const headers = agentSignedMetering(() => privy.value);           // personal_sign
const strategy = createMonadStrategy({ signer: privy.value, tabSettlement, assets }); // eth_signTransaction
```

`signMessage` is `personal_sign`, `signTypedData` is `eth_signTypedData_v4`, and a transaction is signed with `eth_signTransaction` and broadcast through the provider you pass; `transactions: "privy"` has Privy send it with `eth_sendTransaction` on the chain's `caip2` instead.
Every signature is recovered, and every signed transaction decoded and compared with the request, before either is used.
A policy refusal throws `PrivyError` with code `PRIVY_POLICY_DENIED`, which a strategy reports as its error's `cause`, and the message names the call that was refused and the rules the policy has for that method.

`buildPrivyAgentPolicy` writes the policy for one chain: transactions only to `TabSettlement` (`settle`, `settleBatch`), `TabBook` (`authorise`), an accepted Asset (`approve` with `TabSettlement` or Permit2 as spender) and Permit2 (`invalidateUnorderedNonces`), with a value of zero; typed data only as a Permit2 `PermitWitnessTransferFrom` to `TabSettlement`; and `personal_sign` only for a metering claim.
`createPrivyAgentWallet` creates that policy and an `ethereum` wallet, both owned by an owner key, and adds the Agent's own authorization key as a signer bound to the policy, so the credentials on the Agent's machine cannot loosen it.
`scripts/privy-agent.mjs` in the repository drives both, and the loop, against the live deployment.
It has run on Testnet against a real Privy app: the policy, signer and wallet were created, a transfer to an address the policy does not name came back as Privy's own `policy_violation`, and the loop settled directly and gasless through the relay until the tabs were at zero.

It needs a Privy app (an app id and secret).
Privy enforces the policy off chain, in its signing enclave, at the moment it signs; the contracts treat the wallet like any other account.

---

## x402: prepaid fallback and buy-now-pay-later

x402 is the prepaid protocol: a server answers `402` with a `PAYMENT-REQUIRED` header naming what it accepts, the client signs a payment and repeats the request with `PAYMENT-SIGNATURE`, and the server returns the resource once a facilitator has settled the payment on chain. Tab is the opposite model, and this package makes the two meet in two places.

**The offer on a credit refusal.** A Tab Service that refuses a call on `LimitExceeded` can put an x402 `exact` requirement for the same charge beside its `Tab-Charge-*` block. An Agent that would rather pay for that one call than settle its tab first takes the offer; one that would rather settle ignores it. When the offer is taken, the facilitator moves the Asset to the Service's Collection address, the work is delivered, and nothing lands on the Open Tab, because nothing is owed.

```ts
// A Service, on a Hono route
const requirement = exactRequirementFor({ chainId: 10143n, asset, amount, payTo: collectionAddress });
// On LimitExceeded: onLimitExceeded: (ctx) => jsonResponse(ctx.status, { ...ctx.headers, ...paymentRequiredHeaders(paymentRequiredFor({ resource, accepts: [requirement.value] })).value }, ctx.body)
// On a request carrying PAYMENT-SIGNATURE:
const outcome = await handlePrepaidRequest({ facilitator: createX402Facilitator(), payload, requirements: requirement.value, resource, deliver });
```

`handlePrepaidRequest` runs x402's default flow and no other: verify through the facilitator, deliver, settle through the facilitator, answer with `PAYMENT-RESPONSE`. A payment that does not verify is answered `402` with the reason and nothing is delivered; a delivery that failed is never settled, on the same rule the post-paid plugin meters no failed response. Monad's facilitator at `x402-facilitator.molandak.org` is the default and settles `exact` on Mainnet and Testnet.

On the Agent's side, `createTab402Client` and `tab_call` take the offer when, and only when, an x402 signer is configured. The signer comes from `tab.config`'s `x402` entry, a factory called at the moment a refusal carries an offer and never before, so every read stays keyless. In the library client the repeat still happens first: a `402` is answered by one repeat, and only a `402` that stands after it and carries `PAYMENT-REQUIRED` is paid. `tab_call`, which never repeats, takes the offer on the first refusal, and reports the payment:

```json
{
  "ok": true,
  "result": { "quote": "42" },
  "charge": { "amountBaseUnits": "10000", "asset": "10143:0x534b…43a3", "tool": "0x71…" },
  "tab": { "openTabBaseUnits": "40000", "headroomBaseUnits": "500", "asset": "10143:0x534b…43a3" },
  "x402": {
    "txHash": "0xef…",
    "network": "eip155:10143",
    "amountBaseUnits": "10000",
    "asset": "10143:0x534b…43a3",
    "payTo": "0x9d3d…d837",
    "payer": "0x19e7…ff2a",
    "explorerUrl": "https://testnet.monadvision.com/tx/0xef…"
  }
}
```

`charge` and `tab` are the refusal the call was answered with; `x402` is what paid for it instead.

**Buy now, pay later for x402 APIs.** The reverse direction is the one that changes what an Agent can do. A Tab Service can front any x402 upstream: the Agent calls the Service on credit, the Service pays the upstream with its operator's key, and the Service meters the Agent's Open Tab for the upstream's price plus a margin. The Agent never signs and never holds the upstream's currency.

```ts
const pricing = createX402UpstreamPricing({ tool, margin: { bps: 500n } });
const metering = tabPostPaid({ serviceId, asset, tabBook, priceOf: pricing.priceOf });
const proxy = createX402FrontedProxy({
  upstream: "https://api.nansen.ai/api/v1",
  stripPrefix: "/hub/nansen",
  signer: operatorWallet,
  asset,
  pricing,
  metering,
  preflight: async ({ agent, amount }) => simulateDelivery(agent, amount),
});
app.all("/hub/nansen/*", (c) => proxy(c.req.raw));
```

The price is known only after the upstream's `402`, so `pricing` is a book the forward writes and `priceOf` reads, keyed by the request. **The amount rides in the unit count, not the unit price.** `TabBook.recordDelivery` refuses any unit price the applied price list does not hold, and a fronted price varies per call, so the Service publishes a small fixed unit for the fronted tool, one base unit by default, and a call consumes as many units as it cost. Without that published price every fronted delivery reverts `UnknownTool`, the plugin delivers anyway because a broken price list is the Service's fault, and the Service pays the upstream for work it bills nobody. `unitBaseUnits` sets a coarser unit, rounded up so the Service is never left short. `preflight` runs between the upstream's `402` and the operator's signature, with the quoted amount in hand: a Service simulates the delivery against `TabBook` there and refuses an Agent with no headroom before its own funds move. Only `exact` with EIP-3009 is signed, on the Service's own chain and Asset; an upstream that accepts nothing the Service can pay in is answered with why, and nothing is metered.

`fetchHubManifest` reads Monad's API Hub, which fronts dozens of pay-per-request providers behind one x402 endpoint, and `tab_discover` lists a fronted provider's endpoints under the Service as the tools they are, with the Hub's per-call price in base units:

```js
services: [{ serviceId, endpoint, hub: { provider: "defillama", prefix: "apihub" } }]
```

The metering gateway in this repository mounts both: `GATEWAY_HUB_UPSTREAMS` names the upstreams, `X402_ENABLED` and `X402_FACILITATOR_URL` govern the offer on a `402`, and `GATEWAY_COLLECTION_ADDRESS` is the `payTo` fallback when `ServiceRegistry.collectionOf` cannot be read.

**What is official and what is not.** The types, the three header codecs and the facilitator HTTP client are `@x402/core`, the reference implementation. The EIP-3009 signing is this package's own, over ethers rather than the reference client's viem, and it is checked two ways: every test recovers the signer with `verifyTypedData`, and the reference client was run over the same authorization while this was written, producing the same signature byte for byte. The request handling is this package's own because the reference server middleware gates every request on payment, which is the model Tab exists to replace.

### Settle in any asset through Kuru

`TabSettlement.settle` moves the Asset the tab is denominated in. An Agent that holds MON, or a different stablecoin, can still settle: `createKuruFundedStrategy` wraps the Monad strategy, reads the Agent's balance of the Asset before every Settlement, and when it is short, swaps the shortfall in from a configured source token through Kuru, Monad's on-chain order book, then settles. The Settlement is still the inner strategy's transaction.

```ts
import { createKuruFundedStrategy, createKuruOnchainRouter, KURU_DEPLOYMENTS, KURU_NATIVE_TOKEN, kuruRouteKey } from "@tabai/sdk";

const inner = createMonadStrategy({ signer, tabSettlement, assets });
const strategy = createKuruFundedStrategy({
  inner,
  signer,
  kuru: {
    source: { address: KURU_NATIVE_TOKEN, decimals: 18, symbol: "MON" },
    maxSourceAmount: 5n * 10n ** 18n,
    router: createKuruOnchainRouter({
      signer,
      router: KURU_DEPLOYMENTS.mainnet.router,
      routes: {
        [kuruRouteKey(KURU_NATIVE_TOKEN, usdc.address)]: {
          markets: [KURU_DEPLOYMENTS.mainnet.markets["MON-USDC"]],
          isBuy: [false],
          nativeSend: [true],
        },
      },
      slippageBps: 100,
    }),
  },
});
```

The swap runs through a `KuruRouter`, a two-method seam: `quote` says how much of the source token buys the shortfall, `swap` executes it. `createKuruOnchainRouter` is the shipped implementation over Kuru's `Router.anyToAnySwap`, quoting by simulation at the amount that will be sent and passing the shortfall as the swap's minimum out, so a Settlement is either fully funded or the swap reverts. A test hands in a fake router. The Router is deployed on Testnet and Mainnet; Kuru's aggregator is Mainnet only and is not used here, and neither is Kuru's own SDK, which pins ethers 5 and takes amounts as floating point.

### Fund from another chain through NEAR Intents

An Agent whose USDC sits on Base, Arbitrum, Ethereum or another chain can still settle a Mainnet tab.
`createIntentsFundedStrategy` wraps the Monad strategy and reads the Agent's Monad balance of the Asset before every Settlement.
When it is short, it asks the 1Click API for an `EXACT_OUTPUT` quote of the shortfall delivered to the Agent's own Monad address, transfers the quoted USDC to the deposit address on the funding chain, waits for the delivery, checks the Monad balance again, and only then settles.
The funding step fills the Agent's own balance and never touches a tab.
Settlement is unchanged and stays same-chain and atomic by design: one Monad transaction moves the Asset to the Service and applies it to the tab together.

```ts
import { createIntentsFundedStrategy, createMonadStrategy, ONE_CLICK_USDC_FUNDING } from "@tabai/sdk";

const inner = createMonadStrategy({ signer, tabSettlement, assets });
const strategy = createIntentsFundedStrategy({
  inner,
  signer, // the Agent on Monad, for the balance read
  intents: {
    funding: ONE_CLICK_USDC_FUNDING.base,
    fundingSigner: signer.connect(baseProvider), // the same key on the funding chain
    maxFundingAmount: 5_000_000n, // at most 5 USDC in per funding step
    apiKey: process.env.NEAR_INTENTS_API_KEY, // optional
  },
});
```

The strategy id is `intents-funded`, so `tab settle --strategy intents-funded` names it, and the repository's `tab.config.mjs` builds it from `INTENTS_FUNDING_CHAIN` and `INTENTS_FUNDING_RPC_URL`.
It supports Mainnet USDC only, the one Tab Asset NEAR Intents delivers on Monad, and declines Testnet mUSDC so another strategy resolves for it.
A dry run asks for a `dry: true` quote, which creates no deposit address, and reports the input it would take; nothing moves until `--broadcast`.
A refused quote, an input above `maxFundingAmount`, a funding signer on the wrong chain or short of USDC, a refund, a failure or a timeout each come back as a `Result` naming the deposit address and the last status, and no Settlement is sent.
A failed or expired deposit is refunded to the Agent's own address on the funding chain; the slippage tolerance on a delivered one is spent, not refunded.
The strategy has run live on Mainnet: owing 0.20 USDC with 0.08868 on Monad, the Agent deposited 0.113481 USDC on Arbitrum, NEAR Intents delivered the 0.11132 shortfall to its Monad address in block 109379795, and the Settlement of 0.20 landed in block 109379821.
The transactions are on the [On Monad](https://trytabai-docs.vercel.app/on-monad) page.
The API talks through `OneClickClient`, a three-method seam with an injectable `fetch`, so a test drives the whole flow without a network.
A partner key is optional: without one the API answers and charges an extra fee on each quote.
Beside that live run, the strategy is tested with mocks, and live dry quotes from Base and Arbitrum USDC to Monad USDC are confirmed.

### Configuration keys

| Key | Where | What it does |
| --- | --- | --- |
| `x402` | `tab.config` | A factory returning an x402 signer, or `undefined` to decline. Called only when a refusal carries an offer |
| `services[].hub` | `tab.config` | `{ provider, prefix?, manifestUrl? }`: the API Hub provider a Service fronts, listed by `tab_discover` |
| `x402` | `createTab402Client` | `{ signer, chainId?, asset?, maxAmount?, onPayment? }`: the same fallback, for the library client |
| `upstreamPayment` | `createX402FrontedProxy` | `{ chainId, asset, signer? }`: where the upstream is paid when that is not the Service's own chain and Asset. The API Hub takes Mainnet USDC only, so a Testnet Service pays there and meters here, base unit for base unit |
| `X402_ENABLED`, `X402_FACILITATOR_URL`, `GATEWAY_COLLECTION_ADDRESS`, `GATEWAY_HUB_UPSTREAMS`, `GATEWAY_X402_PRIVATE_KEY` | gateway environment | The offer on a `402`, the facilitator, the `payTo` fallback, the fronted upstreams (each with an optional `payOn: { chainId, asset }`), and an optional dedicated paying key |

---

## Network

Tab is deployed on both Monad networks, and `MONAD_CHAIN_ID` picks which one this package talks to.

| | Monad Mainnet | Monad Testnet |
| --- | --- | --- |
| Chain id | `143` | `10143` |
| RPC | `https://rpc.monad.xyz` | `https://testnet-rpc.monad.xyz` |
| Explorer | `https://monadvision.com` | `https://testnet.monadvision.com` |
| Assets | USDC, AUSD | Circle's USDC, and `mUSDC`, a test token |

| Contract | Mainnet | Testnet |
| --- | --- | --- |
| `ServiceRegistry` | `0x4F791F13F94944fCB2F884f8C7991cAa583884A6` | `0x3638DB35A76E5a22EA1E827636dA994be622c139` |
| `Bond` | `0xbA86C0D053ba88afDECbED8aBa5b2eC3973fb230` | `0x29aDfD90Fc7c9026563Fc60651f696ab089080E7` |
| `TabBook` | `0x0Dabf8E52280D0F128f546602a99b6DC4fbb80DC` | `0x87571030cCe27C84836bAfF85288eB1d85d908a4` |
| `TabSettlement` | `0x32A96bfEABe766B4898b961B333B7B89f079a9a9` | `0x654Fac48185e4B71779eEc2457B1F24aEdf46717` |
| `MeteringDelegates` | `0x32f04C3e19d6a39f1B8A513ad86Bd8d5c6486F98` | `0xD287900EE0D4415CE4d362Fe8b6a4D4d6413A1a9` |
| `CurationMultisig` (2-of-3) | `0x123c19F46C38d5b4E922D1297250a71A03DFFD17` | |
| `mUSDC` | | `0x480209747417f5c830fDA188a9b9AcFa70Bc4083` |

Mainnet USDC is `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` and AUSD is `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`.
Testnet USDC is `0x534b2f3A21130d7a60830c2Df862319e593943A3`, from Circle's faucet; MON for gas comes from `https://faucet.monad.xyz`.

A Settlement is final when its block is. **Nothing in an agent's request path waits for anything**: a metered call returns in the block its charge is recorded in, and headroom is restored in the block the Settlement lands.

---

## Status

Live on Monad Mainnet and Monad Testnet.

| | Mainnet (`143`) | Testnet (`10143`) |
| --- | --- | --- |
| Registry read API | `https://registry-mainnet-production.up.railway.app` | `https://registry-testnet-production.up.railway.app` |
| Demo Service `tab.demo` | `https://gateway-mainnet-production.up.railway.app` | `https://gateway-testnet-production-a657.up.railway.app` |

**With nothing configured, this package uses them.** `tab_discover` and `tab_status` read the hosted registry for the chosen network, so a fresh `npx -y @tabai/sdk connect` works before you set anything.
The hosted gateways meter only a signed call, so `tab_call` to the demo Service needs `AGENT_ADDRESS` and `AGENT_PRIVATE_KEY` in the environment, and then signs each call with the Agent's own key.
With no `tab.config`, the same key also settles: `tab_settle` pays through the direct Monad strategy against the deployment's `TabSettlement`, in that network's Assets, so a fresh install can call and pay with nothing but those two variables.
Once a Settlement lands, `tab_settle` waits up to 20 seconds for the registry to index it and says whether it did as `indexed`, so a `tab_status` straight after reads the tab as paid rather than as it was a block earlier.
Anything you configure wins, and `TAB_HOSTED_DEFAULTS=off` switches the defaults off entirely.
They are exported as `TAB_HOSTED`.

The Dashboard, which shows either network, is at `https://trytabai.vercel.app`, and the documentation at `https://trytabai-docs.vercel.app`.

---

## Built by

Emad Qureshi. Source-available: free to read, run and evaluate, and any other use needs permission. Versions up to 0.2.0 were published under MIT and stay under it. See LICENSE.
