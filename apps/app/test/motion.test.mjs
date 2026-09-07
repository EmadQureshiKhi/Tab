/**
 * Motion may decide how a thing moves, never whether it exists.
 *
 * This is the same defect three times over, and it will be a fourth without a
 * test. `useReducedMotion()` is read during the client's first render while the
 * server had no preference to read, so any component that branches its markup on
 * it produces one tree on the server and a different one in a browser set to
 * reduce motion. React throws a hydration error and re-renders the whole tree,
 * which is expensive, and it happened on every route both times.
 *
 * The rule is narrow and mechanical: the value may reach a `transition`, a
 * `delay`, an `animate` or a `style`, and it may not decide an early `return` or
 * sit in a JSX conditional. Anything that needs to change shape waits for a
 * `mounted` flag instead, which is identical on the server and on first paint.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Resolved from this file rather than from the working directory, so the rule
// holds wherever the suite is invoked from.
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = [join(PACKAGE, "components"), join(PACKAGE, "app")];

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith(".tsx")) {
      found.push(path);
    }
  }
  return found;
}

/** Package-relative, so a failure names a path a reader can open. */
function relative(path) {
  return path.slice(PACKAGE.length + 1);
}

/** Strips comments, so a rule described in prose is not read as a violation. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("no component branches its markup on the reduced-motion preference", () => {
  const offenders = [];

  for (const root of ROOTS) {
    for (const path of sourceFiles(root)) {
      const code = withoutComments(readFileSync(path, "utf8"));
      if (!code.includes("useReducedMotion")) continue;

      // `if (reduced) return null` and friends: the component disappears.
      //
      // Only a return that yields markup counts. An effect that bails with
      // `return undefined` is the correct way to skip work under the preference,
      // and both the scroll smoother and the split heading do exactly that.
      if (/if\s*\([^)]*reduced[^)]*\)\s*return\s*(null|<|\()/.test(code)) {
        offenders.push(`${relative(path)}: an early return depends on the preference`);
      }
      // `{reduced ? <a/> : <b/>}` and `{!reduced ? <a/> : null}`: the tree changes.
      if (/\{\s*!?reduced[^}]*\?\s*\(?\s*</.test(code)) {
        offenders.push(`${relative(path)}: a JSX conditional depends on the preference`);
      }
      // `initial={reduced ? ... }`: Motion writes `initial` into the server's
      // style attribute, so branching it is a mismatch even though it looks like
      // an animation value rather than markup.
      if (/initial=\{[^}]*reduced/.test(code)) {
        offenders.push(`${relative(path)}: \`initial\` depends on the preference`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `the preference must decide how a thing moves, never whether it exists:\n  ${offenders.join("\n  ")}`,
  );
});
