#!/usr/bin/env bash
# Before/after screenshots for an upstream sync — phase 3 of collie-upstream-sync.
#
#   before-after.sh prepare <tag> [--before <ref>] [--after-ref <ref>] [--upstream]
#       Two scratch worktrees under $DIR/<tag>/: `before` at <ref> (default HEAD, i.e. what the
#       phone runs now) and `after` = HEAD with <tag> merged, uncommitted. Exits 3 when the merge
#       conflicts: resolve the conflicts IN THE `after` WORKTREE the way the phase-3 verdicts say
#       (git's rerere records it, and phase 4 in the live checkout replays it), then run `shoot`.
#       --after-ref skips the merge and checks out that ref instead (a merge already made).
#       --upstream adds a third worktree, `upstream`, at <tag> as shipped: the look a declined
#       restyle would have brought, so the report can show what is being declined.
#   before-after.sh shoot <tag> <shots.json>
#       Builds each tree's PWA and photographs every shot in shots.json at phone (390x844) and
#       desktop (1280x800) size, into $DIR/<tag>/shots/{before,after[,upstream]}/<id>--<device>.jpg.
#   before-after.sh clean <tag>
#       Removes both worktrees and the directory.
#
# The live checkout is never built or touched: `vite build` there would swap web/dist under the
# running bridge (the build IS the deployment). Everything happens in the scratch worktrees.
set -euo pipefail

REPO="${COLLIE_REPO:-$HOME/git/collie}"
DIR="${COLLIE_SYNC_DIR:-$HOME/.cache/collie-upstream-sync}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

# node_modules from the live checkout, as an APFS clone (instant, no disk), when the lockfile is the
# same; a real install when the release changed dependencies.
deps() {
  local tree="$1" sub
  for sub in . web; do
    [ -d "$tree/$sub/node_modules" ] && continue
    if cmp -s "$REPO/$sub/bun.lock" "$tree/$sub/bun.lock" && [ -d "$REPO/$sub/node_modules" ]; then
      cp -cR "$REPO/$sub/node_modules" "$tree/$sub/node_modules"
    else
      echo "  $sub: lockfile changed, bun install" >&2
      (cd "$tree/$sub" && bun install --frozen-lockfile >/dev/null)
    fi
  done
}

cmd="${1:-}"; tag="${2:-}"
[ -n "$cmd" ] && [ -n "$tag" ] || die "usage: $0 prepare|shoot|clean <tag> …"
base="$DIR/$tag"

case "$cmd" in
  prepare)
    shift 2
    before_ref=HEAD; after_ref=""; with_upstream=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --before) before_ref="$2"; shift 2 ;;
        --after-ref) after_ref="$2"; shift 2 ;;
        --upstream) with_upstream=1; shift ;;
        *) die "unknown flag $1" ;;
      esac
    done
    [ -e "$base" ] && die "$base exists — run \`$0 clean $tag\` first"
    mkdir -p "$base"
    git -C "$REPO" worktree add --quiet --detach "$base/before" "$before_ref"
    if [ "$with_upstream" = 1 ]; then
      git -C "$REPO" worktree add --quiet --detach "$base/upstream" "$tag"
      echo "upstream $base/upstream  ($tag as shipped)"
    fi
    if [ -n "$after_ref" ]; then
      git -C "$REPO" worktree add --quiet --detach "$base/after" "$after_ref"
    else
      git -C "$REPO" worktree add --quiet --detach "$base/after" HEAD
      if ! git -C "$base/after" merge --no-commit --no-ff "$tag" >/dev/null 2>&1; then
        unresolved="$(git -C "$base/after" diff --name-only --diff-filter=U)"
        if [ -n "$unresolved" ]; then
          echo "CONFLICTS in $base/after — resolve per the phase-3 verdicts, then \`shoot\`:" >&2
          echo "$unresolved" | sed 's/^/  /' >&2
          exit 3
        fi
      fi
    fi
    echo "before  $base/before  $(git -C "$base/before" rev-parse --short HEAD)"
    if [ -n "$after_ref" ]; then note="$after_ref"; else note="HEAD + $tag, uncommitted"; fi
    echo "after   $base/after   ($note)"
    ;;

  shoot)
    spec="${3:-}"
    [ -f "$spec" ] || die "shots.json not found: $spec"
    spec="$(cd "$(dirname "$spec")" && pwd)/$(basename "$spec")"
    [ -d "$base/after" ] || die "no worktrees — run \`$0 prepare $tag\` first"
    [ -z "$(git -C "$base/after" diff --name-only --diff-filter=U)" ] || die "the after tree still has conflicts"
    failed=""
    for side in before after upstream; do
      tree="$base/$side"
      [ -d "$tree" ] || continue
      echo "── $side ($tree)" >&2
      deps "$tree"
      (cd "$tree/web" && bunx vite build --logLevel error)
      cp "$HERE/shots.spec.ts" "$tree/web/e2e/collie-sync-shots.spec.ts"
      cp "$HERE/shots.config.ts" "$tree/web/collie-sync-shots.config.ts"
      rm -rf "$base/shots/$side"
      status=0
      (cd "$tree/web" && SHOTS_SPEC="$spec" SHOTS_SIDE="$side" SHOTS_FIXTURES="$base/after/web/src/fixtures/panes" \
        SHOTS_OUT="$base/shots/$side" bunx playwright test -c collie-sync-shots.config.ts) || status=$?
      rm -f "$tree/web/e2e/collie-sync-shots.spec.ts" "$tree/web/collie-sync-shots.config.ts"
      # One failed shot must not cost the other trees theirs: note it, shoot on, fail at the end.
      [ "$status" -eq 0 ] || { echo "  $side: playwright failed ($status) — the shots that passed are kept" >&2; failed="$failed $side"; }
    done
    echo "$base/shots"
    [ -z "$failed" ] || die "shots failed on:$failed (see above; fix the selector or add a per-side override)"
    ;;

  clean)
    for side in before after upstream; do
      [ -d "$base/$side" ] && git -C "$REPO" worktree remove --force "$base/$side"
    done
    rm -rf "$base"
    ;;

  *) die "unknown command $cmd" ;;
esac
