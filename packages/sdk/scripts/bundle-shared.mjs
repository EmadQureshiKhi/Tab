/**
 * Inlines `@tabai/shared` into the published SDK.
 *
 * ## Why this exists
 *
 * `@tabai/shared` is `workspace:*`. That is correct inside the repository and
 * unpublishable outside it: npm has no `@tabai/shared`, so an install of `@tabai/sdk`
 * would fail at resolution with an error about a package nobody can look up.
 *
 * The alternatives were to publish `@tabai/shared` as a second package, or to
 * inline it. Publishing two packages to say one thing costs a second name, a
 * second release every time a constant moves, and a version skew a consumer can
 * hit without doing anything wrong: `@tabai/sdk@1.2` against `@tabai/shared@1.1` is a
 * combination nobody tested. `@tabai/shared` is replay-key packing, chain
 * constants, ABIs and a `Result` type - it has no dependencies of its own and no
 * separate audience. Inlining it means the SDK ships exactly the code it was
 * built and tested against.
 *
 * ## What it does
 *
 * `tsc` has already emitted both packages. This copies the shared build into
 * `dist/_shared/` and rewrites the specifier in every emitted file to a relative
 * path into it. Declarations and source maps are copied and rewritten the same
 * way, so a consumer's editor resolves the types to real files rather than to a
 * package that is not there.
 *
 * A bundler would also work and is not used: it would replace an exact copy of
 * the tested output with a transformation of it, and inline nothing that this
 * does not.
 *
 * ## It fails loudly
 *
 * A missing shared build, or a specifier this does not know how to rewrite, exits
 * non-zero. The failure mode being prevented is a package that publishes fine and
 * breaks on the consumer's install, so silence here is the one thing that must
 * not happen.
 */

import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(PACKAGE, "dist");
const SHARED_SRC = resolve(PACKAGE, "..", "shared", "dist");
const SHARED_DEST = join(DIST, "_shared");

/** The one specifier the SDK uses. Anything else is a change this script must see. */
const SPECIFIER = "@tabai/shared";

function fail(message) {
  console.error(`bundle-shared: ${message}`);
  process.exit(1);
}

function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

if (!existsSync(DIST)) fail("dist/ is missing. Run the build before bundling.");
if (!existsSync(join(SHARED_SRC, "index.js"))) {
  fail("packages/shared/dist/index.js is missing. Build @tabai/shared first.");
}

cpSync(SHARED_SRC, SHARED_DEST, { recursive: true });

let rewritten = 0;
for (const path of walk(DIST)) {
  if (path.startsWith(SHARED_DEST)) continue;
  if (!/\.(js|d\.ts|map)$/.test(path)) continue;

  const text = readFileSync(path, "utf8");
  if (!text.includes(SPECIFIER)) continue;

  // Relative from this file's own directory, so it is correct at every depth,
  // and always prefixed so it is read as a path rather than as a package.
  const target = relative(dirname(path), join(SHARED_DEST, "index.js"));
  const asImport = (target.startsWith(".") ? target : `./${target}`).replace(/\\/g, "/");
  const asTypes = asImport.replace(/\.js$/, ".js");

  const next = text
    .replaceAll(`"${SPECIFIER}"`, `"${asImport}"`)
    .replaceAll(`'${SPECIFIER}'`, `'${asImport}'`)
    // Inside a .map the specifier appears in the sources list as plain text.
    .replaceAll(`${SPECIFIER}`, asTypes);

  if (next.includes(SPECIFIER)) fail(`${relative(PACKAGE, path)} still names ${SPECIFIER}`);
  writeFileSync(path, next);
  rewritten += 1;
}

// A build that rewrote nothing means the SDK stopped importing shared, the
// specifier changed, or - much more likely - this ran twice over the same
// emitted output, because `tsc -b` is incremental and will not re-emit files a
// previous run already rewrote. That is why `prepack` passes `--force`: the
// rewrite has to see fresh output or it cannot tell "already inlined" from
// "never imported", and only one of those is safe to publish.
if (rewritten === 0) {
  fail(
    `no emitted file imported ${SPECIFIER}.\n` +
      `  Either the SDK stopped importing it, or dist/ was already rewritten by an\n` +
      `  earlier run and tsc had nothing to re-emit. Rebuild from scratch and retry:\n` +
      `    tsc -b --force && node scripts/bundle-shared.mjs`,
  );
}

console.log(`bundle-shared: inlined ${SPECIFIER} into ${rewritten} emitted files`);
