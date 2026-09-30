/**
 * The Privy policy an Agent's server wallet is created under.
 *
 * Privy evaluates a wallet's policy in its enclave before it signs anything,
 * and a request no rule allows is refused. The policy below allows exactly
 * what an Agent on Tab does and nothing else:
 *
 * - **Transactions** (`eth_signTransaction` and `eth_sendTransaction`), on
 *   this chain only and with a value of zero:
 *   `settle` and `settleBatch` on `TabSettlement`, `authorise` on `TabBook`,
 *   `approve` on an accepted Asset whose spender is `TabSettlement` or
 *   Permit2, and `invalidateUnorderedNonces` on Permit2 to cancel a permit
 *   before it is used.
 * - **Typed data** (`eth_signTypedData_v4`): a Permit2
 *   `PermitWitnessTransferFrom` under Permit2's domain on this chain whose
 *   `spender` is `TabSettlement`, which is the gasless Settlement and only it.
 *   `TabSettlement` checks the witness (Service, Asset, amount, chain), so a
 *   signature the policy lets through can pay only a Settlement.
 * - **Messages** (`personal_sign`): a Tab metering claim, which starts with
 *   the claim's fixed first line. The gateway recovers it against the Agent,
 *   so it can only put a call on this Agent's own tab.
 *
 * Optionally, an EIP-3009 `TransferWithAuthorization` on an accepted Asset up
 * to a cap per authorisation, for the x402 prepaid fallback. Off by default,
 * because it pays a party the policy cannot name in advance.
 *
 * ## Why address values appear twice
 *
 * Privy compares strings case-sensitively and evaluates the request as sent.
 * Each address is listed checksummed and lower-case, so the rule holds
 * whichever form a request, or Privy's own calldata decoding, carries.
 *
 * ## Why the typed-data types are built, not written out
 *
 * A typed-data message condition only applies when the types map in the policy
 * equals the one in the request exactly, `EIP712Domain` included. The signer
 * builds its request with {@link typedDataPayload} and the policy's map comes
 * from the same function over the same types, so the two cannot drift.
 */

import { Interface, TypedDataEncoder, ZeroAddress, getAddress, isAddress, type TypedDataDomain, type TypedDataField } from "ethers";
import {
  PERMIT2_ADDRESS,
  PERMIT2_WITNESS_TRANSFER_FROM_PRIMARY_TYPE,
  PERMIT2_WITNESS_TRANSFER_FROM_TYPES,
  ok,
  permit2Domain,
  type Address,
  type Result,
} from "@tabai/shared";

import { validationError } from "../errors.js";
import { METERING_DIGEST_PREFIX } from "../http/metering-claim.js";
import { ERC20_ABI, TAB_SETTLEMENT_ABI } from "../payments/abi.js";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "../x402/client.js";

/** The TabBook function an Agent calls, as human-readable ABI. */
export const TAB_BOOK_AGENT_ABI = [
  "function authorise(bytes32 serviceId, address asset, uint128 maxCumulative, uint64 expiry)",
] as const;

/** The one Permit2 function an Agent may call under the policy: cancelling its own unused permits. */
export const PERMIT2_CANCEL_ABI = ["function invalidateUnorderedNonces(uint256 wordPos, uint256 mask)"] as const;

/** The two RPC methods that sign an EVM transaction. The signer uses one, and the policy allows both. */
export const PRIVY_TRANSACTION_METHODS = ["eth_signTransaction", "eth_sendTransaction"] as const;

export type PrivyPolicyMethod = (typeof PRIVY_TRANSACTION_METHODS)[number] | "eth_signTypedData_v4" | "personal_sign";

/** One condition, in the shape Privy's `POST /v1/policies` takes. */
export interface PrivyPolicyCondition {
  readonly field_source: "ethereum_transaction" | "ethereum_calldata" | "ethereum_typed_data_domain" | "ethereum_typed_data_message" | "message";
  readonly field: string;
  readonly operator: "eq" | "in" | "lte" | "starts_with";
  readonly value: string | readonly string[];
  readonly abi?: readonly Record<string, unknown>[];
  readonly typed_data?: { readonly types: Record<string, readonly TypedDataField[]>; readonly primary_type: string };
}

export interface PrivyPolicyRule {
  readonly name: string;
  readonly method: PrivyPolicyMethod;
  readonly conditions: readonly PrivyPolicyCondition[];
  readonly action: "ALLOW" | "DENY";
}

/** A policy body for `POST /v1/policies`. */
export interface PrivyPolicy {
  readonly version: "1.0";
  readonly name: string;
  readonly chain_type: "ethereum";
  readonly rules: readonly PrivyPolicyRule[];
}

/** The contracts the policy names, on one chain. */
export interface PrivyAgentPolicyAddresses {
  readonly tabSettlement: string;
  readonly tabBook: string;
  /** Every Asset the Agent settles in. At least one. */
  readonly assets: readonly string[];
  /** Defaults to the canonical Permit2. */
  readonly permit2?: string;
}

export interface PrivyAgentPolicyInput {
  readonly chainId: bigint | number;
  readonly addresses: PrivyAgentPolicyAddresses;
  /** At most 50 characters. Defaults to `Tab Agent on chain <id>`. */
  readonly name?: string;
  /**
   * Allows the x402 prepaid fallback: an EIP-3009 `TransferWithAuthorization`
   * on an accepted Asset of at most this many base units each. Omitted, the
   * policy refuses every x402 payment.
   */
  readonly x402MaxBaseUnits?: bigint;
}

/** Typed data as `eth_signTypedData_v4` takes it, with `EIP712Domain` in the types. */
export interface TypedDataPayload {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, TypedDataField[]>;
  readonly primary_type: string;
  readonly message: Record<string, unknown>;
}

/**
 * Typed data in the JSON form `eth_signTypedData_v4` signs: `EIP712Domain`
 * derived from the domain, integers as decimal strings, addresses
 * lower-cased. Throws on typed data ethers would refuse to hash.
 */
export function typedDataPayload(
  domain: TypedDataDomain,
  types: Record<string, readonly TypedDataField[]>,
  value: Record<string, unknown>,
): TypedDataPayload {
  const payload = TypedDataEncoder.getPayload(domain, types as Record<string, TypedDataField[]>, value);
  // ethers writes the domain's chain id as a hex quantity and lower-cases its
  // contract. The chain id goes as a JSON number, as wallets send it and as a
  // policy's decimal `chainId` value reads it, and the contract checksummed.
  const normalised: Record<string, unknown> = { ...(payload.domain as Record<string, unknown>) };
  if (normalised["chainId"] !== undefined) {
    const chainId = BigInt(normalised["chainId"] as string | number | bigint);
    normalised["chainId"] = chainId <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(chainId) : chainId.toString(10);
  }
  if (typeof normalised["verifyingContract"] === "string") normalised["verifyingContract"] = getAddress(normalised["verifyingContract"]);
  return {
    domain: normalised,
    types: payload.types,
    primary_type: payload.primaryType,
    message: payload.message as Record<string, unknown>,
  };
}

/** Both spellings of an address Privy may compare against. */
export function addressForms(address: string): string[] {
  const checksummed = getAddress(address);
  return [...new Set([checksummed, checksummed.toLowerCase()])];
}

/** One function of an ABI, as the JSON Privy decodes calldata against. */
function abiFor(abi: readonly string[], name: string): Record<string, unknown>[] {
  const fragment = new Interface(abi).getFunction(name);
  if (fragment === null) throw new Error(`no ${name} in the ABI`);
  const json = JSON.parse(fragment.format("json")) as Record<string, unknown>;
  return [
    {
      type: "function",
      name: fragment.name,
      stateMutability: fragment.stateMutability,
      inputs: json["inputs"],
      outputs: json["outputs"] ?? [],
    },
  ];
}

/** The types map of a Permit2 settlement permit, as the signer sends it. */
export function permit2PermitTypes(chainId: bigint, permit2: string): Record<string, TypedDataField[]> {
  return typedDataPayload(permit2Domain(chainId, getAddress(permit2) as Address), PERMIT2_WITNESS_TRANSFER_FROM_TYPES, {
    permitted: { token: ZeroAddress, amount: 0n },
    spender: ZeroAddress,
    nonce: 0n,
    deadline: 0n,
    witness: { serviceId: `0x${"00".repeat(32)}`, asset: ZeroAddress, amount: 0n, surface: ZeroAddress, chainId },
  }).types;
}

/** The types map of an EIP-3009 authorisation under a USDC-style domain (name, version, chain, contract). */
function transferWithAuthorizationTypes(chainId: bigint, asset: string): Record<string, TypedDataField[]> {
  return typedDataPayload({ name: "x", version: "x", chainId, verifyingContract: getAddress(asset) }, TRANSFER_WITH_AUTHORIZATION_TYPES, {
    from: ZeroAddress,
    to: ZeroAddress,
    value: 0n,
    validAfter: 0n,
    validBefore: 0n,
    nonce: `0x${"00".repeat(32)}`,
  }).types;
}

/**
 * Builds the Agent's policy. Refuses an address that is not one, an empty
 * Asset list and a name Privy would refuse.
 */
export function buildPrivyAgentPolicy(input: PrivyAgentPolicyInput): Result<PrivyPolicy> {
  let chainId: bigint;
  try {
    chainId = BigInt(input.chainId);
  } catch {
    return validationError("PRIVY_POLICY_INVALID", "chainId must be an integer chain id");
  }
  if (chainId <= 0n) return validationError("PRIVY_POLICY_INVALID", "chainId must be a positive chain id");
  const { addresses } = input;
  const named: Array<[string, unknown]> = [
    ["tabSettlement", addresses.tabSettlement],
    ["tabBook", addresses.tabBook],
    ["permit2", addresses.permit2 ?? PERMIT2_ADDRESS],
  ];
  for (const [field, value] of named) {
    if (typeof value !== "string" || !isAddress(value)) {
      return validationError("PRIVY_POLICY_INVALID", `addresses.${field} must be a 20-byte 0x address`, { details: { field } });
    }
  }
  if (!Array.isArray(addresses.assets) || addresses.assets.length === 0) {
    return validationError("PRIVY_POLICY_INVALID", "addresses.assets must name at least one Asset the Agent settles in");
  }
  for (const [index, asset] of addresses.assets.entries()) {
    if (typeof asset !== "string" || !isAddress(asset)) {
      return validationError("PRIVY_POLICY_INVALID", `addresses.assets[${index}] must be a 20-byte 0x address`, { details: { index } });
    }
  }
  const name = input.name ?? `Tab Agent on chain ${chainId.toString(10)}`;
  if (name.length === 0 || name.length > 50) {
    return validationError("PRIVY_POLICY_INVALID", "a Privy policy name is 1 to 50 characters");
  }
  if (input.x402MaxBaseUnits !== undefined && (typeof input.x402MaxBaseUnits !== "bigint" || input.x402MaxBaseUnits <= 0n)) {
    return validationError("PRIVY_POLICY_INVALID", "x402MaxBaseUnits must be a positive bigint of base units");
  }

  const tabSettlement = addressForms(addresses.tabSettlement);
  const tabBook = addressForms(addresses.tabBook);
  const permit2 = addressForms(addresses.permit2 ?? PERMIT2_ADDRESS);
  const assets = [...new Set(addresses.assets.flatMap((asset) => addressForms(asset)))];
  const chain = chainId.toString(10);

  const onThisChainWithNoValue = (to: readonly string[]): PrivyPolicyCondition[] => [
    { field_source: "ethereum_transaction", field: "to", operator: "in", value: to },
    { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: chain },
    { field_source: "ethereum_transaction", field: "value", operator: "eq", value: "0x0" },
  ];
  const calls = (abi: readonly string[], fn: string): PrivyPolicyCondition => ({
    field_source: "ethereum_calldata",
    field: "function_name",
    abi: abiFor(abi, fn),
    operator: "eq",
    value: fn,
  });

  const transactionRules = (method: (typeof PRIVY_TRANSACTION_METHODS)[number]): PrivyPolicyRule[] => {
    const tag = method === "eth_signTransaction" ? "sign" : "send";
    return [
      {
        name: `TabSettlement settle (${tag})`,
        method,
        conditions: [...onThisChainWithNoValue(tabSettlement), calls(TAB_SETTLEMENT_ABI, "settle")],
        action: "ALLOW",
      },
      {
        name: `TabSettlement settleBatch (${tag})`,
        method,
        conditions: [...onThisChainWithNoValue(tabSettlement), calls(TAB_SETTLEMENT_ABI, "settleBatch")],
        action: "ALLOW",
      },
      {
        name: `TabBook authorise (${tag})`,
        method,
        conditions: [...onThisChainWithNoValue(tabBook), calls(TAB_BOOK_AGENT_ABI, "authorise")],
        action: "ALLOW",
      },
      {
        name: `Asset approve to TabSettlement or Permit2 (${tag})`,
        method,
        conditions: [
          ...onThisChainWithNoValue(assets),
          {
            field_source: "ethereum_calldata",
            field: "approve.spender",
            abi: abiFor(ERC20_ABI, "approve"),
            operator: "in",
            value: [...tabSettlement, ...permit2],
          },
        ],
        action: "ALLOW",
      },
      {
        name: `Permit2 cancel unused permits (${tag})`,
        method,
        conditions: [...onThisChainWithNoValue(permit2), calls(PERMIT2_CANCEL_ABI, "invalidateUnorderedNonces")],
        action: "ALLOW",
      },
    ];
  };

  const rules: PrivyPolicyRule[] = [
    ...PRIVY_TRANSACTION_METHODS.flatMap(transactionRules),
    {
      name: "Permit2 Settlement to TabSettlement",
      method: "eth_signTypedData_v4",
      conditions: [
        { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: chain },
        { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "in", value: permit2 },
        {
          field_source: "ethereum_typed_data_message",
          field: "spender",
          typed_data: { types: permit2PermitTypes(chainId, addresses.permit2 ?? PERMIT2_ADDRESS), primary_type: PERMIT2_WITNESS_TRANSFER_FROM_PRIMARY_TYPE },
          operator: "in",
          value: tabSettlement,
        },
      ],
      action: "ALLOW",
    },
    {
      name: "Tab metering claims",
      method: "personal_sign",
      conditions: [{ field_source: "message", field: "content", operator: "starts_with", value: `${METERING_DIGEST_PREFIX}\n` }],
      action: "ALLOW",
    },
  ];

  if (input.x402MaxBaseUnits !== undefined) {
    const firstAsset = addresses.assets[0] ?? ZeroAddress;
    rules.push({
      name: "x402 EIP-3009 payment, capped",
      method: "eth_signTypedData_v4",
      conditions: [
        { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: chain },
        { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "in", value: assets },
        {
          field_source: "ethereum_typed_data_message",
          field: "value",
          typed_data: { types: transferWithAuthorizationTypes(chainId, firstAsset), primary_type: "TransferWithAuthorization" },
          operator: "lte",
          value: input.x402MaxBaseUnits.toString(10),
        },
      ],
      action: "ALLOW",
    });
  }

  return ok({ version: "1.0", name, chain_type: "ethereum", rules });
}
