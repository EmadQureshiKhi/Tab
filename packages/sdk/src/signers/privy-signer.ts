/**
 * An Agent's signer whose key lives in a Privy server wallet.
 *
 * The key never enters the Agent's process: every signature is a request to
 * Privy's wallet RPC, and Privy's policy engine decides in its enclave whether
 * to sign. {@link PrivyAgentSigner} is an ethers `AbstractSigner`, so it goes
 * wherever this package takes a signer: `createMonadStrategy`,
 * `createRelayedMonadStrategy`, `agentSignedMetering` and the x402 client.
 *
 * | ethers call | Privy RPC method |
 * | --- | --- |
 * | `getAddress` | `GET /v1/wallets/{id}`, once, then cached |
 * | `signMessage` | `personal_sign` (a metering claim) |
 * | `signTypedData` | `eth_signTypedData_v4` (a Permit2 Settlement) |
 * | `signTransaction` | `eth_signTransaction` |
 * | `sendTransaction` | `eth_signTransaction`, then the provider broadcasts; or `eth_sendTransaction` with `caip2` |
 *
 * ## Why signing and broadcasting are separate by default
 *
 * Privy's `eth_signTransaction` takes an explicit chain id and returns the
 * signed transaction, so it works on any EVM chain; `eth_sendTransaction`
 * broadcasts from Privy's side and depends on Privy serving that chain. The
 * default fills nonce and fees from the Agent's own Monad provider, has Privy
 * sign, checks the signed transaction is the one asked for, and broadcasts it
 * through the same provider. `transactions: "privy"` hands the whole send to
 * Privy instead.
 *
 * ## What is checked on the way back
 *
 * A signature Privy returns is recovered before it is used, and a signed
 * transaction is decoded and compared field by field with the request. A wallet
 * id that points at a different wallet than the one the caller meant, or an
 * answer that is not what was asked for, fails here rather than on chain.
 */

import {
  AbstractSigner,
  Interface,
  Transaction,
  getAddress,
  getBigInt,
  hexlify,
  isAddress,
  resolveAddress,
  toQuantity,
  verifyMessage,
  verifyTypedData,
  type Provider,
  type TransactionRequest,
  type TransactionResponse,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import { TAB_SETTLEMENT_PERMIT2_ABI, causeOf, ok, type Address, type Result } from "@tabai/shared";

import { defaultLogger, type Logger } from "../logger.js";
import { validationError } from "../errors.js";
import { ERC20_ABI, TAB_SETTLEMENT_ABI } from "../payments/abi.js";
import { PrivyError, createPrivyApi, type PrivyApi, type PrivyFetch } from "./privy-api.js";
import { PERMIT2_CANCEL_ABI, TAB_BOOK_AGENT_ABI, typedDataPayload } from "./privy-policy.js";

/** `sign` has Privy sign and the provider broadcast; `privy` has Privy do both. */
export type PrivyTransactionMode = "sign" | "privy";

export interface PrivyAgentSignerOptions {
  readonly appId: string;
  /** Read from the environment by the caller. Never logged. */
  readonly appSecret: string;
  readonly walletId: string;
  /** The chain the Agent transacts on: 143 for Monad Mainnet, 10143 for Testnet. */
  readonly chainId: bigint | number;
  /** Reads nonce, gas and fees, and broadcasts. Required to send a transaction. */
  readonly provider?: Provider | null;
  /**
   * The authorization key of the wallet's signer, `wallet-auth:` form. Required
   * when the wallet has an owner, which every wallet `createPrivyAgentWallet`
   * makes does. Never logged.
   */
  readonly authorizationKey?: string;
  /** Defaults to `sign`. */
  readonly transactions?: PrivyTransactionMode;
  readonly apiUrl?: string;
  readonly fetch?: PrivyFetch;
  readonly timeoutMs?: number;
  readonly requestTtlMs?: number;
  /** In `privy` mode, how often and how many times to look for the sent transaction. */
  readonly pollIntervalMs?: number;
  readonly pollAttempts?: number;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/** What `GET /v1/wallets/{id}` said, as far as the signer needs it. */
export interface PrivyWalletRecord {
  readonly id: string;
  readonly address: Address;
  /** The wallet's own policies and every additional signer's override policies. */
  readonly policyIds: readonly string[];
  readonly ownerId: string | null;
}

interface Shared {
  readonly api: PrivyApi;
  readonly walletId: string;
  readonly chainId: bigint;
  readonly mode: PrivyTransactionMode;
  readonly logger: Logger;
  readonly pollIntervalMs: number;
  readonly pollAttempts: number;
  wallet: Promise<PrivyWalletRecord> | undefined;
}

const KNOWN_CALLS = [
  new Interface(ERC20_ABI),
  new Interface(["function transfer(address to, uint256 amount) returns (bool)", "function transferFrom(address from, address to, uint256 amount) returns (bool)"]),
  new Interface(TAB_SETTLEMENT_ABI),
  new Interface(TAB_SETTLEMENT_PERMIT2_ABI),
  new Interface(TAB_BOOK_AGENT_ABI),
  new Interface(PERMIT2_CANCEL_ABI),
];

function formatArgument(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return `[${value.map(formatArgument).join(", ")}]`;
  return String(value);
}

function describeCalldata(data: unknown): string {
  if (typeof data !== "string" || data === "0x" || data.length === 0) return "with no calldata";
  for (const contract of KNOWN_CALLS) {
    try {
      const parsed = contract.parseTransaction({ data });
      if (parsed !== null) return `calling ${parsed.name}(${[...parsed.args].map(formatArgument).join(", ")})`;
    } catch {
      // Not this contract's function; try the next.
    }
  }
  return `calling an unrecognised function ${data.slice(0, 10)}`;
}

/**
 * One sentence naming what a wallet RPC request asked Privy to sign, for an
 * error message or a log line. Carries no credential.
 */
export function describePrivyRequest(body: Record<string, unknown>): string {
  const method = String(body["method"]);
  const params = (body["params"] ?? {}) as Record<string, unknown>;
  if (method === "personal_sign") {
    const message = String(params["message"] ?? "");
    const head = message.length > 48 ? `${message.slice(0, 48)}...` : message;
    return `personal_sign of a ${String(params["encoding"] ?? "utf-8")} message beginning ${JSON.stringify(head)}`;
  }
  if (method === "eth_signTypedData_v4") {
    const typed = (params["typed_data"] ?? {}) as Record<string, unknown>;
    const domain = (typed["domain"] ?? {}) as Record<string, unknown>;
    const message = (typed["message"] ?? {}) as Record<string, unknown>;
    const spender = typeof message["spender"] === "string" ? `, spender ${message["spender"]}` : "";
    return `eth_signTypedData_v4 of ${String(typed["primary_type"])} under the ${String(domain["name"] ?? "unnamed")} domain at ${String(domain["verifyingContract"] ?? "no contract")} on chain ${String(domain["chainId"] ?? "unstated")}${spender}`;
  }
  if (method === "eth_signTransaction" || method === "eth_sendTransaction") {
    const transaction = (params["transaction"] ?? {}) as Record<string, unknown>;
    return `${method} of a transaction to ${String(transaction["to"])} on chain ${String(transaction["chain_id"] ?? body["caip2"])} with value ${String(transaction["value"] ?? "0x0")}, ${describeCalldata(transaction["data"])}`;
  }
  return method;
}

function signatureOf(data: Record<string, unknown>, what: string): string {
  const signature = data["signature"];
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new PrivyError("PRIVY_RESPONSE_INVALID", `Privy answered ${what} without a 65-byte signature`);
  }
  return signature;
}

function dataOf(response: unknown, what: string): Record<string, unknown> {
  const data = typeof response === "object" && response !== null ? (response as Record<string, unknown>)["data"] : undefined;
  if (typeof data !== "object" || data === null) throw new PrivyError("PRIVY_RESPONSE_INVALID", `Privy answered ${what} without a data object`);
  return data as Record<string, unknown>;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The Agent's signer, backed by a Privy server wallet. Build it with
 * {@link createPrivyAgentSigner}.
 */
export class PrivyAgentSigner extends AbstractSigner {
  readonly walletId: string;
  readonly chainId: bigint;
  /** `eip155:<chainId>`, as Privy names the chain. */
  readonly caip2: string;
  #shared: Shared;
  readonly #options: PrivyAgentSignerOptions;

  /** Throws {@link PrivyError}; {@link createPrivyAgentSigner} is the non-throwing way in. */
  constructor(options: PrivyAgentSignerOptions) {
    super(options.provider ?? null);
    const walletId = typeof options.walletId === "string" ? options.walletId.trim() : "";
    if (walletId.length === 0 || !/^[A-Za-z0-9_-]+$/.test(walletId)) {
      throw new PrivyError("PRIVY_CONFIG_INVALID", "a Privy wallet id is required (PRIVY_WALLET_ID), and it is letters, digits, - and _ only");
    }
    let chainId: bigint;
    try {
      chainId = BigInt(options.chainId);
    } catch {
      throw new PrivyError("PRIVY_CONFIG_INVALID", "chainId must be an integer chain id");
    }
    if (chainId <= 0n) throw new PrivyError("PRIVY_CONFIG_INVALID", "chainId must be a positive chain id");
    const mode = options.transactions ?? "sign";
    if (mode !== "sign" && mode !== "privy") {
      throw new PrivyError("PRIVY_CONFIG_INVALID", `transactions must be "sign" or "privy", not ${JSON.stringify(mode)}`);
    }
    const logger = options.logger ?? defaultLogger;
    const api = createPrivyApi({
      appId: options.appId,
      appSecret: options.appSecret,
      ...(options.authorizationKey === undefined ? {} : { authorizationKey: options.authorizationKey }),
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.requestTtlMs === undefined ? {} : { requestTtlMs: options.requestTtlMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#options = options;
    this.walletId = walletId;
    this.chainId = chainId;
    this.caip2 = `eip155:${chainId.toString(10)}`;
    this.#shared = {
      api,
      walletId,
      chainId,
      mode,
      logger,
      pollIntervalMs: options.pollIntervalMs ?? 1_000,
      pollAttempts: options.pollAttempts ?? 30,
      wallet: undefined,
    };
  }

  /** The same wallet over another provider. The wallet lookup is shared, so the address is read once. */
  override connect(provider: Provider | null): PrivyAgentSigner {
    const next = new PrivyAgentSigner({ ...this.#options, provider });
    next.#shared = this.#shared;
    return next;
  }

  /** How the wallet looks from Privy: its address and the policies that govern it. */
  async wallet(): Promise<PrivyWalletRecord> {
    const shared = this.#shared;
    if (shared.wallet === undefined) {
      shared.wallet = this.#readWallet().catch((error: unknown) => {
        shared.wallet = undefined;
        throw error;
      });
    }
    return shared.wallet;
  }

  async #readWallet(): Promise<PrivyWalletRecord> {
    const { api, walletId } = this.#shared;
    const response = await api.get(`/v1/wallets/${encodeURIComponent(walletId)}`);
    const record = (typeof response === "object" && response !== null ? response : {}) as Record<string, unknown>;
    if (record["chain_type"] !== "ethereum") {
      throw new PrivyError(
        "PRIVY_RESPONSE_INVALID",
        `Privy wallet ${walletId} is a ${String(record["chain_type"])} wallet; an Agent on Monad needs chain_type ethereum`,
      );
    }
    const address = record["address"];
    if (typeof address !== "string" || !isAddress(address)) {
      throw new PrivyError("PRIVY_RESPONSE_INVALID", `Privy wallet ${walletId} came back without an EVM address`);
    }
    const signers = Array.isArray(record["additional_signers"]) ? (record["additional_signers"] as unknown[]) : [];
    const policyIds = new Set(stringList(record["policy_ids"]));
    for (const signer of signers) {
      if (typeof signer === "object" && signer !== null) {
        for (const id of stringList((signer as Record<string, unknown>)["override_policy_ids"])) policyIds.add(id);
      }
    }
    return {
      id: walletId,
      address: getAddress(address) as Address,
      policyIds: [...policyIds],
      ownerId: typeof record["owner_id"] === "string" ? record["owner_id"] : null,
    };
  }

  override async getAddress(): Promise<string> {
    return (await this.wallet()).address;
  }

  /** One wallet RPC call. A policy refusal is reported with what was refused and the rules that did not allow it. */
  async #rpc(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { api, walletId, logger } = this.#shared;
    const method = String(body["method"]);
    try {
      const response = await api.post(`/v1/wallets/${encodeURIComponent(walletId)}/rpc`, body, method);
      logger.debug("privy signed", { walletId, method });
      return dataOf(response, method);
    } catch (error) {
      if (error instanceof PrivyError && error.code === "PRIVY_POLICY_DENIED") throw await this.#explainDenial(error, body);
      throw error;
    }
  }

  async #explainDenial(error: PrivyError, body: Record<string, unknown>): Promise<PrivyError> {
    const method = String(body["method"]);
    let rules = "";
    try {
      const { policyIds } = await this.wallet();
      const described: string[] = [];
      for (const id of policyIds) {
        const policy = (await this.#shared.api.get(`/v1/policies/${encodeURIComponent(id)}`)) as Record<string, unknown>;
        const name = typeof policy["name"] === "string" ? policy["name"] : id;
        const matching = (Array.isArray(policy["rules"]) ? (policy["rules"] as Record<string, unknown>[]) : []).filter(
          (rule) => rule["method"] === method || rule["method"] === "*",
        );
        described.push(
          matching.length === 0
            ? `policy "${name}" has no rule for ${method}, and Privy refuses a method no rule names`
            : `policy "${name}" allows ${method} only under ${matching.map((rule) => `"${String(rule["name"])}" (${String(rule["action"])})`).join(", ")}`,
        );
      }
      if (described.length > 0) rules = ` ${described.join("; ")}.`;
    } catch {
      // The explanation is best effort; the refusal itself stands either way.
    }
    return new PrivyError("PRIVY_POLICY_DENIED", `${error.message}. Refused: ${describePrivyRequest(body)}.${rules}`, {
      status: error.status,
      privyCode: error.privyCode,
      privyMessage: error.privyMessage,
    });
  }

  async #expectSigner(recovered: string, what: string): Promise<void> {
    const address = await this.getAddress();
    if (recovered.toLowerCase() !== address.toLowerCase()) {
      throw new PrivyError(
        "PRIVY_SIGNATURE_MISMATCH",
        `Privy's ${what} signature recovers to ${recovered}, not to wallet ${this.walletId} at ${address}`,
      );
    }
  }

  override async signMessage(message: string | Uint8Array): Promise<string> {
    const params = typeof message === "string" ? { message, encoding: "utf-8" } : { message: hexlify(message), encoding: "hex" };
    const data = await this.#rpc({ method: "personal_sign", params });
    const signature = signatureOf(data, "personal_sign");
    await this.#expectSigner(verifyMessage(message, signature), "personal_sign");
    return signature;
  }

  override async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const typed_data = typedDataPayload(domain, types, value);
    const data = await this.#rpc({ method: "eth_signTypedData_v4", params: { typed_data } });
    const signature = signatureOf(data, "eth_signTypedData_v4");
    await this.#expectSigner(verifyTypedData(domain, types, value, signature), "eth_signTypedData_v4");
    return signature;
  }

  /** The transaction as Privy's wallet RPC takes it, after checking it is one this signer can sign. */
  async #privyTransaction(tx: TransactionRequest, complete: boolean): Promise<Record<string, unknown>> {
    const address = await this.getAddress();
    if (tx.from !== undefined && tx.from !== null) {
      const from = await resolveAddress(tx.from, this.provider);
      if (from.toLowerCase() !== address.toLowerCase()) {
        throw new PrivyError("PRIVY_TRANSACTION_UNSUPPORTED", `the transaction is from ${from}, and wallet ${this.walletId} is ${address}`);
      }
    }
    if (tx.to === undefined || tx.to === null) {
      throw new PrivyError("PRIVY_TRANSACTION_UNSUPPORTED", "an Agent's Privy wallet does not deploy contracts; the transaction needs a `to`");
    }
    if (Array.isArray(tx.accessList) && tx.accessList.length > 0) {
      throw new PrivyError("PRIVY_TRANSACTION_UNSUPPORTED", "Privy's wallet RPC takes no access list");
    }
    if (Array.isArray(tx.authorizationList) && tx.authorizationList.length > 0) {
      throw new PrivyError("PRIVY_TRANSACTION_UNSUPPORTED", "an Agent's Privy wallet does not sign EIP-7702 authorisations");
    }
    const chainId = tx.chainId === undefined || tx.chainId === null ? this.chainId : getBigInt(tx.chainId);
    if (chainId !== this.chainId) {
      throw new PrivyError("PRIVY_TRANSACTION_UNSUPPORTED", `the transaction is for chain ${chainId.toString(10)}, and this signer is for chain ${this.chainId.toString(10)}`);
    }
    const transaction: Record<string, unknown> = {
      to: getAddress(await resolveAddress(tx.to, this.provider)),
      value: toQuantity(tx.value ?? 0n),
      data: hexlify(tx.data ?? "0x"),
      chain_id: Number(chainId),
    };
    if (tx.nonce !== undefined && tx.nonce !== null) transaction["nonce"] = Number(tx.nonce);
    if (tx.gasLimit !== undefined && tx.gasLimit !== null) transaction["gas_limit"] = toQuantity(tx.gasLimit);
    const hasEip1559 = tx.maxFeePerGas != null || tx.maxPriorityFeePerGas != null;
    const type = tx.type ?? (hasEip1559 ? 2 : tx.gasPrice != null ? 0 : undefined);
    if (type === 2) {
      transaction["type"] = 2;
      if (tx.maxFeePerGas != null) transaction["max_fee_per_gas"] = toQuantity(tx.maxFeePerGas);
      if (tx.maxPriorityFeePerGas != null) transaction["max_priority_fee_per_gas"] = toQuantity(tx.maxPriorityFeePerGas);
    } else if (type === 0) {
      transaction["type"] = 0;
      if (tx.gasPrice != null) transaction["gas_price"] = toQuantity(tx.gasPrice);
    } else if (type !== undefined) {
      throw new PrivyError("PRIVY_TRANSACTION_UNSUPPORTED", `transaction type ${String(type)} is not one an Agent's Privy wallet signs; use 2 (EIP-1559) or 0`);
    }
    if (complete) {
      const missing = [
        ["nonce", transaction["nonce"]],
        ["gasLimit", transaction["gas_limit"]],
        ["a fee (maxFeePerGas and maxPriorityFeePerGas, or gasPrice)", type === 2 ? transaction["max_fee_per_gas"] && transaction["max_priority_fee_per_gas"] : transaction["gas_price"]],
      ]
        .filter(([, present]) => present === undefined)
        .map(([name]) => name);
      if (missing.length > 0) {
        throw new PrivyError("PRIVY_TRANSACTION_UNSUPPORTED", `signTransaction needs a populated transaction; missing ${missing.join(", ")}`);
      }
    }
    return transaction;
  }

  override async signTransaction(tx: TransactionRequest): Promise<string> {
    const transaction = await this.#privyTransaction(tx, true);
    const data = await this.#rpc({ method: "eth_signTransaction", params: { transaction } });
    const signed = data["signed_transaction"];
    if (typeof signed !== "string" || !/^0x[0-9a-fA-F]+$/.test(signed)) {
      throw new PrivyError("PRIVY_RESPONSE_INVALID", "Privy answered eth_signTransaction without a signed transaction");
    }
    let parsed: Transaction;
    try {
      parsed = Transaction.from(signed);
    } catch (error) {
      throw new PrivyError("PRIVY_RESPONSE_INVALID", `Privy's signed transaction does not decode: ${causeOf(error).message}`);
    }
    const address = await this.getAddress();
    const differences: string[] = [];
    if (parsed.from === null || parsed.from.toLowerCase() !== address.toLowerCase()) differences.push(`signer ${String(parsed.from)}`);
    if ((parsed.to ?? "").toLowerCase() !== String(transaction["to"]).toLowerCase()) differences.push(`to ${String(parsed.to)}`);
    if (parsed.data.toLowerCase() !== String(transaction["data"]).toLowerCase()) differences.push("calldata");
    if (parsed.value !== getBigInt(String(transaction["value"]))) differences.push(`value ${parsed.value.toString(10)}`);
    if (parsed.chainId !== this.chainId) differences.push(`chain ${parsed.chainId.toString(10)}`);
    if (parsed.nonce !== transaction["nonce"]) differences.push(`nonce ${parsed.nonce}`);
    if (parsed.gasLimit !== getBigInt(String(transaction["gas_limit"]))) differences.push(`gas limit ${parsed.gasLimit.toString(10)}`);
    if (differences.length > 0) {
      throw new PrivyError(
        "PRIVY_SIGNATURE_MISMATCH",
        `Privy signed a transaction that differs from the one requested (${differences.join(", ")}); it was not broadcast`,
      );
    }
    return signed;
  }

  override async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const provider = this.provider;
    if (provider === null) {
      throw new PrivyError("PRIVY_PROVIDER_REQUIRED", "a Privy signer needs a provider to send a transaction; pass one to createPrivyAgentSigner");
    }
    if (this.#shared.mode === "sign") return super.sendTransaction(tx);

    const transaction = await this.#privyTransaction(tx, false);
    const data = await this.#rpc({ method: "eth_sendTransaction", caip2: this.caip2, chain_type: "ethereum", params: { transaction } });
    const hash = data["hash"];
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new PrivyError("PRIVY_RESPONSE_INVALID", "Privy answered eth_sendTransaction without a transaction hash");
    }
    for (let attempt = 0; attempt < this.#shared.pollAttempts; attempt += 1) {
      const found = await provider.getTransaction(hash);
      if (found !== null) return found;
      await new Promise((resolve) => setTimeout(resolve, this.#shared.pollIntervalMs));
    }
    throw new PrivyError(
      "PRIVY_TRANSACTION_NOT_FOUND",
      `Privy reports ${hash} as sent on ${this.caip2}, and the provider has not seen it; look it up before sending again`,
    );
  }
}

/**
 * Builds the signer, or says which option is wrong. No network call is made
 * until the first signature or address is asked for.
 */
export function createPrivyAgentSigner(options: PrivyAgentSignerOptions): Result<PrivyAgentSigner> {
  try {
    return ok(new PrivyAgentSigner(options));
  } catch (error) {
    if (error instanceof PrivyError) return validationError(error.code, error.message);
    return validationError("PRIVY_CONFIG_INVALID", `the Privy signer could not be built: ${causeOf(error).message}`);
  }
}
