/**
 * The little of the MetaMask Agent Wallet host this plugin touches, and the
 * bridge that turns it into three narrow ports.
 *
 * ## Why these types are written here
 *
 * `@metamask/agent-wallet` publishes `PluginCommand`, `CommandIO` and the input
 * helpers, and this package imports those from `@metamask/agent-wallet/plugin`
 * as the authoring guide says to. The members of `this.ctx` are typed against
 * `@metamask/agent-sdk`, which the CLI bundles at build time and does not
 * publish, so in a consumer's type check every one of them collapses to `any`.
 * The interfaces below are the structural subset this plugin relies on, written
 * from the plugin reference (the context table, "Raw EVM reads", "Signing and
 * submission") and the CLI's own declaration files, and the bridge casts the
 * untyped context onto them exactly once, in {@link createHost}. Everything
 * past that point is typed, and everything past that point is what the tests
 * exercise with a fake.
 *
 * ## Three ports, each behind a capability
 *
 * - {@link HostWallet}: the wallet's selected EVM address, from `wallet-read`.
 * - {@link HostChainReader}: `eth_call` against one chain, from `wallet-read`
 *   through `ctx.publicClient(chainId)`, or from `MONAD_RPC_URL` when the
 *   environment names an endpoint, which needs no capability at all.
 * - {@link HostSubmitter}: a transaction submitted through `wallet-submit`, which
 *   is `ctx.walletExecutor(io, commandId)`. The executor routes every request
 *   through MetaMask policy, so a spending cap or an MFA step set on the wallet
 *   applies to a Tab Settlement exactly as it applies to a transfer.
 */

import type { Address, Hex, Result } from "@tabai/sdk";
import { causeOf, err, ok, wrap } from "@tabai/sdk";
import { JsonRpcProvider } from "ethers";

import type { CommandIO } from "@metamask/agent-wallet/plugin";

// ---------------------------------------------------------------- host shapes

/** One wallet as the host's state snapshot lists it. */
export interface HostWalletRecord {
  readonly address?: string | undefined;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  /** `"evm"` or `"solana"`. Absent on older records, which are EVM. */
  readonly namespace?: string | undefined;
}

/** How the host names the wallet the user selected. */
export type HostWalletRef =
  | { readonly id: string }
  | { readonly address: string }
  | { readonly name: string };

/** `ctx.walletStateManager.read()`, reduced to the fields that name an address. */
export interface HostWalletState {
  readonly byokWallets?: readonly HostWalletRecord[] | undefined;
  readonly remoteWallets?: readonly HostWalletRecord[] | undefined;
  readonly selectedWallet?: { readonly namespace?: string | undefined; readonly ref?: HostWalletRef | undefined } | undefined;
}

/** The one viem `PublicClient` method the plugin calls. */
export interface HostPublicClient {
  call(args: { readonly to: `0x${string}`; readonly data: `0x${string}` }): Promise<{ readonly data?: `0x${string}` | undefined }>;
}

/** A transaction request as `EvmWalletExecutor` takes it. */
export interface HostTransactionRequest {
  readonly kind: "transaction";
  readonly chainId: number;
  readonly transaction: { readonly to: string; readonly data: `0x${string}`; readonly value?: bigint };
  readonly intent?: {
    readonly summary: string;
    readonly action: string;
    readonly details?: Record<string, string | undefined>;
  };
}

/** What the executor answers for a transaction. */
export interface HostTransactionResult {
  readonly kind: string;
  readonly hash?: string | undefined;
  readonly status?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly failureDescription?: string | undefined;
}

export type HostWalletExecutor = (
  request: HostTransactionRequest,
  opts?: { readonly waitForReceipt?: boolean; readonly noAwait?: boolean },
) => Promise<HostTransactionResult>;

/** `this.ctx`, as far as this plugin reaches into it. */
export interface HostContext {
  readonly logger?: { debug?(message: string): void; warn?(message: string): void } | undefined;
  readonly walletStateManager?: { read(): HostWalletState } | undefined;
  readonly publicClient?: ((chainId: number) => HostPublicClient) | undefined;
  readonly walletExecutor?:
    | ((io: CommandIO, source: string, opts?: { emitStepNotices?: boolean }) => Promise<HostWalletExecutor>)
    | undefined;
}

// ---------------------------------------------------------------- ports

export interface HostWallet {
  /** The selected EVM address, lower-cased. */
  address(): Result<Address>;
}

export interface HostChainReader {
  /** `eth_call` at the latest block, returning the raw return data. */
  call(to: Address, data: Hex): Promise<Result<Hex>>;
}

/** One transaction the plugin has fully built and is ready to hand to the wallet. */
export interface PlannedTransaction {
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  /** The one-line intent the wallet shows and records. */
  readonly summary: string;
  readonly details: Readonly<Record<string, string>>;
}

export interface SubmittedTransaction {
  readonly txHash: Hex;
  /** The host's last-known job status, for example `CONFIRMED` or `BROADCASTED`. */
  readonly status: string;
}

export interface HostSubmitter {
  submit(transaction: PlannedTransaction): Promise<Result<SubmittedTransaction>>;
}

export interface Host {
  wallet(): HostWallet;
  chain(chainId: number): HostChainReader;
  /** Resolved lazily, so a dry run never asks for `wallet-submit`. */
  submitter(): Promise<Result<HostSubmitter>>;
}

// ---------------------------------------------------------------- wallet

const isEvmAddress = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

const isEvmRecord = (record: HostWalletRecord): boolean =>
  (record.namespace === undefined || record.namespace === "evm") && isEvmAddress(record.address);

const matchesRef = (record: HostWalletRecord, ref: HostWalletRef): boolean => {
  if ("id" in ref) return record.id === ref.id;
  if ("address" in ref) return typeof record.address === "string" && record.address.toLowerCase() === ref.address.toLowerCase();
  return record.name === ref.name;
};

/**
 * The address the wallet would sign with.
 *
 * The selected wallet when the host has one and it is an EVM wallet; otherwise
 * the first EVM wallet on the roster. An empty roster is `NOT_FOUND`, because
 * the remedy is `mm init`, not a retry.
 */
export function selectedEvmAddress(state: HostWalletState): Result<Address> {
  const roster = [...(state.byokWallets ?? []), ...(state.remoteWallets ?? [])].filter(isEvmRecord);
  const ref = state.selectedWallet?.ref;
  const namespace = state.selectedWallet?.namespace;
  if (ref !== undefined && (namespace === undefined || namespace === "evm")) {
    const chosen = roster.find((record) => matchesRef(record, ref));
    if (chosen?.address !== undefined) return ok(chosen.address.toLowerCase() as Address);
  }
  const first = roster[0];
  if (first?.address !== undefined) return ok(first.address.toLowerCase() as Address);
  return err({
    category: "NOT_FOUND",
    code: "WALLET_MISSING",
    message: "this Agent Wallet has no EVM address to act as the Agent; run `mm init` or select a wallet with `mm wallet select`",
    retryable: false,
  });
}

// ---------------------------------------------------------------- bridge

export interface CreateHostOptions {
  readonly ctx: HostContext;
  readonly io: CommandIO;
  /** The manifest id of the running command, which the executor records as the source. */
  readonly commandId: string;
  /** Names a JSON-RPC endpoint to read through instead of the host's client. */
  readonly rpcUrl?: string | undefined;
}

const FAILED_STATUSES = new Set([
  "DENIED",
  "EXPIRED",
  "FAILED",
  "BROADCAST_FAILED",
  "BROADCAST_TRACKING_EXPIRED",
  "CONFIRMATION_TRACKING_EXPIRED",
]);

const capabilityMissing = (member: string, capability: string): Result<never> =>
  err({
    category: "AUTHORISATION",
    code: "CAPABILITY_MISSING",
    message: `the host did not expose ${member}; this command needs the \`${capability}\` capability, which is granted at install time`,
    retryable: false,
    details: { member, capability },
  });

/** Wraps the host context. Construction is total; each port reports its own missing capability. */
export function createHost(options: CreateHostOptions): Host {
  const { ctx, io, commandId } = options;

  const wallet: HostWallet = {
    address() {
      const manager = ctx.walletStateManager;
      if (manager === undefined) return capabilityMissing("walletStateManager", "wallet-read");
      let state: HostWalletState;
      try {
        state = manager.read();
      } catch (error) {
        return err({
          category: "UPSTREAM",
          code: "WALLET_STATE_UNREADABLE",
          message: "the wallet state could not be read",
          retryable: true,
          cause: causeOf(error),
        });
      }
      return selectedEvmAddress(state);
    },
  };

  const chain = (chainId: number): HostChainReader => {
    if (options.rpcUrl !== undefined) {
      const provider = new JsonRpcProvider(options.rpcUrl, chainId, { staticNetwork: true, batchMaxCount: 1 });
      return {
        call: (to, data) =>
          wrap(
            async () => (await provider.call({ to, data })) as Hex,
            (error) => ({
              category: "UPSTREAM",
              code: "RPC_CALL_FAILED",
              message: `eth_call to ${to} failed against ${options.rpcUrl ?? ""}`,
              retryable: true,
              cause: causeOf(error),
            }),
          ),
      };
    }
    return {
      async call(to, data) {
        if (ctx.publicClient === undefined) return capabilityMissing("publicClient", "wallet-read");
        return wrap(
          async () => {
            const answer = await ctx.publicClient!(chainId).call({ to, data });
            return (answer.data ?? "0x") as Hex;
          },
          (error) => ({
            category: "UPSTREAM",
            code: "RPC_CALL_FAILED",
            message: `eth_call to ${to} failed through the wallet's RPC client for chain ${chainId}`,
            retryable: true,
            cause: causeOf(error),
          }),
        );
      },
    };
  };

  const submitter = async (): Promise<Result<HostSubmitter>> => {
    if (ctx.walletExecutor === undefined) return capabilityMissing("walletExecutor", "wallet-submit");
    const executor = await wrap(
      async () => ctx.walletExecutor!(io, commandId),
      (error) => ({
        category: "AUTHORISATION",
        code: "EXECUTOR_UNAVAILABLE",
        message: "the wallet refused to hand this command an executor",
        retryable: false,
        cause: causeOf(error),
      }),
    );
    if (!executor.ok) return executor;
    return ok({
      async submit(transaction) {
        const request: HostTransactionRequest = {
          kind: "transaction",
          chainId: transaction.chainId,
          transaction: { to: transaction.to, data: transaction.data },
          intent: { summary: transaction.summary, action: "call", details: { ...transaction.details } },
        };
        const sent = await wrap(
          async () => executor.value(request, { waitForReceipt: true }),
          (error) => ({
            category: "CHAIN",
            code: "SUBMISSION_FAILED",
            message: `the wallet did not submit: ${transaction.summary}`,
            retryable: false,
            cause: causeOf(error),
          }),
        );
        if (!sent.ok) return sent;
        const result = sent.value;
        const status = result.status ?? "UNKNOWN";
        if (result.failureCode !== undefined || FAILED_STATUSES.has(status) || typeof result.hash !== "string" || !result.hash.startsWith("0x")) {
          return err({
            category: "CHAIN",
            code: result.failureCode ?? "SUBMISSION_NOT_CONFIRMED",
            message: `${transaction.summary}: the wallet reported ${status}${result.failureDescription === undefined ? "" : ` (${result.failureDescription})`}`,
            retryable: false,
            details: { status, ...(result.hash === undefined ? {} : { txHash: result.hash }) },
          });
        }
        return ok({ txHash: result.hash as Hex, status });
      },
    });
  };

  return { wallet: () => wallet, chain, submitter };
}
