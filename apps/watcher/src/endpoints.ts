/**
 * Endpoint rotation (R20.11, design section 8.9).
 *
 * At least two RPC endpoints are configured per Source Chain. After
 * `WATCHER_ENDPOINT_FAILURE_THRESHOLD` consecutive failures on the active one the
 * Watcher moves to the next configured endpoint and resets the counter. The count
 * survives a restart through `endpoint_health`, so a known-bad endpoint is not
 * handed a clean slate by a process bounce.
 *
 * ## Why rotation, and not narrowing, is the answer on Mainnet
 *
 * Measured: `drpc` served a 125-block `eth_getLogs` window, refused 250, and then
 * refused a one-block request with the identical message minutes later. The
 * observation window already narrows on a width refusal, and a refusal at the
 * one-block floor is what stops a scan. Narrowing cannot recover from an endpoint
 * that has simply stopped serving, and that is the case rotation exists for: the
 * scan asks the rotation to move on, resets its window, and retries the same chunk
 * against the next endpoint. Only when every endpoint has been tried does the scan
 * stop.
 *
 * ## The rule is a pure state machine, and the wiring is around it
 *
 * `recordFailure` and `recordSuccess` are pure functions of a state; the
 * persisted rotation wraps them with a store callback. Providers are built lazily
 * per endpoint through the same constructor everything else uses, so batching
 * stays off and the network stays pinned on every endpoint.
 *
 * Requirements: 20.11
 */

import type { JsonRpcProvider } from "ethers";

import { err, ok, type ChainKey, type Result } from "@tabai/shared";

import { createJsonRpcProvider } from "./rpc.js";

export interface RotationState {
  readonly chainKey: ChainKey;
  readonly endpoints: readonly string[];
  readonly activeIndex: number;
  readonly consecutiveFailures: number;
  readonly threshold: number;
  /** How many times the active endpoint has changed since construction. */
  readonly rotations: number;
}

/** What one failure did to the state. */
export interface RotationStep {
  readonly state: RotationState;
  readonly rotated: boolean;
}

/** Builds the initial state. `activeUrl` and `failures` come from `endpoint_health` when persisted. */
export function createRotationState(
  chainKey: ChainKey,
  endpoints: readonly string[],
  threshold: number,
  activeUrl?: string,
  failures = 0,
): Result<RotationState> {
  if (endpoints.length === 0) {
    return err({
      category: "VALIDATION",
      code: "NO_ENDPOINTS",
      message: `chainKey ${chainKey} has no configured endpoint to rotate across`,
      retryable: false,
    });
  }
  if (threshold < 1) {
    return err({
      category: "VALIDATION",
      code: "ENDPOINT_THRESHOLD_INVALID",
      message: `WATCHER_ENDPOINT_FAILURE_THRESHOLD is ${threshold}; it must be at least 1`,
      retryable: false,
    });
  }
  const activeIndex = activeUrl === undefined ? 0 : Math.max(0, endpoints.indexOf(activeUrl));
  return ok({
    chainKey,
    endpoints,
    activeIndex,
    consecutiveFailures: Math.max(0, failures),
    threshold,
    rotations: 0,
  });
}

/** The active endpoint's URL. */
export const activeEndpoint = (state: RotationState): string =>
  state.endpoints[state.activeIndex] ?? state.endpoints[0] ?? "";

/** A success clears the counter; the endpoint stays. */
export function recordSuccess(state: RotationState): RotationState {
  return state.consecutiveFailures === 0 ? state : { ...state, consecutiveFailures: 0 };
}

/** A failure counts, and the threshold moves the active endpoint on. */
export function recordFailure(state: RotationState): RotationStep {
  const failures = state.consecutiveFailures + 1;
  if (failures < state.threshold || state.endpoints.length < 2) {
    return { state: { ...state, consecutiveFailures: failures }, rotated: false };
  }
  return { state: rotate(state), rotated: true };
}

/** Moves to the next endpoint unconditionally, wrapping, and resets the counter. */
export function rotate(state: RotationState): RotationState {
  if (state.endpoints.length < 2) return { ...state, consecutiveFailures: 0 };
  return {
    ...state,
    activeIndex: (state.activeIndex + 1) % state.endpoints.length,
    consecutiveFailures: 0,
    rotations: state.rotations + 1,
  };
}

/** Where the rotation is written. `endpoint_health` in production; a recorder in tests. */
export interface RotationStore {
  record(chainKey: ChainKey, endpointUrl: string, consecutiveFailures: number, active: boolean): Promise<Result<void>>;
}

/** The rotation as the rest of the Watcher uses it. */
export interface EndpointRotation {
  readonly chainKey: ChainKey;
  readonly endpoints: readonly string[];
  state(): RotationState;
  active(): string;
  /** Records a failure. Resolves true when the active endpoint changed. */
  failed(): Promise<boolean>;
  /**
   * Records a failure **without moving**, resolving true once the threshold is met.
   *
   * The scan needs counting and moving as two steps rather than one, because it has
   * to rebuild its readers at the moment the endpoint changes and `failed()` changes
   * it in the same breath as counting it. So the scan calls this, and calls
   * {@link EndpointRotation.moveOn} itself when this says the threshold is reached.
   */
  noteFailure(): Promise<boolean>;
  succeeded(): Promise<void>;
  /** Moves on regardless of the counter. Resolves true when there was another endpoint to move to. */
  moveOn(): Promise<boolean>;
}

/**
 * Wraps the state machine with persistence. Every transition is written for both
 * the endpoint that lost the active flag and the one that gained it, so
 * `endpoint_health` never shows two active endpoints for one chain.
 */
export function createEndpointRotation(initial: RotationState, store?: RotationStore): EndpointRotation {
  let state = initial;

  const persist = async (previous: RotationState): Promise<void> => {
    if (store === undefined) return;
    const before = activeEndpoint(previous);
    const after = activeEndpoint(state);
    if (before !== after) await store.record(state.chainKey, before, 0, false);
    await store.record(state.chainKey, after, state.consecutiveFailures, true);
  };

  return {
    chainKey: initial.chainKey,
    endpoints: initial.endpoints,
    state: () => state,
    active: () => activeEndpoint(state),
    async failed() {
      const previous = state;
      const step = recordFailure(state);
      state = step.state;
      await persist(previous);
      return step.rotated;
    },
    async noteFailure() {
      const previous = state;
      const failures = state.consecutiveFailures + 1;
      state = { ...state, consecutiveFailures: failures };
      await persist(previous);
      // A single configured endpoint has nowhere to move, so the threshold is never
      // "reached" in the sense the caller acts on: there is nothing to act on.
      return failures >= state.threshold && state.endpoints.length > 1;
    },
    async succeeded() {
      const previous = state;
      state = recordSuccess(state);
      if (previous.consecutiveFailures !== 0) await persist(previous);
    },
    async moveOn() {
      if (state.endpoints.length < 2) return false;
      const previous = state;
      state = rotate(state);
      await persist(previous);
      return true;
    },
  };
}

/** Providers per endpoint, built on first use so an unused endpoint costs nothing. */
export interface RotatingProviders {
  /** The provider for the rotation's currently active endpoint. */
  provider(): JsonRpcProvider;
  destroy(): void;
}

export function createRotatingProviders(
  rotation: EndpointRotation,
  chainId: number,
  batchMaxCount: number,
): RotatingProviders {
  const providers = new Map<string, JsonRpcProvider>();
  return {
    provider() {
      const url = rotation.active();
      const existing = providers.get(url);
      if (existing !== undefined) return existing;
      const created = createJsonRpcProvider(url, chainId, batchMaxCount);
      providers.set(url, created);
      return created;
    },
    destroy() {
      for (const provider of providers.values()) provider.destroy();
      providers.clear();
    },
  };
}
