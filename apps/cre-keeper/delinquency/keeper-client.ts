/**
 * The two HTTP calls this workflow makes, written for the node-level context.
 *
 * Each function takes a `SendRequester`, which the HTTP client's high-level
 * `sendRequest(runtime, fn, aggregation)` hands to `fn` on every node, and
 * returns a plain value the consensus step can compare. Only types are imported
 * from the SDK here, so these functions run under Node with a fake requester;
 * the SDK's runtime surface loads only inside the WASM build.
 *
 * ## One request per DON, not one per node
 *
 * Every node executes an HTTP request by default. `GET /overdue` recomputes
 * its verdicts at the latest block on each call, so two nodes a block apart
 * would disagree and identical-consensus would fail the tick. `POST /tick`
 * sends transactions, so two nodes would send twice. Both requests therefore
 * carry `cacheSettings`: the first node's response is stored and the rest read
 * it, which is the SDK's own pattern for non-idempotent and time-varying calls.
 */

import { err, ok, type Result } from "@tabai/shared";
import type { HTTPSendRequester } from "@chainlink/cre-sdk";

import { decideMarks, parseOverdue, type MarkDecision, type OverdueSnapshot } from "./overdue.js";

/** The response fields these functions read. `body` is bytes inside WASM and base64 on the JSON side. */
export interface HttpResponseLike {
  readonly statusCode: number;
  readonly body: Uint8Array | string;
}

/** The little of `SendRequester` this module uses, so a test can fake it. */
export interface RequesterLike {
  sendRequest(input: {
    readonly url: string;
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly timeout?: string;
    readonly cacheSettings?: { readonly store?: boolean; readonly maxAge?: string };
  }): { result: () => HttpResponseLike };
}

type Assert<T extends true> = T;
type RequesterIsAccepted = Assert<HTTPSendRequester extends RequesterLike ? true : false>;
export type SendRequesterAcceptsHost = RequesterIsAccepted;

/** What a tick sends to `POST /tick` and what it reads back. */
export interface TickRequest {
  readonly tabIds: readonly string[];
}

export interface TickAction {
  readonly tabId: string;
  readonly outcome: string;
  readonly reason?: string;
  readonly txHash?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface TickOutcome {
  readonly statusCode: number;
  readonly broadcast: boolean;
  readonly at: { readonly blockNumber: number; readonly timestamp: number };
  readonly actions: readonly TickAction[];
  readonly notMarkable: readonly string[];
}

/** The outcome of the read, as the consensus step compares it: the decision, not the block. */
export interface OverdueRead {
  readonly decision: MarkDecision;
  readonly candidates: number;
  readonly overdueCount: number;
  readonly pendingCount: number;
}

const decodeBody = (body: Uint8Array | string): string =>
  typeof body === "string" ? Buffer.from(body, "base64").toString("utf8") : new TextDecoder().decode(body);

const parseJson = (text: string): Result<unknown> => {
  try {
    return ok(JSON.parse(text));
  } catch (error) {
    return err({ category: "UPSTREAM", code: "KEEPER_NOT_JSON", message: `the keeper did not answer with JSON: ${error instanceof Error ? error.message : String(error)}`, retryable: true });
  }
};

const base = (keeperUrl: string): string => keeperUrl.replace(/\/+$/, "");

/**
 * `GET /overdue`, decided.
 *
 * Returns the decision rather than the snapshot so the value the nodes agree
 * on carries no block number: the same set of markable tabs read a block apart
 * is the same decision, and identical aggregation accepts it.
 */
export function fetchOverdue(
  requester: RequesterLike,
  options: { readonly keeperUrl: string; readonly timeout: string; readonly maxMarks: number },
): Result<OverdueRead> {
  const response = requester
    .sendRequest({
      url: `${base(options.keeperUrl)}/overdue`,
      method: "GET",
      headers: { accept: "application/json" },
      timeout: options.timeout,
      cacheSettings: { store: true, maxAge: "60s" },
    })
    .result();
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return err({ category: "UPSTREAM", code: "KEEPER_OVERDUE_STATUS", message: `GET /overdue answered HTTP ${response.statusCode}`, retryable: true });
  }
  const body = parseJson(decodeBody(response.body));
  if (!body.ok) return body;
  const snapshot = parseOverdue(body.value);
  if (!snapshot.ok) return snapshot;
  return ok(readOf(snapshot.value, options.maxMarks));
}

/** The read as the consensus step compares it, split out so a test can build one without a requester. */
export const readOf = (snapshot: OverdueSnapshot, maxMarks: number): OverdueRead => ({
  decision: decideMarks(snapshot, { maxMarks }),
  candidates: snapshot.candidates,
  overdueCount: snapshot.overdue.length,
  pendingCount: snapshot.pendingCount,
});

/** `POST /tick` with the shared secret, asking the keeper to mark exactly these tabs. */
export function postTick(
  requester: RequesterLike,
  options: { readonly keeperUrl: string; readonly timeout: string; readonly secret: string; readonly tabIds: readonly string[] },
): Result<TickOutcome> {
  const payload: TickRequest = { tabIds: [...options.tabIds] };
  const response = requester
    .sendRequest({
      url: `${base(options.keeperUrl)}/tick`,
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.secret}` },
      body: Buffer.from(new TextEncoder().encode(JSON.stringify(payload))).toString("base64"),
      timeout: options.timeout,
      // Longer than a tick takes, so a second node reads the first node's answer
      // rather than sending the marks again. The system-wide ceiling is ten minutes.
      cacheSettings: { store: true, maxAge: "600s" },
    })
    .result();
  const text = decodeBody(response.body);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const body = parseJson(text);
    const detail = body.ok && typeof body.value === "object" && body.value !== null ? JSON.stringify((body.value as { error?: unknown }).error ?? body.value) : text;
    return err({
      category: response.statusCode === 403 ? "AUTHORISATION" : "UPSTREAM",
      code: response.statusCode === 403 ? "KEEPER_SECRET_REJECTED" : "KEEPER_TICK_STATUS",
      message: `POST /tick answered HTTP ${response.statusCode}: ${detail}`,
      retryable: response.statusCode >= 500,
    });
  }
  const body = parseJson(text);
  if (!body.ok) return body;
  const record = body.value as { broadcast?: unknown; at?: unknown; actions?: unknown; notMarkable?: unknown };
  if (!Array.isArray(record.actions) || typeof record.at !== "object" || record.at === null) {
    return err({ category: "UPSTREAM", code: "KEEPER_TICK_MALFORMED", message: "POST /tick answered without actions", retryable: true });
  }
  return ok({
    statusCode: response.statusCode,
    broadcast: record.broadcast === true,
    at: record.at as TickOutcome["at"],
    actions: record.actions as TickAction[],
    notMarkable: Array.isArray(record.notMarkable) ? (record.notMarkable as string[]) : [],
  });
}
