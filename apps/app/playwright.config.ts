/**
 * Playwright, configured for the one thing this suite exists to prove: every
 * read-only route resolves in a real browser with no wallet present.
 *
 * ## Where the browser comes from
 *
 * On a host Playwright supports, `playwright install chromium` provides the
 * browser and nothing else is needed. On a Linux release Playwright ships no
 * build for, `scripts/e2e.sh` at the repository root fetches one and the shared
 * libraries it needs without root, and names the binary through
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Left unset, Playwright looks where it
 * normally would.
 *
 * ## Why the server is started here
 *
 * `webServer` builds and serves the app for the run and tears it down afterwards, so
 * the suite has no external precondition to forget. It reuses an already-running
 * server outside CI, because a rebuild per run makes the suite something nobody runs
 * locally.
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3070);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  // One worker: the routes share one registry read API and one chain endpoint, and
  // the public Monad RPC caps `eth_getLogs` at a hundred blocks per request, so
  // parallel scans of the overdue-tab section make the run slower, not faster.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // No GPU: the suite asserts structure and console output, never pixels, and a
    // headless run on a CI runner has no GPU to offer.
    launchOptions: {
      args: ["--disable-gpu"],
      ...(executablePath === undefined ? {} : { executablePath }),
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
