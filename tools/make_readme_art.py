"""
Generates every raster figure the README and the social card need.

Run from the repository root:

    tools/.venv/Scripts/python.exe -m tools.make_readme_art
    tools/.venv/Scripts/python.exe -m tools.make_readme_art --check

`--check` renders everything in memory, reports what would change, and writes
nothing. Output goes to `assets/readme/` and is committed, because GitHub renders
a README from the repository and not from a build. So this is a local authoring
tool, not a build or CI dependency.

--------------------------------------------------------------------------------
Palette: white, near-black, and exactly one accent hue
--------------------------------------------------------------------------------

Three colours, and no more. Earlier drafts of these figures used an eleven-token
palette with five clearing-state colours, and the result read as a chart rather
than as a figure: every panel competed for attention and nothing carried meaning.
So the rule here is white paper, near-black ink, and one accent used only where
something is genuinely load-bearing.

The accent is measured from the brand mark rather than chosen. Sampling the
near-opaque, saturated pixels of `assets/brand/tab-logo-4k.png` and quantising
them, the single most common ink is `#109090` — hue 180, saturation 0.89. That
teal is therefore the accent hue, and it is not negotiable by taste.

It is negotiable by contrast, though, and that is what `readable_accent` does.
`#109090` reaches only 3.88:1 on white, under the 4.5:1 that body text needs. So
the hue and the saturation are held and the *value* is walked outward in both
directions until the ratio clears. Two values come out of that — a darker teal for
white surfaces and a lighter one for the dark hero — which is one accent seen on
two papers rather than two accents. Walking outward in both directions matters:
darkening ink on a dark surface reduces contrast, so a one-directional search
finds the wrong answer half the time.

Greys are the ink at reduced strength, composited to opaque. They are shades of
the one ink, not additional colours.

`assets/palette.json` is deliberately *not* read. It describes the Dashboard's
eleven-token theme, which is the right model for an interactive interface with
five clearing states to distinguish and the wrong model for a static figure. The
contrast gate in `apps/app` still owns that palette; this file owns these
figures, and the two do not constrain each other.

--------------------------------------------------------------------------------
Why the layout is measured rather than estimated
--------------------------------------------------------------------------------

Every panel sizes itself from the rendered width and height of its own content.
Text wraps on real `draw.textlength` measurements at the actual font metrics, and
each panel's content is produced exactly once by `flow()`, which returns a list of
placed lines. Both the height measurement and the renderer consume that same list,
so they cannot disagree.

That single-list rule is the whole point. The approach this is modelled on once
had two copies of the same arithmetic with slightly different padding, and it
measured every panel sixteen device pixels short — which is invisible until a
descender clips. Here, if `flow()` is wrong the panel is wrong in both places
identically, which is a visible bug rather than a silent one.

Column gutters are sized from the rendered width of the widest connector label
plus a readable run of line on each side, because one constant cannot serve both
a one-word label and a four-word one.

--------------------------------------------------------------------------------
Rendering notes that are easy to get wrong
--------------------------------------------------------------------------------

* Pillow has no antialiased drawing primitives. Everything is rendered at `SCALE`
  and reduced with LANCZOS, which is what makes a 1 px border look like a border
  instead of a hard or blurred line depending on where it lands on the pixel grid.

* The README figures are *exported* at `EXPORT = 2` times their nominal layout and
  displayed at nominal width, so they stay sharp on a high-density display instead
  of being resampled up from a 1x raster. That still leaves `SCALE / EXPORT = 2x`
  of genuine supersampling for the hairlines. The social card exports at the same
  factor, landing at 2400 by 1260 — twice the 1200 by 630 that Open Graph and
  Twitter recommend, on the same 1.91:1 ratio those consumers actually key on, and
  well inside both platforms' 4096 px and 5 MB ceilings. The ratio is the
  requirement; the pixel count is a floor rather than a target, and a feed on a
  high-density display is the one place a card is ever read.

* Canvas dimensions are snapped up to a multiple of the reduce factor. Otherwise
  the reduce scales x and y by very slightly different factors, which shears the
  whole figure.

* `ImageDraw` *replaces* destination alpha for shape primitives instead of
  compositing over it. A translucent fill therefore punches a hole through
  whatever it is drawn on rather than tinting it. Every tint here is
  pre-composited to an opaque colour by `blend()` before it reaches the drawing
  code. This is a real bug that cost a previous attempt at these figures.

* The hero's rounded card is built as an alpha mask so everything outside it is
  fully transparent. Cropping is not equivalent: an opaque surround shows as a
  white or near-black rectangle around the corners on whichever GitHub theme it
  was not built for.

* The brand mark is composited in its own colours, straight from
  `assets/brand/tab-logo-4k.png`, cropped to its alpha bounding box and reduced
  with LANCZOS. It is the real artwork, not a re-traced or recoloured stand-in.

  An earlier draft stencilled the mark flat in the accent, on the argument that
  the artwork's ink is a teal-to-blue gradient with pale cyan fills and that 36
  percent of its opaque pixels fall under 3:1 on white. That measurement is real,
  but it is not the right test: the mark sits immediately beside the word "Tab"
  set as actual text at full contrast, so it is decorative under WCAG 1.4.11 and
  carries no information of its own. Flattening the brand's identity to satisfy a
  ratio that does not apply was the wrong trade, so the stencil path is kept for
  anything that genuinely needs a single-colour glyph and is not used for the
  mark.

  The three-colour rule therefore applies to the figure *chrome* — paper, ink,
  accent — and not to the mark.

* Nominal width is 960 so GitHub's roughly 900 px content column does not
  downscale the text into mush.
"""

from __future__ import annotations

import argparse
import colorsys
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets" / "readme"
MARK_PATH = ROOT / "assets" / "brand" / "tab-logo-4k.png"

# --------------------------------------------------------------------------- #
# geometry                                                                    #
# --------------------------------------------------------------------------- #

#: Device pixels per nominal unit while drawing. Supersampling factor.
SCALE = 4

#: Output pixels per nominal unit, for the README figures. The saved PNG is this
#: much larger than the layout and the README constrains display width, so the
#: figures are sharp on a high-density display instead of being resampled up from a
#: 1x raster.
#:
#: Drawing at SCALE and exporting at EXPORT leaves SCALE / EXPORT of genuine
#: supersampling, which is what Pillow needs to produce a clean 1 px border: it has
#: no antialiased primitives, so a hairline drawn straight to the output grid comes
#: out hard or blurred depending on where it lands. Keep that quotient at 2 or more.
EXPORT = 2

WIDTH = 960

#: Multiples of the wordmark's measured cap height. The mark is the dominant
#: element of the hero rather than a bullet beside it, and it is a multi-hue raster
#: that turns to mud below roughly 40 nominal pixels, so both of these are well
#: above the 1.18 an earlier draft used.
HERO_MARK_ZOOM = 3.0
HEADER_MARK_ZOOM = 1.9

MARGIN = 30
PANEL_PAD = 15
ITEM_GAP = 10
PANEL_GAP = 14
MIN_GUTTER = 26
BULLET_INDENT = 13
PANEL_RADIUS = 12
HERO_RADIUS = 22

TREE_INDENT = 16
TREE_TICK = 8
TREE_DESC_GAP = 20
TREE_ROW_GAP = 6


def px(value: float) -> int:
    """Nominal units to device pixels. Every geometric constant goes through this."""
    return int(round(value * SCALE))


def snap(value: int, multiple: int) -> int:
    """
    Round `value` up to a multiple of `multiple`.

    Canvas dimensions go through here so the LANCZOS reduce divides both axes
    exactly. A dimension that is one device pixel off scales x and y by very
    slightly different factors, which shears the whole figure.
    """
    remainder = value % multiple
    return value if remainder == 0 else value + (multiple - remainder)


# --------------------------------------------------------------------------- #
# colour                                                                      #
# --------------------------------------------------------------------------- #

RGB = tuple[int, int, int]

#: Measured from the brand mark: the most common near-opaque saturated ink.
BRAND_ACCENT: RGB = (0x10, 0x90, 0x90)

WHITE: RGB = (0xFF, 0xFF, 0xFF)

#: Near-neutral rather than cool-tinted, deliberately. An earlier draft used a
#: blue-tinted ink and paper, and measuring the output showed 97 percent of the
#: dark hero's pixels registering as hue 210 — technically a third colour, even
#: though it reads as black. These are within two points of neutral on every
#: channel, so the figure genuinely is white, black, and one accent. Not pure
#: #000000, because a hard black against a saturated teal accent reads as harsh.
INK: RGB = (0x12, 0x12, 0x13)
DARK_PAPER: RGB = (0x0C, 0x0C, 0x0D)


def relative_luminance(rgb: RGB) -> float:
    """WCAG 2.1 relative luminance."""

    def channel(v: int) -> float:
        c = v / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: RGB, b: RGB) -> float:
    """WCAG 2.1 contrast ratio. Order-independent."""
    la, lb = relative_luminance(a), relative_luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def blend(fg: RGB, bg: RGB, alpha: float) -> RGB:
    """
    Pre-composite `fg` over `bg` at `alpha` into an opaque colour.

    Every tint in this file goes through here. Handing a translucent fill to
    ImageDraw punches a hole in the destination instead of tinting it, because the
    shape primitives replace destination alpha rather than compositing over it.
    """
    return tuple(round(f * alpha + b * (1 - alpha)) for f, b in zip(fg, bg))  # type: ignore[return-value]


def readable_accent(base: RGB, surfaces: tuple[RGB, ...], minimum: float = 4.5) -> RGB:
    """
    The nearest colour to `base` that clears `minimum` against every surface.

    Hue and saturation are held so the result is still recognisably the brand
    accent; only value moves. The search steps outward in *both* directions,
    because whether the accent needs to darken or lighten depends on the surface:
    darkening ink on a dark surface reduces contrast rather than improving it.

    Returns `base` unchanged when it already clears, and raises when no value of
    this hue can — which is a real possibility for a mid-tone against both white
    and near-black at once, and is better as a loud failure than a quiet
    substitution.
    """
    if all(contrast(base, s) >= minimum for s in surfaces):
        return base

    h, s, v = colorsys.rgb_to_hsv(*(c / 255 for c in base))
    for step in range(1, 51):
        delta = step * 0.02
        for candidate_v in (v - delta, v + delta):
            if not 0.0 <= candidate_v <= 1.0:
                continue
            rgb = tuple(round(c * 255) for c in colorsys.hsv_to_rgb(h, s, candidate_v))
            if all(contrast(rgb, surface) >= minimum for surface in surfaces):  # type: ignore[arg-type]
                return rgb  # type: ignore[return-value]

    raise SystemExit(
        f"readable_accent: no value of hue {h * 360:.0f} at saturation {s:.2f} clears "
        f"{minimum}:1 against every one of {len(surfaces)} surfaces. "
        "Widen the surface set or pick another hue deliberately."
    )


@dataclass(frozen=True)
class Palette:
    """
    White, near-black, one accent, and greys that are the ink at reduced strength.

    `band` is the accent at low strength, already composited opaque, used for the
    one highlighted region in the tree figure.
    """

    name: str
    page: RGB
    surface: RGB
    text: RGB
    text_secondary: RGB
    text_muted: RGB
    accent: RGB
    border: RGB
    border_strong: RGB
    band: RGB
    rule: RGB

    @property
    def surfaces(self) -> tuple[RGB, ...]:
        return (self.page, self.surface, self.band)


def solve_strength(ink: RGB, page: RGB, surfaces: tuple[RGB, ...], minimum: float) -> RGB:
    """
    The weakest tint of `ink` over `page` that still clears `minimum` everywhere.

    Greys here are not chosen, they are solved. Hand-picking a strength is how the
    first version of these figures ended up with 1.5:1 hairlines and 3.6:1
    subtitles: each looked plausible in isolation on white and neither survived
    being measured against the tinted band. Walking strength upward from
    transparent and stopping at the first value that clears every surface gives
    the lightest tint that is still legible, which is the one that looks like a
    considered grey rather than a heavy one.

    Steps in 1 percent increments and returns the solid ink if nothing weaker
    works, which cannot fail because the ink itself is the maximum.
    """
    for step in range(1, 101):
        candidate = blend(ink, page, step / 100)
        if all(contrast(candidate, surface) >= minimum for surface in surfaces):
            return candidate
    return ink


def build_palette(name: str, page: RGB, ink: RGB) -> Palette:
    """
    Derive a whole palette from two colours and the measured brand accent.

    Everything except the accent is the ink composited over the page at a solved
    strength, so a palette is genuinely two colours plus one. Nothing here is a
    hand-picked hex value.

    The surface set every ink is solved against includes the tinted band, which is
    the palest surface in play and therefore the binding constraint. Solving
    against the page alone would produce inks that fail on the band, which is
    precisely the bug the audit caught on the first run.
    """
    surface = blend(ink, page, 0.03)
    band_base = blend(BRAND_ACCENT, page, 0.10)
    accent = readable_accent(BRAND_ACCENT, (page, surface, band_base))
    band = blend(accent, page, 0.09)
    surfaces = (page, surface, band)

    return Palette(
        name=name,
        page=page,
        surface=surface,
        text=ink,
        # Body-weight ink, so 4.5:1. Solved a little above the floor so it still
        # reads as secondary rather than collapsing into the primary ink.
        text_secondary=solve_strength(ink, page, surfaces, 7.0),
        text_muted=solve_strength(ink, page, surfaces, 4.5),
        accent=accent,
        # Decorative hairlines only, never the sole carrier of meaning.
        border=solve_strength(ink, page, surfaces, 1.6),
        # Panel boundaries are what separate one region of small type from the
        # next, so they are held to the 3:1 non-text floor rather than treated as
        # decoration. This is the pair that made the earlier figures look washed
        # out at 1.94:1.
        border_strong=solve_strength(ink, page, surfaces, 3.0),
        band=band,
        # Connectors and elbows carry the reading order of the figure, so they are
        # structural and held to 3:1 as well.
        rule=solve_strength(ink, page, surfaces, 3.0),
    )


LIGHT = build_palette("light", WHITE, INK)
DARK = build_palette("dark", DARK_PAPER, WHITE)

#: Figures render light only. See the module docstring.
FIGURE_PALETTE = LIGHT


# --------------------------------------------------------------------------- #
# contrast audit                                                              #
# --------------------------------------------------------------------------- #

#: role -> (attribute carrying the ink, minimum ratio, what it is used for)
TEXT_ROLES: tuple[tuple[str, float, str], ...] = (
    ("text", 4.5, "headings, panel titles, item labels"),
    ("text_secondary", 4.5, "notes and descriptions"),
    ("text_muted", 4.5, "subtitles, connector labels, tree descriptions"),
    ("accent", 4.5, "accented labels and the emphasised panel title"),
)

#: Non-text pairs. 3:1 under WCAG 1.4.11.
NON_TEXT_ROLES: tuple[tuple[str, float, str], ...] = (
    ("border_strong", 3.0, "panel boundaries and the emphasised panel border"),
    ("rule", 3.0, "header rules, connectors, arrows, tree elbows"),
)


def audit() -> list[str]:
    """
    Measure every ink against every surface it can land on, before anything is
    written.

    A figure that ships with a 3.9:1 label is worse than a build that fails,
    because nobody notices the former. So this runs first and its failures are
    fatal.
    """
    failures: list[str] = []
    print("contrast audit")
    print("-" * 74)
    for palette in (LIGHT, DARK):
        for surface_name in ("page", "surface", "band"):
            surface: RGB = getattr(palette, surface_name)
            for role, minimum, purpose in TEXT_ROLES + NON_TEXT_ROLES:
                ink: RGB = getattr(palette, role)
                ratio = contrast(ink, surface)
                ok = ratio >= minimum
                if not ok:
                    failures.append(
                        f"{palette.name}.{role} on {palette.name}.{surface_name} "
                        f"reaches {ratio:.2f}:1 but needs {minimum:.1f}:1 ({purpose})"
                    )
                print(
                    f"  {'ok  ' if ok else 'FAIL'} "
                    f"{palette.name + '.' + role:<28} on {surface_name:<8} "
                    f"{ratio:6.2f}:1  needs {minimum:.1f}:1"
                )
        # The brand mark is not audited. It ships in its own colours, it is a
        # gradient rather than a single ink, and it sits beside the word "Tab" set
        # as real text at full contrast — so it is decorative under WCAG 1.4.11 and
        # has no ratio to clear. `mark_report` prints the measurement anyway, so the
        # number is on the record rather than assumed.
    print("-" * 74)
    if failures:
        print(f"audit: {len(failures)} failing pair(s)")
        for f in failures:
            print(f"  x {f}")
    else:
        print("audit: every ink clears the ratio its role requires")
    return failures


# --------------------------------------------------------------------------- #
# fonts                                                                       #
# --------------------------------------------------------------------------- #

#: The four faces, by file name rather than by full path.
#:
#: Layout here is measured from rendered glyph metrics, so a substituted face
#: does not merely look different — it silently changes every width the layout
#: was solved against. The resolver below therefore looks for these exact files
#: and refuses rather than falling back to something similar.
FONT_FILES = {
    "regular": "segoeui.ttf",
    "semibold": "seguisb.ttf",
    "bold": "segoeuib.ttf",
    "mono": "CascadiaMono.ttf",
}

#: Where to look, in order.
#:
#: The second entry is the Windows font directory as WSL mounts it. Those are the
#: same files as the first entry, byte for byte, so finding a face there is not a
#: substitution and the measured layout is identical — which is the only reason
#: a second root is safe at all.
FONT_ROOTS = (
    Path(r"C:\Windows\Fonts"),
    Path("/mnt/c/Windows/Fonts"),
)

#: Nominal point sizes. h1 18 bold, panel title 12 semibold, item label 10
#: semibold, notes and subtitles 9 regular, mono 9, connector labels 8.
SIZES = {
    "h1": ("bold", 18),
    "h2": ("semibold", 13),
    "subtitle": ("regular", 9.5),
    "panel_title": ("semibold", 12),
    "label": ("semibold", 10),
    "note": ("regular", 9),
    "mono": ("mono", 9),
    "connector": ("regular", 8),
    "wordmark": ("bold", 44),
    "tagline": ("regular", 13),
    "og_title": ("bold", 34),
    "og_sub": ("regular", 15),
}

_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(role: str) -> ImageFont.FreeTypeFont:
    """Load a font by role. Fails loudly rather than substituting silently."""
    family, size = SIZES[role]
    key = (family, px(size))
    if key not in _font_cache:
        name = FONT_FILES[family]
        path = next((root / name for root in FONT_ROOTS if (root / name).is_file()), None)
        if path is None:
            searched = "\n".join(f"    {root / name}" for root in FONT_ROOTS)
            raise SystemExit(
                f"make_readme_art: font file missing: {name}\n"
                f"  needed for the '{family}' family, used by role '{role}'. Looked in:\n"
                f"{searched}\n"
                "  Substituting a different face silently would change every measured "
                "width in the layout, so this is fatal."
            )
        _font_cache[key] = ImageFont.truetype(str(path), key[1])
    return _font_cache[key]


# --------------------------------------------------------------------------- #
# the mark                                                                    #
# --------------------------------------------------------------------------- #

_mark_cache: dict[tuple[int, RGB | None], Image.Image] = {}
_mark_source: Image.Image | None = None


def _mark_artwork() -> Image.Image:
    """
    The brand mark, cropped to its alpha bounding box, loaded once.

    The crop matters. A PNG mark carries transparent padding — this one is a 2048
    square whose ink occupies 1488 by 1537 of it — so scaling the raw canvas would
    make the visible mark about 25 percent smaller than asked for and would
    misalign it against text measured from its own bounding box.
    """
    global _mark_source
    if _mark_source is None:
        if not MARK_PATH.is_file():
            raise SystemExit(f"make_readme_art: brand mark missing: {MARK_PATH}")
        source = Image.open(MARK_PATH).convert("RGBA")
        box = source.getchannel("A").getbbox()
        if box is None:
            raise SystemExit(f"make_readme_art: brand mark at {MARK_PATH} is fully transparent")
        _mark_source = source.crop(box)
    return _mark_source


def mark(height_px: int, colour: RGB | None = None) -> Image.Image:
    """
    The brand mark at `height_px`.

    With `colour` left at None — which is what every figure here uses — this is the
    real artwork in its own colours, reduced with LANCZOS from the 4k master so the
    gradient survives. Nothing is re-traced and nothing is recoloured.

    Passing a `colour` returns a flat stencil cut from the mark's alpha channel
    instead. That path exists for anywhere a genuinely single-colour glyph is
    needed, and the figures deliberately do not take it: see the module docstring
    for why flattening the mark was the wrong trade.
    """
    key = (height_px, colour)
    if key in _mark_cache:
        return _mark_cache[key]

    source = _mark_artwork()
    ratio = height_px / source.height
    resized = source.resize((max(1, round(source.width * ratio)), height_px), Image.LANCZOS)

    if colour is not None:
        stencil = Image.new("RGBA", resized.size, colour + (0,))
        stencil.putalpha(resized.getchannel("A"))
        resized = stencil

    _mark_cache[key] = resized
    return resized


def mark_report() -> None:
    """
    Print what the real mark measures on each paper.

    Not a gate. The mark is decorative, so there is no ratio for it to fail. But
    "the logo is a gradient and part of it is pale" is the kind of claim that should
    be a number in the build output rather than a sentence in a comment, so that if
    the artwork is ever replaced the change in legibility is visible immediately.
    """
    source = _mark_artwork()
    ink = [p for p in source.getdata() if p[3] > 200]
    mean: RGB = tuple(sum(p[i] for p in ink) // len(ink) for i in range(3))  # type: ignore[assignment]

    print("\nbrand mark, in its own colours")
    print("-" * 74)
    print(f"  source               {MARK_PATH.name}, ink bounding box {source.width} x {source.height}")
    print(f"  mean ink             #{'%02X%02X%02X' % mean}")
    for palette in (LIGHT, DARK):
        faint = sum(1 for r, g, b, _ in ink if contrast((r, g, b), palette.page) < 3.0)
        print(
            f"  on {palette.name + ' page':<17} mean {contrast(mean, palette.page):5.2f}:1   "
            f"{faint / len(ink) * 100:4.1f}% of ink under 3:1"
        )
    print("  decorative under WCAG 1.4.11 — the word 'Tab' beside it is real text, so")
    print("  the mark carries no information and has no ratio to clear.")


# --------------------------------------------------------------------------- #
# measured text                                                               #
# --------------------------------------------------------------------------- #

_measure = ImageDraw.Draw(Image.new("RGB", (8, 8)))


def text_width(s: str, role: str) -> int:
    return int(round(_measure.textlength(s, font=font(role))))


def line_height(role: str) -> int:
    """Ascender-to-descender height of the face, so rows never clip a descender."""
    ascent, descent = font(role).getmetrics()
    return ascent + descent


def wrap(s: str, role: str, max_width: int) -> list[str]:
    """
    Greedy wrap on real rendered widths.

    A word longer than the line is emitted on its own rather than dropped or
    broken, so an over-long identifier is visibly too long instead of silently
    truncated. Everything in these figures is checked to fit, so that path should
    never fire; it exists so that a future edit fails loudly.
    """
    words = s.split()
    if not words:
        return [""]
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        trial = f"{current} {word}"
        if text_width(trial, role) <= max_width:
            current = trial
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


# --------------------------------------------------------------------------- #
# panel model                                                                 #
# --------------------------------------------------------------------------- #


@dataclass
class Item:
    """One row inside a panel."""

    label: str
    note: str = ""
    #: Render the label in the mono face. For real identifiers and signatures.
    mono: bool = False
    #: Render the label in the accent. For the one fact per panel worth noticing.
    accent: bool = False
    #: Draw a small square bullet and indent the text.
    bullet: bool = True


@dataclass
class Panel:
    title: str
    items: list[Item]
    #: Draw the border in the accent at double weight. At most one per figure.
    emphasis: bool = False
    #: Optional line under the title, before the items.
    subtitle: str = ""


@dataclass
class Placed:
    """A line of text with its offset relative to the panel's content origin."""

    dx: int
    dy: int
    role: str
    text: str
    colour_role: str
    bullet: bool = False


def flow(panel: Panel, content_width: int) -> tuple[list[Placed], int]:
    """
    Produce every line of a panel exactly once, with its offset and its height.

    Both `panel_height` and `draw_panel` consume this one list, which is what
    stops the measurement and the drawing from disagreeing. Nothing else in this
    file is permitted to compute a panel's geometry.
    """
    lines: list[Placed] = []
    y = 0

    lines.append(Placed(0, y, "panel_title", panel.title, "accent" if panel.emphasis else "text"))
    y += line_height("panel_title")

    if panel.subtitle:
        y += px(2)
        for row in wrap(panel.subtitle, "subtitle", content_width):
            lines.append(Placed(0, y, "subtitle", row, "text_muted"))
            y += line_height("subtitle")

    y += px(ITEM_GAP - 2)

    for index, item in enumerate(panel.items):
        if index:
            y += px(ITEM_GAP)

        indent = px(BULLET_INDENT) if item.bullet else 0
        label_role = "mono" if item.mono else "label"
        label_colour = "accent" if item.accent else "text"
        available = content_width - indent

        label_rows = wrap(item.label, label_role, available)
        for row_index, row in enumerate(label_rows):
            lines.append(
                Placed(
                    indent,
                    y,
                    label_role,
                    row,
                    label_colour,
                    bullet=(item.bullet and row_index == 0),
                )
            )
            y += line_height(label_role)

        if item.note:
            y += px(1)
            for row in wrap(item.note, "note", available):
                lines.append(Placed(indent, y, "note", row, "text_secondary"))
                y += line_height("note")

    return lines, y


def panel_height(panel: Panel, width: int) -> int:
    _, content = flow(panel, width - 2 * px(PANEL_PAD))
    return content + 2 * px(PANEL_PAD)


# --------------------------------------------------------------------------- #
# canvas                                                                      #
# --------------------------------------------------------------------------- #


class Canvas:
    """
    A device-resolution canvas that reduces to `export` times nominal size on save.

    Every figure uses the module-wide EXPORT. The parameter exists so a figure with
    a hard external size constraint can opt out without the reduce factor becoming
    a special case inside `render`, and nothing currently takes that option.
    """

    def __init__(
        self,
        width_nominal: int,
        height_nominal: int,
        background: RGB | None,
        *,
        export: int = EXPORT,
    ):
        if SCALE % export or SCALE // export < 2:
            raise SystemExit(
                f"make_readme_art: SCALE {SCALE} must be a multiple of export {export}, "
                "and must leave at least 2x of supersampling. Pillow has no "
                "antialiased primitives, so drawing at the output resolution ships "
                "hard or blurred hairlines depending on where they land."
            )
        self.reduce = SCALE // export
        self.w = snap(px(width_nominal), self.reduce)
        self.h = snap(px(height_nominal), self.reduce)
        mode_bg = background + (255,) if background else (0, 0, 0, 0)
        self.img = Image.new("RGBA", (self.w, self.h), mode_bg)
        self.d = ImageDraw.Draw(self.img)

    def text(self, x: int, y: int, s: str, role: str, colour: RGB) -> None:
        self.d.text((x, y), s, font=font(role), fill=colour + (255,))

    def rect(
        self,
        box: tuple[int, int, int, int],
        *,
        fill: RGB | None = None,
        outline: RGB | None = None,
        width: int = 1,
        radius: int = 0,
    ) -> None:
        kwargs = {
            "fill": fill + (255,) if fill else None,
            "outline": outline + (255,) if outline else None,
            "width": width,
        }
        if radius:
            self.d.rounded_rectangle(box, radius=radius, **kwargs)  # type: ignore[arg-type]
        else:
            self.d.rectangle(box, **kwargs)  # type: ignore[arg-type]

    def line(self, points: list[tuple[int, int]], colour: RGB, width: int = 1) -> None:
        self.d.line(points, fill=colour + (255,), width=width, joint="curve")

    def paste(self, image: Image.Image, at: tuple[int, int]) -> None:
        self.img.alpha_composite(image, dest=at)

    def render(self) -> Image.Image:
        return self.img.resize(
            (self.w // self.reduce, self.h // self.reduce), Image.LANCZOS
        )


def draw_panel(c: Canvas, panel: Panel, x: int, y: int, width: int, p: Palette) -> int:
    """Draw one panel and return its height. Geometry comes only from `flow`."""
    content_width = width - 2 * px(PANEL_PAD)
    lines, content_height = flow(panel, content_width)
    height = content_height + 2 * px(PANEL_PAD)

    c.rect(
        (x, y, x + width, y + height),
        fill=p.surface,
        outline=p.accent if panel.emphasis else p.border_strong,
        width=px(2) if panel.emphasis else px(1),
        radius=px(PANEL_RADIUS),
    )

    ox, oy = x + px(PANEL_PAD), y + px(PANEL_PAD)
    for line in lines:
        if line.bullet:
            size = px(3)
            top = oy + line.dy + line_height(line.role) // 2 - size // 2
            bx = ox + px(BULLET_INDENT) - px(9)
            c.rect((bx, top, bx + size, top + size), fill=p.accent)
        c.text(ox + line.dx, oy + line.dy, line.text, line.role, getattr(p, line.colour_role))

    return height


def draw_header(c: Canvas, title: str, subtitle: str, p: Palette, width_nominal: int) -> int:
    """
    Mark top-left, title beside it, subtitle under that, then a rule.

    Returns the y of the first content row. The rule's position is measured from
    the rendered header rather than fixed, so a subtitle that wraps to two lines
    pushes the rule down instead of colliding with it.

    The mark is now taller than the title line on its own, so the title and
    subtitle are centred as a block against the mark's band rather than sharing its
    top edge. The header's height is whichever of the two is taller.
    """
    x = px(MARGIN)
    y = px(MARGIN)

    mark_h = round(line_height("h1") * HEADER_MARK_ZOOM)
    glyph = mark(mark_h)
    text_x = x + glyph.width + px(13)

    available = px(width_nominal - MARGIN) - text_x
    rows = wrap(subtitle, "subtitle", available) if subtitle else []
    block = line_height("h1")
    if rows:
        block += px(3) + len(rows) * line_height("subtitle")

    band = max(mark_h, block)
    c.paste(glyph, (x, y + (band - mark_h) // 2))

    ty = y + (band - block) // 2
    c.text(text_x, ty, title, "h1", p.text)
    ty += line_height("h1")
    if rows:
        ty += px(3)
        for row in rows:
            c.text(text_x, ty, row, "subtitle", p.text_muted)
            ty += line_height("subtitle")

    bottom = y + band + px(12)
    c.line([(x, bottom), (px(width_nominal - MARGIN), bottom)], p.rule, px(1))
    return bottom + px(18)


def draw_arrow(
    c: Canvas, x0: int, y: int, x1: int, label: str, p: Palette, *, dashed: bool = False
) -> None:
    """
    A horizontal connector with its label centred above the shaft.

    The label is centred on the gutter rather than on the arrow, because the head
    occupies the last few pixels and a label centred on the whole span reads as
    offset to the left.
    """
    head = px(5)
    if dashed:
        dash, gap, cursor = px(4), px(3), x0
        while cursor < x1 - head:
            c.line([(cursor, y), (min(cursor + dash, x1 - head), y)], p.rule, px(1))
            cursor += dash + gap
    else:
        c.line([(x0, y), (x1 - head, y)], p.rule, px(1))

    c.d.polygon(
        [(x1, y), (x1 - head, y - head // 2 - px(1)), (x1 - head, y + head // 2 + px(1))],
        fill=p.rule + (255,),
    )

    if label:
        w = text_width(label, "connector")
        cx = (x0 + x1) // 2 - w // 2
        c.text(cx, y - line_height("connector") - px(4), label, "connector", p.text_muted)


# --------------------------------------------------------------------------- #
# figure content                                                              #
# --------------------------------------------------------------------------- #


def pipeline_columns() -> list[list[Panel]]:
    return [
        [
            Panel(
                "1 · Metered call",
                [
                    Item(
                        "Agent calls a priced tool",
                        "No prepayment, no wallet connection, no held response.",
                    ),
                    Item(
                        "recordDelivery",
                        "Charges the Open Tab after the result is already delivered.",
                        mono=True,
                    ),
                    Item(
                        "The tab only ever rises here",
                        "This path reduces nothing, so it never meets the boundary.",
                        accent=True,
                    ),
                ],
            )
        ],
        [
            Panel(
                "2 · Settlement on Ethereum",
                [
                    Item(
                        "The Agent signs, with its own keys",
                        "A USDC Transfer to the Service Collection Address.",
                    ),
                    Item(
                        "The Watcher observes only",
                        "Waits until the height is attested. Holds no key over Agent funds.",
                    ),
                    Item(
                        "deriveRoot",
                        "Re-derives the Merkle root locally and submits only on an exact match.",
                        mono=True,
                    ),
                ],
            )
        ],
        [
            Panel(
                "3 · Verification on Creditcoin",
                [
                    Item(
                        "submitSettlementBatch",
                        "Proof material only. No handler, no action byte, no selector.",
                        mono=True,
                    ),
                    Item(
                        "verifyAndEmit → true",
                        "The one path from Ethereum value movement to a reduced Open Tab.",
                        mono=True,
                        accent=True,
                    ),
                    Item(
                        "applyVerifiedSettlement",
                        "Reduces the tab once, keyed on chainKey, height, txIndex, logIndex.",
                        mono=True,
                    ),
                ],
                emphasis=True,
            )
        ],
    ]


def repository_columns() -> list[list[Panel]]:
    return [
        [
            Panel(
                "Creditcoin contracts",
                [
                    Item("src/asc/TabAscBase.sol", "Verification and log-scoped replay.", mono=True),
                    Item("src/SettlementVerifier.sol", "Pair authentication and crediting.", mono=True),
                    Item("src/TabBook.sol", "Open Tabs, metering, clearing.", mono=True),
                    Item("src/LimitLib.sol", "Pure credit arithmetic.", mono=True),
                    Item("src/Bond.sol", "Per-Asset stake and slashing.", mono=True),
                ],
            ),
            Panel(
                "Registries",
                [
                    Item("src/ServiceRegistry.sol", "Emitters keyed on the pair.", mono=True),
                    Item("src/AgentRegistry.sol", "Binding proven by payment.", mono=True),
                ],
            ),
        ],
        [
            Panel(
                "Off-chain rail",
                [
                    Item("apps/watcher", "Observes, waits, re-derives, submits.", mono=True),
                    Item("services/proof-service", "Metered, and an Agent itself.", mono=True),
                    Item("apps/gateway", "Meters delivery after the fact.", mono=True),
                    Item("apps/registry", "Indexes events, serves reads.", mono=True),
                ],
            ),
            Panel(
                "Verified interfaces",
                [
                    Item(
                        "13 of 13 selectors confirmed",
                        "Probed live against both precompiles before anything was built on them.",
                        accent=True,
                    )
                ],
            ),
        ],
        [
            Panel(
                "Client tooling",
                [
                    Item("packages/sdk", "Strategies, 402 client, MCP, CLI.", mono=True),
                    Item("packages/shared", "Replay key, chains, ABIs.", mono=True),
                    Item("apps/app", "Dashboard. No wallet to read.", mono=True),
                    Item("apps/docs", "Documentation site.", mono=True),
                ],
            ),
            Panel(
                "Evidence",
                [
                    Item("spike/", "Live transcripts, committed.", mono=True),
                    Item(
                        "The mainnet path verifies",
                        "A real historical mainnet USDC Transfer, proved on testnet.",
                        accent=True,
                    ),
                ],
            ),
        ],
    ]


def attestcoin_columns() -> list[list[Panel]]:
    """
    The protocol surfaces, in the order one settlement actually consumes them.

    Read left to right this is a question, an answer, and a verdict: when is a
    payment provable, what proves it, and does the chain accept the proof. The
    emphasis sits on the last column because that is the only place a tab falls.
    """
    return [
        [
            Panel(
                "ChainInfo Precompile",
                [
                    Item(
                        "get_supported_chains",
                        "Discovery. Configuration cannot force a chain the precompile does not report.",
                        mono=True,
                    ),
                    Item(
                        "get_latest_attestation_height_and_hash",
                        "Tells the Watcher when a Settlement has become provable.",
                        mono=True,
                    ),
                    Item(
                        "get_attestation_bounds",
                        "Bounds the range a reorganisation check has to compare.",
                        mono=True,
                    ),
                    Item(
                        "11 methods, snake_case, a name is a selector",
                        "13 of 13 probed against the live chain before anything was built on them.",
                        accent=True,
                    ),
                ],
                subtitle="0x…0fd3 · when is it provable",
            )
        ],
        [
            Panel(
                "Proof material, from two sources",
                [
                    Item(
                        "Proof Builder API",
                        "Merkle Proof and Continuity Proof by transaction hash, batched.",
                    ),
                    Item(
                        "RawProofBuilder",
                        "Rebuilds the same tree from Source Chain RPC reads, independently.",
                    ),
                    Item(
                        "deriveRoot, locally",
                        "The root is re-derived here and submitted only on an exact match, so a bad supplier costs gas and nothing else.",
                        mono=True,
                        accent=True,
                    ),
                ],
                subtitle="two suppliers · what proves it",
            )
        ],
        [
            Panel(
                "BlockProver Precompile",
                [
                    Item(
                        "verify(…) view",
                        "Keyless preflight. A refusal here spends nothing.",
                        mono=True,
                    ),
                    Item(
                        "calculateTxIndex",
                        "Cross-checks the transaction's place in the block before gas is committed.",
                        mono=True,
                    ),
                    Item(
                        "verifyAndEmit → true",
                        "The one path from an Ethereum payment to a reduced Open Tab.",
                        mono=True,
                        accent=True,
                    ),
                ],
                subtitle="0x…0FD2 · does the chain accept it",
                emphasis=True,
            )
        ],
    ]


def credit_columns() -> list[list[Panel]]:
    """
    The credit invariant, as three panels rather than as an equation.

    Every figure here is a named constant in `LimitLib`, so the panel and the
    contract cannot drift without the contract changing.
    """
    return [
        [
            Panel(
                "The witness",
                [
                    Item(
                        "Every Verified Settlement the Agent has",
                        "Passed as calldata and validated against an on-chain commitment, so it cannot be edited.",
                    ),
                    Item(
                        "512 records, 32 counterparties",
                        "Beyond either bound the contract reverts HistoryTooLong rather than dropping records.",
                        mono=True,
                    ),
                    Item(
                        "Each record follows a real Metered Delivery",
                        "There is no self-reported history anywhere in the input.",
                    ),
                ],
                subtitle="what the Agent has actually paid",
            )
        ],
        [
            Panel(
                "LimitLib, a pure function",
                [
                    Item(
                        "Age ramp, 25% → 100% over 30 days",
                        "A burst of fresh settlement weighs a quarter of seasoned history.",
                    ),
                    Item(
                        "Concentration cap, 25% per counterparty",
                        "No single Service can carry an Agent's limit on its own.",
                    ),
                    Item(
                        "At least 3 Curated Tier counterparties",
                        "A ring of two buys nothing, because the third is required before any credit exists.",
                    ),
                    Item(
                        "No price, no rate, no oracle",
                        "The function reads no external state at all. It is pure, and it is fuzzed as pure.",
                        accent=True,
                    ),
                ],
                subtitle="deterministic, and unit tested at every edge",
            )
        ],
        [
            Panel(
                "The ceiling",
                [
                    Item(
                        "Bond cap, 95% of the counterparties' Bonds",
                        "Credit unlocked is strictly less than the stake standing behind it.",
                    ),
                    Item(
                        "Collusion costs more than it returns",
                        "A colluding ring's ceiling is its own Bond sum, which is the bound rather than a fix.",
                    ),
                    Item(
                        "A cold-start Agent has no limit",
                        "No history means no counterparties, so the first purchase is always a Settlement.",
                        accent=True,
                    ),
                ],
                subtitle="what an Agent can never exceed",
                emphasis=True,
            )
        ],
    ]


#: (depth, name, description, is_dir, highlighted)
#:
#: Descriptions are full sentences rather than labels. The first version used
#: three-word notes and the rendered figure filled only 40 percent of its width,
#: which reads as an unfinished layout rather than a deliberate one. Saying what
#: each file is actually responsible for both fills the measured column and is
#: more useful to the reader it exists for.
TREE_ROWS: tuple[tuple[int, str, str, bool, bool], ...] = (
    (0, "packages/", "", True, False),
    (
        1,
        "contracts/src/",
        "Every contract that can move an Open Tab. Read this subtree first.",
        True,
        True,
    ),
    (
        2,
        "asc/TabAscBase.sol",
        "The proof gate. Nothing is written before verifyAndEmit returns true.",
        False,
        True,
    ),
    (
        2,
        "SettlementVerifier.sol",
        "Authenticates on the (chainKey, emitter) pair, never the address alone.",
        False,
        True,
    ),
    (
        2,
        "TabBook.sol",
        "Open Tabs, metered delivery, and the provisional clearing lifecycle.",
        False,
        True,
    ),
    (
        2,
        "LimitLib.sol",
        "Pure credit arithmetic. No storage read, so it is reproducible off chain.",
        False,
        True,
    ),
    (
        2,
        "Bond.sol",
        "Per-Asset stake. Isolation is structural: no key exists without an Asset.",
        False,
        True,
    ),
    (
        2,
        "ServiceRegistry.sol",
        "Authorised emitters, collection addresses, integer prices, curation tier.",
        False,
        True,
    ),
    (
        2,
        "AgentRegistry.sol",
        "Binds a payer address by payment, because no signature can be verified.",
        False,
        True,
    ),
    (
        1,
        "shared/",
        "The replay key, the chain table, and the generated ABIs, defined once.",
        True,
        False,
    ),
    (
        1,
        "sdk/",
        "Payment strategies, the 402 client, the MCP server, and the CLI.",
        True,
        False,
    ),
    (0, "apps/", "", True, False),
    (
        1,
        "watcher/",
        "Observes, waits for attestation, re-derives the root, then submits.",
        True,
        False,
    ),
    (
        1,
        "app/",
        "Dashboard. Every read-only route renders with no wallet connected.",
        True,
        False,
    ),
    (1, "docs/", "Documentation site, published separately from the Dashboard.", True, False),
    (0, "services/", "", True, False),
    (
        1,
        "proof-service/",
        "Sells proof material, and settles its own tabs on the same rail.",
        True,
        False,
    ),
    (
        0,
        "spike/",
        "Live transcripts from the real chain, committed so the claims are checkable.",
        True,
        False,
    ),
)


# --------------------------------------------------------------------------- #
# figures                                                                     #
# --------------------------------------------------------------------------- #


def render_columns_figure(
    title: str, subtitle: str, columns: list[list[Panel]], arrows: list[str], footer: str
) -> Image.Image:
    """
    Three columns of panels with optional labelled connectors between them.

    Column width and gutter are solved together from the widest connector label,
    so the arrow always has a readable run of shaft on each side of its text.
    """
    p = FIGURE_PALETTE
    count = len(columns)
    usable = WIDTH - 2 * MARGIN

    if arrows:
        widest = max(text_width(a, "connector") for a in arrows) / SCALE
        gutter = max(MIN_GUTTER, int(widest) + 22)
    else:
        gutter = MIN_GUTTER
    col_w = (usable - gutter * (count - 1)) // count

    # Measure first so the canvas is exactly tall enough.
    probe = Canvas(WIDTH, 10, p.page)
    content_top = draw_header(probe, title, subtitle, p, WIDTH)
    stack_heights = [
        sum(panel_height(pan, px(col_w)) for pan in col) + px(PANEL_GAP) * (len(col) - 1)
        for col in columns
    ]
    body = max(stack_heights)

    footer_rows = wrap(footer, "note", px(usable)) if footer else []
    footer_h = (px(16) + len(footer_rows) * line_height("note")) if footer_rows else 0
    total = content_top + body + footer_h + px(MARGIN)

    c = Canvas(WIDTH, total / SCALE, p.page)
    content_top = draw_header(c, title, subtitle, p, WIDTH)

    for index, column in enumerate(columns):
        x = px(MARGIN + index * (col_w + gutter))
        y = content_top
        for pan in column:
            y += draw_panel(c, pan, x, y, px(col_w), p) + px(PANEL_GAP)

    # Arrows sit on the first panel's vertical centre, which is where the eye is.
    if arrows:
        first_h = panel_height(columns[0][0], px(col_w))
        y = content_top + first_h // 2
        for index, label in enumerate(arrows):
            x0 = px(MARGIN + (index + 1) * col_w + index * gutter) + px(6)
            x1 = px(MARGIN + (index + 1) * (col_w + gutter)) - px(6)
            draw_arrow(c, x0, y, x1, label, p)

    if footer_rows:
        y = content_top + body + px(16)
        c.line([(px(MARGIN), y - px(8)), (px(WIDTH - MARGIN), y - px(8))], p.rule, px(1))
        for row in footer_rows:
            c.text(px(MARGIN), y, row, "note", p.text_secondary)
            y += line_height("note")

    return c.render()


def render_tree() -> Image.Image:
    """
    A file tree with drawn connectors.

    The elbows are real lines, not `|--` box-drawing characters: those glyphs come
    from the reader's monospace font and substitute into empty rectangles on a
    machine that lacks them, which turns the figure into noise.

    The description column starts at one measured x for the whole figure, taken
    from the widest name at its own indent, so the descriptions line up as a column
    instead of ragging against the deepest name.
    """
    p = FIGURE_PALETTE
    row_h = max(line_height("mono"), line_height("note")) + px(TREE_ROW_GAP)
    title = "Where the money logic lives"
    subtitle = (
        "The highlighted subtree is what a reviewer should read first: every "
        "contract that can move an Open Tab."
    )

    name_x = [px(MARGIN + TREE_INDENT) + depth * px(TREE_INDENT) for depth, *_ in TREE_ROWS]
    desc_x = max(
        x + text_width(name, "mono") for x, (_, name, *_) in zip(name_x, TREE_ROWS)
    ) + px(TREE_DESC_GAP)

    # Width is derived from the content, not fixed at the figure width.
    #
    # A tree is left-weighted by nature, and forcing it to 960 nominal left it
    # filling 55 percent of its canvas with the rest empty, which reads as an
    # unfinished layout. Padding the descriptions to fill the space would be
    # writing prose to serve a rectangle. So the rectangle is measured from the
    # prose instead, and this figure is simply narrower than the three-column ones.
    widest = max(
        (desc_x + text_width(desc, "note")) if desc else 0 for _, _, desc, _, _ in TREE_ROWS
    )
    width_nominal = int(round((widest + px(MARGIN)) / SCALE))

    probe = Canvas(width_nominal, 10, p.page)
    content_top = draw_header(probe, title, subtitle, p, width_nominal)
    total = content_top + len(TREE_ROWS) * row_h + px(MARGIN)

    c = Canvas(width_nominal, total / SCALE, p.page)
    content_top = draw_header(c, title, subtitle, p, width_nominal)

    # Bands first, so connectors and glyphs land on top of them. Contiguous
    # highlighted rows share one band rather than stacking edges.
    start: int | None = None
    for index in range(len(TREE_ROWS) + 1):
        highlighted = index < len(TREE_ROWS) and TREE_ROWS[index][4]
        if highlighted and start is None:
            start = index
        elif not highlighted and start is not None:
            c.rect(
                (
                    px(MARGIN) - px(6),
                    content_top + start * row_h - px(3),
                    px(width_nominal - MARGIN) + px(6),
                    content_top + index * row_h - px(3),
                ),
                fill=p.band,
                radius=px(6),
            )
            start = None

    for index, (depth, name, desc, is_dir, _) in enumerate(TREE_ROWS):
        y = content_top + index * row_h
        mid = y + row_h // 2 - px(TREE_ROW_GAP) // 2

        if depth:
            # The vertical run for this level, and the elbow into the name.
            parent_x = px(MARGIN + TREE_INDENT) + (depth - 1) * px(TREE_INDENT) + px(3)
            c.line([(parent_x, y - px(3)), (parent_x, mid)], p.rule, px(1))
            c.line([(parent_x, mid), (parent_x + px(TREE_TICK), mid)], p.rule, px(1))
            # A last child gets an elbow and no tail below it. Anything else gets
            # the run continued, so the vertical is unbroken down the sibling set.
            if has_later_sibling(index, depth):
                c.line([(parent_x, mid), (parent_x, y + row_h - px(3))], p.rule, px(1))

        c.text(
            name_x[index],
            y,
            name,
            "mono",
            p.accent if is_dir else p.text,
        )
        if desc:
            c.text(desc_x, y + px(1), desc, "note", p.text_muted)

    return c.render()


def has_later_sibling(index: int, depth: int) -> bool:
    """
    Whether another row at exactly `depth` follows before the parent closes.

    Walk forward: a row shallower than `depth` means the parent has closed, so
    there is no further sibling. A row at exactly `depth` is that sibling. A row
    deeper than `depth` is inside this row's own subtree and says nothing either
    way, so it is skipped.

    Getting this wrong is what makes a drawn tree look broken rather than merely
    plain: a missing tail leaves a sibling apparently unparented, and a spurious
    one leaves a vertical running into empty space below the last child.
    """
    for depth_ahead, *_ in TREE_ROWS[index + 1 :]:
        if depth_ahead < depth:
            return False
        if depth_ahead == depth:
            return True
    return False


def render_hero(p: Palette) -> Image.Image:
    """
    The hero card, transparent everywhere outside its rounded rectangle.

    Built as an alpha mask rather than cropped, because an opaque surround shows
    as a rectangle around the corners on whichever GitHub theme this file is not
    for. Inset by two nominal pixels so the border stroke antialiases instead of
    clipping against the canvas edge.

    The card's height is measured from the lockup rather than fixed, so enlarging
    the mark rebalances the whole card instead of crowding the tagline.
    """
    wordmark = "Tab"
    wm_font = font("wordmark")
    wm_box = _measure.textbbox((0, 0), wordmark, font=wm_font)

    # Optical centring, not box centring. The wordmark's cap height is measured
    # from its own ink, and the mark is sized against that rather than against the
    # font's full em box, which is taller than any letterform in it.
    cap_h = wm_box[3] - wm_box[1]
    mark_h = round(cap_h * HERO_MARK_ZOOM)
    glyph = mark(mark_h)

    pad = px(34)
    tag_gap = px(28)
    rule_gap = px(20)
    rule_w, rule_h = px(46), px(3)
    height_device = (
        pad + mark_h + tag_gap + line_height("tagline") + rule_gap + rule_h + pad
    )

    c = Canvas(WIDTH, height_device / SCALE, None)
    inset = px(2)
    box = (inset, inset, c.w - inset - 1, c.h - inset - 1)

    # A vertical gradient of only a few points of lightness. More than that and it
    # reads as a gradient rather than as a lit surface.
    gradient = Image.new("RGBA", (1, c.h))
    gp = gradient.load()
    for y in range(c.h):
        t = y / max(1, c.h - 1)
        gp[0, y] = blend(p.surface, p.page, 1 - t) + (255,)
    gradient = gradient.resize((c.w, c.h))

    mask = Image.new("L", (c.w, c.h), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=px(HERO_RADIUS), fill=255)
    c.img.paste(gradient, (0, 0), mask)
    c.rect(box, outline=p.border_strong, width=px(1), radius=px(HERO_RADIUS))

    # The wordmark's cap band is centred against the mark, so the two read as one
    # lockup rather than as a large graphic with a caption stuck to its top edge.
    gap = px(22)
    total_w = glyph.width + gap + (wm_box[2] - wm_box[0])
    lockup_x = (c.w - total_w) // 2

    c.paste(glyph, (lockup_x, pad))
    c.text(
        lockup_x + glyph.width + gap - wm_box[0],
        pad + (mark_h - cap_h) // 2 - wm_box[1],
        wordmark,
        "wordmark",
        p.text,
    )

    tagline = "Post-paid billing and a credit facility for autonomous agents"
    tw = text_width(tagline, "tagline")
    ty = pad + mark_h + tag_gap
    c.text((c.w - tw) // 2, ty, tagline, "tagline", p.text_muted)

    ry = ty + line_height("tagline") + rule_gap
    c.rect(((c.w - rule_w) // 2, ry, (c.w + rule_w) // 2, ry + rule_h), fill=p.accent)

    return c.render()


def render_og_card() -> Image.Image:
    """
    One static social card, 1200 by 630, on the dark surface.

    Static rather than per-settlement: nobody shares an individual settlement
    link, and three dynamic templates is three things to keep in step with the
    brand for no reader benefit.

    Laid out at the nominal 1200 by 630 that Open Graph and Twitter document, and
    exported at EXPORT like everything else, so the file is 2400 by 1260 on the same
    1.91:1 ratio. Both consumers treat 1200 by 630 as a recommended minimum rather
    than a fixed size, and both accept well past 2400 px, so the extra resolution
    costs nothing and is the difference between crisp and soft in a feed on a
    high-density display.
    """
    p = DARK
    c = Canvas(1200, 630, p.page)

    mark_h = px(190)
    glyph = mark(mark_h)
    c.paste(glyph, (px(72), px(58)))

    x = px(72)
    y = px(58) + mark_h + px(38)
    c.text(x, y, "Tab", "og_title", p.text)
    y += line_height("og_title") + px(10)

    for row in wrap(
        "Post-paid billing and a credit facility for autonomous agents, "
        "settled by cryptographic proof rather than by a trusted facilitator.",
        "og_sub",
        px(1200 - 144),
    ):
        c.text(x, y, row, "og_sub", p.text_secondary)
        y += line_height("og_sub") + px(4)

    rule_w, rule_h = px(64), px(4)
    y += px(18)
    c.rect((x, y, x + rule_w, y + rule_h), fill=p.accent)

    footer = "Creditcoin CC3 Testnet · chain id 102031"
    c.text(x, px(630 - 72) - line_height("note"), footer, "note", p.text_muted)

    return c.render()


# --------------------------------------------------------------------------- #
# driver                                                                      #
# --------------------------------------------------------------------------- #


def build_all() -> dict[str, Image.Image]:
    return {
        "hero-light.png": render_hero(LIGHT),
        "hero-dark.png": render_hero(DARK),
        "pipeline.png": render_columns_figure(
            "One settlement, end to end",
            "Left to right in the order it happens. The accented panel is the only "
            "place an Open Tab can fall.",
            pipeline_columns(),
            ["settles on Ethereum", "submits proof material"],
            "Remove the precompile and no path remains from an Ethereum payment to a reduced Open Tab. "
            "The Watcher submits bytes and the proof builder supplies bytes; neither is trusted, and "
            "neither can assert that a settlement happened.",
        ),
        "repository.png": render_columns_figure(
            "What is in this repository",
            "Real paths, and what each one is responsible for.",
            repository_columns(),
            [],
            "Every contract, the Watcher, the SDK, the MCP server, and the figures in this README were "
            "written for this project. The two precompile interfaces were confirmed against the live "
            "chain before anything was built on them.",
        ),
        "attestcoin.png": render_columns_figure(
            "What Tab calls on the Attestcoin Protocol",
            "A question, an answer, and a verdict. The accented panel is the only "
            "place an Open Tab can fall.",
            attestcoin_columns(),
            ["attested height", "proof bytes"],
            "Every surface here is a read: the BlockProver verifies, and every ChainInfo method is a "
            "get_, an is_ or a find_. Readability consumes CTC gas and carries no protocol fee. "
            "Writability, the announced write direction, is where IOutboxAdapter already points.",
        ),
        "credit.png": render_columns_figure(
            "How much credit, and what bounds it",
            "Every figure below is a named constant in LimitLib, so the panel and the "
            "contract cannot drift apart.",
            credit_columns(),
            ["proven history", "bounded by Bond"],
            "A Bond is denominated in the Asset it backs, so a Bond and the credit it unlocks are the "
            "same unit. No rate can move the ceiling and no oracle sits on it, which is what lets the "
            "whole calculation be a pure function of things the chain already proved.",
        ),
        "tree.png": render_tree(),
        "og-card.png": render_og_card(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="report what would change and write nothing",
    )
    args = parser.parse_args()

    failures = audit()
    if failures:
        print("\nmake_readme_art: refusing to write while a contrast pair fails.")
        return 1

    print("\naccent, measured from the brand mark")
    print("-" * 74)
    print(f"  brand ink            #{'%02X%02X%02X' % BRAND_ACCENT}  (hue 180, the mark's most common ink)")
    for p in (LIGHT, DARK):
        moved = "unchanged" if p.accent == BRAND_ACCENT else "value walked to clear 4.5:1"
        print(
            f"  {p.name + ' accent':<20} #{'%02X%02X%02X' % p.accent}  "
            f"{contrast(p.accent, p.page):5.2f}:1 on page   {moved}"
        )

    mark_report()

    images = build_all()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("\nfigures")
    print("-" * 74)
    changed: list[str] = []
    for name, image in images.items():
        target = OUT_DIR / name
        from io import BytesIO

        buffer = BytesIO()
        image.save(buffer, "PNG", optimize=True)
        payload = buffer.getvalue()

        existing = target.read_bytes() if target.is_file() else None
        differs = existing != payload
        if differs:
            changed.append(name)
        if not args.check:
            target.write_bytes(payload)

        print(
            f"  {name:<18} {image.width:>5} x {image.height:<5} "
            f"{len(payload) / 1024:7.1f} KiB  "
            f"{'would change' if (differs and args.check) else ('written' if not args.check else 'unchanged')}"
        )

    print("-" * 74)
    if args.check:
        if changed:
            print(f"--check: {len(changed)} file(s) would change: {', '.join(changed)}")
            return 1
        print("--check: output is stable, nothing would change")
        return 0

    print(f"wrote {len(images)} file(s) to {OUT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
