/**
 * The two modules copied from the Dashboard must stay identical below their
 * provenance header. Apps may not depend on apps, so the copy is the seam, and
 * this is what keeps the keeper judging a tab exactly as the page does.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const here = import.meta.dirname;
const original = (name) => resolve(here, "..", "..", "app", "src", "dashboard", name);
const copy = (name) => resolve(here, "..", "src", name);

const HEADER_LINES = 4;

for (const name of ["chain.ts", "overdue.ts"]) {
  test(`src/${name} is apps/app/src/dashboard/${name} verbatim, under a four-line provenance header`, () => {
    if (!existsSync(original(name))) return;
    const theirs = readFileSync(original(name), "utf8");
    const ours = readFileSync(copy(name), "utf8").split("\n");
    const header = ours.slice(0, HEADER_LINES);
    assert.ok(header.every((line) => line.startsWith("//")), "the header is comment lines only");
    assert.match(header[0], /Copied verbatim from `apps\/app\/src\/dashboard\//);
    assert.equal(ours.slice(HEADER_LINES).join("\n"), theirs);
  });
}
