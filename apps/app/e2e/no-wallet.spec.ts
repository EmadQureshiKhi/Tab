/**
 * Every read-only route renders with no wallet.
 *
 * ## The claim under test
 *
 * The Dashboard's read-only routes resolve without a wallet connection. That is
 * an architectural claim, not a styling one, and the unit suite already
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
 * The four signing routes (`/authorise`, `/services/new`, `/services/bond` and
 * `/keys`) are excluded on purpose rather than overlooked: a wallet or a passkey
 * account is what they are for, so asserting they need none would be asserting
 * the wrong thing. `/authorise` appears below in its own case, which checks the
 * opposite: that it degrades to a stated message rather than throwing when no
 * wallet is present.
 *
 * ## Running it
 *
 * `playwright.config.ts` starts the app for the run, and `scripts/e2e.sh` at the
 * repository root supplies the browser on a host Playwright ships no build for.
 * On a supported host:
 *   pnpm --filter @tabai/app exec playwright install chromium
 *   pnpm --filter @tabai/app exec playwright test
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

/** Every read-only route, with the heading each one must render. */
const READ_ONLY_ROUTES = [
  { path: "/", heading: /Post-paid billing for autonomous agents/i },
  { path: "/browse", heading: /Tools an agent can call now/i },
  { path: "/explorer", heading: /Settlement explorer/i },
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

test("/authorise states that no wallet is available rather than throwing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await withoutWallet(page);
  await page.goto("/authorise", READY);

  // The one route that needs a wallet still has to render without one, and say so
  // when asked to act. A blank page or a thrown error is the failure mode here.
  await expect(page.getByRole("heading", { name: /Authorise a Service/i })).toBeVisible();

  // The form only exists where the deployment names a `TabBook` and the registry
  // lists a Service. Where it does not, the page states that instead, which is
  // also a render without a wallet and not a throw.
  const ceiling = page.getByLabel(/Ceiling, in/i);
  if ((await ceiling.count()) === 0) {
    await expect(page.locator("body")).toContainText(/not configured|No Service is registered|could not be read/i);
    expect(errors).toEqual([]);
    return;
  }

  await ceiling.fill("5000000");
  await page.getByRole("button", { name: /Sign the authorisation/i }).click();

  // Filtered rather than `.first()`: Next injects an empty `role="alert"` route
  // announcer into every page, so the role alone resolves to two elements and which
  // one comes first is not ours to rely on. The assertion still goes through the role,
  // because a message a screen reader would not announce has not been delivered.
  await expect(
    page.getByRole("alert").filter({ hasText: /No wallet is available/i }),
  ).toContainText(/No wallet is available/i);
  expect(errors).toEqual([]);
});

test("a malformed ceiling is refused with text tied to its own field", async ({ page }) => {
  await withoutWallet(page);
  await page.goto("/authorise", READY);

  const ceiling = page.getByLabel(/Ceiling, in/i);
  if ((await ceiling.count()) === 0) {
    test.skip(true, "this deployment names no TabBook or lists no Service, so there is no form");
    return;
  }

  await ceiling.fill("1.5");
  await page.getByRole("button", { name: /Sign the authorisation/i }).click();

  // The error has to be the field's own description, not merely text near it, or a
  // screen reader never associates the two.
  await expect(ceiling).toHaveAttribute("aria-invalid", "true");
  const describedBy = await ceiling.getAttribute("aria-describedby");
  expect(describedBy).toContain("ceiling-error");
  await expect(page.locator("#ceiling-error")).toContainText(/whole number/i);
});
