#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10"]
# ///
"""Outline what changed between the shots of one screen, and crop each change enlarged.

    uv run --script highlight.py <sync dir> <shots.json>

<sync dir> is ~/.cache/collie-upstream-sync/<tag>; its shots/{before,after[,upstream]}/ hold the
JPEGs `before-after.sh shoot` wrote. For every shot and device, `before` is the base and is compared
with every other side that was shot (`after`, `upstream`). The changed cells of all comparisons are
merged, so the regions — and therefore every crop — are THE SAME BOXES on every side: the 現在,
合併後 and upstream 原樣 zooms of one region show the same part of the screen.

Into shots/hl/ (everything for that shot and device is deleted first, so a re-shoot that became
identical leaves no stale zoom behind):

    <id>--<device>--<side>.jpg           the full picture, every region outlined in red
    <id>--<device>--r<k>--<side>.jpg     region k, cropped with a margin and enlarged to ZOOM_WIDTH
    manifest.json                        per shot and device: the sides, each region's CSS box, which
                                         comparisons changed it, and the files written

A shot's `ignore` boxes (CSS px, [x, y, w, h]) are never outlined — the dashboard's version stamp
differs on every build. The diff is coarse on purpose: a cell is 8 CSS px, it counts when enough of
its pixels moved in ANY colour channel, cells within two of each other merge into one region, and a
one-cell region is noise (anti-aliasing, a caret). It finds WHERE to look; the report's 看哪裡 line
says WHAT changed.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

SCALE = 2  # shots are taken at deviceScaleFactor 2
CELL = 8 * SCALE  # px per grid cell
PIX_THRESHOLD = 28  # largest per-channel difference that counts as a changed pixel
CELL_SHARE = 0.03  # share of a cell's pixels that must change for the cell to count
MIN_CELLS = 2
MAX_REGIONS = 6
RED = (200, 63, 73)  # Folio --bad
ZOOM_WIDTH = 900  # px; every crop is scaled to this width, at most 3x up
MARGIN = 12 * SCALE
SIDES = ("before", "after", "upstream")

Cell = tuple[int, int]
Box = tuple[int, int, int, int]


def changed_cells(a: Image.Image, b: Image.Image) -> set[Cell]:
    # Every channel, not grey: a red mark that turns green can keep its luminance.
    r, g, bl = ImageChops.difference(a.convert("RGB"), b.convert("RGB")).split()
    diff = ImageChops.lighter(ImageChops.lighter(r, g), bl).point(lambda v: 255 if v > PIX_THRESHOLD else 0)
    gw, gh = -(-a.width // CELL), -(-a.height // CELL)
    means = diff.resize((gw, gh), Image.Resampling.BOX)  # mean = share of changed pixels × 255
    return {(x, y) for y in range(gh) for x in range(gw) if means.getpixel((x, y)) > 255 * CELL_SHARE}


def drop_ignored(cells: set[Cell], ignore: list[list[int]]) -> set[Cell]:
    for ix, iy, iw, ih in ignore:
        x0, y0 = ix * SCALE // CELL, iy * SCALE // CELL
        x1, y1 = -(-(ix + iw) * SCALE // CELL), -(-(iy + ih) * SCALE // CELL)
        cells = {(x, y) for x, y in cells if not (x0 <= x < x1 and y0 <= y < y1)}
    return cells


def regions(cells: set[Cell]) -> list[tuple[Box, set[Cell]]]:
    """Groups of cells within two cells of each other, as pixel boxes, largest first (top to bottom
    among the kept ones, so r1 is the highest on screen)."""
    left, out = set(cells), []
    while left:
        stack, group = [left.pop()], set()
        while stack:
            x, y = stack.pop()
            group.add((x, y))
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    n = (x + dx, y + dy)
                    if n in left:
                        left.remove(n)
                        stack.append(n)
        if len(group) < MIN_CELLS:
            continue
        xs, ys = [g[0] for g in group], [g[1] for g in group]
        out.append(((min(xs) * CELL, min(ys) * CELL, (max(xs) + 1) * CELL, (max(ys) + 1) * CELL), group))
    out.sort(key=lambda r: (r[0][2] - r[0][0]) * (r[0][3] - r[0][1]), reverse=True)
    kept = out[:MAX_REGIONS]
    kept.sort(key=lambda r: (r[0][1], r[0][0]))
    return kept


def outline(img: Image.Image, boxes: list[Box]) -> Image.Image:
    out = img.convert("RGB").copy()
    d = ImageDraw.Draw(out)
    for x0, y0, x1, y1 in boxes:
        d.rectangle(
            (max(x0 - 4, 0), max(y0 - 4, 0), min(x1 + 4, img.width - 1), min(y1 + 4, img.height - 1)),
            outline=RED,
            width=3 * SCALE,
        )
    return out


def crop(img: Image.Image, box: Box) -> Image.Image:
    x0, y0 = max(box[0] - MARGIN, 0), max(box[1] - MARGIN, 0)
    x1, y1 = min(box[2] + MARGIN, img.width), min(box[3] + MARGIN, img.height)
    part = img.convert("RGB").crop((x0, y0, x1, y1))
    width = min(ZOOM_WIDTH, part.width * 3)
    return part.resize((width, round(part.height * width / part.width)), Image.Resampling.LANCZOS)


def one(shots: Path, shot: dict, device: str) -> dict:
    sid = shot["id"]
    hl = shots / "hl"
    hl.mkdir(exist_ok=True)
    for stale in hl.glob(f"{sid}--{device}--*"):
        stale.unlink()
    imgs = {s: Image.open(p) for s in SIDES if (p := shots / s / f"{sid}--{device}.jpg").is_file()}
    entry: dict = {"sides": list(imgs), "regions": [], "pairs": {}, "files": {}}
    if not imgs:
        print(f"{sid} {device}: no shots")
        return entry
    base = "before" if "before" in imgs else next(iter(imgs))
    per_pair: dict[str, set[Cell]] = {}
    for side, img in imgs.items():
        if side == base:
            continue
        pair = f"{base}→{side}"
        if img.size != imgs[base].size:
            # A page of another height cannot be diffed cell by cell. Say so; the pictures still go out.
            entry["pairs"][pair] = f"sizes differ {imgs[base].size} vs {img.size}"
            continue
        per_pair[pair] = drop_ignored(changed_cells(imgs[base], img), shot.get("ignore", []))
    found = regions(set().union(*per_pair.values()) if per_pair else set())
    boxes = [box for box, _ in found]
    for pair, cells in per_pair.items():
        entry["pairs"][pair] = [k + 1 for k, (_, group) in enumerate(found) if group & cells] or "identical"
    entry["regions"] = [[v // SCALE for v in (b[0], b[1], b[2] - b[0], b[3] - b[1])] for b in boxes]
    for side, img in imgs.items():
        full = hl / f"{sid}--{device}--{side}.jpg"
        outline(img, boxes).save(full, quality=80)
        files = {"full": full.name, "zooms": []}
        for k, box in enumerate(boxes, start=1):
            z = hl / f"{sid}--{device}--r{k}--{side}.jpg"
            crop(img, box).save(z, quality=82)
            files["zooms"].append(z.name)
        entry["files"][side] = files
    print(f"{sid} {device}: sides {list(imgs)} · regions {entry['regions']} · {entry['pairs']}")
    return entry


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 1
    shots = Path(sys.argv[1]).expanduser() / "shots"
    spec = json.loads(Path(sys.argv[2]).read_text())
    manifest = {shot["id"]: {d: one(shots, shot, d) for d in shot.get("devices", ["phone"])} for shot in spec}
    (shots / "hl" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
