/**
 * Sealing and opening the agent book, one passkey prompt each.
 *
 * Both go through Mera's secret vault, so neither touches the account: sealing
 * evaluates the passkey's PRF at a fresh random salt and encrypts under a key
 * derived from that output; opening evaluates it again at the salt the vault
 * carries. `agent-book.ts` explains why that is a second namespace and not the
 * account's.
 *
 * Like `ceremony.ts`, nothing here throws, every prompt follows a press, and
 * every Mera error code becomes a sentence the reader can act on. The WebAuthn
 * client is injectable so the tests can run the real vault code against an
 * authenticator double whose PRF behaves like the real one.
 */

import {
  type PasskeyCredentialMetadata,
  createSecretVaultWithExistingPasskey,
  decryptSecretVaultWithPasskey,
  isMeraError,
} from "@category-labs/mera";

import { type Result, err, ok } from "../wallet/result";
import {
  AGENT_BOOK_FILE_KIND,
  type AgentBook,
  type SealedAgentBook,
  encodeAgentBook,
  parseAgentBook,
} from "./agent-book";
import { describeCeremonyFailure } from "./ceremony";

/** The ceremony options Mera takes besides the vault itself; `webAuthnClient` is for tests. */
type WebAuthnClientOption = Parameters<typeof decryptSecretVaultWithPasskey>[0]["webAuthnClient"];

/**
 * Seals the book with the signed-in passkey. One prompt.
 *
 * The prompt is pinned to `credential`, so a book is always sealed by the
 * passkey whose keys the page is showing, never by whichever passkey the
 * platform offers first.
 */
export async function sealAgentBook(options: {
  readonly rpId: string;
  readonly credential: PasskeyCredentialMetadata;
  readonly book: AgentBook;
  readonly now?: Date;
  readonly webAuthnClient?: WebAuthnClientOption;
}): Promise<Result<SealedAgentBook>> {
  const sealedAt = (options.now ?? new Date()).toISOString();
  const secret = encodeAgentBook({ ...options.book, updatedAt: sealedAt });
  try {
    const vault = await createSecretVaultWithExistingPasskey({
      rpId: options.rpId,
      credential: options.credential,
      secret,
      ...(options.webAuthnClient === undefined ? {} : { webAuthnClient: options.webAuthnClient }),
    });
    return ok({ kind: AGENT_BOOK_FILE_KIND, version: 1, sealedAt, vault });
  } catch (cause) {
    return err(describeBookFailure(cause, "seal"));
  } finally {
    secret.fill(0);
  }
}

/** Opens a sealed book with the passkey that sealed it. One prompt. */
export async function openAgentBook(options: {
  readonly rpId: string;
  readonly sealed: SealedAgentBook;
  readonly webAuthnClient?: WebAuthnClientOption;
}): Promise<Result<AgentBook>> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await decryptSecretVaultWithPasskey({
      rpId: options.rpId,
      vault: options.sealed.vault,
      ...(options.webAuthnClient === undefined ? {} : { webAuthnClient: options.webAuthnClient }),
    });
    const book = parseAgentBook(bytes);
    return book === undefined
      ? err("The book opened, but what was inside is not an agent book this page can read.")
      : ok(book);
  } catch (cause) {
    return err(describeBookFailure(cause, "open"));
  } finally {
    bytes?.fill(0);
  }
}

/** The sentence for a failed seal or open. Exported so the copy can be checked. */
export function describeBookFailure(cause: unknown, action: "seal" | "open"): string {
  if (isMeraError(cause)) {
    switch (cause.code) {
      case "DECRYPT_FAILED":
        return "The passkey answered, but its key does not open this book. It was sealed by a different passkey, or the file was changed after it was sealed.";
      case "VAULT_FORMAT_INVALID":
        return "This is not a sealed agent book, or it is damaged. Nothing was opened.";
      case "INPUT_INVALID":
        return action === "seal"
          ? "The book could not be sealed because the remembered passkey record is malformed. Forget it from the Connect menu and use the passkey again."
          : "This book names a passkey record this page cannot read. Nothing was opened.";
      case "PASSKEY_OPERATION_FAILED":
        if ((cause.cause as { name?: unknown } | undefined)?.name === "NotAllowedError") {
          return action === "seal"
            ? "Cancelled at the authenticator. The book was not sealed, and the last sealed copy is unchanged."
            : "The book stays sealed: the prompt was closed, or this device holds no copy of the passkey that sealed it.";
        }
        break;
      default:
        break;
    }
  }
  return describeCeremonyFailure(cause, "assert");
}
