/**
 * Which browsers can make a passkey account at all.
 *
 * Three things have to hold: WebAuthn, discoverable credentials, and the PRF
 * extension. The first is a property of the browser and can be read before
 * any prompt. The other two are properties of the authenticator the reader
 * picks in the prompt, and are only known once a ceremony has run and either
 * returned 32 bytes or not. So `webAuthnAvailable` is a fact this page can
 * state up front, and the list below is what to say when the ceremony comes
 * back without a PRF: not "try again" but which stacks are known to work.
 *
 * The list is the Mera authenticator-support table as published at
 * mera.category.xyz, restated rather than linked. It is a snapshot; a stack
 * missing from it is untested, not refused.
 */

/** True where a ceremony can be attempted. PRF support is only known after one runs. */
export function webAuthnAvailable(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential === "undefined") return false;
  const credentials = (navigator as { credentials?: { create?: unknown; get?: unknown } }).credentials;
  return typeof credentials?.create === "function" && typeof credentials?.get === "function";
}

export interface AuthenticatorSupport {
  readonly authenticator: string;
  readonly where: string;
}

/** Stacks with a confirmed PRF create-and-get cycle, from the Mera support table. */
export const SUPPORTED_AUTHENTICATORS: readonly AuthenticatorSupport[] = [
  { authenticator: "1Password", where: "any browser with 1Password active, any OS" },
  { authenticator: "iCloud Keychain", where: "Safari, Chrome or Firefox on macOS 15 or later; Safari or Chrome on iOS 18 or later" },
  { authenticator: "Google Password Manager", where: "Chrome or Edge on Android; Chrome on desktop when signed in to Google" },
  { authenticator: "Windows Password Manager", where: "Edge, Chrome or Firefox on Windows 11 25H2 or later" },
  { authenticator: "YubiKey 5 series", where: "Chrome on desktop, firmware 5.2 or later" },
  { authenticator: "Proton Pass", where: "Chrome on desktop" },
];

/** Stacks known to create a passkey that returns no PRF, so the account cannot be made. */
export const UNSUPPORTED_AUTHENTICATORS: readonly AuthenticatorSupport[] = [
  { authenticator: "Chrome's local profile", where: "desktop Chrome when the passkey is not saved to Google Password Manager" },
  { authenticator: "Bitwarden", where: "Chrome on desktop" },
  { authenticator: "Dashlane", where: "Chrome on desktop" },
];
