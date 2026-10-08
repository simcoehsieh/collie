---
name: collie-upstream-sync
description: >-
  Track AltanS/collie releases from the simcoehsieh/collie fork and merge them on the operator's
  confirmation. Use when Simcoe asks to check for a new Collie release, see how far the fork is
  behind upstream, learn what a new upstream version adds, or merge upstream into the fork — "collie
  有新版嗎", "追一下 collie upstream", "collie 更新", "merge collie upstream", "collie fork 落後多少".
  Surveys the gap, sorts every upstream item into infra, new UI capability or restyle, keeps the
  fork's own UI design as the reference, compares any fork patch against an upstream fix of the same
  bug, photographs the phone before and after (changed regions outlined and zoomed) into an HTML
  report with a recommended scope, then asks before merging, rebuilding and restarting the live service.
---

# Collie upstream sync

`~/git/collie` is a **maintained fork** of `AltanS/collie` and it is also the **live service**:
launchd runs `bin/collie _exec-bridge` out of that checkout, serving `https://meow.agnex.dev` to
Simcoe's iPhone. A merge here is a deployment, not a git exercise.

`collie update` is not the path — it refuses a fork by design, and its git path would force-checkout
over local commits. Everything below is a manual merge. See `FORK.md` in the repo.

## The fork's design is the reference

The operator's UI is a deliberate design, and for this install it is better than upstream's. A sync
takes upstream's **engineering**. It does not re-converge the fork's screens on upstream's, and it
does not do compatibility work whose only result is a screen that looks more like upstream's.

Every upstream item belongs to exactly one class. The class sets the default:

| Class | What it is | Default |
| --- | --- | --- |
| **基礎層** (infra) | No new screen or control: bridge, push, notifications, harness screen-reading fixes, multiplexers, CLI, security, performance, other platforms | **Take it.** A collision with a fork patch goes through `references/fix-comparison.md` |
| **介面新功能** (new capability) | Something the operator could not do before: a new screen, view, control or alert | **Judge each one.** Take the capability drawn in the fork's design, or switch it off with a fork gate. Never take upstream's look just because it came with the capability |
| **既有畫面改版** (restyle) | Upstream moved, renamed, regrouped, re-ordered or restyled a screen that already exists | **Keep the fork's.** Resolve to the fork's side or gate it off. Carry over only the bug fixes inside the change |

Sorting rules:

- **A fix is 基礎層, even when you can see it.** A harness fix that makes a card read correctly, a
  layout fix that stops a bar floating above the home indicator, a switch that now stays on — each
  restores behaviour the design already promised. "Keep the fork's" never applies to a fix: when the
  fork's screen has the same defect, take the fix into the fork's screen (or compare the two fixes,
  `references/fix-comparison.md`, when the fork fixed it its own way).
- **One changelog line can hold two classes.** "Files shows the folder" (new capability) and "the
  Changes tab is now called Files" (restyle) are two items. Split them.
- **When unsure between capability and restyle, ask: can the operator do something new?** No → restyle.

Design rules:

- **Every screen the fork redesigned is a standing shape, listed or not** (FORK.md lists the pinned
  ones; see 3a). A restyle of such a screen is not a question for the operator.
- **Keep the fork's component, carry upstream's fixes into it.** When upstream restructures a file the
  fork redesigned, do not re-graft the fork's design onto upstream's new structure if the result looks
  worse than either one. Resolve to the fork's file and port the specific fixes.
- **Account for every fix in a kept file.** For each file resolved to the fork's side, list upstream's
  commits to it in the range (`git log --oneline <base>..<tag> -- <file>`) and say where each fix went:
  ported (name the test that pins it), already fixed in the fork, or not applicable here (say why —
  "crew only", "tmux only"). This ledger is a report section; a kept file with no ledger is how a
  security fix gets dropped silently.
- **State the cost.** A declined restyle widens the divergence, and the next merge of that file
  conflicts again. When one file keeps conflicting for this reason, say so in the report in one line.

## Workflow

Run the phases in order. **Phase 3 is a hard stop**: never merge without the operator's answer, and
never ask for it without the before/after report (3b) in front of them.

### 1. Survey

```bash
python3 ~/git/collie/.claude/skills/collie-upstream-sync/scripts/survey.py
```

Fetches `upstream --tags` (read-only w.r.t. the working tree) and prints: the fork base, how far
behind, every upstream release newer than the base, the fork-local commits a merge must not lose,
the files **both sides** touched, and upstream's own changelog entries for the new releases.

`--json` for the same facts machine-readably, `--no-fetch` when offline, `--repo` for another
checkout.

Two stop conditions, in this order:

1. **`WARNING fetch failed`** (or a `fetch_error` in the JSON) — the figures came from refs already
   on disk, so "no new release" would be an answer about **yesterday's** upstream. Report the fetch
   failure, do not report "nothing to merge", and ask whether to retry or proceed on cached refs.
   A false "you're up to date" is the worst output this skill can produce: it is indistinguishable
   from the true one and nobody goes looking.
2. **No new release, fetch fine** — say so and stop. There is nothing to decide.

Then check the tree is clean (`git -C ~/git/collie status -sb`). A dirty tree means someone was
mid-edit; report it and stop rather than merging over it.

### 2. Report what the new version adds

Turn the survey into something worth reading, in this order:

1. **The gap in one line** — `1.5.2 → 1.6.1, three releases, 67 commits, 3 fork patches at risk`.
2. **What upstream added, sorted into the three classes** (see "The fork's design is the reference").
   Split a changelog line that holds two classes. Quote upstream's own wording for each item (they
   write one line per change with its PR); do not paraphrase it into something vaguer. Say which items
   **matter for this deployment** and which do not — pack/tmux/zellij/Tailscale/crew/Windows work
   usually does not, since this is a solo herdr install behind Cloudflare. That judgement is the value
   being added; a bare changelog paste is not.
3. **Anything that could break this deployment** — changed config keys, a renamed env var, a moved
   default, anything touching `COLLIE_SKIP_SERVE`, `COLLIE_DEVICE_HEADER`, `COLLIE_PUBLIC_HOSTS`,
   push, or the service worker. Read the actual diff for these rather than trusting the changelog
   line, and check `.env.example` and `docs/deployment.md` in the range.
4. **The contested files**, and for each one whether upstream appears to have fixed the same thing a
   fork patch fixes → phase 3.

This is the CONTENT of the phase-3b report, not a terminal message. In the terminal say the gap in
one line and that the report is coming; the operator reads the rest on the page, next to the pictures.

### 3. Compare fixes, show the before/after, then ask

#### 3a. Compare fixes

For every contested file the survey lists, and for every fork patch whose subject suggests a bug
fix, decide whether upstream has now fixed **the same defect**. Load
[`references/fix-comparison.md`](references/fix-comparison.md) and follow it — it defines what
counts as the same defect, the evidence to gather, and the four possible verdicts.

**Before asking, check the standing shapes.** Some fork decisions are not patches to be compared
but SHAPES the operator has settled on, and an upstream release that walks back into one gets
re-grafted rather than accepted. They are listed in `FORK.md` — today those are **the dashboard row's
standing shape** (one line per pane, never the harness's own name, no model on the row), **the dashboard's
no-footer shape** (no Panes / Focus / Changes bar, `lib/dash-tabs.ts`), **the belt's no-pins shape** (no Switch mark,
Changes pill or clear X at its right end, `lib/belt-pins.ts`), **the headings' no-"+" shape** (no new-tab
"+" on a dashboard workspace heading, `lib/dash-tabs.ts`), **the dashboard's agents-only list** (no bare-shell rows,
`FORK_DASH_SHELLS_ON` in `lib/dash-tabs.ts`), **the summary line's no-controls shape** (no order toggle
or needs-you switch, both counts spelled, place order kept; `FORK_DASH_SUMMARY_CONTROLS_ON`), **the
terminal-first pane** (upstream's Chat is not the default; `FORK_CHAT_DEFAULT_ON` in `lib/pane-view.ts`),
**the one-tap pane header** (`FORK_HEADER_NAME_TAP_ON` in `lib/fork-shape.ts`), **the
first-run screen's standing shape** (it never opens; a `TOUR_VERSION` bump must stay silent and
Settings has no row for it) and **the composer's standing shape on a physical keyboard** (an empty box
sends its keys to the pane, a box with text is a message Enter sends, a `/` over an empty box
mirrors keystrokes into the pane, and there is no Type toggle, armed strip or stop-glyph there). Each has a
pinned test, so a merge that violates one usually shows up as a red test rather than as a conflict;
a merge that violates one WITHOUT a red test is a gap in those tests and the fix includes closing
it. Do not raise these as questions — they are already decided.

The list above is the pinned subset. **Any screen the fork redesigned counts the same way**, pinned or
not: an upstream restyle of it is declined by default (class 既有畫面改版), and the report shows the
declined items in one compact section rather than asking about each.

#### 3b. The before/after report (every sync, before asking)

Every sync that has a release to take produces an HTML report. It answers two questions, in two
separate parts, because they are decided differently:

1. **基礎層** — what changes under the hood. Decided from text: a table, no pictures needed.
2. **介面** — what the operator would see. Decided from pictures: now vs after, the changed part
   outlined and zoomed, so the difference is visible without hunting for it.

The recommendation is Claude's own judgment, stated plainly; the operator corrects it when the
direction is wrong, so hedging it into a menu of neutral options defeats the point.

**1. Build the "after" the operator would actually get**, not upstream's tag. The tag alone lacks the
fork's skin, branding and patches, so its pictures would show differences the merge never makes.
Build the after **with the recommendation applied**: restyles resolved to the fork's side, new
capabilities either drawn in the fork's design or gated off.

```bash
S=~/git/collie/.claude/skills/collie-upstream-sync/scripts
$S/before-after.sh prepare v1.6.1 --upstream   # before = HEAD; after = HEAD + tag, uncommitted;
                                               # upstream = the tag as shipped (a third tree)
```

A shot that fails in one tree does not stop the others: `shoot` keeps every picture that passed and
exits non-zero at the end, naming the trees that failed. `--upstream` adds a third worktree at the tag. Use it whenever a UI item's recommendation differs
from upstream's own look (a declined restyle, a capability redrawn in the fork's design): the
operator then sees what is being declined, not only what is kept. Its shots show upstream's own
branding; label them 「upstream 原樣」 and never present them as the merge.

Exit 3 means the merge conflicts. Resolve the conflicts **in the `after` worktree**
(`~/.cache/collie-upstream-sync/<tag>/after`) exactly as the 3a verdicts and the class defaults say.
That resolution is the proposal the pictures show, and phase 4 lands this same tree (below). The
live checkout is untouched throughout: every build happens in the scratch worktrees.

**2. Choose the shots** (`shots.json`, a list of shots):

```json
[{ "id": "dash", "route": "/" },
 { "id": "files", "route": "/", "steps": [{ "click": "role=tab[name=Files]" }, { "wait": 400 }] },
 { "id": "slash", "fixture": "claude--slash-2-1-291.txt" },
 { "id": "dash-stamp", "route": "/", "ignore": [[0, 800, 390, 44]] }]
```

| Field | Meaning |
| --- | --- |
| `fixture` | A pane capture under `web/src/fixtures/panes/` (the after tree's). The harness comes from its `<harness>--` prefix. New captures in the range: `git diff --name-only --diff-filter=A <base> <tag> -- web/src/fixtures/panes/` |
| `route` | A screen other than a pane: `/`, `/settings`, … |
| `steps` | Run before the shot, to reach a state: `{"click": "<playwright selector>"}`, `{"press": "Escape"}`, `{"wait": ms}` |
| `per` | Per-tree overrides: `{"before": {"route": …, "steps": […]}}`. A new capability's control does not exist in `before`, so its before is the screen the capability would live on, reached another way |
| `sides` | Which trees shoot this id, default all three. A restyle that the after tree declines can still be shot on all three: before and after should then be identical |
| `ignore` | CSS-pixel boxes `[x, y, w, h]` that `highlight.py` must not outline (the version stamp) |
| `devices` | `["phone"]` (default) or `["phone", "desktop"]`. Desktop only when it shows something the phone does not |

Which shots:

| Shot | When |
| --- | --- |
| One per **介面新功能** item | Always. Use `steps` to open the new thing: a picture of the screen it hides behind proves nothing |
| One per **既有畫面改版** item | Always, from the `upstream` tree: that is the declined look |
| One per **基礎層** item whose effect is visible (a card that now reads) | Optional. Only when the picture says more than the sentence. `"sides": ["before", "after"]`: the upstream tree's own branding differs on every pixel, so a third column turns the whole screen into one region and every zoom into a full page |
| The dashboard `/` and one ordinary pane (`claude--working.txt`) | Always. The standing shapes live there; a walk-back into one shows up as a picture before it shows up as a complaint |

```bash
$S/before-after.sh shoot v1.6.1 shots.json      # → <tag>/shots/{before,after,upstream}/<id>--phone.jpg
uv run --script $S/highlight.py ~/.cache/collie-upstream-sync/v1.6.1 shots.json
                                                # → <tag>/shots/hl/<id>--phone--<side>.jpg        (outlined)
                                                #   <tag>/shots/hl/<id>--phone--r<k>--<side>.jpg  (region k, enlarged)
                                                #   <tag>/shots/hl/manifest.json  (regions, which comparisons changed each)
```

Phone is 390×844 (iPhone CSS size), desktop 1280×800, both at 2×, each the tree's own shipped bundle
over the e2e API stub. `highlight.py` compares before with every other tree in RGB, merges the changed
cells into regions, outlines every region in red on every picture, and crops each region separately,
enlarged. The regions are shared, so the 現在 / 合併後 / upstream zooms of region k are the same box. **Look at every picture before using it** (Read the JPEGs). A shot that shows the stub's
`hello from the pane` means the fixture did not reach the pane. "identical" is either a finding (no
visible change, which for a declined restyle is the point) or a bad shot; say which. An item that
cannot be photographed (push, bridge behaviour, a CLI verb) is a 基礎層 row, not a picture. Never draw
a mockup and present it as the app. **A 1–2 px layout shift reads as one big region** (the whole list
below a line that grew): look at the zoom, and say "位移，看不出差別" in 看哪裡 rather than leaving
the operator to hunt for a change that is not there.

**3. Write the report** with the `html-presentation` skill (its palette, light-locked, self-contained;
load it first). Images reference `shots/…` relative to the report file. In this order:

| Section | Contents |
| --- | --- |
| Hero | The gap line (`1.5.2 → 1.6.1 · 3 releases · 67 commits · 2 conflicts`), the one-sentence recommendation in the `.claimbox`, and three counts: 基礎層 N · 介面新功能 N · 改版（不採用）N |
| 一、基礎層 | One table. Columns: 項目 (upstream's wording, shortened), 對這台 (matters / does not, and why), 建議, 代價. Rows that do not matter here go in a closed `<details>` under the table |
| 二、介面新功能 | One card per item. In order: the item in one line; **看哪裡** (one line naming each outlined region by its number); the columns 現在 · 合併後（建議）· upstream 原樣 (the third only when the recommendation differs from upstream's look), each column holding its label, the outlined full picture and that tree's zooms; then 建議 and 代價. A capability that does not exist "now" shows the screen it would live on (`per.before`) |
| 三、既有畫面改版（預設保留 fork 的） | One compact row per item: upstream's wording, what the fork keeps, and a small 現在 · upstream 原樣 pair. The operator flips a row to 採用 only by saying so |
| 保留 fork 的檔案：上游修正去向 | The ledger from the design rules: per kept file, each upstream fix and where it went |
| Fork patch 判定 | The 3a verdicts in fix-comparison.md's shape (ours / upstream / same defect? / verdict) |
| 可能弄壞部署的變更 | From phase 2, point 3; "沒有" is a valid answer and is said explicitly |

Picture layout rules, for a 390 px phone:

- **One column per tree, columns side by side in one container that scrolls sideways.** A column is
  the label, the full picture, then its zooms, top to bottom, so a tree's pictures never separate.
- **A column is at least 260 px wide.** Three columns then need a sideways swipe on the phone, and that
  is the price of legible pictures: at 160 px a 14 px label shrinks to 6 px.
- **The zooms carry the comparison**, not the full pictures: a full picture says where, its zoom says
  what. Number the regions in the 看哪裡 line the way the outlines number them (top to bottom).
- No picture without a 看哪裡 line, and no zoom without its region number.

Git merges a release whole, so "don't take item X" is never a merge option. It means taking the
release and switching X off in the fork (as the glide was, `lib/glide.ts`), resolving a restyle to
the fork's side, or not merging yet. Say which one the recommendation is, and what it costs.

**4. Inline and publish** to Meow's artifact library, where the phone shows it:

```bash
R=~/.cache/collie-upstream-sync/v1.6.1
python3 $S/inline_shots.py $R/report.html $R/report-inline.html --max-side 1200   # exit 2 over 4.5 MiB → 1000, or drop shots
~/git/collie/bin/collie artifact add $R/report-inline.html --title "Collie 1.5.2 → 1.6.1 前後對照" --slug collie-sync-v1-6-1   # [a-z0-9-] only: dots become dashes
```

Budget: the library keeps files up to 5 MiB. Over budget, cut in this order: desktop shots, then
`--max-side 1000`, then the full pictures of 基礎層 shots (keep their zooms). Never drop the upstream
column of the restyle section: it is the only evidence of what is being declined.

The library frames the page `sandbox=""`, so the images must be inline and the page must work
without script. Give the operator the `open on the phone:` line it prints.

#### 3c. Ask

Then **ask the operator with `AskUserQuestion`** before touching anything. Offer, at minimum:

Put the report's link in the question text. The recommended option is the report's recommendation.

- **Merge the newest release** (name the tag), with the scope the report recommends.
- When the report has **介面新功能** items, ask about them in a second, multi-select question:
  「哪些介面新功能要採用？」, one option per item, the recommended ones marked （建議）. Restyles are
  not asked about; they stay the fork's unless the operator raises one.
- **Merge an older release first** — when several accumulated and one is a major, or one contains a
  change worth landing alone.
- **Don't merge yet** — report only.

When a fix comparison concluded "upstream's is better, drop ours", put that in its own question:
dropping a local patch is a separate decision from taking the release, and must never ride along
inside a merge confirmation.

### 4. Merge

Merge the **release tag**, never `upstream/main` — the tip may be unreleased work in progress.

**Land the tree the operator saw.** The 3b `after` worktree already holds the merge, held open with
the verdicts applied, and it is what the pictures show. Finish it THERE: apply any scope change the
operator made in 3c (re-shoot if it changes a screen), write the `CHANGELOG.fork.md` entry, review
every contested file against its verdict (the rules below apply unchanged), commit, and then
fast-forward the live checkout to that commit:

```bash
A=~/.cache/collie-upstream-sync/v1.6.1/after
git -C $A commit                      # the merge commit, message as usual
git -C ~/git/collie merge --ff-only "$(git -C $A rev-parse HEAD)"
```

`--ff-only` refuses if `main` moved since `prepare`. Then re-run `prepare` rather than forcing it.
Without a 3b worktree, merge in the live checkout directly:

```bash
cd ~/git/collie
git merge --no-commit --no-ff v1.6.1
```

**`--no-commit` is load-bearing.** Without it a merge with no textual conflict commits itself
immediately — and a phase-3 verdict of "take upstream, drop ours" is usually exactly that case: two
non-overlapping hunks in one file, git happily keeping both, the patch you decided to drop still in
the tree. Holding the merge open is what makes the verdict applicable. Review the diff of every
contested file against its verdict, apply the verdict, then commit.

If it goes wrong at any point before the commit, `git merge --abort` puts the tree back exactly.

Conflict handling:

- **`CHANGELOG.md` must not conflict.** Fork entries live in `CHANGELOG.fork.md` precisely so this
  file stays upstream's alone. If it conflicts, a fork commit wrongly edited it — take upstream's
  side whole (`git checkout --theirs CHANGELOG.md`) and move the stray entry into
  `CHANGELOG.fork.md` in the merge commit.
- **A conflict in a file a fork patch owns** is the phase-3 verdict arriving as text. Resolve it the
  way that verdict decided; do not improvise a different answer at the conflict marker.
- **A conflict inside a restyle** resolves to the fork's side, then the bug fixes in upstream's hunks
  are ported by hand. Name each ported fix in the merge commit message.
- **Never resolve with `-X ours` or `-X theirs` wholesale.** That is how a fork silently loses a
  patch or silently reverts an upstream fix.

Add a line to `CHANGELOG.fork.md` under a heading naming the release just taken, recording any fork
patch that was **dropped** because upstream superseded it — that record is the only thing that
explains, a year later, why the fork no longer carries it.

### 5. Check the merged tree BEFORE it goes live, then rebuild

Order matters here, and it is not the obvious one. `collie build` swaps `web/dist` in as its last
step and the bridge serves that directory straight off disk, so **the build is the deployment** —
anything checked afterwards is checked on a version the phone is already being served. Test the
merged tree first, ship second.

```bash
cd ~/git/collie
bun run typecheck && (cd web && bun run typecheck)   # BOTH: the root one skips web/'s test files
cd web && bun run vitest run src/lib/push-decision.test.ts src/lib/  # the areas the merge touched
```

`CLAUDE.md` is explicit that the root typecheck does not cover `web/`'s test files and that the gap
has shipped a broken tip once.

**The suite is GREEN on this fork — 406 files, 19929 tests at 1.17.2, zero failures.** It was not: jsdom 29
never wires up `globalThis.localStorage`, and 133 tests across 18 files failed on it, which meant a
persistence regression was untestable here and a real new failure had to be found inside a wall of
expected ones. `web/src/test/setup.ts` now installs a Map-backed Storage (see its own header for the
one subtlety — the members go on `Storage.prototype`, because that is where this suite's spies go).
So **any** failure after a merge is now a finding: there is no expected-failure baseline left to
excuse it with. If an upstream merge brings the count back, say so rather than filing it under
weather.

Only once those pass:

```bash
cd ~/git/collie
bash scripts/collie-ctl.sh build     # not optional: git carries neither bin/ nor web/dist/
./bin/collie restart
./bin/collie version                 # matches the merged release
# SUPERVISED, and ONE bridge: launchd's pid is the one on the port, and no other bridge runs
launchctl print gui/$(id -u)/herdr.collie | grep -E '^\s*pid ='
lsof -nP -iTCP:4318 -sTCP:LISTEN | tail -1
ps -axo pid,command | grep '_exec-bridge' | grep -v grep
./bin/collie doctor --plain          # `update-source` stays red on a fork; that one is expected
curl -s http://127.0.0.1:4318/sw.js | grep -c push.apple.com   # 1 = the iOS push patch survived
# 1 = the redesign's skin.css is in the shipped stylesheet (FORK.md → "The redesign")
curl -s http://127.0.0.1:4318/ | grep -o 'assets/[^"]*\.css' | head -1 | xargs -I{} curl -s http://127.0.0.1:4318/{} | grep -c 'data-slot=mirror'
```

`restart` printing "falling back to an unsupervised bridge", or `collie status` saying "unsupervised —
launchd bootstrap refused", is a failure of this phase even though the phone is served: the bridge then
has no restart-on-crash and does not come back at login. On 2026-10-08 that happened on every restart
with Meow open (the old bridge drained the live feed past `start`'s bootstrap retries); the fork now
bounds the shutdown (`bridge/shutdown.ts`) and `stop` waits for the old pid (`waitForLaunchdExit`). If
it happens again, read `[bridge] shutdown: <step>` in `~/.config/collie/collie.log` for the step that
hung, and do not leave an orphaned second bridge running.

Add a `grep` like that last one for every fork patch that has a greppable fingerprint in a built
artefact. A patch that survives the merge in git but not in the bundle is the failure this step
exists to catch.

> **HARD STOP.** If anything in this phase fails — either typecheck, a test, the build, the restart,
> or a fingerprint `grep` returning 0 — **do not proceed to phase 6.** Restore service first, then
> report:
>
> ```bash
> git merge --abort                 # if the merge is still open
> git reset --hard ORIG_HEAD        # if it was already committed — nothing is pushed yet
> bash scripts/collie-ctl.sh build && ./bin/collie restart
> ```
>
> Then tell the operator what failed and what the evidence was. A failed verification that gets
> pushed anyway is worse than not merging at all: the phone loses a patch, and the git history says
> the release landed cleanly.

### 6. Land it

```bash
git push origin main
```

Then remove the scratch worktrees: `before-after.sh clean v1.6.1`.

Report to the operator: what was merged, what upstream added that matters, which fork patches
survived, which were dropped and why, and the verification output. If Simcoe is on Telegram, the
reply must go there too.

## Facts worth not re-deriving

| | |
| --- | --- |
| Fork | `git@github.com:simcoehsieh/collie.git` (SSH — HTTPS has no credential here) |
| Upstream | `https://github.com/AltanS/collie.git`, remote name `upstream` |
| Checkout | `~/git/collie`, branch `main`, **is the live service** |
| Service | launchd `herdr.collie` → `127.0.0.1:4318` → cloudflared → `meow.agnex.dev` |
| Config | `~/.config/collie/.env` — outside the checkout, no merge can touch it |
| Deployment | Variant E (`COLLIE_SKIP_SERVE=1`), Cloudflare Access identity header, **not** Tailscale |
| Fork patches | listed by the survey; the durable record is `CHANGELOG.fork.md` |
| Never run | `collie update` — refuses a fork, and would force-checkout over local commits |
| Before/after scratch | `~/.cache/collie-upstream-sync/<tag>/{before,after,upstream,shots}` — two or three worktrees, never the live checkout |
| Shots | `scripts/before-after.sh` + `shots.spec.ts` + `shots.config.ts`: the tree's own bundle over the e2e API stub, installed Google Chrome (`SHOTS_CHANNEL`), port 4183. `scripts/highlight.py` (Pillow, via `uv run --script`) outlines and zooms the differences |
| Report delivery | `collie artifact add` (Meow's library, 5 MiB, `sandbox=""`); images inlined by `scripts/inline_shots.py` |
