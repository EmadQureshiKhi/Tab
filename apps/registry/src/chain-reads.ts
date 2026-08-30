/**
 * The keyless chain reads the credit cross-check needs, over `ethers` v6.
 *
 * ## What this module is for, and what it is not
 *
 * Every figure the read layer derives is checked against the chain before it is
 * served: a Credit Limit against `TabBook.creditLimit`, headroom against
 * `TabBook.headroom`, a Bond ledger against `Bond.ledgerOf`. Those are `view`
 * functions, so each check is an `eth_call` that costs nothing, needs no key, and
 * can be pinned to the block the index was computed against. A figure the chain
 * disagrees with is not served; see `credit-service.ts` for what is served instead.
 *
 * This is not a second source of truth for the rows. The index stays a record of
 * what the chain said, and the chain is asked only to confirm a derivation, at the
 * horizon block, so the two cannot be compared across different states of the
 * world.
 *
 * ## Why an interface
 *
 * The route tests seed fixtures whose Agents and Services do not exist on chain, so
 * a live read would disagree with every fixture figure by construction. The
 * service is therefore written against {@link CreditChainReader}, and the tests
 * supply a reader that answers what a chain holding the fixture would answer, in
 * both the agreeing and the disagreeing shapes. The live implementation is
 * exercised on its own against an address with no history, where the true answer
 * is known without a fixture.
 *
 * Block objects on this RPC arrive without `mixHash`; `ethers` v6 tolerates the
 * omission, which is why the block timestamp read is safe here.
 *
 * Requirements: 24.1, 24.3, 24.7, 12.6, 28.3
 */

import { Interface, type JsonRpcProvider } from "ethers";

import type { LimitWitness } from "./credit.js";

/** The four stored figures of one Bond ledger, as `Bond.ledgerOf` returns them. */
export interface LedgerFigures {
  readonly staked: bigint;
  readonly reserved: bigint;
  readonly slashed: bigint;
  readonly released: bigint;
}

/** The two governance parameters `LimitLib` takes, read off `TabBook`'s immutables. */
export interface LimitGovernance {
  readonly baseline: bigint;
  readonly growthFactorBps: bigint;
}

/**
 * Every chain read the credit path performs. Each takes the block to read at, so a
 * derivation computed at the index horizon is compared with the chain at that same
 * block and never with a later one.
 */
export interface CreditChainReader {
  /** Creditcoin timestamp of a block, which is `LimitLib.Params.evaluatedAt` at that block. */
  blockTimestamp(blockNumber: number): Promise<bigint>;
  governance(blockNumber: number): Promise<LimitGovernance>;
  historyCommitment(agent: string, asset: string, blockNumber: number): Promise<{ root: string; count: number }>;
  creditLimit(agent: string, asset: string, witness: LimitWitness, blockNumber: number): Promise<bigint>;
  headroom(agent: string, asset: string, witness: LimitWitness, blockNumber: number): Promise<bigint>;
  assetOpen(agent: string, asset: string, blockNumber: number): Promise<bigint>;
  delinquentTabCount(agent: string, asset: string, blockNumber: number): Promise<number>;
  bondLedger(party: string, asset: string, blockNumber: number): Promise<LedgerFigures>;
}

/**
 * The fragments this module calls, in the contracts' own shapes. The witness is
 * the `TabBook.LimitWitness` struct: an array of `LimitLib.SettlementRecord` and an
 * array of `LimitLib.BondEntry`, both in declaration order.
 */
export const TAB_BOOK_READ_ABI = [
  "function BASELINE() view returns (uint256)",
  "function GROWTH_FACTOR_BPS() view returns (uint256)",
  "function historyCommitment(address agent, address asset) view returns (bytes32 root, uint32 count)",
  "function creditLimit(address agent, address asset, (tuple(bytes32 serviceId, address asset, uint128 amount, uint64 settledAt, uint64 firstDeliveryAt, uint64 chainKey, bool curated, bool bonded)[] history, tuple(bytes32 serviceId, address asset, uint128 amount)[] bonds) witness) view returns (uint256 limit)",
  "function headroom(address agent, address asset, (tuple(bytes32 serviceId, address asset, uint128 amount, uint64 settledAt, uint64 firstDeliveryAt, uint64 chainKey, bool curated, bool bonded)[] history, tuple(bytes32 serviceId, address asset, uint128 amount)[] bonds) witness) view returns (uint256 available)",
  "function assetOpen(address agent, address asset) view returns (uint256 open)",
  "function delinquentTabCount(address agent, address asset) view returns (uint32 count)",
] as const;

export const BOND_READ_ABI = [
  "function ledgerOf(bytes32 party, address asset) view returns (tuple(uint128 staked, uint128 reserved, uint128 slashed, uint128 released) ledger)",
] as const;

/** The witness as the ABI encoder takes it: positional tuples in declaration order. */
const encodeWitness = (witness: LimitWitness): [unknown[], unknown[]] => [
  witness.history.map((record) => [
    record.serviceId,
    record.asset,
    record.amount,
    record.settledAt,
    record.firstDeliveryAt,
    record.chainKey,
    record.curated,
    record.bonded,
  ]),
  witness.bonds.map((bond) => [bond.serviceId, bond.asset, bond.amount]),
];

/** The live implementation. One `eth_call` per read, each pinned to a block. */
export class EthersCreditChainReader implements CreditChainReader {
  private readonly tabBook = new Interface(TAB_BOOK_READ_ABI);
  private readonly bond = new Interface(BOND_READ_ABI);

  // Declared and assigned rather than taken as parameter properties: this package
  // builds with `erasableSyntaxOnly`, which rejects any constructor syntax that
  // emits runtime code. `PostgresReads` is written the same way.
  private readonly provider: JsonRpcProvider;
  private readonly tabBookAddress: string;
  private readonly bondAddress: string;

  constructor(provider: JsonRpcProvider, tabBookAddress: string, bondAddress: string) {
    this.provider = provider;
    this.tabBookAddress = tabBookAddress;
    this.bondAddress = bondAddress;
  }

  private async call(
    iface: Interface,
    to: string,
    name: string,
    args: readonly unknown[],
    blockNumber: number,
  ): Promise<ReadonlyArray<unknown>> {
    const data = iface.encodeFunctionData(name, [...args]);
    const returned = await this.provider.call({ to, data, blockTag: blockNumber });
    return iface.decodeFunctionResult(name, returned).toArray();
  }

  async blockTimestamp(blockNumber: number): Promise<bigint> {
    const block = await this.provider.getBlock(blockNumber);
    if (block === null) throw new Error(`chain-reads: block ${blockNumber} is not available`);
    return BigInt(block.timestamp);
  }

  async governance(blockNumber: number): Promise<LimitGovernance> {
    const [baseline] = await this.call(this.tabBook, this.tabBookAddress, "BASELINE", [], blockNumber);
    const [growth] = await this.call(this.tabBook, this.tabBookAddress, "GROWTH_FACTOR_BPS", [], blockNumber);
    return { baseline: BigInt(baseline as bigint), growthFactorBps: BigInt(growth as bigint) };
  }

  async historyCommitment(agent: string, asset: string, blockNumber: number): Promise<{ root: string; count: number }> {
    const [root, count] = await this.call(
      this.tabBook,
      this.tabBookAddress,
      "historyCommitment",
      [agent, asset],
      blockNumber,
    );
    return { root: String(root).toLowerCase(), count: Number(count) };
  }

  async creditLimit(agent: string, asset: string, witness: LimitWitness, blockNumber: number): Promise<bigint> {
    const [limit] = await this.call(
      this.tabBook,
      this.tabBookAddress,
      "creditLimit",
      [agent, asset, encodeWitness(witness)],
      blockNumber,
    );
    return BigInt(limit as bigint);
  }

  async headroom(agent: string, asset: string, witness: LimitWitness, blockNumber: number): Promise<bigint> {
    const [available] = await this.call(
      this.tabBook,
      this.tabBookAddress,
      "headroom",
      [agent, asset, encodeWitness(witness)],
      blockNumber,
    );
    return BigInt(available as bigint);
  }

  async assetOpen(agent: string, asset: string, blockNumber: number): Promise<bigint> {
    const [open] = await this.call(this.tabBook, this.tabBookAddress, "assetOpen", [agent, asset], blockNumber);
    return BigInt(open as bigint);
  }

  async delinquentTabCount(agent: string, asset: string, blockNumber: number): Promise<number> {
    const [count] = await this.call(
      this.tabBook,
      this.tabBookAddress,
      "delinquentTabCount",
      [agent, asset],
      blockNumber,
    );
    return Number(count);
  }

  async bondLedger(party: string, asset: string, blockNumber: number): Promise<LedgerFigures> {
    const [ledger] = await this.call(this.bond, this.bondAddress, "ledgerOf", [party, asset], blockNumber);
    const figures = (ledger as { toArray?: () => unknown[] }).toArray?.() ?? (ledger as unknown[]);
    const [staked, reserved, slashed, released] = figures as [bigint, bigint, bigint, bigint];
    return { staked: BigInt(staked), reserved: BigInt(reserved), slashed: BigInt(slashed), released: BigInt(released) };
  }
}
