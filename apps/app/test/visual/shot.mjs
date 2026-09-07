/**
 * One screenshot, at a chosen width and theme.
 *
 * The companion to `audit.mjs`: the audit says a route is clean, this says what
 * it looks like. It scrolls the whole page before shooting so every in-view
 * reveal has already fired, and it reports console errors on the way out,
 * because a screenshot of a page that threw still looks like a screenshot.
 *
 *   node test/visual/shot.mjs <url> <out.png> [width] [light|dark] [full]
 */

import { chromium } from "@playwright/test";

const [, , url, out, widthRaw, themeRaw, fullRaw] = process.argv;

if (!url || !out) {
  console.error("usage: node test/visual/shot.mjs <url> <out.png> [width] [light|dark] [full]");
  process.exit(2);
}

const width = Number(widthRaw ?? 1440);
const theme = themeRaw ?? "light";

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox", "--disable-gpu"],
});
const context = await browser.newContext({
  viewport: { width, height: 1000 },
  colorScheme: theme === "dark" ? "dark" : "light",
});
// Both keys: the Dashboard reads `tab-theme` from its own boot script, the docs
// site reads `theme` through next-themes.
await context.addInitScript((value) => {
  try {
    localStorage.setItem("tab-theme", value);
    localStorage.setItem("theme", value);
  } catch {}
}, theme);

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2400);
await page.evaluate(async () => {
  const step = window.innerHeight * 0.8;
  for (let y = 0; y < document.body.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 90));
  }
  window.scrollTo(0, 0);
});
await page.waitForTimeout(900);

await page.screenshot({ path: out, fullPage: fullRaw === "full" });
console.log(errors.length > 0 ? errors.slice(0, 6).join("\n") : "no console errors");
await browser.close();
