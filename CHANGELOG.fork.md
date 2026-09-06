# Fork changelog

Changes that exist only in `simcoehsieh/collie`, newest first. Upstream's own history stays in
[`CHANGELOG.md`](./CHANGELOG.md), **untouched** — that file is the one place a `git merge
upstream/main` would otherwise conflict on every single release, because upstream appends at exactly
the spot a fork entry would sit. Keeping the two lists apart makes an upstream merge conflict-free by
construction, and a conflict that never happens cannot be resolved wrong in a hurry.

Same style as upstream's: one short line per change, landing order within a section, no commit hash.
Version headings are upstream's — a fork entry records which upstream release it landed on top of,
not a version of its own (`bin/collie version` reports upstream's number plus the commit, and that
stays true).

## On top of 1.5.3

Merged `v1.5.3` on 2026-09-06. It touched `cli/update*` only — release tag reads now use git's
explicit `https::` transport so an `insteadOf` rewrite cannot send them to SSH (#170) — and nothing
in it is fork-patched, so no local patch was dropped and none needed re-applying. The merge was
textually clean: no file was touched by both sides.

- **Pick a folder for a new space instead of typing its path.** A new `GET /api/dirs` answers with
  DIRECTORY NAMES and nothing else — no files, no sizes, no contents — rooted at the operator's home
  and enforced on the RESOLVED path, so a `..` or a symlink is refused after the kernel has said
  where it lands rather than before. Gated on write although it writes nothing: a device that may
  not create a space has no use for the list. The sheet browses one tap per level, with a shortcut
  strip built from the directories already open (repo roots first, then pane cwds), and the manual
  path field stays below it for everything the picker deliberately cannot reach. Every filesystem
  call is on a deadline: the operator's own `~` never answered at first, because one symlink in it
  resolves into `~/Library/CloudStorage/`, and the bridge — started by launchd without Full Disk
  Access — waits on that forever. One unresponsive entry now costs its own row and nothing else.
- **The tab strip's "+" can open an agent.** Hold it to choose which launcher row it runs — or a
  plain shell, which is the default and what every install shipped with. The pin is stored as the
  row's `command`, so renaming a row in `launchers.toml` keeps it working and deleting one falls
  back to the shell rather than failing a create nobody remembers configuring. No new plumbing:
  `POST /api/launch` already opened a tab beside a named pane, and the "+" had no way to ask for it.
  Holding it no longer hands iOS the page to highlight. Three rounds, and the first two were the
  wrong model: iOS does not give up when the pressed element is unselectable, it walks UP for the
  nearest SELECTABLE ancestor — so `select-none` on the button moved the selection one level out and
  `select-none` on the scroller moved it out again. The walk ends only at an unselectable ROOT, so on
  a device with no mouse the chrome is now unselectable from `body` down and CONTENT is exempted by
  name (`pre`, `code`, form controls, `[data-selectable]`). Desktop is untouched. Each row in that
  sheet also carries its agent's own mark — the same tile the tab strip and the herd list already
  draw, resolved from the row's COMMAND (`codex --profile work` and `/opt/homebrew/bin/codex` are
  both codex) rather than from a second list of names; a row whose first word names no agent gets
  the neutral initials tile the component already falls back to.
  Antigravity's tile is the real mark now: upstream drew a triangle "A" in white on Google blue —
  the one brand entry with no source cited beside it — and the actual logo is a rounded arch with a
  four-colour gradient. With no official vector to take a path from, this embeds Google's own
  `apple-touch-icon.png` (cropped, 80px WebP, 3.0 kB) through SVG `<image>` in the same tile, rather
  than tracing it by hand the way the wrong one got there. Orca answers this by fetching each
  agent's favicon by domain at runtime; Collie does not copy that — it would need a third-party
  image host in the CSP, tell that host which agents you run, and show nothing offline.

- The mirror's font ceiling goes 16 → 24, for the desktop. Measured in a 1908px browser window: the
  pane view's column is 1400px and the reply field 1320px, but a herdr pane is 84 columns, so at the
  default 10px the terminal draws 504px and the rest of the width has nothing in it. The mirror was
  never narrow — the terminal is — and the only lever that fills the width without touching the
  source pane is the glyph. 16 was a phone's ceiling that had quietly become everyone's.
- **The test suite is green: 181 files, 5067 tests, zero failures.** jsdom 29 defines `Storage` but
  never wires up `globalThis.localStorage`, so 133 tests across 18 files had been failing on it —
  meaning no test in this repo could catch a persistence regression, and a real new failure had to be
  spotted inside a wall of expected ones. `web/src/test/setup.ts` installs a Map-backed Storage whose
  members live on `Storage.prototype`, because that is where this suite's own Safari-private-mode
  spies go. Three assertions that had gone unrun since `controlsOpen` landed are corrected with it.

- The Controls row (Keys / Type / Quick / Agent / ⚙) can be put away, and the status band above it
  is the handle — a surface that was already on screen in both states, so collapsing costs nothing
  to reach. Measured on a 393x852 phone: the terminal mirror gains 40px (the row's 44px plus its
  8px/6px margins, less the 18px the band grows by to stay tappable while it is the only way back).
  Persisted with the other display prefs, so it survives a pane switch and a restart; default is
  open, so an install that never touches it renders exactly what it always did. The band reads
  leading-edge now — handle, machine, state as one group — because a right-aligned word with a lone
  chevron at the far end reads as two unrelated things once the band grows to 32px.
- A home-screen web app fills the screen again, and the fix is the viewport meta rather than any
  CSS height. On iOS 26 `viewport-fit=cover` produced two answers at once: a layout viewport of 793
  on an 852pt screen — already 852 minus a status bar, i.e. sized for an INSET web view — while the
  page was still placed under the status bar and `env(safe-area-inset-top)` still reported 59. iOS
  letterboxed the 59pt difference in page colour above the home indicator, and no CSS reaches it:
  stretching the shell to `lvh` (852) put the composer off the bottom of the screen instead, which
  is what proved whose 793 to believe. Cover is dropped and the status-bar style is `default`, so
  the web view is inset for real, every `env()` reads 0 and the OS paints the bands it reserves.
  The shell stays exactly `100dvh` — the invariant that keeps the Send button reachable.
- …and the home indicator's band is a token, `--safe-bottom`, because with cover gone the platform
  can no longer report it: every `env()` reads 0 by definition, while iOS 26 still runs the page to
  the physical bottom edge, so the composer's last row came out under the indicator — invisible in a
  screenshot, plainly cut on the glass. In standalone the reserve has a floor of 34px (Apple's own
  portrait inset, and therefore what normal looks like); elsewhere `max()` leaves the platform's
  number in charge. Every surface that reserved that band — composer, sheets, toasts, both footers,
  zen — reads the one token now.
- An iPhone's push subscription survives normal use: on a push service that revokes one for
  answering a push with silence (Apple's, after three), a retraction now replaces the alert with a
  quiet "Nothing needs you", and a visible tab shows the alert instead of suppressing it. Chrome and
  Firefox keep the silent paths the code was written against, so the change is opt-in per push
  service rather than a behaviour swap. See [`FORK.md`](./FORK.md) for why this fork carries it.
- `bun build --compile`'s temp artefact is ignored, so a build no longer stamps the version `-dirty`
  and `git status` stays a usable pre-merge check.
- `collie-upstream-sync` skill: surveys the gap to upstream, reports what a new release adds,
  compares each fork patch against an upstream fix of the same defect, and asks before merging,
  rebuilding and restarting. Lives in this repo, symlinked into both agent runtime roots.
- `collie-upstream-sync` hardened after review: prerelease tags compare numerically (`beta.10` after
  `beta.9`), a rename reports both paths so a moved fork-patched file still shows as contested, the
  survey is one `git log` instead of one subprocess per commit, a failed `git fetch` can no longer
  read as "nothing to merge", the merge is held open with `--no-commit` so a drop-ours verdict is
  applicable, and verification failure is a hard stop before the push.
- `collie-upstream-sync` again after a second review: a strict install is never offered a prerelease
  (upstream's own ADR 0020 rule), the survey exits non-zero when it never reached upstream, the
  contested set comes from the effective diff so a second sync is not wrong, an unreadable upstream
  CHANGELOG is reported rather than read as "no changes", and tests run before the build that
  deploys them.
