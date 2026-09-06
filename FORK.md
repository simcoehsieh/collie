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

```bash
cd ~/git/collie
git fetch upstream
git merge upstream/main
bash scripts/collie-ctl.sh build   # THIS checkout is the running service
./bin/collie restart
git push origin main
```

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

`COLLIE_UPDATE_REPO` can retarget the guard. Leave it alone — this fork publishes no releases, so
there is nothing for it to find.

## Merge hygiene

- **Upstream's `CHANGELOG.md` is never edited here.** Fork entries go in
  [`CHANGELOG.fork.md`](./CHANGELOG.fork.md), which upstream does not have, so it cannot conflict.
  Editing upstream's file instead would guarantee a conflict on every release, and a conflict that
  recurs is one that eventually gets resolved with `-X ours`.
- **`git status` is the pre-merge check**, which is why the build's temp artefact is ignored rather
  than tolerated: a tree that is always slightly dirty teaches you to skip looking at it.
- Config lives outside the checkout, so no merge can touch it. Nothing here needs a local `.env`.
