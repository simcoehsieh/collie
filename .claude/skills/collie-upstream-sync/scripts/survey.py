#!/usr/bin/env python3
"""Survey the gap between this fork and upstream — every fact the merge decision needs, in one pass.

Read-only with respect to the working tree. `git fetch` is the only thing it writes, and only to
remote-tracking refs (pass --no-fetch to skip even that). It never checks out, merges, or resets:
the skill decides, the operator confirms, and the merge happens afterwards by hand.

Output is JSON on stdout (--json) or a human digest (default). The JSON exists so a second run can
be diffed against the first; the digest exists because that is what gets shown to the operator.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

# `## [1.6.0] - 2026-09-20` — upstream's changelog heading. `## [Unreleased]` deliberately does not
# match: it is not a release, and this tool only ever reports things someone decided to ship.
RELEASE_HEADING = re.compile(r"^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]")
VERSION_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$")


class GitError(RuntimeError):
    pass


def git(repo: Path, *args: str, check: bool = True) -> str:
    r = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
    )
    if check and r.returncode != 0:
        raise GitError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def tail_key(tail: str) -> list:
    """Compare a prerelease tail NUMERICALLY where it is numeric: `beta.9` before `beta.10`.

    Lexically `"beta.10" < "beta.9"`, which would pick beta.9 as the newest of a train that has
    reached double digits — and upstream's own history has `v1.0.0-beta.45` through `beta.49`, so
    this is a reachable wrong answer, not a hypothetical one. Split into digit and non-digit runs and
    compare each run in its own domain. `(0, int)` sorts every numeric run below every alphabetic one
    so the tuple never compares int against str.
    """
    return [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.split(r"(\d+)", tail) if p]


def version_key(tag: str) -> tuple:
    """Sort key for a `vX.Y.Z[-tail]` tag. A prerelease sorts BELOW its own release (PEP 440 / semver
    rule), so `v1.6.0-beta.1` never outranks `v1.6.0` and a beta is never proposed as the newer
    thing to merge."""
    m = VERSION_TAG.match(tag)
    if not m:
        return (0, 0, 0, 0, [])
    major, minor, patch, tail = m.groups()
    # 1 = final release, 0 = prerelease.
    return (int(major), int(minor), int(patch), 0 if tail else 1, tail_key(tail or ""))


def commits(repo: Path, rng: str) -> list[dict]:
    """One entry per non-merge commit in `rng`, with the files it touched.

    Merges are excluded on purpose: on a fork that merges upstream repeatedly, the merge commits are
    the fork's own bookkeeping and would otherwise be reported as "changes" with no content.

    ONE `git log` for the whole range, not one `git show` per commit — a hundred commits behind is a
    normal amount to be, and that shape cost a hundred and one subprocesses.

    `--name-status -M` rather than `--name-only`, so a RENAME reports both paths. Upstream moving a
    file the fork has patched is precisely when the operator must be told the file is contested, and
    a rename recorded only under its new name would have reported no overlap at all — the quiet
    wrong answer, in the one case that most needs the loud one.
    """
    marker = "\x01"
    raw = git(
        repo,
        "log",
        "--no-merges",
        "-M",
        "--name-status",
        f"--format={marker}%H%x00%an%x00%ad%x00%s",
        "--date=short",
        rng,
    )
    out: list[dict] = []
    cur: dict | None = None
    for line in raw.splitlines():
        if line.startswith(marker):
            if cur:
                out.append(cur)
            sha, author, date, subject = line[len(marker) :].split("\0", 3)
            cur = {"sha": sha[:9], "author": author, "date": date, "subject": subject, "files": []}
            continue
        if cur is None or not line.strip():
            continue
        # "M\tpath" · "A\tpath" · "R096\told\tnew" — take every path field, so both ends of a rename
        # land in the set the overlap is computed from.
        parts = line.split("\t")
        for p in parts[1:]:
            if p and p not in cur["files"]:
                cur["files"].append(p)
    if cur:
        out.append(cur)
    return out


def changelog_sections(repo: Path, ref: str, after: str | None) -> list[dict]:
    """Upstream's own release notes for everything newer than `after`, read out of CHANGELOG.md AT
    `ref` — not from the working tree, which is the fork's copy and may say something else.

    This is the answer to "what did the new version add". Upstream writes one line per change with
    the PR it answers, which is a better feature list than any diff summary that could be derived
    here, so it is quoted rather than paraphrased.
    """
    try:
        text = git(repo, "show", f"{ref}:CHANGELOG.md")
    except GitError as e:
        # Raise rather than return []. An unreadable CHANGELOG and a CHANGELOG with no release
        # sections are the same empty list to the caller, and phase 2 would then silently skip the
        # entire "what's new" report — the one part of this survey a human cannot reconstruct from
        # the other fields.
        raise GitError(f"could not read CHANGELOG.md at {ref}: {e}") from e
    sections: list[dict] = []
    current: dict | None = None
    for line in text.splitlines():
        m = RELEASE_HEADING.match(line)
        if m:
            if current:
                sections.append(current)
            current = {"version": m.group(1), "heading": line.strip(), "lines": []}
            continue
        if current is not None:
            if line.startswith("## "):  # a non-release heading ends the last section
                sections.append(current)
                current = None
            elif line.strip():
                current["lines"].append(line.rstrip())
    if current:
        sections.append(current)

    if after is None:
        return sections
    floor = version_key(f"v{after}")
    return [s for s in sections if version_key(f"v{s['version']}") > floor]


def survey(repo: Path, upstream: str, do_fetch: bool) -> dict:
    if git(repo, "rev-parse", "--is-inside-work-tree", check=False) != "true":
        raise GitError(f"{repo} is not a git checkout")

    remotes = dict(
        line.split("\t")[0:2] for line in git(repo, "remote", "-v").splitlines() if "(fetch)" in line
    )
    remotes = {k: v.replace(" (fetch)", "") for k, v in remotes.items()}
    if upstream not in remotes:
        raise GitError(
            f"no `{upstream}` remote — add it with:\n"
            f"  git remote add {upstream} https://github.com/AltanS/collie.git"
        )

    fetch_error = None
    if do_fetch:
        r = subprocess.run(
            ["git", "-C", str(repo), "fetch", upstream, "--tags", "--prune"],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            # Offline is not fatal: everything below still works off the refs already on disk, and
            # saying so is better than refusing to report anything.
            fetch_error = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "fetch failed"

    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    head = git(repo, "rev-parse", "HEAD")
    upstream_ref = f"{upstream}/main"
    base = git(repo, "merge-base", "HEAD", upstream_ref)
    base_tag = git(repo, "describe", "--tags", "--abbrev=0", "--match", "v*", base, check=False) or None

    behind_ahead = git(repo, "rev-list", "--left-right", "--count", f"{upstream_ref}...HEAD")
    behind, ahead = (int(x) for x in behind_ahead.split())

    # Releases upstream cut after the point this fork branched from. `--contains base` is the exact
    # question: a tag whose commit has base as an ancestor is a release that came after it.
    tags = [
        t
        for t in git(repo, "tag", "--list", "v*", "--contains", base, "--merged", upstream_ref).splitlines()
        if VERSION_TAG.match(t)
    ]
    # Exclude by COMMIT, not by tag name. `git describe` reports one tag for the base, so a second
    # tag on that same commit (an annotated/lightweight pair, an alias) would otherwise be announced
    # as a release waiting to be merged when it is the version already installed.
    candidates = sorted(
        {t for t in tags if git(repo, "rev-parse", f"{t}^{{commit}}") != base}, key=version_key
    )

    # CHANNEL FILTER — a stable install never sees a prerelease. This is upstream's own rule, not a
    # preference: ADR 0020's amendment says of a strict install "Nothing can pull it onto a
    # prerelease", and `cli/update.ts`'s `strictOnly` enforces it there. Without this the sort alone
    # would hand `v1.6.0-beta.1` to a fork sitting on `v1.5.2` — it really is the higher version —
    # and propose shipping a beta to the phone.
    base_is_prerelease = bool(base_tag and (m := VERSION_TAG.match(base_tag)) and m.group(4))
    new_tags = candidates if base_is_prerelease else [t for t in candidates if not VERSION_TAG.match(t).group(4)]
    held_back = [t for t in candidates if t not in new_tags]
    releases = [
        {
            "tag": t,
            "date": git(repo, "log", "-1", "--format=%ad", "--date=short", t),
            "sha": git(repo, "rev-parse", "--short", f"{t}^{{commit}}"),
        }
        for t in new_tags
    ]

    target = new_tags[-1] if new_tags else None
    upstream_range = f"{base}..{target or upstream_ref}"

    fork_commits = commits(repo, f"{base}..HEAD")
    upstream_commits = commits(repo, upstream_range)

    def by_file(cs: list[dict]) -> dict[str, list[str]]:
        """path → the shas that touched it. One pass; the comprehension this replaces re-scanned
        every commit for every (commit, file) pair and shadowed its own loop variable."""
        out: dict[str, list[str]] = {}
        for c in cs:
            for f in c["files"]:
                out.setdefault(f, []).append(c["sha"])
        return out

    # The CONTESTED set is computed from the effective diff, not from the commit list, and the
    # distinction only shows up on the SECOND sync. A commit history says what was once done: a
    # patch dropped during the last merge is still in it (reported forever as "must not lose"), and
    # a fix re-applied inside a merge commit's conflict resolution is missing from it (never
    # reported as contested at all). `git diff <base>...HEAD` says what the fork ACTUALLY carries
    # right now, which is the only thing a merge can lose.
    def delta_files(rng: str) -> set[str]:
        raw = git(repo, "diff", "--name-only", "-M", rng)
        return {f for f in raw.splitlines() if f}

    fork_files = by_file(fork_commits)
    up_files = by_file(upstream_commits)
    fork_active = delta_files(f"{base}...HEAD")
    up_active = delta_files(f"{base}...{target or upstream_ref}")
    overlap = [
        {
            "file": f,
            "fork": fork_files.get(f, ["(in the effective diff, no single commit)"]),
            "upstream": up_files.get(f, ["(in the effective diff, no single commit)"]),
        }
        for f in sorted(fork_active & up_active)
    ]

    try:
        changelog = changelog_sections(repo, target or upstream_ref, base_tag.lstrip("v") if base_tag else None)
        changelog_error = None
    except GitError as e:
        changelog, changelog_error = [], str(e)

    return {
        "repo": str(repo),
        "branch": branch,
        "head": head[:9],
        "remotes": remotes,
        "fetch_error": fetch_error,
        # The single field a caller must check before believing `new_releases`. Both ways of not
        # having asked upstream — a failed fetch, and `--no-fetch` — land here, because "no new
        # release" is a claim about the remote and neither of them consulted it.
        "indeterminate": bool(fetch_error) or not do_fetch,
        "changelog_error": changelog_error,
        "held_back_prereleases": held_back,
        "base": {"sha": base[:9], "tag": base_tag, "prerelease": base_is_prerelease},
        "behind": behind,
        "ahead": ahead,
        "target": target,
        "new_releases": releases,
        "fork_commits": fork_commits,
        "upstream_commits": upstream_commits,
        "overlap": overlap,
        "changelog": changelog,
    }


def digest(s: dict) -> str:
    L: list[str] = []
    a = L.append
    a(f"fork      {s['remotes'].get('origin', '?')}")
    a(f"upstream  {s['remotes'].get('upstream', '?')}")
    a(f"branch    {s['branch']} @ {s['head']}")
    a(f"base      {s['base']['tag'] or '(no tag)'} ({s['base']['sha']})")
    a(f"gap       {s['behind']} commit(s) behind upstream/main · {s['ahead']} fork-local commit(s)")
    if s["indeterminate"]:
        why = f"fetch failed ({s['fetch_error']})" if s["fetch_error"] else "--no-fetch was passed"
        a("")
        a(f"!! INDETERMINATE — {why}. Upstream was NOT consulted; these figures describe the refs")
        a("!! already on disk. Do NOT report \"nothing to merge\" from this run.")

    a("")
    if not s["new_releases"]:
        a("No upstream release newer than the base." + ("" if s["indeterminate"] else " Nothing to merge."))
    else:
        a(f"New upstream releases ({len(s['new_releases'])}), newest last:")
        for r in s["new_releases"]:
            a(f"  {r['tag']:<12} {r['date']}  {r['sha']}")
        a(f"Merge target: {s['target']}")
    if s["held_back_prereleases"]:
        a(f"Held back (prerelease, and this install is on a strict release): {', '.join(s['held_back_prereleases'])}")

    a("")
    a(f"Fork-local commits ({len(s['fork_commits'])}) — these are what a merge must not lose:")
    for c in s["fork_commits"]:
        a(f"  {c['sha']}  {c['date']}  {c['subject']}")
        for f in c["files"]:
            a(f"              {f}")

    a("")
    if not s["overlap"]:
        a("No file is touched by both sides. A merge should be textually clean.")
    else:
        a(f"CONTESTED FILES ({len(s['overlap'])}) — both sides changed these; compare before merging:")
        for o in s["overlap"]:
            a(f"  {o['file']}")
            a(f"      fork:     {', '.join(o['fork'])}")
            a(f"      upstream: {', '.join(o['upstream'])}")

    if s["changelog_error"]:
        a("")
        a(f"WARNING   {s['changelog_error']} — assemble 'what is new' from the release diff instead")
    if s["changelog"]:
        a("")
        a("What upstream says is new:")
        for sec in s["changelog"]:
            a(f"  {sec['heading']}")
            for line in sec["lines"]:
                a(f"    {line}")
    return "\n".join(L)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--repo", default=str(Path.home() / "git/collie"), help="fork checkout")
    p.add_argument("--upstream", default="upstream", help="remote name for the source repo")
    p.add_argument("--no-fetch", action="store_true", help="use refs already on disk")
    p.add_argument("--json", action="store_true", help="machine-readable output")
    args = p.parse_args()

    try:
        s = survey(Path(args.repo).expanduser(), args.upstream, not args.no_fetch)
    except GitError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(json.dumps(s, indent=2, ensure_ascii=False) if args.json else digest(s))
    # 2, not 0: the survey ran, but it never asked upstream. A zero exit here is what would let a
    # caller quote "no new release" from a run that could not have known.
    return 2 if s["indeterminate"] else 0


if __name__ == "__main__":
    sys.exit(main())
