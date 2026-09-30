# @tabai/agent-wallet-plugin

**Tab commands for the MetaMask Agent Wallet CLI.**
An agent with an `mm` wallet can discover priced Services on Monad, call one on credit, read its Open Tab, and settle or authorise with the key the wallet holds, under the wallet's own policy.

A plugin is an npm package that adds native `mm` commands.
This one adds six under the `tab` topic.
The wallet's selected EVM address is the Agent, and the wallet's key never leaves the host.
When a command needs a transaction sent, it hands the fully built transaction to the wallet's executor, which is where MetaMask policy, spending caps and any MFA step apply.
The one key this plugin holds is optional: a metering delegate that `mm tab delegate` creates, which signs metered calls and nothing else.

## Install

Plugins are a beta feature of the CLI, so enable them once:

```bash
npm i -g @metamask/agent-wallet
mm config set experimentalPlugins true
mm plugins install @tabai/agent-wallet-plugin
```

The consent screen lists the six commands, what each reads, and which capabilities each asks for.
`tab discover` asks for none.
`tab status` and `tab call` ask for `wallet-read`, which is the address.
`tab settle`, `tab authorise` and `tab delegate` ask for `wallet-read` and `wallet-submit`, which is signing and submission through the wallet's policy.

To run it from this repository instead:

```bash
nvm use 22                                   # the CLI refuses Node below 22.18
pnpm --filter @tabai/agent-wallet-plugin build
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true

# One copy of the host, not two. See below.
ln -sf "$(dirname "$(readlink -f "$(command -v mm)")")/../lib/node_modules/@metamask/agent-wallet" \
  packages/agent-wallet-plugin/node_modules/@metamask/agent-wallet

mm plugins install "file:$PWD/packages/agent-wallet-plugin" --accept-permissions
```

**The symlink is the one thing worth knowing before trying from the repository.**
This package takes `@metamask/agent-wallet` as a peer dependency, which is right, and keeps a devDependency copy so it can type-check, which is also right.
But the host checks that every plugin command extends its own `PluginCommand`, and that check is by class identity: with the workspace's copy reachable from this directory the CLI ends up holding two, and every command is refused before it runs with `PLUGIN_INVALID_BASE`, which names neither the duplicate nor the fix.
Pointing this package's copy at the globally installed one leaves exactly one, and the check passes.
A `pnpm install` puts the copy back, so point it again after one.

A second copy loaded from a linked or working-tree plugin can also break the host outright: every `mm` command, for every plugin, then fails with `window.addEventListener is not a function` before it runs.
That error is not the host's own. It is a second copy of the CLI starting inside the first, and it goes when the copy is pointed at the host's, as above.

The published install is different, and simpler.
npm installs a peer dependency, so `mm plugins install @tabai/agent-wallet-plugin` does put a copy of `@metamask/agent-wallet` in the host's plugin directory, but the commands pass the identity check regardless and nothing needs linking.
That was verified against CLI 7.0.0 with the package installed from npm; the symlink is only for running the working tree.

`mm plugins link` does not work: it loads the built output in place and satisfies the identity check, but the host's grant lookup compares the recorded install against the registered plugin and finds no grant, so every wallet capability is denied.
A tarball from `pnpm pack` installs like the published package, because pnpm rewrites the `workspace:*` dependency to the SDK's version; `npm pack` does not, and its tarball cannot resolve `@tabai/sdk`.

Run `mm plugins uninstall @tabai/agent-wallet-plugin` between iterations.

### End to end on Monad Mainnet

The whole loop has run on Monad Mainnet from a MetaMask server wallet, `0xf5674626bcc16939dc678538c8099adfc6592a7b`, against the hosted `tab.demo`:

| Step | Command | Transaction |
| --- | --- | --- |
| Register a metering delegate | `mm tab delegate --broadcast` | `0x9fa194a03534f82f07d20cec91fa54f1cf09787ea489706dfdf002483a7ad0f3` |
| Authorise `tab.demo` | `mm tab authorise` | `0x18234fb932a313ceebff047c1bf6af97b2572393807157a0e810a024cfd80149` |
| One metered call on credit | `mm tab call` | none from the wallet: 0.01 USDC metered to its Open Tab, the claim signed by the delegate |
| Approve and settle | `mm tab settle --broadcast` | approval `0x78a13daf0822df1d4d2af61c58e39874fd23b6e7e425349fd90a5b74819ade64`, Settlement `0x7d39cb340abb5b7003aa310541a220cd9865f229bb20e05e10a503ff099b9abb` in block `109352198` |

Each wallet transaction was approved through MetaMask's email MFA before the wallet submitted it.
The call needed no approval at all, because the delegate signed its metering claim and the hosted gateway checked that delegate on chain.

Three practical notes from that run:

- Run `mm` under Node `>= 22.18`; the CLI refuses anything older.
- Run `mm tab` from a directory with no `tab.config.mjs` in it or above it.
  The plugin reads the nearest one, and inside this repository that is the development config, which points `tab.demo` at a gateway on `localhost`.
- No option ever prompts: a flag left off means its default, so leaving out `--broadcast` is always a dry run.

### What the host will and will not do on Monad Testnet

`discover`, `status` and the dry runs of `settle`, `authorise` and `delegate` work: they read the chain and the registry and build the calldata.

A **broadcast does not**, and the reason is the host's infrastructure rather than this plugin or the chain.
`mm chains list` carries Monad Mainnet (`eip155:143`) and not Monad Testnet, and on 10143 the wallet's own fee estimation fails after this plugin has handed over a correct transaction and its intent:

```
Intent: Authorise Service 0x7461622e…0000 to meter up to 5000000 mUSDC base units until 2026-10-22T14:53:06.000Z
Error: Gas fee/price estimation failed … data: { error: 'Invalid chainId' }
```

There is nothing to configure around it: the CLI has no add-network command and no RPC override, and the endpoints it uses are resolved from the chain id inside the binary.
Everything up to the signature is exercised on Testnet, and the dry runs print the exact transactions a broadcast would submit.

### Why the wallet cannot sign `tab call`, in one line of the host's own code

The host hands a plugin a restricted context: `walletExecutor` behind `wallet-submit`, and a set of read services behind `wallet-read`.
`walletExecutor` submits **transactions**.
Message signing lives on the agent SDK's wallet client, which the CLI reaches for its own `mm wallet sign-message` and which no plugin can reach, so there is no seam through which a plugin signs an arbitrary string.
That the wallet *can* sign on Monad Testnet is not the question, and it can: `mm wallet sign-message --message … --chain-id 10143 --wait` returns `SIGNED`.
A plugin simply is not given the door.
`mm tab delegate` is the way around it that needs no door: the wallet submits one transaction naming a local key, and that key signs each call.

## The six commands

| Command | What it does | Capability | Spends |
| --- | --- | --- | --- |
| `mm tab discover` | Lists the Services registered on Monad, the Assets each accepts, what each tool costs, and the Bond each has staked | none | nothing |
| `mm tab status` | Credit limit, Open Tab, prepaid credit and headroom for this wallet, per Asset, with recent Settlements | `wallet-read` | nothing |
| `mm tab call <service> <tool> [--args '<json>']` | Calls a metered tool. The result comes back now; the charge lands on this wallet's Open Tab | `wallet-read` | nothing at call time |
| `mm tab settle <service> <asset> <amount> [--broadcast]` | Pays down the Open Tab: the ERC-20 approval if the allowance falls short, then `TabSettlement.settle` | `wallet-read`, `wallet-submit` | real funds, only with `--broadcast` |
| `mm tab authorise <service> <asset> <ceiling> <expiryDays> [--broadcast]` | Caps what a Service may meter to this wallet's tab in one Asset until an expiry | `wallet-read`, `wallet-submit` | gas only, only with `--broadcast` |
| `mm tab delegate [--days <n>] [--revoke] [--broadcast]` | Registers a local key in `MeteringDelegates` that signs this wallet's metered calls, or revokes it | `wallet-read`, `wallet-submit` | gas only, only with `--broadcast` |

Every command takes the host's `--json`, `--format`, `--toon` and `--verbose`.
That is why the arguments flag on `tab call` is `--args`: `--json` is the host's output flag and is inherited by every command.

Start with `tab discover`, because every other command takes a Service's 32-byte identifier from its list.

`tab discover` needs no wallet and runs as soon as the plugin is installed.
The other four ask the host for `wallet-read` or `wallet-submit`, and the host answers those only for a signed-in account: without one they refuse with `AUTH_FAILED: run mm login to sign in`, which is the CLI's gate and not this plugin's.

```bash
mm tab discover --tier curated
mm tab status --json
mm tab delegate --broadcast
mm tab call 0x7461622e64656d6f000000000000000000000000000000000000000000000000 quote.generate --args '{"prompt":"hello"}'
mm tab settle 0x7461622e…0000 10143:0x4802…4083 47000
mm tab settle 0x7461622e…0000 10143:0x4802…4083 47000 --broadcast
mm tab authorise 0x7461622e…0000 0x4802…4083 5000000 30 --broadcast
```

## How `tab call` is signed: a metering delegate

A gateway on the open internet meters a call only when it is signed, by the Service operator, by the Agent, or by a delegate the Agent registered.
This CLI gives a plugin no message signing, so the wallet cannot give either of the first two here: `wallet-read` is the address and `wallet-submit` is a transaction.
The third needs only a transaction.

`mm tab delegate` makes a fresh key on this machine and plans `MeteringDelegates.setDelegate(delegate, expiry)` for its address, 30 days ahead by default and at most 365.
With `--broadcast` the wallet submits it, through the same executor and policy as `settle`.
From then on `mm tab call` checks `MeteringDelegates.isDelegate(agent, delegate)` and, when it holds, signs each call's metering claim with that key: the claim still names this wallet as the Agent, and the call carries `Tab-Delegate`, `Tab-Delegate-Signature` and `Tab-Delegate-Issued-At`.
The gateway recovers the signature, checks the same registration on chain, and meters the call to this wallet's Open Tab exactly as it would one the wallet signed.

**What a delegate can do is bounded, and that bound is the reason it is safe to keep on disk.**
It signs metering claims and nothing else.
It cannot move funds: no Settlement path reads `MeteringDelegates`, and `settle` still goes through the wallet.
Every charge it causes still passes `TabBook.recordDelivery`, which holds it to the ceiling and expiry this wallet set with `mm tab authorise` for that Service and Asset, and to the Credit Limit.
So a leaked delegate key costs at most metered calls at the listed price, within those ceilings, until the delegate's expiry or its revocation, whichever comes first.
`mm tab delegate --revoke --broadcast` revokes it in one transaction, effective from that block: the hosted gateways read `MeteringDelegates` on every delegate-signed call, so the next call after the revocation is refused.

The key lives in `~/.config/tab/delegates/<chainId>-<agent>.json`, written `0600` in a `0700` directory, one per wallet per network.
Only its address is ever printed; a key file other users can read is refused until it is restricted again.
The dry run writes the key when there is none, so the transaction it prints is the exact one a broadcast would submit.

`mm tab call` without a registered delegate behaves as it always has: the call goes unsigned, and a Service that requires a signature refuses it with `METERING_SIGNATURE_ABSENT`, now followed by what to do about it.
This repository's gateway run with `GATEWAY_REQUIRE_SIGNATURE=false` still accepts unsigned calls, which is the setting for a gateway on a machine nobody else can reach.

Two things this depends on, stated plainly, and both hold for the hosted `tab.demo` on either network.
The network must have `MeteringDelegates` deployed and known to the plugin, either in its recorded defaults or through `METERING_DELEGATES_ADDRESS`; it is deployed on Mainnet and Testnet and recorded in both defaults, and where it is not, `mm tab delegate` refuses with `METERING_DELEGATES_UNDEPLOYED` and `tab call` stays unsigned.
And the Service's gateway must read the same contract (`METERING_DELEGATES_ADDRESS` on its side); both hosted gateways do, and one that does not answers `METERING_DELEGATE_UNSUPPORTED`.

**Amounts are always base units.**
USDC has six decimals, so `47000` is 0.047 USDC.
An Asset is `chainId:0xaddress`, or a bare address on the configured chain.

## How `settle` submits through the wallet

`mm tab settle` builds the whole Settlement before it asks the wallet for anything.
It checks the Service accepts the Asset against the registry, reads the wallet's allowance for `TabSettlement`, and encodes two transactions at most: an exact `approve` when the allowance falls short, and `TabSettlement.settle(serviceId, asset, amount)`, which moves the Asset to the Service's Collection address and applies the Settlement to the tab in the same transaction.

Without `--broadcast` that plan is the whole result, calldata included, so an agent reading the output sees exactly what would be signed:

```json
{
  "chainId": 10143,
  "broadcast": false,
  "plan": {
    "agent": "0x1f6f…0542",
    "serviceId": "0x7461622e…0000",
    "asset": "10143:0x4802…4083",
    "amountBaseUnits": "47000",
    "allowanceBaseUnits": "0",
    "approval": { "to": "0x4802…4083", "data": "0x095ea7b3…", "summary": "Approve TabSettlement to move 47000 mUSDC base units for one Settlement" },
    "settlement": { "to": "0x654f…6717", "data": "0x…", "summary": "Settle 47000 mUSDC base units of the Open Tab with Service 0x7461622e…0000" }
  },
  "note": "Dry run. Nothing was submitted. Add --broadcast to hand these two transactions to the wallet; that spends real funds."
}
```

With `--broadcast`, the command asks the host for an executor with `ctx.walletExecutor(io, "tab:settle")`, the `wallet-submit` capability, and hands it each transaction in turn as a `{ kind: "transaction", chainId, transaction: { to, data }, intent }` request with `waitForReceipt` set, because `settle` cannot be sent before the approval lands.
The executor routes every request through MetaMask policy.
A denied, failed or expired job comes back as an error carrying the wallet's status, and the settlement is never handed over when the approval was refused.
The result then carries both transaction hashes with explorer links.

`mm tab authorise` goes through the same executor with one transaction, `TabBook.authorise(serviceId, asset, maxCumulative, expiry)`, and is a dry run by default for the same reason.

### Nothing throws below the command

Every fallible step returns a `Result` with a `category`, a `code` and a `message`.
The six command classes are the one place that turns a failed `Result` into the host's `CommandError`, so `mm` renders it with a hint and exits non-zero.
The hint worth knowing is `LIMIT_EXCEEDED` on `tab call`: it names the base units the call needed and the headroom the tab had, and the remedy is to settle, not to retry.
The other is `METERING_SIGNATURE_ABSENT` on `tab call`, whose remedy is `mm tab delegate --broadcast`.

## Configuration

Six variables, each already part of the Tab environment contract, with the deployment recorded for the named network as the fallback:

| Variable | Needed for | Default |
| --- | --- | --- |
| `MONAD_CHAIN_ID` | which network the Assets and contracts are on | `10143`, Monad Testnet; `143` is Mainnet |
| `TAB_BOOK_ADDRESS` | `tab authorise` | that network's `TabBook` from `deployments.json` |
| `TAB_SETTLEMENT_ADDRESS` | `tab settle` | that network's `TabSettlement` from `deployments.json` |
| `METERING_DELEGATES_ADDRESS` | `tab delegate`, and signing in `tab call` | that network's recorded `MeteringDelegates` |
| `MOCK_USDC_ADDRESS` | naming the Testnet test token `mUSDC` | the Testnet `MockUsdc` from `deployments.json`; unused on Mainnet |
| `NEXT_PUBLIC_REGISTRY_API_URL` | `tab discover`, `tab status`, and the Service check in `tab settle` | the project's hosted registry for that network; `TAB_HOSTED_DEFAULTS=off` turns that off |

Every command prints where each setting came from, so a default is never mistaken for a choice.

Two optional ones: `MONAD_RPC_URL` makes the plugin read the chain through that endpoint instead of the wallet's own RPC client, and `MONAD_EXPLORER_URL` changes the links.

`tab call` needs to know where a Service is.
The chain records no URL for a Service, deliberately.
The project's hosted demo Service, `tab.demo`, is known without any setup; any other endpoint comes from a `tab.config.mjs` in the working directory or any parent, exactly as it does for the `@tabai/sdk` MCP server:

```js
export default {
  services: [
    {
      serviceId: "0x7461622e64656d6f000000000000000000000000000000000000000000000000",
      name: "tab.demo",
      endpoint: "https://gateway-testnet-production-a657.up.railway.app",
    },
  ],
};
```

## Layout

```
src/commands/tab/*.ts   the six PluginCommand classes; the file path is the command
src/tab/*.ts            what each command does, as functions returning Result
src/host-context.ts     the narrow view of this.ctx the plugin relies on, and the bridge onto it
src/delegate-key.ts     the metering delegate's key file: made, checked and read, never printed
src/calldata.ts         the encoders, from the SDK's ABIs
src/settings.ts         the environment, one name per line
scripts/manifest.mjs    writes oclif.manifest.json from dist/commands, as `oclif manifest` does
```

`PluginCommand`, `CommandIO` and the input helpers are imported from `@metamask/agent-wallet/plugin`, as the authoring guide says.
The members of `this.ctx` are typed against a package the CLI bundles and does not publish, so `src/host-context.ts` carries the structural subset this plugin uses, written from the plugin reference, and the bridge casts the context onto it exactly once.
The tests drive the real command classes with a fake `CommandIO` and a fake context whose executor records every request.

```bash
pnpm --filter @tabai/agent-wallet-plugin test
```

## Network

| | Monad Testnet | Monad Mainnet |
| --- | --- | --- |
| Chain id | `10143`, the default | `143` |
| RPC | `https://testnet-rpc.monad.xyz` | `https://rpc.monad.xyz` |
| Explorer | `https://testnet.monadvision.com` | `https://monadvision.com` |
| `TabBook` | `0x87571030cCe27C84836bAfF85288eB1d85d908a4` | `0x0Dabf8E52280D0F128f546602a99b6DC4fbb80DC` |
| `TabSettlement` | `0x654Fac48185e4B71779eEc2457B1F24aEdf46717` | `0x32A96bfEABe766B4898b961B333B7B89f079a9a9` |
| `MeteringDelegates` | `0xD287900EE0D4415CE4d362Fe8b6a4D4d6413A1a9` | `0x32f04C3e19d6a39f1B8A513ad86Bd8d5c6486F98` |

The contract addresses this plugin defaults to are the ones recorded in the repository's `deployments.json`, and a test fails when the two disagree.
MetaMask's gas service knows Mainnet and not Testnet, so `--broadcast` goes through on Mainnet only, where the whole loop has run; reads and dry runs work on both.
That includes `mm tab delegate --broadcast`: on Testnet the registration is the dry run's printed transaction, which the same wallet has to submit by other means before `tab call` can sign.

Source-available: free to read, run and evaluate, and any other use needs permission. Versions up to 0.1.1 were published under MIT and stay under it. See LICENSE.
