/**
 * Next.js configuration for the Dashboard.
 *
 * Deliberately almost empty. The theme is configured in CSS by Tailwind v4, the
 * routes are App Router defaults, and every read goes through the registry API
 * over plain `fetch`, so there is no bundler special-casing to do here.
 *
 * `typedRoutes` stays off because route hrefs are built by the chain toggle from
 * a chainKey, which is a runtime value; a typed-route check would reject a string
 * it cannot see the shape of and buy nothing.
 *
 * The `eslint` key that stood here is gone. Next 16 dropped `next lint` and now
 * rejects the key outright, so every build printed two warning lines about an
 * option that no longer did anything. It was only ever `ignoreDuringBuilds: true`,
 * which asked the build not to run a linter this package does not configure, so
 * removing it changes no behaviour and removes the noise. Linting here is
 * `pnpm lint`, which is the contrast check.
 *
 * Requirements: 24.8, 24.9
 */

/** @type {import("next").NextConfig} */
const config = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: false },
};

export default config;
