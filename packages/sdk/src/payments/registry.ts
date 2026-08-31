/**
 * Strategy registration and resolution: mechanisms one and two of R23.6.
 *
 * One implementation serves both. A registry is a keyed set of strategies with an
 * optional parent it falls back to:
 *
 * - **Constructor injection.** `createStrategyRegistry({ strategies: [...] })`
 *   is what a client wrapper builds from its own options, so a consumer passes
 *   strategies in and never touches global state. Its parent is the module-level
 *   registry by default, so injection adds to what is already registered instead
 *   of hiding it.
 * - **The module-level registry.** `registerPaymentStrategy(strategy)` writes to
 *   one process-wide registry, which is what a plugin package needs: it
 *   self-registers on import and the consumer's only line is the import.
 *
 * ## Why the module-level state hangs off `globalThis`
 *
 * A plugin package that self-registers on import may resolve a *different copy*
 * of `@tabai/sdk` than the application does — different versions, a nested
 * `node_modules`, a bundled duplicate. With module-scoped state each copy gets
 * its own registry, the plugin registers into a registry the application never
 * reads, and the failure is silent: the strategy simply never resolves. So the
 * state lives under a versioned `Symbol.for` key on `globalThis` and every copy
 * of this module wraps the same `Map`. Only the shared state is global; the
 * behaviour is each copy's own.
 *
 * ## Idempotence, and what replacement means
 *
 * `register` is keyed by `strategy.id`:
 *
 * - the same object again is a no-op — `unchanged`, no warning, no reordering;
 * - a *different* object under a live id replaces it **in its original
 *   position** and warns through the logger rather than throwing (design section
 *   9.3), because a strategy replaced at the back of the queue would silently
 *   change which strategy resolves for every other Asset too;
 * - anything else appends.
 *
 * Order matters because resolution order is registration order, so the operation
 * has to be idempotent in the ordering as well as in the membership. `Map.set`
 * on a live key keeps the key's insertion position, which is exactly this rule.
 *
 * ## Resolution order
 *
 * An explicit `strategyId` wins. Otherwise the first strategy whose
 * `supports(asset)` returns true, in registration order, own entries before the
 * parent's (design section 9.3). A named strategy that does not support the Asset
 * is an error rather than a silent fall-through to another one: a caller that
 * named a strategy meant it.
 *
 * Requirements: 23.6, 21.5
 */

import { ok, type Result } from "@tabai/shared";
import { defaultLogger, type Logger } from "../logger.js";
import { notFoundError, validationError } from "../errors.js";
import {
  assetKey,
  supportsAsset,
  validatePaymentStrategy,
  type AssetRef,
  type PaymentStrategy,
} from "./strategy.js";

/** What `register` did. `unchanged` is the idempotent case. */
export type RegistrationAction = "registered" | "replaced" | "unchanged";

export interface StrategyRegistration {
  readonly action: RegistrationAction;
  readonly strategy: PaymentStrategy;
  /** The strategy that was displaced, on `replaced` alone. */
  readonly previous?: PaymentStrategy;
}

/** What resolution is given: the Asset that must be settled, and an optional override. */
export interface StrategyQuery {
  readonly asset: AssetRef;
  readonly strategyId?: string;
}

export interface StrategyRegistry {
  register(strategy: PaymentStrategy): Result<StrategyRegistration>;
  /** Removes a strategy from *this* registry. Never reaches into the parent. */
  unregister(id: string): boolean;
  /** Empties *this* registry. Never reaches into the parent. */
  clear(): void;
  /** This registry's own strategies in registration order, then the parent's. */
  list(): readonly PaymentStrategy[];
  get(id: string): PaymentStrategy | undefined;
  resolve(query: StrategyQuery): Result<PaymentStrategy>;
}

export interface StrategyRegistryOptions {
  /** Registered in array order at construction. Mechanism one. */
  readonly strategies?: readonly PaymentStrategy[];
  readonly logger?: Logger;
  /**
   * The registry to fall back to. Omitted means the module-level registry;
   * `false` means an isolated registry, which is what the module-level registry
   * itself is and what a test wants.
   */
  readonly inherit?: StrategyRegistry | false;
}

/** Versioned so a future state-shape change cannot be misread by an older copy. */
const MODULE_STATE_KEY = Symbol.for("@tabai/sdk.paymentStrategies.v1");

interface ModuleState {
  readonly version: 1;
  readonly strategies: Map<string, PaymentStrategy>;
}

function moduleState(): ModuleState {
  const host = globalThis as typeof globalThis & { [MODULE_STATE_KEY]?: ModuleState };
  const existing = host[MODULE_STATE_KEY];
  if (existing !== undefined && existing.version === 1) return existing;
  const created: ModuleState = { version: 1, strategies: new Map() };
  host[MODULE_STATE_KEY] = created;
  return created;
}

/**
 * Builds a registry.
 *
 * Construction cannot fail, so it does not return a `Result`. An invalid entry in
 * `strategies` is refused and reported through the logger, and the registry comes
 * back holding the valid ones — a consumer's typo in one strategy should not take
 * out the strategies that were fine. Use {@link StrategyRegistry.register}
 * directly when the caller wants the `Result` for each one.
 */
export function createStrategyRegistry(options: StrategyRegistryOptions = {}): StrategyRegistry {
  const logger = options.logger ?? defaultLogger;
  const own = new Map<string, PaymentStrategy>();
  const registry = registryOver(own, logger, () => resolveParent(options.inherit));

  for (const strategy of options.strategies ?? []) {
    const outcome = registry.register(strategy);
    if (!outcome.ok) {
      logger.error("payment strategy rejected at construction", {
        code: outcome.error.code,
        message: outcome.error.message,
      });
    }
  }
  return registry;
}

/** The process-wide registry mechanism two writes to. */
export function moduleStrategyRegistry(logger?: Logger): StrategyRegistry {
  return registryOver(moduleState().strategies, logger ?? defaultLogger, () => undefined);
}

/**
 * Registers a strategy process-wide. Idempotent by `strategy.id`.
 *
 * This is the whole of mechanism two: a plugin package calls it at import time,
 * and the consumer's only line is `import "@acme/tab-strategy-solana"`.
 */
export function registerPaymentStrategy(
  strategy: PaymentStrategy,
  options: { readonly logger?: Logger } = {},
): Result<StrategyRegistration> {
  return moduleStrategyRegistry(options.logger).register(strategy);
}

/** Removes a process-wide registration. Returns false when the id was not registered. */
export const unregisterPaymentStrategy = (id: string): boolean =>
  moduleStrategyRegistry().unregister(id);

/** Every process-wide registration, in registration order. */
export const listPaymentStrategies = (): readonly PaymentStrategy[] =>
  moduleStrategyRegistry().list();

/** Empties the process-wide registry. Present for hosts that rebuild their world. */
export const clearPaymentStrategies = (): void => moduleStrategyRegistry().clear();

/** Resolves against the process-wide registry alone. */
export const resolvePaymentStrategy = (query: StrategyQuery): Result<PaymentStrategy> =>
  moduleStrategyRegistry().resolve(query);

function resolveParent(inherit: StrategyRegistry | false | undefined): StrategyRegistry | undefined {
  if (inherit === false) return undefined;
  if (inherit !== undefined) return inherit;
  return moduleStrategyRegistry();
}

/**
 * The one registry implementation, over a `Map` it does not own.
 *
 * `parent` is a thunk so the module-level registry can be the default parent
 * without this function forcing it into existence at construction time, which
 * would make the load order of two modules matter.
 */
function registryOver(
  own: Map<string, PaymentStrategy>,
  logger: Logger,
  parent: () => StrategyRegistry | undefined,
): StrategyRegistry {
  const registry: StrategyRegistry = {
    register(candidate) {
      const validated = validatePaymentStrategy(candidate);
      if (!validated.ok) return validated;
      const strategy = validated.value;
      const previous = own.get(strategy.id);

      if (previous === strategy) {
        return ok({ action: "unchanged", strategy });
      }
      if (previous !== undefined) {
        // Map.set keeps the key's original insertion position, so the replacement
        // inherits the displaced strategy's place in the resolution order.
        own.set(strategy.id, strategy);
        logger.warn("payment strategy replaced an earlier registration of the same id", {
          strategyId: strategy.id,
          chainKeys: strategy.chainKeys.map((chainKey) => chainKey.toString(10)),
        });
        return ok({ action: "replaced", strategy, previous });
      }
      own.set(strategy.id, strategy);
      return ok({ action: "registered", strategy });
    },

    unregister: (id) => own.delete(id),

    clear: () => own.clear(),

    list() {
      const inherited = parent()?.list() ?? [];
      const merged = [...own.values()];
      for (const strategy of inherited) {
        if (!own.has(strategy.id)) merged.push(strategy);
      }
      return merged;
    },

    get(id) {
      return own.get(id) ?? parent()?.get(id);
    },

    resolve(query) {
      const candidates = registry.list();
      const onThrow = (strategyId: string) => (error: unknown) =>
        logger.warn("payment strategy supports() threw and was read as unsupported", {
          strategyId,
          error: error instanceof Error ? error.message : String(error),
        });

      if (query.strategyId !== undefined) {
        const named = registry.get(query.strategyId);
        if (named === undefined) {
          return notFoundError(
            "STRATEGY_NOT_FOUND",
            `no payment strategy is registered under id \`${query.strategyId}\``,
            {
              details: {
                strategyId: query.strategyId,
                registered: candidates.map((strategy) => strategy.id).join(", "),
              },
            },
          );
        }
        if (!supportsAsset(named, query.asset, onThrow(named.id))) {
          return validationError(
            "STRATEGY_ASSET_MISMATCH",
            `payment strategy \`${named.id}\` does not support asset ${assetKey(query.asset)}`,
            { details: { strategyId: named.id, asset: assetKey(query.asset) } },
          );
        }
        return ok(named);
      }

      for (const strategy of candidates) {
        if (supportsAsset(strategy, query.asset, onThrow(strategy.id))) return ok(strategy);
      }
      return notFoundError(
        "NO_STRATEGY_FOR_ASSET",
        `no registered payment strategy supports asset ${assetKey(query.asset)}`,
        {
          details: {
            asset: assetKey(query.asset),
            registered: candidates.map((strategy) => strategy.id).join(", "),
          },
        },
      );
    },
  };

  return registry;
}
