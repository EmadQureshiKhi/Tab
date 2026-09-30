/**
 * Signers an Agent can hold its key behind, other than a raw private key.
 *
 * A signer here is an ethers `AbstractSigner`, so it drops into every place
 * this package takes one: the settlement strategies, `agentSignedMetering`
 * and the x402 client.
 */

export {
  PRIVY_API_URL,
  PRIVY_AUTHORIZATION_KEY_PREFIX,
  PrivyError,
  canonicalJson,
  generatePrivyAuthorizationKeyPair,
  isPrivyPublicKey,
  privyAuthorizationSignature,
  type PrivyAuthorizationKeyPair,
  type PrivyErrorCode,
  type PrivyFetch,
} from "./privy-api.js";
export {
  PRIVY_TRANSACTION_METHODS,
  addressForms,
  buildPrivyAgentPolicy,
  permit2PermitTypes,
  typedDataPayload,
  type PrivyAgentPolicyAddresses,
  type PrivyAgentPolicyInput,
  type PrivyPolicy,
  type PrivyPolicyCondition,
  type PrivyPolicyMethod,
  type PrivyPolicyRule,
  type TypedDataPayload,
} from "./privy-policy.js";
export {
  createPrivyAgentSigner,
  describePrivyRequest,
  type PrivyAgentSigner,
  type PrivyAgentSignerOptions,
  type PrivyTransactionMode,
  type PrivyWalletRecord,
} from "./privy-signer.js";
export { createPrivyAgentWallet, type CreatePrivyAgentWalletOptions, type PrivyAgentWallet } from "./privy-wallet.js";
