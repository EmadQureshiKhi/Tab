/**
 * `tab-keeper`: the executable entry point.
 *
 *   once [--broadcast] [--json]   judge every tab, simulate the markable ones, and
 *                                 send the marks only with --broadcast
 *   serve                         the HTTP surface on KEEPER_PORT
 *
 * `once` is a dry run unless told otherwise, for the reason every other
 * spending command in this workspace is: a mark spends this process's gas, and
 * a command that spends by default is a command somebody runs to see what it
 * does. `--json` puts the report on stdout and nothing else there, so the
 * command is scriptable; everything a person reads goes to stderr.
 */

import { serve } from "@hono/node-server";
import { JsonRpcProvider, Wallet } from "ethers";

import { createChainReader } from "./chain.js";
import { loadKeeperConfig, requireKeeperKey, type KeeperConfig } from "./config.js";
import { walkDeliveryFeed } from "./feed.js";
import { createEthersMarker } from "./marker.js";
import { createKeeperApp } from "./server.js";
import { runTick, type TickDeps, type TickReport } from "./tick.js";

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** The dependencies one process shares between `once` and `serve`. */
function depsFor(config: KeeperConfig, broadcast: boolean): { deps: TickDeps; canBroadcast: boolean; keeper: string | undefined } | { failure: string } {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true, batchMaxCount: 1 });
  let signer: Wallet | undefined;
  if (broadcast) {
    const key = requireKeeperKey(config);
    if (!key.ok) return { failure: `${key.error.code}: ${key.error.message}` };
    signer = new Wallet(key.value, provider);
  }
  return {
    deps: {
      chain: createChainReader({ rpcUrl: config.rpcUrl }),
      walkFeed: () => walkDeliveryFeed({ registryUrl: config.registryUrl, maxPages: config.maxFeedPages }),
      marker: createEthersMarker({ provider, tabBook: config.tabBook, signer }),
      tabBook: config.tabBook,
      serviceRegistry: config.serviceRegistry,
    },
    canBroadcast: signer !== undefined,
    keeper: signer?.address,
  };
}

function render(report: TickReport): void {
  err("");
  err(`Block ${report.at.blockNumber} at ${new Date(report.at.timestamp * 1000).toISOString()}`);
  err(`  candidates  ${report.candidates} distinct tabs from ${report.feed.rows} deliveries over ${report.feed.pages} page${report.feed.pages === 1 ? "" : "s"}`);
  err(`  overdue     ${report.overdue.length}`);
  err(`  pending     ${report.pending.length}`);
  for (const action of report.actions) {
    const suffix =
      action.outcome === "marked"
        ? `tx ${action.txHash ?? "?"}`
        : action.outcome === "skipped"
          ? `(${action.reason ?? "?"})`
          : action.outcome === "failed"
            ? `${action.error?.code ?? "?"}: ${action.error?.message ?? ""}`
            : "";
    err(`  ${action.outcome.padEnd(10)} ${action.tabId} ${suffix}`);
  }
  if (!report.broadcast && report.actions.some((action) => action.outcome === "would-mark")) {
    err("");
    err("Dry run. Nothing was sent. Add --broadcast to mark them; that spends gas in MON.");
  }
}

async function commandOnce(flags: ReadonlySet<string>): Promise<number> {
  const config = loadKeeperConfig();
  if (!config.ok) {
    err(`keeper: ${config.error.code}: ${config.error.message}`);
    return 2;
  }
  const broadcast = flags.has("--broadcast");
  const built = depsFor(config.value, broadcast);
  if ("failure" in built) {
    err(`keeper: ${built.failure}`);
    return 2;
  }
  const report = await runTick(built.deps, { broadcast });
  if (!report.ok) {
    err(`keeper: ${report.error.code}: ${report.error.message}`);
    return 1;
  }
  if (flags.has("--json")) out(JSON.stringify(report.value, null, 2));
  else render(report.value);
  return report.value.actions.some((action) => action.outcome === "failed") ? 1 : 0;
}

async function commandServe(): Promise<number> {
  const config = loadKeeperConfig();
  if (!config.ok) {
    err(`keeper: ${config.error.code}: ${config.error.message}`);
    return 2;
  }
  // The server broadcasts when it has a key and refuses when it does not, so a
  // read-only deployment is the same binary with one variable unset.
  const built = depsFor(config.value, config.value.keeperKey !== undefined);
  if ("failure" in built) {
    err(`keeper: ${built.failure}`);
    return 2;
  }
  const app = createKeeperApp({
    deps: built.deps,
    sharedSecret: config.value.sharedSecret,
    canBroadcast: built.canBroadcast,
    chainId: config.value.chainId,
  });
  serve({ fetch: app.fetch, port: config.value.port });
  err(`keeper: serving on port ${config.value.port}; broadcast ${built.canBroadcast ? `enabled as ${built.keeper ?? "?"}` : "disabled (KEEPER_PRIVATE_KEY unset)"}; POST /tick ${config.value.sharedSecret === undefined ? "refused (KEEPER_SHARED_SECRET unset)" : "protected"}`);
  return 0;
}

const HELP = `tab-keeper - the permissionless markDelinquent cranker

Usage
  pnpm --filter @tabai/keeper once [--broadcast] [--json]
  pnpm --filter @tabai/keeper serve

Environment
  MONAD_RPC_URL, MONAD_CHAIN_ID, TAB_BOOK_ADDRESS, SERVICE_REGISTRY_ADDRESS
  NEXT_PUBLIC_REGISTRY_API_URL     the registry read API; /deliveries names the candidate tabs
  KEEPER_PRIVATE_KEY               read only when a mark is sent
  KEEPER_PORT, KEEPER_SHARED_SECRET, KEEPER_MAX_FEED_PAGES
`;

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  const flags = new Set(argv.slice(1));
  switch (command) {
    case "once":
      return commandOnce(flags);
    case "serve":
      return commandServe();
    case undefined:
    case "help":
    case "--help":
      err(HELP);
      return 0;
    default:
      err(`keeper: \`${command}\` is not a command`);
      err(HELP);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
