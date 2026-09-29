/**
 * Next.js configuration for the Dashboard.
 *
 * Deliberately almost empty. The theme is configured in CSS by Tailwind v4, the
 * routes are App Router defaults, and every read goes through the registry API
 * over plain `fetch`, so there is no bundler special-casing to do here.
 *
 * `typedRoutes` stays off because the explorer and agent routes are built from
 * runtime identifiers, and a typed-route check would reject a string it cannot
 * see the shape of and buy nothing.
 *
 * There is no `eslint` key: Next 16 has no `next lint` and rejects the key.
 * Linting here is `pnpm lint`, which is the contrast check.
 */

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
};

export default config;
