/**
 * A consumer's config file: mechanism three, with no application code.
 *
 * Written as `.mjs` rather than `.ts` so a plain Node process loads it, which is
 * the case the loader has to keep working for. The entry is a module specifier,
 * resolved from this file rather than from inside `@tabai/sdk`.
 */

export default {
  strategies: ["./strategy-plugin.mjs"],
};
