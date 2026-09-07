/**
 * Visual audit: every route, at three widths, in both themes.
 *
 * This is not a screenshot-diff suite. It asserts the two things that were
 * actually breaking during the presentation work and that no unit test can see:
 *
 *   - the document never scrolls sideways. A 66-character transaction hash or a
 *     42-character address that cannot wrap runs the page past the viewport, and
 *     on a phone that is the whole layout ruined. When a route does overflow the
 *     audit walks the tree and names the deepest element responsible, because
 *     "the page is 198px too wide" is not an actionable finding on its own.
 *   - the console stays quiet. React #418 hydration mismatches reached this
 *     product three separate times, each from a client-only preference read
 *     during the first render, and each was invisible in a screenshot.
 *
 * It needs a server already running (`pnpm --filter @tabai/app dev`) and a
 * Chromium that Playwright can launch. Point `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
 * at one when the bundled download will not run on the host distribution.
 *
 *   node test/visual/audit.mjs [origin]
 *
 * Exits non-zero on the first route that is not clean, and prints every route it
 * checked either way, so a passing run is evidence rather than silence.
 */

import { chromium } from "@playwright/test";

const ORIGIN = process.argv[2] ?? "http://127.0.0.1:3000";

/**
 * A settlement and an Agent that the local index actually holds. Detail routes
 * are where the long identifiers live, so auditing only the list routes would
 * miss the class of bug this exists to catch.
 */
const ROUTES = [
  "/",
  "/browse",
  "/explorer",
  "/explorer/0x00000000000000010000000000b1c07c000000000000005d0000000000000000",
  "/agents",
  "/agents/0x1f6f797edc2eecb02bd54009b805fb2e99f80542",
  "/services",
  "/services/new",
  "/services/bond",
  "/analytics",
  "/register",
];

const WIDTHS = [390, 768, 1440];
const THEMES = ["light", "dark"];

/**
 * The deepest element whose right edge sits past the viewport and is not clipped.
 *
 * Ancestors of an overflowing element overflow too, so reporting the outermost
 * one always names `<body>` and says nothing. Depth-first, keeping the last hit,
 * names the element a person can go and fix.
 *
 * The walk stops at anything that clips its own overflow, because
 * `getBoundingClientRect` reports an element's layout box whether or not it is
 * visible: a decorative glow sitting deliberately outside an `overflow-hidden`
 * card measures as 54px past the viewport and, being deep, wins the search every
 * time. It cannot scroll the document, so it is not the finding. Skipping those
 * subtrees is what makes the answer the element actually responsible.
 */
function findOverflow() {
  const limit = document.documentElement.clientWidth;
  let worst = null;
  const walk = (node, depth) => {
    for (const el of node.children) {
      const box = el.getBoundingClientRect();
      const past = Math.round(box.right - limit);
      if (past > 1 && box.width > 0) {
        worst = {
          past,
          depth,
          tag: el.tagName.toLowerCase(),
          className: typeof el.className === "string" ? el.className.slice(0, 160) : "",
          text: (el.textContent ?? "").trim().slice(0, 60),
        };
      }
      const clipped = getComputedStyle(el).overflowX !== "visible";
      if (!clipped) walk(el, depth + 1);
    }
  };
  walk(document.body, 0);
  return { scrollWidth: document.documentElement.scrollWidth, clientWidth: limit, worst };
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox", "--disable-gpu"],
});

let failures = 0;

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      colorScheme: theme,
    });
    // The boot script reads this before first paint, so it has to be in place
    // before the document loads rather than toggled afterwards.
    await context.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch {}
      },
      ["tab-theme", theme],
    );

    for (const route of ROUTES) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
      });

      await page.goto(`${ORIGIN}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2200);
      // Scroll the whole page so every in-view reveal has fired. A section that
      // is still at its entry transform has not been measured yet.
      await page.evaluate(async () => {
        const step = window.innerHeight * 0.8;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 80));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(600);

      const report = await page.evaluate(findOverflow);
      const wide = report.scrollWidth - report.clientWidth > 1;
      const label = `${theme.padEnd(5)} ${String(width).padStart(4)} ${route}`;

      if (!wide && errors.length === 0) {
        console.log(`ok   ${label}`);
      } else {
        failures += 1;
        console.log(`FAIL ${label}`);
        if (wide) {
          console.log(
            `       overflows by ${report.scrollWidth - report.clientWidth}px` +
              (report.worst
                ? `: <${report.worst.tag} class="${report.worst.className}"> ${report.worst.past}px past, text ${JSON.stringify(report.worst.text)}`
                : ""),
          );
        }
        for (const error of errors.slice(0, 4)) console.log(`       ${error}`);
      }

      await page.close();
    }

    await context.close();
  }
}

await browser.close();

console.log(failures === 0 ? "\nall routes clean" : `\n${failures} route(s) not clean`);
process.exit(failures === 0 ? 0 : 1);
