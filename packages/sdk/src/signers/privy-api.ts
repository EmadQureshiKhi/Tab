/**
 * The little of Privy's REST API an Agent's signer needs, over `fetch`.
 *
 * Every request carries Basic authentication (the app id and secret) and the
 * `privy-app-id` header. A wallet with an owner, or one whose signing is
 * delegated to an additional signer, also needs a `privy-authorization-signature`
 * on every `POST`: an ECDSA P-256 signature, base64 DER, over the RFC 8785
 * canonical JSON of `{ version: 1, method, url, body, headers }`, where
 * `headers` holds only the `privy-` headers the request sends. Privy's SDKs do
 * this for their callers; this module does it directly so the published SDK
 * gains no dependency for it.
 *
 * Nothing here logs or echoes a credential. An error carries the status,
 * Privy's own code and message, and the method that was refused, never a
 * header.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";

/** Privy's API origin. HTTPS only; Privy rejects plain HTTP. */
export const PRIVY_API_URL = "https://api.privy.io";

/** The prefix Privy's dashboard puts on an authorization private key. */
export const PRIVY_AUTHORIZATION_KEY_PREFIX = "wallet-auth:";

/** The subset of `fetch` the client calls, so a test or a host can supply its own. */
export type PrivyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/**
 * Why a Privy request failed, by name. The `name` of a {@link PrivyError} is
 * its code, so a strategy that wraps the thrown value keeps the code in the
 * `cause` it reports.
 */
export type PrivyErrorCode =
  | "PRIVY_CONFIG_INVALID"
  | "PRIVY_POLICY_DENIED"
  | "PRIVY_AUTHORIZATION_REQUIRED"
  | "PRIVY_AUTHENTICATION_FAILED"
  | "PRIVY_NOT_FOUND"
  | "PRIVY_INSUFFICIENT_FUNDS"
  | "PRIVY_BROADCAST_FAILED"
  | "PRIVY_RATE_LIMITED"
  | "PRIVY_REQUEST_REJECTED"
  | "PRIVY_UNAVAILABLE"
  | "PRIVY_RESPONSE_INVALID"
  | "PRIVY_SIGNATURE_MISMATCH"
  | "PRIVY_TRANSACTION_UNSUPPORTED"
  | "PRIVY_TRANSACTION_NOT_FOUND"
  | "PRIVY_PROVIDER_REQUIRED";

/**
 * A failed Privy request or a Privy answer the signer would not trust.
 *
 * Thrown, not returned, because it leaves an ethers `Signer`, whose contract
 * is to throw; every strategy in this package catches it at that boundary and
 * reports it as a `Result` with this error's code and message as the cause.
 */
export class PrivyError extends Error {
  readonly code: PrivyErrorCode;
  /** The HTTP status Privy answered with, when it answered. */
  readonly status: number | null;
  /** Privy's own error code, such as `policy_violation`, when it sent one. */
  readonly privyCode: string | null;
  /** Privy's own message, verbatim, when it sent one. */
  readonly privyMessage: string | null;

  constructor(
    code: PrivyErrorCode,
    message: string,
    extras: { status?: number | null; privyCode?: string | null; privyMessage?: string | null } = {},
  ) {
    super(message);
    this.name = code;
    this.code = code;
    this.status = extras.status ?? null;
    this.privyCode = extras.privyCode ?? null;
    this.privyMessage = extras.privyMessage ?? null;
  }
}

export interface PrivyApiOptions {
  readonly appId: string;
  readonly appSecret: string;
  /**
   * The authorization private key that signs each `POST`, as Privy's dashboard
   * shows it (`wallet-auth:` then base64 PKCS#8 DER) or without the prefix.
   * Needed when the wallet has an owner or signs through an additional signer.
   */
  readonly authorizationKey?: string;
  /** Defaults to {@link PRIVY_API_URL}. */
  readonly apiUrl?: string;
  readonly fetch?: PrivyFetch;
  /** Per request. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /**
   * When an authorization key signs, the request also carries
   * `privy-request-expiry` this far ahead, so a captured request cannot be
   * replayed later. Defaults to 60 seconds; 0 sends no expiry.
   */
  readonly requestTtlMs?: number;
  readonly now?: () => number;
}

/** One request, already authenticated. Throws {@link PrivyError}. */
export interface PrivyApi {
  readonly appId: string;
  readonly apiUrl: string;
  readonly signsRequests: boolean;
  get(path: string): Promise<unknown>;
  post(path: string, body: Record<string, unknown>, what: string): Promise<unknown>;
}

/**
 * Serialises JSON per RFC 8785: object keys sorted by UTF-16 code unit, no
 * whitespace, strings and numbers as ECMAScript serialises them. Only what a
 * JSON body can hold is accepted; `undefined` members are dropped, as
 * `JSON.stringify` drops them from the body that is sent.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON has no representation for a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON has no representation for a ${typeof value}`);
}

/** Reads an authorization private key, with or without Privy's `wallet-auth:` prefix. */
export function parseAuthorizationKey(key: string): KeyObject {
  const trimmed = key.trim();
  const body = trimmed.startsWith(PRIVY_AUTHORIZATION_KEY_PREFIX) ? trimmed.slice(PRIVY_AUTHORIZATION_KEY_PREFIX.length) : trimmed;
  let parsed: KeyObject;
  try {
    parsed = createPrivateKey({ key: Buffer.from(body, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new PrivyError(
      "PRIVY_CONFIG_INVALID",
      "the Privy authorization key is not a base64 PKCS#8 private key; copy it as the dashboard shows it, `wallet-auth:` prefix and all",
    );
  }
  if (parsed.asymmetricKeyType !== "ec" || parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new PrivyError("PRIVY_CONFIG_INVALID", "the Privy authorization key must be a P-256 key");
  }
  return parsed;
}

/** Checks a base64 SPKI DER public key is P-256, as Privy's `owner.public_key` and key quorums take it. */
export function isPrivyPublicKey(publicKey: string): boolean {
  try {
    const parsed = createPublicKey({ key: Buffer.from(publicKey.trim(), "base64"), format: "der", type: "spki" });
    return parsed.asymmetricKeyType === "ec" && parsed.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
  }
}

/** A fresh P-256 authorization key pair, in the forms Privy takes and shows. */
export interface PrivyAuthorizationKeyPair {
  /** `wallet-auth:` then base64 PKCS#8 DER. A credential: store it like one and never log it. */
  readonly privateKey: string;
  /** Base64 SPKI DER, for `owner.public_key` or a key quorum's `public_keys`. */
  readonly publicKey: string;
}

/** Generates a P-256 authorization key pair locally. Privy never sees the private half. */
export function generatePrivyAuthorizationKeyPair(): PrivyAuthorizationKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey: `${PRIVY_AUTHORIZATION_KEY_PREFIX}${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}`,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/**
 * The value of `privy-authorization-signature` for one request: ECDSA P-256
 * over SHA-256 of the canonical payload, DER, base64.
 */
export function privyAuthorizationSignature(
  key: KeyObject,
  request: { method: "POST" | "PATCH" | "PUT" | "DELETE"; url: string; body: unknown; headers: Record<string, string> },
): string {
  const payload = canonicalJson({ version: 1, method: request.method, url: request.url, body: request.body, headers: request.headers });
  return signBytes("sha256", Buffer.from(payload, "utf8"), key).toString("base64");
}

function hostFetch(): PrivyFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  return typeof candidate === "function" ? (candidate as PrivyFetch) : undefined;
}

/** Privy's error body, read leniently: it has carried `error`, `code` and `message` in different shapes. */
function readErrorBody(text: string): { code: string | null; message: string | null } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const trimmed = text.trim();
    return { code: null, message: trimmed.length === 0 ? null : trimmed.slice(0, 300) };
  }
  if (typeof body !== "object" || body === null) return { code: null, message: null };
  const record = body as Record<string, unknown>;
  const nested = typeof record["error"] === "object" && record["error"] !== null ? (record["error"] as Record<string, unknown>) : undefined;
  const code = [record["code"], record["error_code"], nested?.["code"]].find((candidate) => typeof candidate === "string") as string | undefined;
  const message = [typeof record["error"] === "string" ? record["error"] : undefined, record["message"], nested?.["message"]].find(
    (candidate) => typeof candidate === "string",
  ) as string | undefined;
  return { code: code ?? null, message: message ?? null };
}

const AUTHORIZATION_CODES = new Set([
  "missing_or_empty_authorization_header",
  "zero_correct_authorization_signatures",
  "insufficient_correct_authorization_signatures",
  "incorrect_quantity_of_authorization_signatures",
  "request_expired",
  "no_valid_user_session_keys",
  "user_session_keys_expired",
]);

/** Maps one failed answer to the error the signer throws. `what` names the request, such as `personal_sign`. */
export function privyErrorFor(status: number, text: string, what: string, context: { walletId?: string } = {}): PrivyError {
  const { code, message } = readErrorBody(text);
  const said = message === null ? "" : `: ${message}`;
  const on = context.walletId === undefined ? "" : ` for wallet ${context.walletId}`;
  const extras = { status, privyCode: code, privyMessage: message };
  if (code === "policy_violation" || (status >= 400 && status < 500 && message !== null && /\bpolic(y|ies)\b/i.test(message))) {
    return new PrivyError("PRIVY_POLICY_DENIED", `Privy's policy refused ${what}${on}${said}`, extras);
  }
  if (code !== null && AUTHORIZATION_CODES.has(code)) {
    return new PrivyError(
      "PRIVY_AUTHORIZATION_REQUIRED",
      `Privy wants a valid authorization signature for ${what}${on} (${code}); set the authorization key of the wallet's signer${said}`,
      extras,
    );
  }
  if (code === "insufficient_funds") {
    return new PrivyError("PRIVY_INSUFFICIENT_FUNDS", `the wallet cannot pay for ${what}${on}${said}`, extras);
  }
  if (code === "transaction_broadcast_failure") {
    return new PrivyError("PRIVY_BROADCAST_FAILED", `Privy could not broadcast ${what}${on}, and nothing was sent${said}`, extras);
  }
  if (status === 401 || status === 403) {
    return new PrivyError("PRIVY_AUTHENTICATION_FAILED", `Privy did not accept the app id and secret for ${what}${on} (HTTP ${status})${said}`, extras);
  }
  if (status === 404) return new PrivyError("PRIVY_NOT_FOUND", `Privy knows no such resource for ${what}${on}${said}`, extras);
  if (status === 429) return new PrivyError("PRIVY_RATE_LIMITED", `Privy is rate limiting ${what}${on}${said}`, extras);
  if (status >= 500) return new PrivyError("PRIVY_UNAVAILABLE", `Privy failed ${what}${on} (HTTP ${status})${said}`, extras);
  return new PrivyError("PRIVY_REQUEST_REJECTED", `Privy rejected ${what}${on} (HTTP ${status}${code === null ? "" : `, ${code}`})${said}`, extras);
}

/**
 * Builds the authenticated client. Throws {@link PrivyError} with
 * `PRIVY_CONFIG_INVALID` for missing credentials or an unreadable key; the
 * public factories call it inside a `Result`.
 */
export function createPrivyApi(options: PrivyApiOptions): PrivyApi {
  const appId = typeof options.appId === "string" ? options.appId.trim() : "";
  const appSecret = typeof options.appSecret === "string" ? options.appSecret.trim() : "";
  if (appId.length === 0) throw new PrivyError("PRIVY_CONFIG_INVALID", "a Privy app id is required (PRIVY_APP_ID)");
  if (appSecret.length === 0) throw new PrivyError("PRIVY_CONFIG_INVALID", "a Privy app secret is required (PRIVY_APP_SECRET)");
  const apiUrl = (options.apiUrl ?? PRIVY_API_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(apiUrl)) {
    throw new PrivyError("PRIVY_CONFIG_INVALID", "the Privy API URL must be https, or plain http on the loopback for a local test double");
  }
  const key = options.authorizationKey === undefined || options.authorizationKey.trim().length === 0 ? undefined : parseAuthorizationKey(options.authorizationKey);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const requestTtlMs = options.requestTtlMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const basic = `Basic ${Buffer.from(`${appId}:${appSecret}`, "utf8").toString("base64")}`;

  const send = async (method: "GET" | "POST", path: string, body: Record<string, unknown> | undefined, what: string): Promise<unknown> => {
    const transport = options.fetch ?? hostFetch();
    if (transport === undefined) throw new PrivyError("PRIVY_UNAVAILABLE", "this host has no global fetch, so Privy cannot be reached");
    const url = `${apiUrl}${path}`;
    const privyHeaders: Record<string, string> = { "privy-app-id": appId };
    if (method === "POST" && key !== undefined && requestTtlMs > 0) {
      privyHeaders["privy-request-expiry"] = String(now() + requestTtlMs);
    }
    const headers: Record<string, string> = { authorization: basic, "content-type": "application/json", ...privyHeaders };
    if (method === "POST" && key !== undefined) {
      headers["privy-authorization-signature"] = privyAuthorizationSignature(key, { method, url, body: body ?? {}, headers: privyHeaders });
    }
    let response: { status: number; text(): Promise<string> };
    try {
      response = await transport(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PrivyError("PRIVY_UNAVAILABLE", `Privy did not answer ${what}: ${reason}`);
    }
    const text = await response.text().catch(() => "");
    const walletId = /^\/v1\/wallets\/([^/]+)/.exec(path)?.[1];
    if (response.status < 200 || response.status >= 300) {
      throw privyErrorFor(response.status, text, what, walletId === undefined ? {} : { walletId: decodeURIComponent(walletId) });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PrivyError("PRIVY_RESPONSE_INVALID", `Privy answered ${what} with something that is not JSON`, { status: response.status });
    }
  };

  return {
    appId,
    apiUrl,
    signsRequests: key !== undefined,
    get: (path) => send("GET", path, undefined, `GET ${path}`),
    post: (path, body, what) => send("POST", path, body, what),
  };
}
