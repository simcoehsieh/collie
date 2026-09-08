# This fork

`simcoehsieh/collie`, tracking `AltanS/collie`. Maintained as a **long-lived divergent fork**, not a
staging area for pull requests: patches here exist because this deployment needs them, and they are
not sent upstream.

`main` is both the fork's line of development and the branch the running service is built from —
there is no separate deploy branch, because there is only one machine and one operator.

## What this deployment is

Not the documented default. Upstream assumes `tailscale serve`; this runs behind Cloudflare.

| | |
| --- | --- |
| Front door | Cloudflare Tunnel → Cloudflare Access (Google SSO, 720 h session) at `https://collie.agnex.dev` |
| Bridge | `127.0.0.1:4318`, launchd unit `herdr.collie`, built from this checkout |
| Deployment variant | E ([`docs/deployment.md`](./docs/deployment.md)) — `COLLIE_SKIP_SERVE=1`, the operator owns the ingress |
| Write identity | `COLLIE_DEVICE_HEADER=Cf-Access-Authenticated-User-Email` + a one-address allowlist |
| Multiplexer | herdr, session `listeners` — four long-lived Claude panes plus whatever agents spawn |
| Config | `~/.config/collie/.env` (mode 600) — outside the checkout, so it survives every merge |
| Phone | iPhone PWA on the home screen, Web Push subscribed via `web.push.apple.com` |

That last row is why the fork's first patch exists: the silent-push paths upstream wrote against
Chrome's budget are a subscription-revoking offence on Apple's push service, and this deployment's
only notification target is an iPhone.

## Taking upstream's changes

The procedure below is automated by the **`collie-upstream-sync` skill**, which lives in this repo
at [`.claude/skills/collie-upstream-sync/`](./.claude/skills/collie-upstream-sync/) and is symlinked
into `~/.claude/skills/` and `~/.agents/skills/`, so any session — usually one in `ai-live` — can
invoke it. It surveys the gap, reports what the new release adds, compares each fork patch against
any upstream fix of the same bug, and asks before merging. Its survey step runs standalone:

```bash
python3 ~/git/collie/.claude/skills/collie-upstream-sync/scripts/survey.py
```

It lives here rather than in the shared skills repo because it describes *this fork* — its patches,
its deployment, its verification. A procedure kept somewhere else is one that drifts from the thing
it operates on. Doing it by hand instead:

```bash
cd ~/git/collie
git fetch upstream --tags
git tag --list 'v*' | sort -V | tail -3   # what upstream has released
git merge v1.6.0                          # the RELEASE you decided to take, not upstream/main
bash scripts/collie-ctl.sh build          # THIS checkout is the running service
./bin/collie restart
git push origin main
```

Merge the **tag**, the way [`docs/upgrading.md` → *You run a fork*](./docs/upgrading.md) says to.
`upstream/main` is wherever upstream's development happens to sit today, which may be mid-release
work nobody has shipped; a `v*` tag is a version someone decided was finished.

**`v1.6.0` was taken by rebase, once, and that was a one-off.** So `git log` shows this fork's 18
patches in a straight line on top of that tag with no merge commit for `v1.5.6` or `v1.6.0` — the
linear stretch is history, not a change of procedure. Merge is still the way, for the reason the
next release makes obvious: a rebase replays every fork patch individually, so one contested file
can be resolved several times over (`v1.6.0` cost eight rounds), and it rewrites commits that are
already pushed, which means a force push every time. Neither is worth paying on a schedule.

**The rebuild is not optional.** launchd runs `bin/collie _exec-bridge` out of this directory, and
both `bin/` and `web/dist/` are build output that git does not carry. Merge without rebuilding and
`git log` reports the new version while the service keeps serving the old one — the failure mode is
that everything looks correct.

Verify with `./bin/collie version` (reports the built bundle's stamp, not the checkout's) and by
checking that the shipped service worker still carries this fork's patch:

```bash
curl -s http://127.0.0.1:4318/sw.js | grep -c push.apple.com   # expect 1
```

## Do not run `collie update`

It refuses this checkout, and the refusal is correct. `assertOrigin()` in
[`cli/update.ts`](./cli/update.ts) compares `origin` against the configured update repo
(`AltanS/collie`) **before any fetch or checkout**, and this fork's origin does not match. The guard
exists because the git update path force-checks-out onto release tags: pointed at a fork, it would
discard local commits. `git merge upstream/main` above is the supported way, and the only one.

`COLLIE_UPDATE_REPO` can retarget the guard, and upstream says to set it "if your fork releases its
own tags". This one does not, so leave it unset — pointed here it would find no releases at all.

One consequence to expect rather than chase: `collie doctor` reports `update-source` as an **error**
for as long as this is a fork, and the phone's Updates card is red because of it. That is the check
telling the truth — `collie update` really will refuse — and there is no way to silence it that does
not also make the guard lie.

## Merge hygiene

- **Upstream's `CHANGELOG.md` is never edited here.** Fork entries go in
  [`CHANGELOG.fork.md`](./CHANGELOG.fork.md), which upstream does not have, so it cannot conflict.
  Editing upstream's file instead would guarantee a conflict on every release, and a conflict that
  recurs is one that eventually gets resolved with `-X ours`.
- **`git status` is the pre-merge check**, which is why the build's temp artefact is ignored rather
  than tolerated: a tree that is always slightly dirty teaches you to skip looking at it.
- Config lives outside the checkout, so no merge can touch it. Nothing here needs a local `.env`.

## Running the bridge tests takes the live service down with them

`bun test ./bridge` and the live bridge cannot both have the herdr socket. Measured 2026-09-06: with
the suite running, every session-scoped route — `/api/config`, `/api/launchers`, `/api/dirs`, the
pane family — hangs until Bun's 10s idle timeout, while `/api/snapshot` and `/api/health` (which
never call `caller.resolve()`) stay fast. The bridge does not recover on its own.

So: **`./bin/collie restart` after any bridge test run**, and do not run one while the phone is being
used. `bridge/pack/harness.test.ts` is the worst of them — several minutes on its own — and it also
carries one failure that is NOT yours: "an unpinned client certificate is refused before any handler
runs" fails identically on an unmodified tree.

The web suite (`cd web && bun run vitest run`) touches nothing and is safe to run at any time.
