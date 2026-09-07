/**
 * Playwright, configured for the one thing this suite exists to prove: every
 * read-only route resolves in a real browser with no wallet present.
 *
 * ## Why the browser is named explicitly
 *
 * `playwright install` refuses on this machine, because Playwright ships no build
 * for Ubuntu 26.04 and validates the host before it will hand over a browser. The
 * download itself is fine; what is missing is five shared libraries the sandbox has
 * no root to install. So the browser and its libraries are provided from outside,
 * and `scripts/e2e.sh` at the repository root is what supplies them. Running
 * `playwright test` directly, without that script, will fail to launch and the
 * failure will look like a Playwright bug rather than a host one.
 *
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE` names the binary. Left unset, Playwright looks
 * where it normally would, which is what a supported host should do.
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
  // the Creditcoin RPC enforces a ten-second query timeout that parallel scans make
  // worse rather than better.
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
    // No sandbox: this runs under WSL with no user namespaces available, and the
    // pages under test are served from this machine.
    launchOptions: {
      args: ["--no-sandbox", "--disable-gpu"],
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
