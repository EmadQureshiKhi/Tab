/**
 * The call-side fragments the Ethereum USDC strategy encodes against.
 *
 * Only the functions this package calls, written in `ethers`' human-readable
 * form. Deliberately not a full ABI: `@tabai/shared` explains that the ABI arrays
 * arrive by generation from the compiler's own artefacts, and a hand-written copy
 * of a whole contract's ABI would be the second source of truth that package
 * exists to prevent.
 *
 * **Nothing about the events is duplicated here.** The `TabSettled` and
 * `Transfer` signatures, their topic hashes, and the index at which each carries
 * the payer all come from `@tabai/shared`, because the Watcher, the Creditcoin-side
 * verifier, and this package have to agree on them exactly. The struct layout
 * below matches `TabSettlement.SettlementInstruction`, whose field order is fixed
 * by the deployed contract at
 * `0x10619F16E1ac73AAe41AA4C1619f1387687EED79` on Ethereum Sepolia.
 *
 * Requirements: 23.1, 23.7
 */

/**
 * The ERC-20 surface a Settlement uses.
 *
 * `transfer` is the Settlement itself on the `direct-transfer` surface, where Tab
 * deploys no contract at all. `allowance` and `approve` exist only for the
 * `settlement-contract` surface, which pulls with `safeTransferFrom` and so needs
 * an allowance first.
 */
export const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
] as const;

/**
 * `TabSettlement`, the only contract Tab deploys to a Source Chain.
 *
 * The tuple is `SettlementInstruction { address asset; address serviceCollection;
 * uint256 amount; bytes32 tabId; }`. `settleBatch` emits one `TabSettled` per
 * instruction (R1.4), and each of those logs is independently claimable because
 * the replay key is log-scoped.
 *
 * Neither function takes a payer. The contract derives it from `msg.sender` so
 * that `topics[1]` is unforgeable, which is the reason the Creditcoin side reads
 * the payer from the topic and never from the transaction sender.
 */
export const TAB_SETTLEMENT_ABI = [
  "function settle((address asset, address serviceCollection, uint256 amount, bytes32 tabId) instruction)",
  "function settleBatch((address asset, address serviceCollection, uint256 amount, bytes32 tabId)[] instructions)",
] as const;
