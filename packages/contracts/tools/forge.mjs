#!/usr/bin/env node
/**
 * Runs `forge` whether or not it is on `PATH`.
 *
 * ## Why this exists
 *
 * `foundryup` installs into `~/.foundry/bin` and puts that directory on `PATH`
 * by editing a shell rc file. An rc file is read by *interactive* shells, so
 * Foundry is on `PATH` in the terminal a developer types into and absent from
 * every non-interactive one - which is what npm scripts, turbo tasks, CI steps
 * and anything spawned with `sh -c` all are.
 *
 * The failure that produces is `sh: 1: forge: not found` from inside
 * `pnpm build`, on a machine where `forge --version` works when typed by hand.
 * That reads as a broken repository rather than as a missing directory on a
 * search path, and it is the first command the README asks anyone to run.
 *
 * So this resolves the binary the way the installer laid it out, in the order a
 * reader would expect: an explicit `FORGE_BIN`, then `PATH`, then the two
 * standard install locations. Every argument is forwarded untouched, and the
 * exit code is passed straight through, so `forge test` still fails the build
 * exactly as before.
 *
 *   node tools/forge.mjs build
 *   node tools/forge.mjs test --summary
 *
 * ## What it does not do
 *
 * It does not install anything, and it does not fall back to a different tool.
 * Foundry is a stated prerequisite; the only thing being fixed here is finding a
 * copy that is already on disk.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

const EXECUTABLE = platform() === "win32" ? "forge.exe" : "forge";

/** Every place to look, in order, with the reason each is on the list. */
function candidates() {
  const found = [];

  // An explicit override wins, so a non-standard install needs no code change.
  if (process.env.FORGE_BIN) found.push(process.env.FORGE_BIN);

  // PATH, which is what an interactive shell already has.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir) found.push(join(dir, EXECUTABLE));
  }

  // Where foundryup puts it, and where a Homebrew install puts it.
  found.push(join(homedir(), ".foundry", "bin", EXECUTABLE));
  found.push(join("/opt", "homebrew", "bin", EXECUTABLE));

  return found;
}

const forge = candidates().find((path) => existsSync(path));

if (forge === undefined) {
  console.error("forge: not found on PATH, in ~/.foundry/bin, or at FORGE_BIN.");
  console.error();
  console.error("Foundry is a prerequisite for the contracts package. Install it with:");
  console.error("  curl -L https://foundry.paradigm.xyz | bash && foundryup");
  console.error();
  console.error("If it is already installed somewhere else, set FORGE_BIN to the binary.");
  process.exit(127);
}

const result = spawnSync(forge, process.argv.slice(2), {
  stdio: "inherit",
  cwd: process.cwd(),
});

// A signal is not an exit code. Report it as one rather than as a silent 0.
if (result.signal) {
  console.error(`forge: terminated by ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
