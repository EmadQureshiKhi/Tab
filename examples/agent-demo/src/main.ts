/**
 * `pnpm --filter @tabai/agent-demo demo`
 *
 * Runs the story. Narration goes to stderr and the machine-readable result goes
 * to stdout, so a run can be watched by a person and piped into `jq` at the same
 * time without either getting in the other's way.
 *
 * Read-only by default. `--broadcast` is the only thing that spends anything, and
 * each act says what it would do before it does it.
 *
 * Exit codes: 0 every act made its claim, 1 an act did not, 2 the run could not
 * start.
 */

import { parseCommand, HELP } from "./story.js";
import { processDemoEnv, resolveCast } from "./cast.js";
import { createProviders } from "./chain.js";
import { processDemoSecrets } from "./secrets.js";
import { actHeader } from "./narrate.js";
import type { ActOutcome } from "./acts/index.js";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export async function main(argv: readonly string[]): Promise<number> {
  const command = parseCommand(argv);
  if (!command.ok) {
    log(`${command.error.code}: ${command.error.message}`);
    return 2;
  }
  if (command.value.help) {
    log(HELP);
    return 0;
  }

  const cast = resolveCast(processDemoEnv());
  if (!cast.ok) {
    log(`${cast.error.code}: ${cast.error.message}`);
    return 2;
  }

  const providers = createProviders(cast.value);
  const secrets = processDemoSecrets();
  const context = { cast: cast.value, providers, options: command.value.options, secrets, log };

  log("");
  log(`Tab, end to end. ${cast.value.agents[0].name} and ${cast.value.agents[1].name} trade over the rail.`);
  log(
    command.value.options.broadcast
      ? "Broadcasting. Every transaction below is real and costs real money."
      : "Read-only. Nothing below is submitted; add --broadcast when you want it to be.",
  );
  log("");

  const outcomes: ActOutcome[] = [];
  let failed = false;

  for (const act of command.value.acts) {
    log(actHeader(act.number < 0 ? 0 : act.number, act.title, act.synopsis));
    const result = await act.run(context);
    if (!result.ok) {
      failed = true;
      log(`  ${result.error.code}: ${result.error.message}`);
      outcomes.push({
        act: act.id,
        ok: false,
        broadcast: false,
        summary: result.error.message,
        detail: { error: result.error },
      });
      log("");
      // An act that could not run leaves the chain in a state the next act was not
      // written for, so the story stops here rather than reporting cascading
      // failures that all have one cause.
      break;
    }
    outcomes.push(result.value);
    if (!result.value.ok) failed = true;
    log("");
    log(`  ${result.value.ok ? "held" : "did not hold"}: ${result.value.summary}`);
    log("");
  }

  process.stdout.write(
    `${JSON.stringify({ ok: !failed, broadcast: command.value.options.broadcast, acts: outcomes }, null, 2)}\n`,
  );
  return failed ? 1 : 0;
}

// Runs when this file is the entrypoint, under `tsx src/main.ts` as well as under
// `node dist/main.js`, and stays inert when the package is imported for its types.
const entrypoint = process.argv[1] ?? "";
if (/[\\/]main\.(ts|js)$/.test(entrypoint)) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      log(`the run stopped on an unhandled error: ${String(error)}`);
      process.exitCode = 2;
    },
  );
}
