/**
 * The published directory, read from the repository root.
 *
 * `service-endpoints.json` is this project's, committed beside the code, and it
 * is the only source of where a registered Service can be called and of what a
 * Service says about x402 and the API Hub. Two pages read it, so the read lives
 * here once and the narrowing lives in `catalogue.ts` where it can be tested
 * without a filesystem.
 *
 * A missing or malformed file is not an error worth failing a page for: every
 * price on either page is chain state and stands without it. The catalogue
 * renders with no run commands and each row says why it has none.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parsePublishedDirectory, type PublishedService } from "./catalogue.js";

/** Where the directory sits relative to the app's working directory. */
export function publishedDirectoryPath(cwd: string): string {
  return join(cwd, "..", "..", "service-endpoints.json");
}

export async function readPublishedDirectory(
  path: string = publishedDirectoryPath(process.cwd()),
): Promise<readonly PublishedService[]> {
  try {
    return parsePublishedDirectory(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return [];
  }
}
