/**
 * Provisioning an Agent's Privy server wallet under the Tab policy.
 *
 * Three requests, in order:
 *
 * 1. `POST /v1/policies`: the policy {@link buildPrivyAgentPolicy} builds,
 *    owned by the owner's key, so only that key can change its rules.
 * 2. `POST /v1/key_quorums`: a one-key quorum around the Agent's runtime
 *    authorization key, the key the Agent's process signs requests with.
 * 3. `POST /v1/wallets`: an `ethereum` wallet owned by the owner's key, with
 *    the policy, and with the Agent's quorum as an additional signer whose
 *    override policy is the same policy.
 *
 * The split is the point. An owner can change a wallet's policies and signers
 * and export its key; a signer can only ask for signatures, and only within its
 * policy. The Agent's process holds the app secret and the signer key and
 * nothing that can loosen the policy, so a compromised Agent can do exactly
 * what an honest one can, and nothing more. The owner key never needs to be
 * on the machine the Agent runs on.
 */

import { getAddress, isAddress } from "ethers";
import { ok, type Address, type Result } from "@tabai/shared";

import { defaultLogger, type Logger } from "../logger.js";
import { fail, validationError } from "../errors.js";
import { PrivyError, createPrivyApi, isPrivyPublicKey, type PrivyFetch } from "./privy-api.js";
import { buildPrivyAgentPolicy, type PrivyAgentPolicyAddresses, type PrivyPolicy } from "./privy-policy.js";

export interface CreatePrivyAgentWalletOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly chainId: bigint | number;
  readonly addresses: PrivyAgentPolicyAddresses;
  /**
   * The owner's P-256 public key, base64 SPKI DER. It owns the wallet and the
   * policy. Keep its private half off the Agent's machine.
   */
  readonly ownerPublicKey: string;
  /**
   * The Agent's runtime authorization public key, base64 SPKI DER. Its private
   * half is what the Agent's signer is given as `authorizationKey`.
   */
  readonly signerPublicKey: string;
  /** Names the policy, the quorum and the wallet in Privy's dashboard. At most 50 characters. */
  readonly name?: string;
  /** See `PrivyAgentPolicyInput.x402MaxBaseUnits`. */
  readonly x402MaxBaseUnits?: bigint;
  readonly apiUrl?: string;
  readonly fetch?: PrivyFetch;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

export interface PrivyAgentWallet {
  readonly walletId: string;
  readonly address: Address;
  readonly policyId: string;
  /** The key quorum the Agent signs requests as. */
  readonly signerId: string;
  readonly policy: PrivyPolicy;
}

function idOf(response: unknown, what: string): string {
  const id = typeof response === "object" && response !== null ? (response as Record<string, unknown>)["id"] : undefined;
  if (typeof id !== "string" || id.length === 0) throw new PrivyError("PRIVY_RESPONSE_INVALID", `Privy answered ${what} without an id`);
  return id;
}

/**
 * Creates the policy, the Agent's signer quorum and the wallet. Returns the
 * ids and the address to fund. Nothing on chain is touched.
 */
export async function createPrivyAgentWallet(options: CreatePrivyAgentWalletOptions): Promise<Result<PrivyAgentWallet>> {
  const logger = options.logger ?? defaultLogger;
  if ((typeof options.chainId !== "bigint" && typeof options.chainId !== "number") || !/^[1-9][0-9]*$/.test(String(options.chainId))) {
    return validationError("PRIVY_CONFIG_INVALID", "chainId must be a positive integer chain id");
  }
  const name = options.name ?? `Tab Agent ${String(options.chainId)}`;
  if (name.length === 0 || name.length > 50) return validationError("PRIVY_CONFIG_INVALID", "the name is 1 to 50 characters");
  if (typeof options.ownerPublicKey !== "string" || !isPrivyPublicKey(options.ownerPublicKey)) {
    return validationError("PRIVY_CONFIG_INVALID", "ownerPublicKey must be a base64 SPKI DER P-256 public key");
  }
  if (typeof options.signerPublicKey !== "string" || !isPrivyPublicKey(options.signerPublicKey)) {
    return validationError("PRIVY_CONFIG_INVALID", "signerPublicKey must be a base64 SPKI DER P-256 public key");
  }
  if (options.ownerPublicKey.trim() === options.signerPublicKey.trim()) {
    return validationError(
      "PRIVY_CONFIG_INVALID",
      "the owner key and the Agent's signer key must differ: an owner can change the policy, and the Agent must not be able to",
    );
  }
  const policy = buildPrivyAgentPolicy({
    chainId: options.chainId,
    addresses: options.addresses,
    name,
    ...(options.x402MaxBaseUnits === undefined ? {} : { x402MaxBaseUnits: options.x402MaxBaseUnits }),
  });
  if (!policy.ok) return policy;

  let api;
  try {
    api = createPrivyApi({
      appId: options.appId,
      appSecret: options.appSecret,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch (error) {
    return validationError(error instanceof PrivyError ? error.code : "PRIVY_CONFIG_INVALID", error instanceof Error ? error.message : String(error));
  }

  const owner = { public_key: options.ownerPublicKey.trim() };
  const created: { policyId?: string; signerId?: string } = {};
  try {
    const policyId = idOf(await api.post("/v1/policies", { ...policy.value, owner }, "creating the policy"), "creating the policy");
    created.policyId = policyId;
    const signerId = idOf(
      await api.post(
        "/v1/key_quorums",
        { display_name: name, public_keys: [options.signerPublicKey.trim()], authorization_threshold: 1 },
        "creating the Agent's signer quorum",
      ),
      "creating the Agent's signer quorum",
    );
    created.signerId = signerId;
    const wallet = await api.post(
      "/v1/wallets",
      {
        chain_type: "ethereum",
        display_name: name,
        owner,
        policy_ids: [policyId],
        additional_signers: [{ signer_id: signerId, override_policy_ids: [policyId] }],
      },
      "creating the wallet",
    );
    const walletId = idOf(wallet, "creating the wallet");
    const address = (wallet as Record<string, unknown>)["address"];
    if (typeof address !== "string" || !isAddress(address)) {
      throw new PrivyError("PRIVY_RESPONSE_INVALID", `Privy created wallet ${walletId} and returned no EVM address for it`);
    }
    logger.info("privy agent wallet created", { walletId, policyId, signerId });
    return ok({ walletId, address: getAddress(address) as Address, policyId, signerId, policy: policy.value });
  } catch (error) {
    const details: Record<string, string> = {};
    if (created.policyId !== undefined) details["policyId"] = created.policyId;
    if (created.signerId !== undefined) details["signerId"] = created.signerId;
    const leftover = Object.keys(details).length === 0 ? "" : ` Already created, and safe to delete in the dashboard: ${Object.entries(details).map(([key, value]) => `${key} ${value}`).join(", ")}.`;
    if (error instanceof PrivyError) {
      return fail(error.code === "PRIVY_UNAVAILABLE" ? "UPSTREAM" : "VALIDATION", error.code, `${error.message}.${leftover}`, {
        retryable: error.code === "PRIVY_UNAVAILABLE" || error.code === "PRIVY_RATE_LIMITED",
        details,
      });
    }
    return fail("UPSTREAM", "PRIVY_UNAVAILABLE", `creating the Privy wallet failed: ${error instanceof Error ? error.message : String(error)}.${leftover}`, {
      details,
    });
  }
}
