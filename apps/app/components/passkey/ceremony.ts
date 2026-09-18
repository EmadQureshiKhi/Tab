/**
 * The two WebAuthn ceremonies, wrapped so nothing here throws.
 *
 * Mera runs the ceremony and throws a `MeraError` with a stable code when it
 * cannot. This file turns each code into the sentence a reader can act on,
 * because "PRF_UNAVAILABLE" tells a person nothing and "this authenticator
 * returned no PRF; these are the ones that do" tells them what to change.
 *
 * Every prompt here follows a press. Neither function is called on mount.
 */

import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  isMeraError,
  type PasskeyCredentialMetadata,
} from "@category-labs/mera";

import { type Result, err, ok } from "../wallet/result";
import { SUPPORTED_AUTHENTICATORS } from "./support";

/** The relying party name the authenticator shows beside the passkey. */
export const RP_NAME = "Tab";

/** The host this page is served from, which is the only rpId a passkey made here can have. */
export function relyingPartyId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window.location.hostname;
  return host.length > 0 ? host : undefined;
}

export interface CreatedPasskey {
  readonly credential: PasskeyCredentialMetadata;
  /** 32 bytes. Belongs to the caller, who zeroes it. */
  readonly prfOutput: Uint8Array;
}

export interface AssertedPasskey {
  readonly credentialId: string;
  readonly prfOutput: Uint8Array;
}

/** Creates a new passkey under this host and returns its first PRF output. */
export async function createPasskey(options: {
  readonly rpId: string;
  readonly label: string;
}): Promise<Result<CreatedPasskey>> {
  try {
    const created = await createPasskeyWithPrfOutput({
      rp: { id: options.rpId, name: RP_NAME },
      user: { name: options.label, displayName: options.label },
    });
    return ok({
      credential:
        created.transports === undefined
          ? { credentialId: created.credentialId }
          : { credentialId: created.credentialId, transports: created.transports },
      prfOutput: created.prfOutput,
    });
  } catch (cause) {
    return err(describeCeremonyFailure(cause, "create"));
  }
}

/**
 * Asks the authenticator for a passkey under this host and returns its PRF output.
 *
 * With a credential, the prompt is pinned to that one passkey. Without one,
 * the platform offers every passkey it holds for this host, which is how a
 * reader on a new device, where nothing is remembered, gets back in.
 */
export async function assertPasskey(options: {
  readonly rpId: string;
  readonly credential?: PasskeyCredentialMetadata | undefined;
}): Promise<Result<AssertedPasskey>> {
  try {
    const asserted = await getPasskeyPrfOutput({
      rpId: options.rpId,
      ...(options.credential === undefined ? {} : { credential: options.credential }),
    });
    return ok({ credentialId: asserted.credentialId, prfOutput: asserted.prfOutput });
  } catch (cause) {
    return err(describeCeremonyFailure(cause, "assert"));
  }
}

/** The list of working stacks, as one clause. */
export function supportedAuthenticatorsClause(): string {
  return SUPPORTED_AUTHENTICATORS.map((entry) => entry.authenticator).join(", ");
}

/** The sentence for a failed ceremony. Exported so the copy can be checked. */
export function describeCeremonyFailure(cause: unknown, ceremony: "create" | "assert"): string {
  const verb = ceremony === "create" ? "created" : "used";

  if (isMeraError(cause)) {
    switch (cause.code) {
      case "PRF_UNAVAILABLE":
        return `The passkey was ${verb}, but this authenticator returned no PRF output, so no account can be derived from it. Authenticators known to work: ${supportedAuthenticatorsClause()}. On desktop Chrome, save the passkey to Google Password Manager rather than the browser profile.`;
      case "PASSKEY_OPERATION_FAILED":
        return wasCancelled(cause.cause)
          ? "Cancelled at the authenticator. Nothing was created and nothing was signed."
          : `The browser refused the passkey ceremony${reason(cause.cause)}. WebAuthn needs a secure origin (HTTPS, or localhost) and a passkey made under this exact host.`;
      case "CRYPTO_UNAVAILABLE":
        return "This page has no Web Crypto, which usually means it is not served over HTTPS. A passkey account cannot be made here.";
      case "INPUT_INVALID":
        return "The remembered passkey record is malformed. Forget it from the Connect menu and create or use a passkey again.";
      default:
        return `The passkey could not be ${verb}: ${cause.message}`;
    }
  }

  if (cause instanceof Error && cause.message.trim().length > 0) {
    return `The passkey could not be ${verb}: ${cause.message}`;
  }
  return `The passkey could not be ${verb}, and the browser gave no reason.`;
}

/** WebAuthn reports a closed prompt as `NotAllowedError`, which is a decision rather than a fault. */
function wasCancelled(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { name?: unknown }).name === "NotAllowedError";
}

function reason(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return ` (${cause.message})`;
  return "";
}
