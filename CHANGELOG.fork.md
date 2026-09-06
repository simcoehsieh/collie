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

## On top of 1.5.2

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
