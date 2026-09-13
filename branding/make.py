#!/usr/bin/env python3
"""Regenerate the per-machine tile sets in this tree from `web/public/`.

    uv run --with pillow python branding/make.py

Nothing here is read at build time. The build reads `~/.config/collie/branding/` — see
[FORK.md](../FORK.md) — and this tree only exists so a second machine can obtain the artwork through
the `git pull` it has to do anyway, and so the drawing can be REDONE rather than recovered from a
PNG nobody remembers making.

HOW THE TILES ARE MADE. The stock tile is flat ink on a near-black paper with no alpha, so its paper
cannot simply be swapped: every anti-aliased edge is already a blend of ink and THAT paper, and a
threshold repaint leaves a dark fringe around the whole drawing. `unblend` undoes the blend instead —
it reads each pixel as "ink over the old paper", recovers the ink and how much of the pixel it
covers, and hands both back. The mark can then be re-composited over any paper with its edges and
the orbit's coloured beads intact.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "web" / "public"

SS = 4  # supersample factor for anything DRAWN, so its curves match the traced ones beside them
PAPERWHITE = (0xF2, 0xF0, 0xEC)  # the mark's own off-white, reused so the badge belongs to it

# Dcard's own brand blue, read from the `theme-color` its site serves rather than eyeballed.
DCARD_BLUE = (0x00, 0x6A, 0xA6)

# Every flat-paper tile Collie serves, and whether the badge belongs on it.
#
# ONLY the iOS tile is badged. The manifest pair is `purpose: "any maskable"`, so Android may crop it
# to the inner 80% — which is exactly where a corner badge lives — and iOS never reads those files
# anyway. The favicons are 16-32px in practice, where a badge is mush. So the badge rides the one
# file that is actually the home screen icon, and the colour does the work everywhere else.
TILES = [
    ("apple-touch-icon.png", 180, True),
    ("favicon-96x96.png", 96, False),
    ("web-app-manifest-192x192.png", 192, False),
    ("web-app-manifest-512x512.png", 512, False),
    ("notification-icon-192x192.png", 192, False),
]


def unblend(path: Path):
    """(ink RGB, alpha L) for a flat-paper tile. The paper is whatever the corner pixel is."""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    paper = px[0, 0]
    ink, alpha = Image.new("RGB", (w, h)), Image.new("L", (w, h))
    ip, ap = ink.load(), alpha.load()
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            a = max(abs(p[i] - paper[i]) for i in range(3)) / 255.0
            if a <= 0.002:
                ap[x, y] = 0
                continue
            ap[x, y] = round(a * 255)
            ip[x, y] = tuple(
                min(255, max(0, round((p[i] - paper[i] * (1 - a)) / a))) for i in range(3)
            )
    return ink, alpha


def d_glyph(draw, box, fg, thickness, counter):
    """A geometric capital D — a stem and a half-round bowl, built from shapes rather than a font.

    Squarish and mechanical on purpose. It sits beside Aldrich, the app's own face, and it has to
    look nothing like Dcard's own mark, whose D is a frame around a figure — a Collie head inside a
    D's bowl would read as an imitation of their app, on the same home screen as their app.
    """
    x0, y0, x1, y1 = box
    r = (y1 - y0) / 2
    xc = x1 - r
    draw.rectangle([x0, y0, xc, y1], fill=fg)
    draw.pieslice([xc - r, y0, xc + r, y1], -90, 90, fill=fg)
    ri = r - thickness
    draw.rectangle([x0 + thickness, y0 + thickness, xc, y1 - thickness], fill=counter)
    draw.pieslice([xc - ri, y0 + thickness, xc + ri, y1 - thickness], -90, 90, fill=counter)


def badge_layer(size, paper):
    """A white disc carrying a blue D, inset from the low-right corner. Geometry is in 180ths.

    Two things set the size and position. It must not compete with the mark — the drawing already
    carries an orbit and eight beads, so a badge big enough to sit in the middle of that labels
    nothing. And it must clear iOS's squircle, whose bottom-right arc is centred at (140, 140) with
    a radius of about 40 on a 180px tile: anything outside that arc gets a flat edge shaved off it.
    """
    k = size / 180
    lay = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    cx = cy = 135 * k * SS

    def disc(radius, fill):
        r = radius * k * SS
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)

    disc(33, paper + (255,))  # a ring of paper, so the orbit never touches the badge
    disc(28, PAPERWHITE + (255,))
    d_glyph(
        d,
        [(cx - 11 * k * SS), (cy - 14 * k * SS), (cx + 12 * k * SS), (cy + 14 * k * SS)],
        DCARD_BLUE + (255,),
        6 * k * SS,
        counter=PAPERWHITE + (255,),
    )
    return lay


def build(out: Path, paper):
    out.mkdir(parents=True, exist_ok=True)
    for name, size, badged in TILES:
        src = PUBLIC / name
        if not src.exists():
            raise SystemExit(f"{src} is gone — upstream renamed a tile; update TILES")
        ink, alpha = unblend(src)
        tile = Image.new("RGB", (size, size), paper)
        tile.paste(ink, (0, 0), alpha)
        if badged:
            lay = badge_layer(size, paper).resize((size, size), Image.LANCZOS)
            tile = Image.alpha_composite(tile.convert("RGBA"), lay).convert("RGB")
        tile.save(out / name, optimize=True)

    # The tab icon most browsers actually prefer. One flat rect carries the paper, so this is a
    # colour swap and nothing else — the traced head is untouched.
    svg = (PUBLIC / "favicon.svg").read_text(encoding="utf8")
    stock_paper = "#0f1113"
    if svg.count(f'fill="{stock_paper}"') != 1:
        raise SystemExit("favicon.svg's paper is no longer a single flat rect — check the source")
    new_paper = "#%02x%02x%02x" % paper
    (out / "favicon.svg").write_text(
        svg.replace(f'fill="{stock_paper}"', f'fill="{new_paper}"'), encoding="utf8"
    )

    Image.open(out / "favicon-96x96.png").save(
        out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)]
    )


if __name__ == "__main__":
    build(Path(__file__).resolve().parent / "dcard", DCARD_BLUE)
    print("wrote branding/dcard/")
