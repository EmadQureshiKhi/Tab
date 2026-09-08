/**
 * The running order, and how a command line selects from it.
 *
 * Parsing is separated from running for the usual reason: the interesting
 * behaviour is in the defaults and the refusals, and neither is worth a chain to
 * test. {@link parseOptions} and {@link selectActs} are pure functions of an
 * argument list.
 */

import type { Result } from "@tabai/shared";
import { err, ok } from "@tabai/shared";

import { authoriseAct } from "./acts/authorise.js";
import { bindAct } from "./acts/bind.js";
import { consumeAct } from "./acts/consume.js";
import { settleAct } from "./acts/settle.js";
import { smartAccountAct } from "./acts/smart-account.js";
import { stageAct } from "./acts/stage.js";
import type { Act, DemoOptions } from "./acts/index.js";

/**
 * The four acts, in order, with the stage report first and the setup act last.
 *
 * `bind` is last in the list and not in the story because it is stage-setting: it
 * runs once against a fresh deployment and never again, whereas the four acts are
 * the thing being demonstrated and are meant to be re-run.
 */
export const STORY: readonly Act[] = [stageAct, authoriseAct, consumeAct, settleAct, smartAccountAct, bindAct];

/** Defaults, all of them deliberate rather than convenient. */
export const DEFAULTS = {
  /** One unit of the priced tool, at 10,000 base units, is one hundredth of a USDC. */
  units: 1,
  /** A Settlement of 0.01 USDC. Large enough to be visible, small enough to repeat. */
  amount: 10_000n,
  /** A ceiling of 1 USDC. An authorisation is a statement of appetite, not a deposit. */
  ceiling: 1_000_000n,
  /** Thirty days. Long enough that a demo does not expire mid-run. */
  ttlSeconds: 30 * 24 * 60 * 60,
  /** Twelve minutes. Attestation lands on a ten-block stride and a proof follows it. */
  waitSeconds: 720,
} as const;

/** The parsed command line: which acts to run, and under what options. */
export interface ParsedCommand {
  readonly acts: readonly Act[];
  readonly options: DemoOptions;
  /** True when `--help` was asked for and nothing should run. */
  readonly help: boolean;
}

const flag = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const has = (argv: readonly string[], name: string): boolean => argv.includes(name);

function integer(raw: string | undefined, name: string, fallback: number): Result<number> {
  if (raw === undefined) return ok(fallback);
  if (!/^\d+$/.test(raw)) {
    return err({
      category: "VALIDATION",
      code: "DEMO_FLAG_NOT_A_NUMBER",
      message: `${name} takes a non-negative whole number, received \`${raw}\``,
      retryable: false,
    });
  }
  return ok(Number(raw));
}

function baseUnits(raw: string | undefined, name: string, fallback: bigint): Result<bigint> {
  if (raw === undefined) return ok(fallback);
  if (!/^\d+$/.test(raw)) {
    return err({
      category: "VALIDATION",
      code: "DEMO_FLAG_NOT_BASE_UNITS",
      message: `${name} takes an integer count of Asset base units, never a decimal, received \`${raw}\``,
      retryable: false,
    });
  }
  return ok(BigInt(raw));
}

/** Reads the options off an argument list. Pure. */
export function parseOptions(argv: readonly string[]): Result<DemoOptions> {
  const units = integer(flag(argv, "--units"), "--units", DEFAULTS.units);
  if (!units.ok) return units;
  if (units.value < 1) {
    return err({
      category: "VALIDATION",
      code: "DEMO_UNITS_TOO_FEW",
      message: "--units must be at least 1; buying nothing charges nothing and demonstrates nothing",
      retryable: false,
    });
  }
  const amount = baseUnits(flag(argv, "--amount"), "--amount", DEFAULTS.amount);
  if (!amount.ok) return amount;
  const ceiling = baseUnits(flag(argv, "--ceiling"), "--ceiling", DEFAULTS.ceiling);
  if (!ceiling.ok) return ceiling;
  const ttlSeconds = integer(flag(argv, "--ttl"), "--ttl", DEFAULTS.ttlSeconds);
  if (!ttlSeconds.ok) return ttlSeconds;
  const waitSeconds = integer(flag(argv, "--wait"), "--wait", DEFAULTS.waitSeconds);
  if (!waitSeconds.ok) return waitSeconds;
  const gasRaw = flag(argv, "--gas");
  const gas = gasRaw === undefined ? undefined : baseUnits(gasRaw, "--gas", 0n);
  if (gas !== undefined && !gas.ok) return gas;
  const onlyAgent = flag(argv, "--agent");

  return ok({
    broadcast: has(argv, "--broadcast"),
    units: units.value,
    amount: amount.value,
    ceiling: ceiling.value,
    ttlSeconds: ttlSeconds.value,
    waitSeconds: waitSeconds.value,
    ...(gas === undefined ? {} : { gas: gas.value }),
    ...(onlyAgent === undefined ? {} : { onlyAgent }),
  });
}

/**
 * Chooses the acts to run.
 *
 * `--act` takes an act id or a number; with none given the four story acts run in
 * order and the setup act does not, because binding is not something to repeat by
 * accident.
 */
export function selectActs(argv: readonly string[], story: readonly Act[] = STORY): Result<readonly Act[]> {
  const wanted = flag(argv, "--act");
  if (wanted === undefined) return ok(story.filter((act) => act.number >= 0));
  const trimmed = wanted.trim().toLowerCase();
  if (trimmed === "all") return ok(story.filter((act) => act.number >= 0));
  const chosen = story.find(
    (act) => act.id === trimmed || String(act.number) === trimmed,
  );
  if (chosen === undefined) {
    return err({
      category: "VALIDATION",
      code: "DEMO_NO_SUCH_ACT",
      message: `--act ${wanted} names no act; the acts are ${story.map((act) => act.id).join(", ")}`,
      retryable: false,
    });
  }
  return ok([chosen]);
}

/** The whole command line, parsed. */
export function parseCommand(argv: readonly string[], story: readonly Act[] = STORY): Result<ParsedCommand> {
  const options = parseOptions(argv);
  if (!options.ok) return options;
  const acts = selectActs(argv, story);
  if (!acts.ok) return acts;
  return ok({ acts: acts.value, options: options.value, help: has(argv, "--help") || has(argv, "-h") });
}

/** The help text, kept beside the flags it describes. */
export const HELP = `
pnpm --filter @tabai/agent-demo demo [flags]

Two agents trading over the rail end to end. Read-only unless --broadcast.

  --act <id|n|all>  one act, or all four. Acts: stage, authorise, consume,
                    settle, smart-account, and the setup act bind.
  --broadcast       submit transactions. Without it nothing is spent.
  --agent <name>    restrict to one Agent by short name.
  --units N         units of the priced tool to buy in act two. Default ${String(DEFAULTS.units)}.
  --amount N        Settlement size in Asset base units. Default ${String(DEFAULTS.amount)}.
  --ceiling N       authorisation ceiling in base units. Default ${String(DEFAULTS.ceiling)}.
  --ttl N           seconds until the authorisation expires. Default ${String(DEFAULTS.ttlSeconds)}.
  --wait N          seconds to wait for the Watcher to prove a Settlement. Default ${String(DEFAULTS.waitSeconds)}.
  --gas N           override a stated gas limit.
  --help            this text.

Exit codes: 0 every act made its claim, 1 an act did not, 2 the run could not start.
`.trim();
