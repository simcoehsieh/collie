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
| Front door | Cloudflare Tunnel → Cloudflare Access (Google SSO, 720 h session) at `https://meow.agnex.dev` (renamed from `collie.agnex.dev` on 2026-09-11 with the cat icon and the name "Meow"; the old hostname stays an alias until the phone is re-added) |
| Bridge | `127.0.0.1:4318`, launchd unit `herdr.collie`, built from this checkout |
| Deployment variant | E ([`docs/deployment.md`](./docs/deployment.md)) — `COLLIE_SKIP_SERVE=1`, the operator owns the ingress |
| Write identity | `COLLIE_DEVICE_HEADER=Cf-Access-Authenticated-User-Email` + a one-address allowlist |
| Multiplexer | herdr, session `listeners` — four long-lived Claude panes plus whatever agents spawn |
| Config | `~/.config/collie/.env` (mode 600) — outside the checkout, so it survives every merge |
| Branding | `~/.config/collie/branding/` — this machine's home screen icon and label (below); this machine installs `branding/cat/` and is called **Meow** |
| Phone | iPhone PWA on the home screen, Web Push subscribed via `web.push.apple.com` |

That last row is why the fork's first patch exists: the silent-push paths upstream wrote against
Chrome's budget are a subscription-revoking offence on Apple's push service, and this deployment's
only notification target is an iPhone.

## Two machines, one commit

There is a second instance at the office, built from this same fork, and the two are told apart on a
phone by the only thing visible at the moment of the tap: the home screen icon and the word under it.
Both were the stock white collie head on black labelled "Collie", so the identity has to be a
per-MACHINE input rather than a committed value — which means it lives outside the checkout, in
`~/.config/collie/branding/`, next to the `.env` that is already there.

```
~/.config/collie/branding/
├── apple-touch-icon.png       180×180 — THE file iOS bakes into the home screen icon
├── favicon-96x96.png          optional — the browser tab
├── web-app-manifest-*.png     optional — Android and other installers; iOS never reads these
└── branding.json              optional — {"name", "shortName", "description"}, all optional
```

A file whose name matches one in `web/public/` replaces it for that machine's build; a name matching
nothing there is copied anyway and warns, because a typo'd filename is the failure that looks exactly
like success. **A machine with no such directory builds byte for byte what it built before the
feature existed**, so leaving it absent here keeps this install exactly as it is.

The artwork itself is versioned in [`branding/`](./branding/), which the build never reads: it is how
the other machine obtains a set through the `git pull` it already has to do, and it carries the
script that redraws every tile from `web/public/` so a set stays in step with upstream's mark instead
of freezing whatever it looked like the day it was copied. Installing one is a copy:

```bash
mkdir -p ~/.config/collie/branding
cp branding/dcard/* ~/.config/collie/branding/
```

The implementation is [`web/branding.ts`](./web/branding.ts) — a new file, so upstream has nothing to
conflict with — plus thirteen lines in `web/vite.config.ts`. It replaces `publicDir` rather than
copying into `dist/` after the build, and that is not a style choice: vite-plugin-pwa computes each
precache entry's revision from the bytes the BUILD saw, so an icon swapped in afterwards ships under
the stock file's hash and the service worker serves whichever copy it cached first.

Rebuild after changing anything in there — the branding is a build input, and `bin/collie version`
will happily report the new bundle while the phone keeps the old icon:

```bash
bash scripts/collie-ctl.sh build && ./bin/collie restart
curl -s http://127.0.0.1:4318/manifest.webmanifest | head -c 120   # the name it will install under
```

**iOS bakes the icon in at "Add to Home Screen" and never revisits it.** Changing the file afterwards
does nothing to an install that already exists: it has to be removed from the home screen and added
again. Removing an installed PWA on iOS also discards its site data **and its Web Push subscription**,
so that install has to re-subscribe from Settings afterwards — which is the reason to give the OTHER
machine the new icon and leave a working, subscribed install alone.

## The mark inside the app is the cat (2026-09-11)

`web/src/components/meow-mark.tsx` stands in for `collie-mark.tsx` at every place the app draws its
own mark — the header's home button, the boot splash, the idle lock, the not-connected screen, the
playground — and `index.html`'s first-paint splash draws the same cat as a CSS mask instead of the
galloping-dog sprite. **This swap is unconditional in the fork**: both machines get the cat mark
in-app, because the mark is a committed component and not a per-machine file. What DOES come from
`branding.json` is the header's brand word (`shortName`, so this machine's header says "Meow" over
"on herdr") and `"hideMuxLogo": true`, which keeps herdr's own grey mark off that line. Both reach
the bundle through vite's `define` as `__BRAND__`, read by `src/lib/brand.ts`; tests see the stock
brand (`vitest.config.ts`) and mock that module for the branded case.

`collie-mark.tsx` is generated upstream and pinned by `collie-mark-hash.test.ts`, so it is left
byte for byte as shipped and simply not imported by the app. `MeowMark` keeps its contract — the one
`svg:has(> style)`, the `cm-live` class, the `--cm-paper` / `--cm-a1` properties, and `cm-`-prefixed
animation names so `collie-home.tsx`'s spin ramp still finds something to drive. On a merge: keep
upstream's `collie-mark.tsx` and `src/test/collie-mark.ts`; if upstream adds a new call site of
`<CollieMark/>`, swap that one import too; if upstream rewrites the splash block in `index.html`,
take theirs and re-apply the mask rule.

## The redesign (2026-09-10)

The web UI does not look like upstream's. Upstream's `DESIGN.md` pins every corner to 2px, paints
chrome in a neutral grey with no accent, and ships Aldrich as the default face; this fork wanted a
modern phone app — round, tinted, one accent, the phone's own typeface — and got it **without
rewriting a screen**, because the look was already concentrated in three places upstream does not
touch between releases (zero commits to any of them across v1.5.0 → v1.8.0):

| Layer | Where | What changed |
| --- | --- | --- |
| Tokens | `web/src/index.css` `:root` + `@theme` | `--radius` 2px → a real ramp (8/12/16/20/24), cool-tinted neutrals (hue ~258), one indigo `--primary`, tinted elevation (`--elev-*` → `shadow-card` / `shadow-float`), the system font as the default stack |
| Primitives | `web/src/components/ui/*.tsx` | button (tonal `outline`, softer press), card, chip (pill), badge (pill), switch (stadium track), list-group, chat-input (filled field), sheet (3xl top corners, blurred scrim), notice box |
| Skin | `web/src/skin.css` — **fork-only, new file** | everything reachable by a `data-slot` selector: the blurred header, the composer's rounded chrome block, the segmented controls row, the mirror's own ground, the route entrance animation |

Only a handful of component files carry className edits beyond that (`agent-card`, `agent-list`,
`composer` send buttons, `nav-tray` inherits the button change), plus one `data-slot="mirror"`
attribute in `agent-chat.tsx` so the skin can paint the terminal well. Two behaviours were changed
in the same spirit, both from phone reports: the **microphone is its own button** inside the field
beside the attach clip and the round button is always Send (upstream shares one button between the
two, which read as the send key turning into a microphone); and **the dock folds on a downward pull
of its grab handle** — status band, controls and input fold down to the 30px handle, a tap or an
upward pull on it (or a tap on the mirror) brings them back. The pull-down is an `onPullDown` option
added to `hooks/use-sheet-pull.ts`; the fold is `dockOpen` state in `agent-chat.tsx`, session-only. **When a merge conflicts on
one of those, keep upstream's structure and re-apply the class; when it conflicts on `index.css`'s
token block or a `ui/` file, keep the fork's** — those files are the design and upstream's version of
them is the old design.

The default face moved from Aldrich to the system stack (`DEFAULT_FONT = "system"` in
`web/src/lib/design.ts`, mirrored in `public/theme-init.js` and the `index.html` splash), so a fresh
device fetches no webfont at all; Aldrich and Space Grotesk stay shipped as opt-in choices under
`:root.font-aldrich` / `:root.font-grotesk`. `fonts.test.ts` and `typeface-control.test.tsx` pin the
new default.

**Two things were done for the feel of opening a terminal, not the look of it.** A navigation whose
snapshot or mirror is already in memory now returns it at once, flagged `pending`, and
`RootLayout` revalidates in the same tick (`web/src/lib/loaders.ts`, `web/src/routes/root.tsx`) —
so a tap on a pane row paints the pane before the round trip instead of after it, which through
Cloudflare was two of them. And `HOT_MS` in `use-polling.ts` is 1000 rather than 1500: a followed,
moving mirror at 1 Hz reads as live. Both are the kind of edit that will conflict when upstream
touches the same lines; both are a dozen lines and easy to re-apply.

Upstream's `DESIGN.md` is left as it is — it is upstream's argument for upstream's look, and editing
it would conflict on every release. Where a rule of it is knowingly broken here (the stadium, the
ramp, the accent), the reason is in the token's own comment.

## The performance and feature pass (2026-09-10)

An audit the same day the redesign landed measured where the time went: the bridge answers in
1–2 ms on loopback, but every request from the phone is a ~175 ms round trip through Cloudflare
(560 ms cold), the mirror screen made two of them a second, and nothing on either side asked "did
anything change?". Everything below follows from that measurement. The full list is in
[`CHANGELOG.fork.md`](./CHANGELOG.fork.md) → *On top of 1.8.0*; this section is the map of where
each piece lives, for the next merge.

| Piece | Where | On a conflict |
| --- | --- | --- |
| Snapshot ETag / 304, pane read cache + coalescer, long-poll `?wait=`, brotli, precompressed assets, once-per-second `buildId()` and pairing registry | `bridge/server.ts` (snapshot + pane routes, `serveStatic`), `bridge/http-cache.ts`, new `bridge/events.ts`, `bridge/pairing.ts` | Keep upstream's structure, re-apply the cache/ETag hunks. `events.ts` is fork-only |
| SSE pokes `GET /api/events` | `bridge/events.ts`, `bridge/server.ts` (route), new `web/src/lib/live-feed.ts`, `web/src/hooks/use-polling.ts` | Polling stays the truth (ARCHITECTURE.md ADR 0008 is respected: the stream only says *when* to poll). If upstream ever adds its own stream, take theirs and drop `live-feed.ts` |
| Show-first-fetch-second for Settings / Crew / History, follow window 200 lines, snapshot identity memo | `web/src/lib/loaders.ts`, `web/src/lib/api.ts`, `web/src/routes/root.tsx`, `web/src/routes/history.tsx` | Same as the pane's `pending` path from the redesign: a dozen lines each, re-apply |
| Optimistic send, single mirror parse, memo boundaries, lazy routes, rAF auto-scroll, containment, copy-a-fence | `web/src/components/composer.tsx`, new `web/src/hooks/use-mirror-model.ts`, `use-stable-callback.ts`, `web/src/router.tsx`, `web/src/hooks/use-auto-scroll.ts`, `web/src/lib/code-fences.ts` | Keep upstream's screen, re-apply the hook and the `memo()` wrappers |
| Push self-heal, one-tap approve (shade + dashboard row), per-pane notify rules | `web/src/sw.ts`, new `web/src/lib/push-heal.ts`, `bridge/push.ts`, new `bridge/prompt-peek.ts`, `bridge/notify-prefs.ts`, `web/src/components/agent-card.tsx`, `notify-prefs-control.tsx` | `sw.ts` is already a fork file (the iOS silent-push patch); keep the fork's. **Every push must still show a notification** |
| Diff sheet, document browser | new `bridge/diff.ts`, `bridge/docs-list.ts`, `web/src/components/diff-sheet.tsx`, `doc-panel.tsx`, `pane-actions-sheet.tsx` rows | Fork-only files; only the `agent-chat.tsx` mounts and the `server.ts` routes can conflict |
| Send queue, connection verdicts | new `web/src/lib/send-queue.ts`, `send-failure.ts`, `queued-sends.tsx`, `web/src/components/connection-banner.tsx`, `web/src/lib/reply-action.ts` (`transport` on the `error` outcome) | `connection-banner.tsx` is a rewrite around `probeBridge()`: keep the fork's |
| Overview, pins, hotkeys, low power, TTS, share target | new `web/src/routes/overview.tsx`, `web/src/lib/overview.ts`, `triage.ts` (third arg), `use-dash-prefs.ts` (store), `use-hotkeys.ts`, `use-tts.ts`, `last-pane.ts`, `web/vite.config.ts` manifest | Mostly new files. `triage.ts` and `use-dash-prefs.ts` are the two upstream may touch |
| agy harness parity | `web/src/lib/harness/agy/*`, ten `web/src/fixtures/panes/agy--*.txt`, `multi-select-model.ts` (`submitKeys`), `conformance.ts` (`notApplicable`) | If upstream ships its own agy adapters, compare fixtures before choosing; theirs may be from a newer agy |

Two things to know when operating it. **The stream watches a followed pane at 400 ms on loopback**
— herdr publishes no pane-output event, so the bridge reads the pane itself while a phone follows it
and pokes on change; that is 2.5 cheap local reads a second per followed pane instead of one
175 ms round trip a second from the phone, and it stops the moment the stream closes. And **the
bridge test run is now `bun test --timeout 20000 ${=FILES}`** with `crew/harness.test.ts` left out
of `FILES` — in zsh an unquoted `$FILES` is one word, and bun then reports that no test file
matched, which reads like an empty suite rather than a shell quirk.

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
