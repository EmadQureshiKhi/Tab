/**
 * Feature: tab, R24.9: every read-only route renders with no wallet
 *
 * ## The claim under test
 *
 * R24.9 says the Dashboard's read-only routes resolve without a wallet connection.
 * That is an architectural claim, not a styling one, and the unit suite already
 * asserts half of it by rendering every view to static markup in a plain Node
 * process where no provider exists. What that cannot show is the browser: a page
 * can render on the server and still, once hydrated, reach for `window.ethereum`,
 * throw, or put a connect gate in front of the content.
 *
 * So this suite loads each route in a real browser with the injected provider
 * deliberately deleted, and asserts three things per route: it renders its own
 * heading, nothing on it asks the reader to connect anything, and no uncaught error
 * reached the console. The third is the one that catches hydration reaching for a
 * provider, which is invisible to a server-side render.
 *
 * `/register` is excluded on purpose rather than overlooked. Design section 12.2
 * marks it as the one route where a wallet is required for signing, so asserting it
 * needs none would be asserting the wrong thing. It appears below in its own case,
 * which checks the opposite: that it degrades to a stated message rather than
 * throwing when no wallet is present.
 *
 * ## Not yet runnable, and why that is recorded rather than hidden
 *
 * Playwright is not a dependency of this package and this lane did not add one.
 * Installing it is one command, recorded in the report and in the task text, and
 * until then this file is a specification rather than a passing gate. Saying so is
 * the point: a spec file that quietly never runs is worse than no spec at all,
 * because the CI job name suggests coverage that does not exist.
 *
 * To run it:
 *   pnpm --filter @tabai/app add -D @playwright/test
 *   pnpm --filter @tabai/app exec playwright install chromium
 *   pnpm --filter @tabai/app exec playwright test
 *
 * Requirements: 24.9, 24.8
 */

import { expect, test, type Page } from "@playwright/test";

/**
 * Navigation waits on `domcontentloaded`, never on `networkidle`.
 *
 * The overview holds a server-sent event stream open so the settlement strip stays
 * fresh, which is the route working rather than a route hanging, and a wait for an
 * idle network therefore never returns. Playwright's own guidance says the same. It
 * costs nothing here: every assertion below auto-waits, so the heading check is what
 * establishes the page rendered, and the console check runs after it.
 */
const READY = { waitUntil: "domcontentloaded" } as const;

/** Every route R24.9 covers, with the heading each one must render. */
const READ_ONLY_ROUTES = [
  { path: "/", heading: /Post-paid billing for autonomous agents/i },
  { path: "/explorer", heading: /Settlement and proof explorer/i },
  { path: "/agents", heading: /Agents/i },
  // "Service directory", not "Services": the nav label and the page heading are
  // deliberately different words, and the heading is what a reader lands on.
  { path: "/services", heading: /Service directory/i },
  { path: "/analytics", heading: /Adoption and Bond/i },
] as const;

/** Words that would only appear if a route were gating content behind a wallet. */
const CONNECT_GATE = /connect (your )?wallet|connect to continue|please connect/i;

/**
 * Removes every injected provider before any page script runs.
 *
 * `addInitScript` runs before the document's own scripts, so this is the state the
 * page actually boots into rather than a provider deleted after the fact. Both the
 * EIP-1193 global and the EIP-6963 announcement are covered, because a page could
 * discover a wallet through either.
 */
async function withoutWallet(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "ethereum", { get: () => undefined, configurable: true });
    window.addEventListener("eip6963:requestProvider", (event) => event.stopImmediatePropagation());
  });
}

for (const route of READ_ONLY_ROUTES) {
  test(`${route.path} renders with no injected provider and shows no connect gate`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await withoutWallet(page);
    await page.goto(route.path, READY);

    await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(CONNECT_GATE);

    // Hydration is where a wallet reach-for would surface, and it is invisible to a
    // server-side render, so the console is part of the assertion rather than noise.
    expect(errors, `${route.path} logged: ${errors.join(" | ")}`).toEqual([]);
  });
}

test("the skip link is the first focusable element on every route", async ({ page }) => {
  for (const route of READ_ONLY_ROUTES) {
    await withoutWallet(page);
    await page.goto(route.path, READY);
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toContainText(/skip to content/i);
  }
});

test("/register states that no wallet is available rather than throwing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await withoutWallet(page);
  await page.goto("/register", READY);

  // The one route that needs a wallet still has to render without one, and say so
  // when asked to act. A blank page or a thrown error is the failure mode here.
  await expect(page.getByRole("heading", { name: /Bind an address/i })).toBeVisible();
  await page.getByLabel(/Agent address on Creditcoin/i).fill(`0x${"11".repeat(20)}`);
  // Named for the Source Chain rather than by the looser /Address on/, which also
  // matches "Agent address on Creditcoin" and so resolves to two fields at once.
  await page.getByLabel(/Address on Ethereum/i).fill(`0x${"22".repeat(20)}`);
  await page.getByRole("button", { name: /Request a binding nonce/i }).click();

  // Filtered rather than `.first()`: Next injects an empty `role="alert"` route
  // announcer into every page, so the role alone resolves to two elements and which
  // one comes first is not ours to rely on. The assertion still goes through the role,
  // because a message a screen reader would not announce has not been delivered.
  await expect(
    page.getByRole("alert").filter({ hasText: /No wallet is available/i }),
  ).toContainText(/No wallet is available/i);
  expect(errors).toEqual([]);
});

test("a malformed address is refused with text tied to its own field", async ({ page }) => {
  await withoutWallet(page);
  await page.goto("/register", READY);

  const agent = page.getByLabel(/Agent address on Creditcoin/i);
  await agent.fill("not-an-address");
  await page.getByRole("button", { name: /Request a binding nonce/i }).click();

  // The error has to be the field's own description, not merely text near it, or a
  // screen reader never associates the two.
  await expect(agent).toHaveAttribute("aria-invalid", "true");
  const describedBy = await agent.getAttribute("aria-describedby");
  expect(describedBy).toContain("agent-error");
  await expect(page.locator("#agent-error")).toContainText(/40 hexadecimal/i);
});
