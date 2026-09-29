# Tab brand assets

Everything Tab ships as artwork: the brand marks, the icon set, and the eight generated figures the README, the whitepaper and the social card use.

This directory sits outside every workspace glob on purpose. Nothing installs it and nothing builds it.

## Brand marks, in `brand/`

| File | Format | Purpose |
| --- | --- | --- |
| `tab-logo.svg` | 1024 × 1024 pt vector, single fill | The mark for light surfaces. Solid black ink, 21.00:1 on white. |
| `tab-logo-alt.svg` | 1026 × 1026 pt vector, eight fills | The mark for dark surfaces. Six of its eight fills clear 3:1 on the dark surface. |
| `tab-logo.png` | 1024 × 1024 RGBA | Raster of the mark, 74.1 % fully transparent. |
| `tab-logo-4k.png` | 2048 × 2048 RGBA | The same mark at print and social scale. The figures are composited from this one. |
| `icons/favicon.ico` | icon container | Browser tab icon. |
| `icons/favicon-16x16.png`, `icons/favicon-32x32.png` | 16 / 32 | Browser tab icon at 1× and 2×. |
| `icons/apple-touch-icon.png` | 180 × 180 | Home-screen icon on iOS. |
| `icons/android-chrome-192x192.png`, `-512x512.png` | 192 / 512 | Web app manifest icons. |

Both vector marks are pure geometry: no `<text>`, no `<tspan>`, no `<title>`, no `<desc>`, no metadata block. Neither carries a string payload and neither depends on a font. That also means neither carries its own accessible name, supply one at the point of placement with `aria-label` on the `<img>`, or `role="img"` plus a `<title>` on an inlined `<svg>`, and `aria-hidden="true"` where the mark sits beside a text label that already names it.

The rasters carry no text metadata. There is no `tEXt`, `iTXt`, or `zTXt` chunk anywhere in this directory.

## Figures, in `readme/`

| File | Size on disk | Displayed at | Purpose |
| --- | --- | --- | --- |
| `hero-light.png` | 1920 × 472 | 960 wide | README hero for light colour schemes. Transparent outside the rounded card. |
| `hero-dark.png` | 1920 × 472 | 960 wide | The same hero for dark colour schemes. |
| `og-card.png` | 2400 × 1260 | feed-dependent | The social card, on the documented 1.91:1 ratio. The same file ships as `apps/app/public/og-card.png`. |

All three are **committed**, because GitHub renders a README from the repository rather than from a build.
There is no generator in the tree: a figure that changes is re-exported by hand from `brand/tab-logo-4k.png` and checked against the rules below.

### Resolution

The hero is laid out at 960 wide and exported at twice that, so nothing is resampled up from a 1× raster on a high-density display; the README carries `width="960"` so the 2× file displays at its designed size.

The social card is laid out at the 1200 × 630 that Open Graph documents and ships at 2400 × 1260.
Consumers treat 1200 × 630 as a recommended **minimum** and key on the 1.91:1 ratio, and accept well past 2400 px, so the extra resolution costs nothing and is the difference between crisp and soft in a feed on a high-density display.

### The mark ships in its own colours

Every figure composites the real artwork straight from `brand/tab-logo-4k.png`, cropped to its alpha bounding box and reduced with LANCZOS from the 4k master, so the gradient survives.
Nothing is re-traced, nothing is recoloured, and no stand-in mark exists anywhere in this repository.

The mark sits immediately beside the word "Tab" set as actual text at full contrast, so under WCAG 1.4.11 it is decorative and carries no information of its own: there is no ratio for it to fail.
Flattening the brand's identity to satisfy a requirement that does not apply would be a worse outcome than a pale fill in a decorative graphic.

### Three colours in the chrome, and the accent is measured rather than chosen

White paper, near-black ink, and exactly one accent hue. Nothing else.

This rule governs the figure **chrome**, meaning paper, ink, borders, connectors and accent, and not the mark, which ships as drawn.

The accent is not a taste decision. Sampling the near-opaque, saturated pixels of `brand/tab-logo-4k.png` and quantising them, the single most common ink is `#109090`: hue 180, saturation 0.89, 2.3 % of the mark's saturated pixels. That teal is the accent hue.

It reaches only 3.88:1 on white, though, which is under the 4.5:1 that body text needs. So the hue and saturation are held and the *value* is walked outward in both directions until the ratio clears, which yields `#0D7676` on white at 5.43:1 and leaves `#109090` unchanged on the dark surface at 5.04:1. That is one accent seen on two papers, not two accents.

Greys are the ink composited over the paper at a solved strength, not a chosen one: each one steps up from transparent and stops at the first value clearing its role's minimum against every surface it can land on.

The ink and the paper are within two points of neutral on every channel.
They are not pure black and pure white either, because a hard black against a saturated teal reads as harsh.

Measured result, on the committed files:

| Figure | Neutral pixels | Chromatic hues present |
| --- | --- | --- |
| `hero-light.png` | 97.79 % | 165–225, from the mark's gradient |
| `hero-dark.png` | 97.04 % | 180–240, from the mark's gradient |
| `og-card.png` | 97.19 % | 180–240, from the mark's gradient |

Hue 180 is the only chromatic hue the *chrome* uses. The spread either side of it is the mark, which is the intended exception.

### `palette.json`

`palette.json` is the Dashboard's eleven-token theme, including the five status colours. `apps/app` generates its Tailwind theme from it and a CI contrast script cross-checks every published ratio, so it remains authoritative **for the interface**.

The figures deliberately do not read it. An interface with five statuses to distinguish needs five colours; a static figure does not, and a figure drawn in the full palette reads as a chart rather than as a figure, every panel competing for attention and nothing carrying meaning. The two are separately owned and neither constrains the other.

## Accessibility

- Contrast is checked before a figure is committed. Body and numeric text clears 4.5:1; panel boundaries and rules clear the 3:1 non-text floor.
- The brand mark is deliberately outside that gate. It is decorative under WCAG 1.4.11, since the word "Tab" beside it is real text at full contrast, so it has no ratio to clear. If the mark is ever used *alone*, without adjacent text naming it, that reasoning stops holding and it needs an accessible name and a contrasting plaque behind it.
- Nothing is carried by colour alone. The accent marks emphasis that is also stated in words.
- Both heroes are referenced from the README through `<picture>` and `prefers-color-scheme`, so neither scheme gets the other's mark.
- The marks carry no text nodes by design; their accessible name is supplied at the point of placement.

## Working rules

- Take the accent from the mark, not from taste. If the mark changes, re-run the sampling.
- Place the real mark. Never recolour it, never re-trace it, and never substitute an invented one.
- Never hand-pick a grey. Solve each strength against every surface it can land on.
- Pre-composite every tint to an opaque colour before drawing it over another.
- Keep every filename and every rendered string inside the approved vocabulary. This directory is in scope for the vocabulary gate, filenames included, and PNGs are skipped as binary, so rendered text has to be checked deliberately rather than left to the gate.
