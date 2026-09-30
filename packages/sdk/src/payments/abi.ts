/**
 * The two ABIs the Monad strategies need, in the human-readable form `ethers`
 * parses. Kept minimal on purpose: only the functions this package calls and
 * the one event it decodes.
 */

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

/** `TabSettlement`, the one way an Open Tab is paid on Monad. */
export const TAB_SETTLEMENT_ABI = [
  "function settle(bytes32 serviceId, address asset, uint128 amount) returns (bytes32 settlementId, uint128 applied, uint128 toPrepaid)",
  "function settleBatch((bytes32 serviceId, address asset, uint128 amount)[] instructions) returns (bytes32[] settlementIds)",
  "event Settled(bytes32 indexed settlementId, address indexed agent, bytes32 indexed serviceId, address asset, uint128 amount, uint128 applied, uint128 toPrepaid, address collection)",
] as const;
