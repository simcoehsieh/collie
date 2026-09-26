---
name: collie-upstream-sync
description: >-
  Track AltanS/collie releases from the simcoehsieh/collie fork and merge them on the operator's
  confirmation. Use when Simcoe asks to check for a new Collie release, see how far the fork is
  behind upstream, learn what a new upstream version adds, or merge upstream into the fork — "collie
  有新版嗎", "追一下 collie upstream", "collie 更新", "merge collie upstream", "collie fork 落後多少".
  Surveys the gap, compares any fork patch against an upstream fix of the same bug, photographs the
  phone and desktop PWA before and after the merge into an HTML report with a recommended scope,
  then asks before merging, rebuilding and restarting the live service.
---

# Collie upstream sync

`~/git/collie` is a **maintained fork** of `AltanS/collie` and it is also the **live service**:
launchd runs `bin/collie _exec-bridge` out of that checkout, serving `https://collie.agnex.dev` to
Simcoe's iPhone. A merge here is a deployment, not a git exercise.

`collie update` is not the path — it refuses a fork by design, and its git path would force-checkout
over local commits. Everything below is a manual merge. See `FORK.md` in the repo.

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
2. **What upstream added**, grouped by theme rather than replayed as a changelog dump. Quote
   upstream's own wording for each item (they write one line per change with its PR); do not
   paraphrase it into something vaguer. Say which items **matter for this deployment** and which do
   not — pack/tmux/zellij/Tailscale work usually does not, since this is a solo herdr install behind
   Cloudflare. That judgement is the value being added; a bare changelog paste is not.
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
standing shape** (one line per pane, never the harness's own name, no model on the row), **the
first-run screen's standing shape** (it never opens; a `TOUR_VERSION` bump must stay silent and
Settings has no row for it) and **the composer's standing shape on a physical keyboard** (an empty box
sends its keys to the pane, a box with text is a message Enter sends, a `/` over an empty box
mirrors keystrokes into the pane, and there is no Type toggle, armed strip or stop-glyph there). Each has a
pinned test, so a merge that violates one usually shows up as a red test rather than as a conflict;
a merge that violates one WITHOUT a red test is a gap in those tests and the fix includes closing
it. Do not raise these as questions — they are already decided.

#### 3b. The before/after report (every sync, before asking)

Every sync that has a release to take produces an HTML report that shows, in pictures, what the phone
and the desktop PWA look like **now** and **after the merge**, and says what Claude recommends taking.
The operator decides the scope from it. The recommendation is Claude's own judgment, stated plainly;
the operator corrects it when the direction is wrong, so hedging it into a menu of neutral options
defeats the point.

**1. Build the "after" the operator would actually get**, not upstream's tag. The tag alone lacks the
fork's skin, branding and patches, so its pictures would show differences the merge never makes.

```bash
S=~/git/collie/.claude/skills/collie-upstream-sync/scripts
$S/before-after.sh prepare v1.6.1        # before = HEAD (the phone now); after = HEAD + tag, uncommitted
```

Exit 3 means the merge conflicts. Resolve the conflicts **in the `after` worktree**
(`~/.cache/collie-upstream-sync/<tag>/after`) exactly as the 3a verdicts say, including any fork
patch re-applied on top of upstream's new structure. That resolution is the proposal the pictures
show, and phase 4 lands this same tree (below). The live checkout is untouched throughout: every
build happens in the two scratch worktrees.

**2. Choose the shots** (`shots.json`, a list of `{ "id", "fixture" }` or `{ "id", "route" }`):

| Shot | Where it comes from |
| --- | --- |
| One per upstream item that changes a pane's screen | The pane captures the release ADDED: `git diff --name-only --diff-filter=A <base> <tag> -- web/src/fixtures/panes/`. Pick the one that shows the item: for a "Collie cannot read this dialog" fix, the dialog capture. `fixture` names a file there; the harness comes from its `<harness>--` prefix |
| One per item that changes a screen other than a pane | `route`: `/` (dashboard), `/settings`, `/changes/…`, whatever the item names |
| Always: the dashboard `/` and one ordinary pane (`claude--working.txt`) | The standing shapes (dashboard row, composer) live there; a walk-back into one shows up as a picture before it shows up as a complaint |

```bash
$S/before-after.sh shoot v1.6.1 shots.json    # → ~/.cache/collie-upstream-sync/<tag>/shots/{before,after}/<id>--{phone,desktop}.jpg
```

Phone is 390×844 (iPhone CSS size), desktop 1280×800, both at 2× and both the tree's own shipped
bundle over the e2e API stub, with the fixture as the pane's text. **Look at every pair before using
it** (Read the JPEGs). A pair that shows the stub's `hello from the pane` means the fixture did not
reach the pane. A pair where before and after are identical is either a finding ("no visible change")
or a bad shot; say which. The dashboard's footer always differs by its version stamp
(`v1.13.1-dev · ec2a8df6`), so a byte diff there means nothing. It does label which build a shot is. An item that cannot be photographed (push, bridge behaviour, a CLI verb) gets
a row in the report saying 無畫面變化 and why. Never draw a mockup and present it as the app.

**3. Write the report** with the `html-presentation` skill (its palette, light-locked, self-contained;
load it first). Images reference `shots/before/…` and `shots/after/…` relative to the report file.
In this order:

| Section | Contents |
| --- | --- |
| Hero | The gap line (`1.5.2 → 1.6.1 · 3 releases · 67 commits · 2 conflicts`) and the one-sentence recommendation in the `.claimbox` |
| 建議的 scope | A table, one row per upstream item: upstream's own wording, 對這個部署 (matters / does not, and why), **建議** (採用 · 採用但以 fork gate 關掉 · 不採用 → 先不合併), and 代價 (a gate is a fork patch carried forever; say so) |
| 前後對照 | Per item that has pictures: its row's wording as the heading, then before \| after side by side for the phone, then the same for the desktop, then one line of Claude's judgment. The phone pair comes first: it is the device that matters |
| Fork patch 判定 | The 3a verdicts in fix-comparison.md's shape (ours / upstream / same defect? / verdict) |
| 可能弄壞部署的變更 | From phase 2, point 3; "沒有" is a valid answer and is said explicitly |

Git merges a release whole, so "don't take item X" is never a merge option. It means taking the
release and switching X off in the fork (as the glide was, `lib/glide.ts`), or not merging yet. Say
which one the recommendation is, and what that gate would cost.

**4. Inline and publish** to Meow's artifact library, where the phone shows it:

```bash
R=~/.cache/collie-upstream-sync/v1.6.1
python3 $S/inline_shots.py $R/report.html $R/report-inline.html   # exit 2 over 4.5 MiB → add --max-side 1400
~/git/collie/bin/collie artifact add $R/report-inline.html --title "Collie 1.5.2 → 1.6.1 前後對照" --slug collie-sync-v1-6-1   # [a-z0-9-] only: dots become dashes
```

Budget: 8 pairs (32 JPEGs) came to 4.39 MiB at `--max-side 1400` for 1.13.2. Past about 8 pairs,
use `--max-side 1200` or put only the phone pair in for the minor items.

The library keeps files up to 5 MiB and frames them `sandbox=""`, so the images must be inline and
the page must work without script. Give the operator the `open on the phone:` line it prints.

#### 3c. Ask

Then **ask the operator with `AskUserQuestion`** before touching anything. Offer, at minimum:

Put the report's link in the question text. The recommended option is the report's recommendation.

- **Merge the newest release** (name the tag), with the scope the report recommends.
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

**The suite is GREEN on this fork — 181 files, 5067 tests, zero failures.** It was not: jsdom 29
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
./bin/collie doctor --plain          # `update-source` stays red on a fork; that one is expected
curl -s http://127.0.0.1:4318/sw.js | grep -c push.apple.com   # 1 = the iOS push patch survived
# 1 = the redesign's skin.css is in the shipped stylesheet (FORK.md → "The redesign")
curl -s http://127.0.0.1:4318/ | grep -o 'assets/[^"]*\.css' | head -1 | xargs -I{} curl -s http://127.0.0.1:4318/{} | grep -c 'data-slot=mirror'
```

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
| Service | launchd `herdr.collie` → `127.0.0.1:4318` → cloudflared → `collie.agnex.dev` |
| Config | `~/.config/collie/.env` — outside the checkout, no merge can touch it |
| Deployment | Variant E (`COLLIE_SKIP_SERVE=1`), Cloudflare Access identity header, **not** Tailscale |
| Fork patches | listed by the survey; the durable record is `CHANGELOG.fork.md` |
| Never run | `collie update` — refuses a fork, and would force-checkout over local commits |
| Before/after scratch | `~/.cache/collie-upstream-sync/<tag>/{before,after,shots}` — two worktrees, never the live checkout |
| Shots | `scripts/before-after.sh` + `shots.spec.ts` + `shots.config.ts`: the tree's own bundle over the e2e API stub, installed Google Chrome (`SHOTS_CHANNEL`), port 4183 |
| Report delivery | `collie artifact add` (Meow's library, 5 MiB, `sandbox=""`); images inlined by `scripts/inline_shots.py` |
