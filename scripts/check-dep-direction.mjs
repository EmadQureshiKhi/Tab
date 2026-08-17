#!/usr/bin/env node
/**
 * Dependency-direction lint rule.
 *
 * The workspace graph is strictly one-way:
 *
 *   apps/*      ->  packages/*
 *   services/*  ->  packages/*
 *   examples/*  ->  packages/*
 *   packages/sdk -> packages/shared
 *   packages/shared -> nothing internal
 *
 * Every other internal edge is a violation. The rule reads each workspace
 * package.json, keeps only the edges whose target is an internal package, and
 * checks each one against the table above. It exits 1 on the first tree that
 * breaks the rule, listing every offending edge.
 *
 * Requirements: 26.4, 28.6
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INTERNAL_SCOPE = "@tabai/";
const WORKSPACE_ROOTS = ["apps", "packages", "services", "examples"];
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Zones that may draw on `packages/*`. */
const CONSUMER_ZONES = new Set(["apps", "services", "examples"]);

/** The only permitted edge inside `packages/*`, keyed by workspace directory. */
const PACKAGE_INTERNAL_EDGES = new Map([["packages/sdk", new Set(["packages/shared"])]]);

/** @returns {string[]} workspace directories relative to the repository root, slash separated */
function discoverWorkspaceDirs() {
  const dirs = [];
  for (const root of WORKSPACE_ROOTS) {
    const absoluteRoot = join(REPO_ROOT, root);
    let entries;
    try {
      entries = readdirSync(absoluteRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(absoluteRoot, entry.name, "package.json");
      try {
        if (!statSync(manifestPath).isFile()) continue;
      } catch {
        continue;
      }
      dirs.push(`${root}/${entry.name}`);
    }
  }
  return dirs.sort();
}

/**
 * @param {string} workspaceDir slash-separated directory relative to the repository root
 * @returns {{ dir: string, zone: string, name: string, manifest: Record<string, unknown> }}
 */
function loadWorkspace(workspaceDir) {
  const manifestPath = join(REPO_ROOT, ...workspaceDir.split("/"), "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const zone = workspaceDir.split("/")[0];
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error(`${workspaceDir}/package.json declares no name`);
  }
  return { dir: workspaceDir, zone, name: manifest.name, manifest };
}

/**
 * @param {{ dir: string, zone: string }} from
 * @param {{ dir: string, zone: string }} to
 * @returns {string | null} the reason the edge is rejected, or null when it is allowed
 */
function rejectionReason(from, to) {
  if (from.dir === to.dir) return "a workspace may not depend on itself";

  if (to.zone !== "packages") {
    return `only \`packages/*\` may be depended upon; \`${to.dir}\` sits in \`${to.zone}/\``;
  }

  if (CONSUMER_ZONES.has(from.zone)) return null;

  if (from.zone === "packages") {
    const allowed = PACKAGE_INTERNAL_EDGES.get(from.dir);
    if (allowed?.has(to.dir)) return null;
    return `\`${from.dir}\` may not depend on \`${to.dir}\`; the only permitted edge inside \`packages/*\` is \`packages/sdk\` -> \`packages/shared\``;
  }

  return `\`${from.zone}/\` is not a recognised workspace zone`;
}

function main() {
  const workspaceDirs = discoverWorkspaceDirs();
  if (workspaceDirs.length === 0) {
    console.error("dep-direction: found no workspace packages to check");
    process.exit(1);
  }

  const workspaces = workspaceDirs.map(loadWorkspace);
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));

  const violations = [];
  let edgeCount = 0;

  for (const from of workspaces) {
    for (const field of DEPENDENCY_FIELDS) {
      const block = from.manifest[field];
      if (block === undefined || block === null || typeof block !== "object") continue;
      for (const target of Object.keys(block)) {
        if (!target.startsWith(INTERNAL_SCOPE)) continue;
        const to = byName.get(target);
        if (to === undefined) {
          violations.push(
            `${from.dir}/package.json (${field}): \`${target}\` carries the internal scope \`${INTERNAL_SCOPE}\` but matches no workspace package`,
          );
          continue;
        }
        edgeCount += 1;
        const reason = rejectionReason(from, to);
        if (reason !== null) {
          violations.push(`${from.dir}/package.json (${field}): ${reason}`);
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `dep-direction: ${violations.length} illegal internal ${
        violations.length === 1 ? "edge" : "edges"
      } across ${workspaces.length} workspaces\n`,
    );
    for (const violation of violations) console.error(`  x ${violation}`);
    console.error(
      "\ndep-direction: the graph is one-way. apps/*, services/*, and examples/* may depend on packages/*;",
    );
    console.error(
      "dep-direction: packages/sdk may depend on packages/shared; packages/shared depends on nothing internal.",
    );
    process.exit(1);
  }

  console.log(
    `dep-direction: ok. ${edgeCount} internal ${
      edgeCount === 1 ? "edge" : "edges"
    } across ${workspaces.length} workspaces respect the one-way graph.`,
  );
  for (const workspace of workspaces) {
    console.log(`  - ${workspace.dir} (${workspace.name})`);
  }
}

main();
