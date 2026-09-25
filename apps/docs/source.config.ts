/**
 * The documentation source.
 *
 * Frontmatter and `meta.json` are validated against Fumadocs' own schemas rather
 * than a hand-written one, so a page missing a title fails the build instead of
 * rendering an untitled entry in the sidebar.
 */

import { defineConfig, defineDocs, frontmatterSchema, metaSchema } from "fumadocs-mdx/config";

export const docs = defineDocs({
  docs: { schema: frontmatterSchema },
  meta: { schema: metaSchema },
});

export default defineConfig();
