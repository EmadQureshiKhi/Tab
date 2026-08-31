/**
 * `tab.config.ts` discovery: mechanism three of R23.6.
 *
 * Zero-code wiring. A consumer writes a config file naming strategies as module
 * specifiers, and the strategies register themselves at startup with no
 * application code involved at all:
 *
 * ```ts
 * // tab.config.ts, at the consumer's project root
 * import { defineTabConfig } from "@tabai/sdk";
 * export default defineTabConfig({ strategies: ["@acme/tab-strategy-solana"] });
 * ```
 *
 * ## What an entry may be
 *
 * A module specifier, a strategy object, or a factory returning one. The
 * specifier form is the point of the mechanism; the other two exist because a
 * config file that can only name packages forces a consumer to publish one before
 * they can try anything.
 *
 * ## Where a specifier resolves from
 *
 * From the **config file**, not from this package. `@acme/tab-strategy-solana` is
 * the consumer's dependency and under pnpm it is not visible from inside
 * `@tabai/sdk` at all, so resolving relative to this module would fail for the
 * exact layout the workspace uses. `createRequire(configFileUrl)` resolves the
 * way the consumer's own `import` would, and a bare specifier that resolution
 * misses is retried as a plain dynamic import before the error is reported.
 *
 * ## The `.ts` config file and the host runtime
 *
 * This module imports the config file; it does not compile it. A `.ts` config
 * loads under a runtime that strips types — `tsx`, `node --experimental-strip-types`,
 * a bundler's dev server — and fails under one that does not. That failure comes
 * back as a `Result` naming the file and the requirement rather than as a stack
 * trace, and `tab.config.js` and `tab.config.mjs` are discovered too so a
 * consumer with a plain Node process has a first-class option.
 *
 * Requirements: 23.6, 21.5
 */

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { causeOf, ok, wrap, wrapSync, type Result } from "@tabai/shared";
import { defaultLogger, type Logger } from "../logger.js";
import { notFoundError, validationError } from "../errors.js";
import { validatePaymentStrategy, type PaymentStrategy } from "./strategy.js";
import {
  moduleStrategyRegistry,
  type StrategyRegistration,
  type StrategyRegistry,
} from "./registry.js";

/**
 * A factory in a config file, so a strategy that needs a signer can be built lazily.
 *
 * Returning `undefined` is a supported answer and means "not available in this
 * environment". That is what keeps every read on this rail keyless: the whole
 * point of a factory rather than an object is that a config file can declare a
 * strategy that only exists once a signing key does, and `tab_discover`,
 * `tab_status` and `doctor` never need one. A declining factory is skipped, and
 * the rest of the config - the Agent, the registry URL, the Service endpoints -
 * is kept.
 */
export type PaymentStrategyFactory = () =>
  | PaymentStrategy
  | undefined
  | Promise<PaymentStrategy | undefined>;

/** A module specifier, a ready strategy, or a factory returning one. */
export type TabConfigStrategyEntry = string | PaymentStrategy | PaymentStrategyFactory;

/**
 * One Service's off-chain coordinates.
 *
 * The chain records who operates a Service, what its tools cost and where it
 * collects Settlements. It records no URL, deliberately: an endpoint moves, and
 * a registry that pinned one would either go stale or need a write every time a
 * Service redeployed. So the endpoint is configuration, and this is where a
 * consumer states it.
 *
 * Without an entry here, `tab_discover` reports the Service with a null endpoint
 * and `tab_call` refuses it by name rather than inventing a URL.
 */
export interface TabServiceEntry {
  /** The Service's 32-byte registry key, as `tab_discover` reports it. */
  readonly serviceId: string;
  /** A label for a person. Defaults to the ascii the serviceId decodes to. */
  readonly name?: string;
  /** Absolute base URL `tab_call` sends requests to. */
  readonly endpoint: string;
  /**
   * Headers sent with every call to this Service.
   *
   * A record for a Service that gates on something fixed, such as an API key. A
   * function for one that gates on something per request: the reference metering
   * gateway, for instance, requires a claim over the method, the path, the Agent
   * and the tool, which no static header can satisfy. Tab defines neither scheme
   * and validates neither -- this is the seam through which a Service's own
   * access control stays the Service's own.
   *
   * Never a Tab credential. The Tab identity headers are added by the 402 client
   * and nothing in Tab authenticates an Agent with a bearer token.
   */
  readonly headers?: Readonly<Record<string, string>> | ServiceHeaderProvider;
}

/** Builds the per-request headers one Service requires. See {@link TabServiceEntry.headers}. */
export type ServiceHeaderProvider = (
  request: ServiceHeaderRequest,
) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

/** What the provider is told about the call it is producing headers for. */
export interface ServiceHeaderRequest {
  readonly method: string;
  /** The absolute URL the request is going to. */
  readonly url: string;
  /** The tool name as the caller gave it, before it is packed into a 32-byte key. */
  readonly tool: string;
  /** The Agent the call is metered against. */
  readonly agent: string;
  readonly serviceId: string;
}

export interface TabConfig {
  readonly strategies?: readonly TabConfigStrategyEntry[];
  /**
   * The Agent's Creditcoin address: whose Open Tab a metered call lands on.
   *
   * An address and never a key. Nothing in this package derives an address from
   * a private key, because doing so would mean a config file that holds one.
   */
  readonly agent?: string;
  /** Absolute base URL of the Tab registry read API, which serves discovery and status. */
  readonly registryUrl?: string;
  /** Where each Service can be reached. See {@link TabServiceEntry}. */
  readonly services?: readonly TabServiceEntry[];
}

/**
 * Types a config file's default export. Identity at runtime — its whole job is to
 * make a typo in the config a compile error in the consumer's editor.
 */
export const defineTabConfig = (config: TabConfig): TabConfig => config;

/**
 * The file names discovery looks for, in order. `.ts` first because it is the
 * documented form and the one that type-checks; the plain-JavaScript forms follow
 * so a consumer whose runtime strips no types is not shut out.
 */
export const TAB_CONFIG_FILE_NAMES = [
  "tab.config.ts",
  "tab.config.mts",
  "tab.config.mjs",
  "tab.config.js",
  "tab.config.cjs",
] as const;

export interface FindTabConfigOptions {
  /** Where the walk starts. Defaults to the working directory. */
  readonly cwd?: string;
  readonly fileNames?: readonly string[];
}

/**
 * Walks from `cwd` towards the filesystem root and returns the first config file
 * found, or `undefined` when there is none.
 *
 * Absence is not an error: the whole point of the mechanism is that a consumer
 * who wants nothing from it writes nothing.
 */
export function findTabConfig(options: FindTabConfigOptions = {}): Result<string | undefined> {
  return wrapSync(
    () => {
      const fileNames = options.fileNames ?? TAB_CONFIG_FILE_NAMES;
      let directory = resolvePath(options.cwd ?? ".");
      for (;;) {
        for (const fileName of fileNames) {
          const candidate = resolvePath(directory, fileName);
          if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
        const parent = dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
      }
    },
    (error) => ({
      category: "INTERNAL",
      code: "CONFIG_SEARCH_FAILED",
      message: "the tab.config search could not read the filesystem",
      retryable: false,
      cause: causeOf(error),
    }),
  );
}

export interface LoadTabConfigOptions extends FindTabConfigOptions {
  /** An explicit config file. Absolute, or relative to `cwd`. Missing is an error. */
  readonly configPath?: string;
  /**
   * Where the discovered strategies are registered. Omitted means the
   * module-level registry, which is what makes the mechanism zero-code; `false`
   * loads and validates without registering anything.
   */
  readonly registry?: StrategyRegistry | false;
  readonly logger?: Logger;
}

export interface LoadedTabConfig {
  /** The file that was loaded, or `undefined` when none was found. */
  readonly path: string | undefined;
  readonly config: TabConfig;
  readonly strategies: readonly PaymentStrategy[];
  /** Empty when `registry` was `false`. */
  readonly registrations: readonly StrategyRegistration[];
}

const EMPTY_CONFIG: TabConfig = {};

/**
 * Loads a config file, resolves every strategy entry, and registers the result.
 *
 * Returns a `Result` for every failure, including a config file that throws on
 * import: a consumer's config is consumer code, and this package does not turn
 * their mistake into an unhandled rejection.
 */
export async function loadTabConfig(
  options: LoadTabConfigOptions = {},
): Promise<Result<LoadedTabConfig>> {
  const logger = options.logger ?? defaultLogger;

  const located = locateConfig(options);
  if (!located.ok) return located;
  const path = located.value;

  if (path === undefined) {
    return ok({ path: undefined, config: EMPTY_CONFIG, strategies: [], registrations: [] });
  }

  const imported = await importModule(path, `tab config \`${path}\``);
  if (!imported.ok) return imported;

  const config = readDefaultExport(imported.value, path);
  if (!config.ok) return config;

  const strategies: PaymentStrategy[] = [];
  let declined = 0;
  for (const [index, entry] of (config.value.strategies ?? []).entries()) {
    const resolved = await resolveEntry(entry, index, path);
    if (!resolved.ok) return resolved;
    // `undefined` is the factory declining, not a fault. Skip it and keep going.
    if (resolved.value === undefined) {
      declined += 1;
      continue;
    }
    strategies.push(resolved.value);
  }

  const registrations: StrategyRegistration[] = [];
  if (options.registry !== false) {
    const registry = options.registry ?? moduleStrategyRegistry(logger);
    for (const strategy of strategies) {
      const outcome = registry.register(strategy);
      if (!outcome.ok) return outcome;
      registrations.push(outcome.value);
    }
  }

  logger.debug("tab config loaded", { path, strategies: strategies.length, declined });
  return ok({ path, config: config.value, strategies, registrations });
}

function locateConfig(options: LoadTabConfigOptions): Result<string | undefined> {
  if (options.configPath === undefined) return findTabConfig(options);

  const cwd = resolvePath(options.cwd ?? ".");
  const path = isAbsolute(options.configPath)
    ? options.configPath
    : resolvePath(cwd, options.configPath);
  if (!existsSync(path)) {
    return notFoundError("CONFIG_NOT_FOUND", `no tab config file at \`${path}\``, {
      details: { path },
    });
  }
  return ok(path);
}

/** Imports a file by path. A `.ts` file needs a type-stripping runtime, so say so. */
async function importModule(path: string, label: string): Promise<Result<Record<string, unknown>>> {
  const href = pathToFileURL(path).href;
  return wrap(
    async () => (await import(href)) as Record<string, unknown>,
    (error) => ({
      category: "UPSTREAM",
      code: "CONFIG_IMPORT_FAILED",
      message: path.endsWith(".ts") || path.endsWith(".mts")
        ? `${label} could not be imported; a TypeScript config file needs a runtime that strips types, or use tab.config.mjs`
        : `${label} could not be imported`,
      retryable: false,
      details: { path },
      cause: causeOf(error),
    }),
  );
}

function readDefaultExport(module: Record<string, unknown>, path: string): Result<TabConfig> {
  const exported = module["default"];
  if (exported === undefined) {
    return validationError(
      "CONFIG_NO_DEFAULT_EXPORT",
      `\`${path}\` must default-export a config, for example \`export default defineTabConfig({ strategies: [] })\``,
      { details: { path } },
    );
  }
  if (typeof exported !== "object" || exported === null) {
    return validationError(
      "CONFIG_INVALID",
      `the default export of \`${path}\` must be an object`,
      { details: { path } },
    );
  }
  const candidate = exported as { strategies?: unknown; services?: unknown };
  if (candidate.strategies !== undefined && !Array.isArray(candidate.strategies)) {
    return validationError(
      "CONFIG_INVALID",
      `\`${path}\` declares \`strategies\` but it is not an array`,
      { details: { path } },
    );
  }
  if (candidate.services !== undefined && !Array.isArray(candidate.services)) {
    return validationError(
      "CONFIG_INVALID",
      `\`${path}\` declares \`services\` but it is not an array`,
      { details: { path } },
    );
  }
  return ok(exported as TabConfig);
}

async function resolveEntry(
  entry: TabConfigStrategyEntry,
  index: number,
  configPath: string,
): Promise<Result<PaymentStrategy | undefined>> {
  const label = `strategies[${index}] of \`${configPath}\``;

  if (typeof entry === "string") {
    const module = await importSpecifier(entry, configPath);
    if (!module.ok) return module;
    const exported = module.value["default"];
    if (exported === undefined) {
      return validationError(
        "STRATEGY_MODULE_INVALID",
        `${label}: \`${entry}\` must default-export a PaymentStrategy or a factory returning one`,
        { details: { specifier: entry } },
      );
    }
    return callIfFactory(exported, `${label} (\`${entry}\`)`);
  }

  return callIfFactory(entry, label);
}

/**
 * A strategy is an object and a factory is a function, so `typeof` separates them.
 *
 * A factory returning `undefined` is passed straight back as `undefined` rather
 * than sent to the validator, because declining is one of the two answers a
 * factory is allowed to give. A bare `undefined` written directly in the array
 * is still invalid, and still reaches the validator: that is a typo rather than
 * a decision, and nothing about it says a key was missing.
 */
async function callIfFactory(
  value: unknown,
  label: string,
): Promise<Result<PaymentStrategy | undefined>> {
  if (typeof value !== "function") return validatePaymentStrategy(value, label);

  const produced = await wrap(
    async () => (await (value as PaymentStrategyFactory)()) as unknown,
    (error) => ({
      category: "UPSTREAM",
      code: "STRATEGY_FACTORY_FAILED",
      message: `${label}: the strategy factory threw`,
      retryable: false,
      cause: causeOf(error),
    }),
  );
  if (!produced.ok) return produced;
  if (produced.value === undefined || produced.value === null) return ok(undefined);
  return validatePaymentStrategy(produced.value, label);
}

/**
 * Resolves a bare or relative specifier the way the consumer's own `import`
 * would: from the config file. Falls back to a plain dynamic import, which covers
 * a package the CommonJS resolver cannot see through its `exports` conditions.
 */
async function importSpecifier(
  specifier: string,
  configPath: string,
): Promise<Result<Record<string, unknown>>> {
  const fromConfig = wrapSync(
    () => createRequire(pathToFileURL(configPath)).resolve(specifier),
    (error) => ({
      category: "NOT_FOUND",
      code: "STRATEGY_MODULE_NOT_FOUND",
      message: `\`${specifier}\` could not be resolved from \`${configPath}\``,
      retryable: false,
      details: { specifier, configPath },
      cause: causeOf(error),
    }),
  );

  if (fromConfig.ok) {
    return importModule(fromConfig.value, `strategy module \`${specifier}\``);
  }

  return wrap(
    async () => (await import(specifier)) as Record<string, unknown>,
    (error) => ({
      category: "NOT_FOUND",
      code: "STRATEGY_MODULE_NOT_FOUND",
      message: `\`${specifier}\` could not be imported from \`${configPath}\` or resolved as a bare module`,
      retryable: false,
      details: { specifier, configPath },
      cause: causeOf(error),
    }),
  );
}
