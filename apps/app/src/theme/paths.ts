/**
 * Where the theme stylesheets live, resolved from the repository root that
 * `palette.ts` discovers.
 *
 * Requirements: 24.8, 24.10
 */

import { join } from "node:path";

/** The Dashboard workspace, relative to the repository root. */
export const APP_WORKSPACE_RELATIVE_PATH = join("apps", "app");

/** The stylesheet directory, relative to the repository root. */
export const STYLES_RELATIVE_PATH = join(APP_WORKSPACE_RELATIVE_PATH, "styles");

/** @param repositoryRoot absolute path to the repository root */
export function stylesDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, STYLES_RELATIVE_PATH);
}
