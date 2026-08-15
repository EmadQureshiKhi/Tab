# Tab

Post-paid billing and a credit facility for autonomous agents.

A Service meters usage into an Open Tab held on Creditcoin. The Agent settles
that Tab in USDC on Ethereum with its own keys. A Creditcoin contract then
verifies that Ethereum transaction itself, through the Attestcoin Protocol's
BlockProver Precompile, so no facilitator, oracle or bridge is asked whether the
money arrived.

## Target network

| | |
| --- | --- |
| Network | Creditcoin CC3 Testnet |
| Chain id | `102031` |
| RPC endpoint | `https://rpc.cc3-testnet.creditcoin.network` |
| BlockProver Precompile | `0x0000000000000000000000000000000000000FD2` |

Source chains for settlement are Ethereum Sepolia (`chainKey 1`) and Ethereum
Mainnet (`chainKey 3`).

## Prerequisites

- Node `>= 20.10.0`
- pnpm `9.15.3`, pinned through the root `packageManager` field
- Foundry (`forge`, `cast`, `anvil`) for the Solidity work

## Status

Early. The specification is written and the de-risking spike against the live
network comes first: nothing is built on a precompile whose interface has not
been confirmed against the chain that serves it.

## License

MIT. See [LICENSE](./LICENSE).
