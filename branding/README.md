# Branding sets

Tile sets for the machines this fork runs on. **Nothing in this tree is read by the build.** The
build reads `~/.config/collie/branding/`, outside the checkout, as [FORK.md](../FORK.md) describes —
because the icon has to differ BETWEEN machines serving the same commit, and a committed value
cannot do that.

So this directory is two things a config directory cannot be: a way for the other machine to obtain
the artwork through the `git pull` it already has to do, and the recipe for redrawing it. A PNG that
only exists in a config directory is a file nobody can change six months from now.

## Installing a set

Copy the whole set — every file in it is one the build knows what to do with, and nothing else:

```bash
mkdir -p ~/.config/collie/branding
cp branding/dcard/* ~/.config/collie/branding/
bash scripts/collie-ctl.sh build && ./bin/collie restart
```

A machine that should stay stock installs nothing. With no `~/.config/collie/branding/`, the build
produces byte for byte what it produced before any of this existed.

**iOS bakes the icon in at "Add to Home Screen" and never revisits it.** An install that already
exists keeps its old icon no matter what the server now sends; it has to be removed from the home
screen and added again. Removing it also discards that PWA's site data **and its Web Push
subscription**, so it has to re-subscribe from Settings afterwards.

## The sets

| Set | Paper | For |
| --- | --- | --- |
| `dcard/` | `#006aa6` — Dcard's own brand blue, read from the `theme-color` their site serves | The work machine |
| `cat/` | `#0f1113` — the stock near-black paper, with the stock paperwhite ink | The home machine: a cat peeking over a terminal window, replacing the collie head. `favicon.svg` IS the source drawing; the PNGs are `qlmanage -t -s 1024` of it, resized with Pillow (LANCZOS) |

`branding.json` in a set names the app: `name` reaches the web manifest, `shortName` becomes both
the `<title>` and the label iOS writes under the icon. Delete the file to change the icon and keep
the name.

## Redrawing them

```bash
uv run --with pillow python branding/make.py
```

It rebuilds every tile from `web/public/`, so a set stays in step with upstream's artwork instead of
freezing whatever the mark looked like the day it was copied. The script explains its own two
non-obvious moves: why the paper is un-blended rather than repainted, and why only the iOS tile
carries the D badge.
