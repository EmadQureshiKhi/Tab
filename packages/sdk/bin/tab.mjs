#!/usr/bin/env node
/**
 * The `tab` executable.
 *
 * A thin shim over `runCli`, and thin on purpose: the CLI is ordinary library
 * code in `src/cli/`, which is what lets the tests drive every command in
 * process with an injected environment and injected input and output, instead of
 * spawning a shell and parsing what comes back.
 *
 * The shim owns three things the library deliberately does not: reading
 * `process.argv`, setting the exit code, and the last-resort handler. Nothing in
 * `runCli` throws, so the `catch` is a backstop for a bug in this file or a
 * failure to load the build at all.
 */

import { runCli } from "../dist/cli/main.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`tab: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
