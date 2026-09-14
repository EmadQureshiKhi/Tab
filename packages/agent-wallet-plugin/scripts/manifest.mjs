#!/usr/bin/env node
/**
 * Writes `oclif.manifest.json`, which an `mm` plugin must ship.
 *
 * The template's build step is `oclif manifest`. The `oclif` CLI that provides
 * it pins Node 22 and pulls the AWS SDK in for its release commands, none of
 * which a manifest needs, so this does what that command does for a plugin with
 * no JIT plugins: load the package through `@oclif/core`'s `Plugin`, which reads
 * every command class under `oclif.commands`, and write its manifest beside
 * `package.json`. The output is the same document `oclif manifest` writes.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin } from "@oclif/core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "oclif.manifest.json");

if (existsSync(file)) unlinkSync(file);

const plugin = new Plugin({
  errorOnManifestCreate: true,
  ignoreManifest: true,
  respectNoCacheDefault: true,
  root,
  type: "core",
});
await plugin.load();
if (!plugin.valid) {
  console.error("manifest: @oclif/core could not load this package as a plugin");
  process.exit(1);
}
const ids = Object.keys(plugin.manifest.commands).sort();
if (ids.length === 0) {
  console.error("manifest: no commands were found under dist/commands; run tsc first");
  process.exit(1);
}
writeFileSync(file, `${JSON.stringify(plugin.manifest, null, 2)}\n`);
console.log(`manifest: wrote ${ids.length} commands (${ids.join(", ")}) to oclif.manifest.json`);
