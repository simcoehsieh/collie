---
name: collie-upstream-sync
description: Track AltanS/collie releases from the simcoehsieh/collie fork and merge them on the operator's confirmation. Use when Simcoe asks to check for a new Collie release, see how far the fork is behind upstream, learn what a new upstream version adds, or merge upstream into the fork — "collie 有新版嗎", "追一下 collie upstream", "collie 更新", "merge collie upstream", "collie fork 落後多少". Surveys the gap, reports upstream's new features, compares any fork patch against an upstream fix of the same bug, then asks before merging, rebuilding and restarting the live service.
---

# Collie upstream sync

`~/git/collie` is a **maintained fork** of `AltanS/collie` and it is also the **live service**:
launchd runs `bin/collie _exec-bridge` out of that checkout, serving `https://collie.agnex.dev` to
Simcoe's iPhone. A merge here is a deployment, not a git exercise.

`collie update` is not the path — it refuses a fork by design, and its git path would force-checkout
over local commits. Everything below is a manual merge. See `FORK.md` in the repo.

## Workflow

Run the phases in order. **Phase 3 is a hard stop**: never merge without the operator's answer.

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

### 3. Compare fixes, then ask

For every contested file the survey lists, and for every fork patch whose subject suggests a bug
fix, decide whether upstream has now fixed **the same defect**. Load
[`references/fix-comparison.md`](references/fix-comparison.md) and follow it — it defines what
counts as the same defect, the evidence to gather, and the four possible verdicts.

Then **ask the operator with `AskUserQuestion`** before touching anything. Offer, at minimum:

- **Merge the newest release** (name the tag).
- **Merge an older release first** — when several accumulated and one is a major, or one contains a
  change worth landing alone.
- **Don't merge yet** — report only.

When a fix comparison concluded "upstream's is better, drop ours", put that in its own question:
dropping a local patch is a separate decision from taking the release, and must never ride along
inside a merge confirmation.

### 4. Merge

Merge the **release tag**, never `upstream/main` — the tip may be unreleased work in progress.

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
has shipped a broken tip once. Note also that the full `vitest` suite has ~133 pre-existing failures
on this machine (`localStorage is not a function` — a vitest environment fault, unrelated to any
change). Do not report those as regressions; compare against a clean tree before claiming the merge
broke something.

Only once those pass:

```bash
cd ~/git/collie
bash scripts/collie-ctl.sh build     # not optional: git carries neither bin/ nor web/dist/
./bin/collie restart
./bin/collie version                 # matches the merged release
./bin/collie doctor --plain          # `update-source` stays red on a fork; that one is expected
curl -s http://127.0.0.1:4318/sw.js | grep -c push.apple.com   # 1 = the iOS push patch survived
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
