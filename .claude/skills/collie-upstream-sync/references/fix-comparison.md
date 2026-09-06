# Comparing a fork patch against an upstream fix

When both sides changed the same file, the question is not "will git merge this" — git will merge
almost anything. The question is **whether upstream fixed the same defect, and if so, whose fix is
better**. Getting this wrong is how a fork either carries a redundant patch forever or silently
reverts to a bug it already fixed.

Contents: [Is it the same defect](#is-it-the-same-defect) · [Evidence to
gather](#evidence-to-gather) · [The four verdicts](#the-four-verdicts) · [Presenting
it](#presenting-it) · [Traps](#traps)

## Is it the same defect

A shared file is a hint, not an answer. Two changes to `web/src/sw.ts` can be entirely unrelated.
Establish sameness from the **defect**, not the location:

1. **What breaks, for whom, under what conditions?** Write one sentence for the fork patch and one
   for upstream's change. Same sentence → same defect. This is the whole test.
2. Then check the supporting signals: upstream's changelog line and PR/issue number, the commit
   message, and whether the hunks overlap or merely share a file.

Same file + different defect → not a fix collision. Say so and move on; do not agonise over it.

Two defects can also be **nested**: upstream fixed a broader problem that happens to subsume the
fork's narrower one, or fixed one symptom of a cause the fork addressed at the root. Treat those as
"same defect" for the purposes below, and say which is broader.

## Evidence to gather

For each candidate, get all four before judging. Substitute the real range and paths.

```bash
cd ~/git/collie
# 1. What the fork did, and why (the message carries the reasoning)
git show <fork-sha>

# 2. What upstream did to the same file, across the range
git log --oneline <base>..<target> -- <file>
git show <upstream-sha>

# 3. The two side by side on that file alone
git diff <base> <fork-sha>     -- <file>
git diff <base> <upstream-sha> -- <file>

# 4. What upstream said it was doing
git show <target>:CHANGELOG.md | grep -n -A2 -i '<keyword>'
```

Also check whether upstream's fix arrives with **tests**, and whether those tests would pass against
the fork's version of the fix. A fix with a test that pins the behaviour is stronger evidence than
a fix without one, and running upstream's test against the fork's code is the cheapest way to find
out whether the fork's fix is actually complete.

## The four verdicts

Pick exactly one per defect. Each names what to do at the merge conflict.

| Verdict | When | At the conflict |
| --- | --- | --- |
| **Take upstream, drop ours** | Upstream's fix covers every case the fork's does, and is at least as correct. Usually true when upstream fixed it more deeply, or with tests the fork lacks. | Resolve to upstream's side. Record the drop in `CHANGELOG.fork.md` with **why**. |
| **Keep ours, drop theirs** | Upstream's fix is narrower, or wrong for this deployment. Rare, and needs a stated reason — "ours is fine" is not one. | Resolve to the fork's side. Note in `CHANGELOG.fork.md` that upstream's differs, so the next merge does not re-litigate it. |
| **Keep both** | They fix different parts of one problem, or upstream's is general and the fork's adds a case upstream does not handle (a platform, a deployment shape). | Resolve by hand so both effects survive. **Verify the combination**, not each half — two correct fixes can compose into a wrong one. |
| **Rewrite on top** | Upstream restructured the code the fork patched, so neither side applies cleanly. | Take upstream's structure, then re-apply the fork's *intent* to it. This is a new patch: give it a commit message that says what it re-applies and why. |

The default is **take upstream, drop ours**. A fork patch is a liability — it has to be carried,
merged, and re-verified forever. Keep one only when there is a reason upstream's version does not
serve this deployment, and state that reason.

## Presenting it

Give the operator, per defect, in this shape:

> **`web/src/sw.ts` — silent push revokes the iOS subscription**
> - **Ours** (`30bcb62`): reads the subscription endpoint, converts `clear`/`suppress` into a quiet
>   visible notification on Apple's push service only. 12 tests.
> - **Upstream** (`a1b2c3d`, #181): always shows on `clear`, all platforms. No endpoint check.
> - **Same defect?** Yes — both stop a push from being answered with silence.
> - **Verdict: keep both.** Upstream's is broader but changes Chrome behaviour too; ours keeps that
>   opt-in. Resolve so the endpoint check gates upstream's new code path.

Short, concrete, and it names the decision. Do not present a diff and ask the operator to judge —
the judgement is the job; the operator confirms it.

## Traps

- **A shared file is not a collision.** Check the defect, not the path.
- **`CHANGELOG.md` will look contested if a fork commit wrongly edited it.** That is a hygiene bug,
  not a fix collision — the fork's entries belong in `CHANGELOG.fork.md`.
- **Upstream's changelog line can undersell a fix**, especially a security or platform one. Read the
  diff before concluding the two fixes differ.
- **"It merged cleanly" proves nothing about correctness.** Two non-overlapping hunks in one file can
  both be needed, or can contradict each other. Clean merges still need the verdict.
- **Never decide this at the conflict marker.** Reach the verdict from the evidence first; resolving
  under time pressure with the markers on screen is how the wrong side wins.
