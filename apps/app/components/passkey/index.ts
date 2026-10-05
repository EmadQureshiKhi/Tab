/**
 * Passkey accounts: one passkey, many keys, no seed phrase, no custodian.
 *
 * The pure half (`derivation`, `account`, `storage`, `signer`, `chain`,
 * `support`, `agent-book`) runs anywhere and is what `test/passkey.test.ts`
 * and `test/agent-book.test.ts` exercise. The browser half (`ceremony`,
 * `agent-book-ceremony`, `use-passkey`) needs WebAuthn and is verified in a
 * browser; the agent book's ceremonies also run in the tests against an
 * authenticator double. `components/wallet/wallet-context.tsx` is the one consumer of
 * the hook; everything else reads the connection through `useWallet`.
 */

export {
  DERIVATION_ROOT,
  FIRST_SESSION_INDEX,
  OWNER_INDEX,
  deriveKey,
  derivePrivateKey,
  isSessionKeyIndex,
  keyLabel,
  pathFor,
  seedFromPrfOutput,
  toHex,
  type DerivedKey,
} from "./derivation";
export { openPasskeyAccount, type PasskeyAccount } from "./account";
export {
  PASSKEY_RECORD_KEY,
  browserStorage,
  clearPasskeyRecord,
  readPasskeyRecord,
  writePasskeyRecord,
  type PasskeyRecord,
  type StorageLike,
} from "./storage";
export { SessionSigner } from "./signer";
export {
  MONAD_FAUCET_URL,
  formatMon,
  passkeyChainFor,
  providerFor,
  readNativeBalance,
  selectedPasskeyChain,
  type PasskeyChain,
} from "./chain";
export {
  SUPPORTED_AUTHENTICATORS,
  UNSUPPORTED_AUTHENTICATORS,
  webAuthnAvailable,
  type AuthenticatorSupport,
} from "./support";
export {
  RP_NAME,
  assertPasskey,
  createPasskey,
  describeCeremonyFailure,
  relyingPartyId,
  supportedAuthenticatorsClause,
} from "./ceremony";
export {
  describeSendFailure,
  usePasskeyConnection,
  type BalanceReading,
  type KeyView,
  type PasskeyConnection,
  type SelectedNetwork,
} from "./use-passkey";
export {
  AGENT_BOOK_FILE_KIND,
  AGENT_BOOK_FILE_NAME,
  AGENT_BOOK_KEY,
  AGENT_BOOK_LIMITS,
  clearSealedAgentBook,
  emptyAgentBook,
  encodeAgentBook,
  entryFor,
  namespaceFingerprint,
  parseAgentBook,
  parseSealedAgentBook,
  readSealedAgentBook,
  serialiseSealedAgentBook,
  withEntry,
  writeSealedAgentBook,
  type AgentBook,
  type AgentBookEntry,
  type SealedAgentBook,
} from "./agent-book";
export { describeBookFailure, openAgentBook, sealAgentBook } from "./agent-book-ceremony";
export { AgentBookView, type AgentBookViewProps } from "./agent-book-view";
export { KeysView, type KeysViewProps } from "./keys-view";
