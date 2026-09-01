/**
 * A config naming a package that is not installed. The loader has to say which
 * specifier failed and from which config file, because "cannot find module" on its
 * own tells a consumer nothing about where to look.
 */

export default {
  strategies: ["@acme/tab-strategy-nowhere"],
};
