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


def version_key(tag: str) -> tuple:
    """Sort key for a `vX.Y.Z[-tail]` tag. A prerelease sorts BELOW its own release (PEP 440 / semver
    rule), so `v1.6.0-beta.1` never outranks `v1.6.0` and a beta is never proposed as the newer
    thing to merge."""
    m = VERSION_TAG.match(tag)
    if not m:
        return (0, 0, 0, 0, "")
    major, minor, patch, tail = m.groups()
    # 1 = final release, 0 = prerelease. Ordering within prereleases is lexical, which is enough to
    # rank beta.1 < beta.2 and is not load-bearing beyond display order.
    return (int(major), int(minor), int(patch), 0 if tail else 1, tail or "")


def commits(repo: Path, rng: str) -> list[dict]:
    """One entry per non-merge commit in `rng`, with the files it touched.

    Merges are excluded on purpose: on a fork that merges upstream repeatedly, the merge commits are
    the fork's own bookkeeping and would otherwise be reported as "changes" with no content.
    """
    raw = git(repo, "log", "--no-merges", "--format=%H%x00%an%x00%ad%x00%s", "--date=short", rng)
    out: list[dict] = []
    for line in raw.splitlines():
        if not line:
            continue
        sha, author, date, subject = line.split("\0", 3)
        files = git(repo, "show", "--name-only", "--format=", sha).splitlines()
        out.append(
            {
                "sha": sha[:9],
                "author": author,
                "date": date,
                "subject": subject,
                "files": [f for f in files if f],
            }
        )
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
    except GitError:
        return []
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
    new_tags = sorted({t for t in tags if t != base_tag}, key=version_key)
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

    fork_files = {f: [c["sha"] for c in fork_commits if f in c["files"]] for c in fork_commits for f in c["files"]}
    up_files = {
        f: [c["sha"] for c in upstream_commits if f in c["files"]]
        for c in upstream_commits
        for f in c["files"]
    }
    overlap = [
        {"file": f, "fork": fork_files[f], "upstream": up_files[f]}
        for f in sorted(set(fork_files) & set(up_files))
    ]

    return {
        "repo": str(repo),
        "branch": branch,
        "head": head[:9],
        "remotes": remotes,
        "fetch_error": fetch_error,
        "base": {"sha": base[:9], "tag": base_tag},
        "behind": behind,
        "ahead": ahead,
        "target": target,
        "new_releases": releases,
        "fork_commits": fork_commits,
        "upstream_commits": upstream_commits,
        "overlap": overlap,
        "changelog": changelog_sections(repo, target or upstream_ref, base_tag.lstrip("v") if base_tag else None),
    }


def digest(s: dict) -> str:
    L: list[str] = []
    a = L.append
    a(f"fork      {s['remotes'].get('origin', '?')}")
    a(f"upstream  {s['remotes'].get('upstream', '?')}")
    a(f"branch    {s['branch']} @ {s['head']}")
    a(f"base      {s['base']['tag'] or '(no tag)'} ({s['base']['sha']})")
    a(f"gap       {s['behind']} commit(s) behind upstream/main · {s['ahead']} fork-local commit(s)")
    if s["fetch_error"]:
        a(f"WARNING   fetch failed ({s['fetch_error']}) — figures are from refs already on disk")

    a("")
    if not s["new_releases"]:
        a("No upstream release newer than the base. Nothing to merge.")
    else:
        a(f"New upstream releases ({len(s['new_releases'])}), newest last:")
        for r in s["new_releases"]:
            a(f"  {r['tag']:<12} {r['date']}  {r['sha']}")
        a(f"Merge target: {s['target']}")

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
