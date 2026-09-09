# Tab brand assets

Everything Tab ships as artwork: the brand marks, the icon set, and the eight generated figures the README, the whitepaper and the social card use.

This directory sits outside every workspace glob on purpose. Nothing installs it and nothing builds it.

## Brand marks, in `brand/`

| File | Format | Purpose |
| --- | --- | --- |
| `tab-logo.svg` | 1024 × 1024 pt vector, single fill | The mark for light surfaces. Solid black ink, 21.00:1 on white. |
| `tab-logo-alt.svg` | 1026 × 1026 pt vector, eight fills | The mark for dark surfaces. Six of its eight fills clear 3:1 on the dark surface. |
| `tab-logo.png` | 1024 × 1024 RGBA | Raster of the mark, 74.1 % fully transparent. |
| `tab-logo-4k.png` | 2048 × 2048 RGBA | The same mark at print and social scale. The generator reads this one. |
| `icons/favicon.ico` | icon container | Browser tab icon. |
| `icons/favicon-16x16.png`, `icons/favicon-32x32.png` | 16 / 32 | Browser tab icon at 1× and 2×. |
| `icons/apple-touch-icon.png` | 180 × 180 | Home-screen icon on iOS. |
| `icons/android-chrome-192x192.png`, `-512x512.png` | 192 / 512 | Web app manifest icons. |

Both vector marks are pure geometry: no `<text>`, no `<tspan>`, no `<title>`, no `<desc>`, no metadata block. Neither carries a string payload and neither depends on a font. That also means neither carries its own accessible name — supply one at the point of placement with `aria-label` on the `<img>`, or `role="img"` plus a `<title>` on an inlined `<svg>`, and `aria-hidden="true"` where the mark sits beside a text label that already names it.

The rasters carry no text metadata. There is no `tEXt`, `iTXt`, or `zTXt` chunk anywhere in this directory.

## Generated figures, in `readme/`

| File | Size on disk | Displayed at | Purpose |
| --- | --- | --- | --- |
| `hero-light.png` | 1920 × 472 | 960 wide | README hero for light colour schemes. Transparent outside the rounded card. |
| `hero-dark.png` | 1920 × 472 | 960 wide | The same hero for dark colour schemes. |
| `pipeline.png` | 1920 × 731 | container width | One settlement end to end, left to right, with the verification panel accented. |
| `repository.png` | 1920 × 1010 | container width | What is in this repository, by real path. |
| `attestcoin.png` | 1920 × 847 | container width | What Tab calls on the Attestcoin Protocol, with the BlockProver panel accented. |
| `credit.png` | 1920 × 865 | container width | How a Credit Limit is computed, and the three bounds on it. |
| `tree.png` | 1082 × 943 | container width | File tree with the money-handling subtree highlighted. |
| `og-card.png` | 2400 × 1260 | feed-dependent | The social card, on the documented 1.91:1 ratio. |

All eight are produced by `tools/make_readme_art.py` and are **committed**, because GitHub renders a README from the repository rather than from a build. Python is therefore a local authoring tool here and not a build or CI dependency.

### Three resolutions, not one

Three numbers govern how sharp the output is, and they are not the same number.

The layout is measured in **nominal** units — 960 wide for the README figures, 1200 × 630 for the card. Drawing happens at `SCALE = 4` nominal units per device pixel, because Pillow has no antialiased drawing primitives: a 1 px border drawn straight onto the output grid comes out either hard or blurred depending on where it lands, so it has to be supersampled and reduced.

Everything then **exports** at `EXPORT = 2` times nominal and is displayed at nominal size, so nothing is resampled up from a 1× raster on a high-density display. That still leaves a 2× reduce, which is what the hairlines need. The hero carries `width="960"` in the README so the 2× file displays at its designed size; the other five README figures are constrained by GitHub's content column.

The social card is laid out at the 1200 × 630 that Open Graph and Twitter document and ships at 2400 × 1260. Both consumers treat 1200 × 630 as a recommended **minimum** and key on the 1.91:1 ratio, and both accept well past 2400 px and 217 KiB, so the extra resolution costs nothing and is the difference between crisp and soft in a feed on a high-density display. There is no per-figure exception to remember: one drawing resolution, one export factor, eight files.

### Regenerating them

One-time bootstrap from the repository root:

```
python3 -m venv tools/.venv
tools/.venv/bin/python -m pip install -r tools/requirements.txt
```

On Windows the interpreter is `tools/.venv/Scripts/python.exe` instead. `pnpm art` resolves whichever layout the venv has, so the command is the same on both.

Then:

```
pnpm art            # regenerate and write
pnpm art:check      # report what would change, write nothing
```

`--check` exits non-zero when the committed output no longer matches what the generator produces, so drift is detectable without a reviewer comparing images by eye.

### The mark ships in its own colours

Every figure composites the real artwork straight from `brand/tab-logo-4k.png` — cropped to its alpha bounding box and reduced with LANCZOS from the 4k master, so the gradient survives. Nothing is re-traced, nothing is recoloured, and no stand-in mark exists anywhere in this repository.

An earlier draft stencilled the mark flat in the accent, cut from its own alpha channel. The argument for that was measured and real: the artwork's ink is a teal-to-blue gradient with pale cyan fills, its mean ink is `#4794AA` at 3.45:1 on white, and **35.8 % of its opaque pixels fall under 3:1** on white against 16.4 % on the dark surface.

It was still the wrong trade, because that is not the applicable test. The mark sits immediately beside the word "Tab" set as actual text at full contrast, so under WCAG 1.4.11 it is decorative and carries no information of its own — there is no ratio for it to fail. Flattening the brand's identity to satisfy a requirement that does not apply is a worse outcome than a pale fill in a decorative graphic. The stencil path is kept in the generator for anywhere a genuinely single-colour glyph is needed, and the figures do not take it.

The measurement is printed on every run by `mark_report()` rather than left in a comment, so if the artwork is ever replaced the change in legibility shows up immediately.

Sizes are expressed as multiples of the wordmark's measured cap height rather than as fixed pixel counts, so the mark stays in proportion if the type scale moves: `HERO_MARK_ZOOM = 3.0` puts the hero mark at 96 nominal pixels, and `HEADER_MARK_ZOOM = 1.9` puts the figure-header mark at 46. Both are well above the roughly 40 px floor at which a multi-hue mark stops resolving and turns to mud.

### Three colours in the chrome, and the accent is measured rather than chosen

White paper, near-black ink, and exactly one accent hue. Nothing else.

This rule governs the figure **chrome** — paper, ink, borders, connectors, accent — and not the mark, which ships as drawn.

The accent is not a taste decision. Sampling the near-opaque, saturated pixels of `brand/tab-logo-4k.png` and quantising them, the single most common ink is `#109090` — hue 180, saturation 0.89, 2.3 % of the mark's saturated pixels. That teal is the accent hue.

It reaches only 3.88:1 on white, though, which is under the 4.5:1 that body text needs. So the hue and saturation are held and the *value* is walked outward in both directions until the ratio clears, which yields `#0D7676` on white at 5.43:1 and leaves `#109090` unchanged on the dark surface at 5.04:1. That is one accent seen on two papers, not two accents.

Greys are the ink composited over the paper at a **solved** strength, not a chosen one: each one steps up from transparent and stops at the first value clearing its role's minimum against every surface it can land on, including the pale accent band. Solving rather than picking is not pedantry — the first draft of these figures used hand-picked strengths and shipped 1.50:1 hairlines and 3.61:1 subtitles, both of which looked plausible on white in isolation and neither of which survived measurement against the band.

The ink and the paper are within two points of neutral on every channel. An earlier draft used a cool-tinted near-black, and measuring the output showed 97 % of the dark hero's pixels registering as hue 210 — a third colour in all but name. They are not pure black and pure white either, because a hard black against a saturated teal reads as harsh.

Measured result, on the committed files:

| Figure | Neutral pixels | Chromatic hues present |
| --- | --- | --- |
| `hero-light.png` | 97.79 % | 165–225, from the mark's gradient |
| `hero-dark.png` | 97.04 % | 180–240, from the mark's gradient |
| `pipeline.png` | 98.64 % | 180 dominant, plus the mark |
| `repository.png` | 99.40 % | 180 dominant, plus the mark |
| `tree.png` | 98.93 % | 180 dominant, plus the mark |
| `og-card.png` | 97.19 % | 180–240, from the mark's gradient |

Hue 180 is the only chromatic hue the *chrome* uses. The spread either side of it is the mark, which is the intended exception.

### `palette.json`

`palette.json` is the Dashboard's eleven-token theme, including the five clearing-state colours. `apps/app` generates its Tailwind theme from it and a CI contrast script cross-checks every published ratio, so it remains authoritative **for the interface**.

The figures deliberately do not read it. An interface with five clearing states to distinguish needs five colours; a static figure does not, and an earlier version that used the full palette read as a chart rather than as a figure — every panel competing for attention and nothing carrying meaning. The two are separately owned and neither constrains the other.

## What the figures assert

**`pipeline.png`** — one settlement, left to right in the order it happens, in three columns. The left column only ever raises an Open Tab. The middle column is the Agent moving value with its own keys, and everything downstream of it is observation. The right column is accented, because `verifyAndEmit` returning true is the only path from an Ethereum payment to a reduced Open Tab. The footer states the removal test directly: take the precompile away and what is left is an off-chain operator signing a claim, which is the trusted facilitator the project exists to remove.

**`repository.png`** — real paths and what each is responsible for, so a reviewer can find the money logic without a tour.

**`tree.png`** — the file tree with `packages/contracts/src/` behind a pale accent band, because that is the subtree worth reading first. Contiguous highlighted rows share one band rather than stacking edges, and the bands are drawn before the connectors so the elbows land on top of them. The connectors are **drawn lines, not `|--` box-drawing characters**: those glyphs come from the reader's own monospace font and substitute into empty rectangles on a machine that lacks them, which turns the figure into noise. Its width is derived from its measured content rather than fixed, so it is narrower than the three-column figures — a tree is left-weighted by nature, and padding the prose to fill a 960-wide rectangle would be writing text to serve a layout.

## Accessibility

- Contrast is enforced before anything is written. `audit()` in the generator measures every ink against every surface it can land on and exits non-zero under the ratio its role requires, so a palette change that breaks a label fails the regeneration instead of shipping. Body and numeric text clears 4.5:1; panel boundaries, connectors, and elbows clear the 3:1 non-text floor.
- The brand mark is deliberately outside that gate. It is decorative under WCAG 1.4.11 — the word "Tab" beside it is real text at full contrast — so it has no ratio to clear. Its measurement is reported rather than enforced. If the mark is ever used *alone*, without adjacent text naming it, that reasoning stops holding and it needs either an accessible name and a contrasting plaque behind it or the single-colour stencil path.
- Nothing is carried by colour alone. The accent marks emphasis that is also stated in words, and the highlighted subtree carries a heading saying what it is.
- Both heroes are referenced from the README through `<picture>` and `prefers-color-scheme`, so neither scheme gets the other's mark.
- The marks carry no text nodes by design; their accessible name is supplied at the point of placement.

## Working rules

- Take the accent from the mark, not from taste. If the mark changes, re-run the sampling.
- Place the real mark. Never recolour it, never re-trace it, and never substitute an invented one.
- Never hand-pick a grey. Add a role and let `solve_strength` find it.
- Never hand-place a line. Add it to the panel model and let `flow` measure it — the height measurement and the renderer read that one list, which is what stops them disagreeing.
- Pre-composite every tint to an opaque colour. `ImageDraw` replaces destination alpha for shape primitives rather than compositing over it, so a translucent fill punches a hole through whatever it is drawn on.
- Keep every filename and every rendered string inside the approved vocabulary. This directory is in scope for the vocabulary gate, filenames included, and PNGs are skipped as binary — so rendered text has to be checked deliberately rather than left to the gate.
