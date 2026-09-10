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

## On top of 1.8.0

- **An agy pane's menus, checklists and slash popup are tappable.** The Antigravity adapter grew
  `menu`, `multi-select` and `autocomplete` detectors from ten fixtures captured live on agy 1.2.0;
  a single-select answers with the digit alone (the old digit + Enter also answered the next
  question of a multi-question call). Wizard, preview-select and paste are asserted not applicable
  rather than left as todo. The multi-select contract admits a TUI whose Enter submits the set.
- **Push heals itself.** The service worker handles `pushsubscriptionchange` and re-subscribes
  with the same VAPID key; on app open the page asks the bridge whether its endpoint is still known
  (`/api/subscribe` now answers `{known}`) and mints a fresh subscription when the bridge had pruned
  it on a 404/410. Before this an Apple endpoint rotation silenced pushes until Settings was opened.
- **A blocked pane answers from the notification shade or the dashboard row.** The bridge peeks the
  pane at push time (`bridge/prompt-peek.ts`) and, when the dialog is a plain Yes/No, the push
  carries two actions plus the exact keystrokes and the prompt region; the worker sends them through
  the guarded keys route with `expected_prompt`, so a dialog that moved is refused and the pane opens
  instead. The dashboard row gets the same Yes/No strip without navigating. `AgentCard` is memoised.
- **Each pane gets its own notification rule.** `notify-prefs` grows per-pane rules matched by pane
  id or label (`default | all | blocked | mute`) with a per-rule snooze, under the existing
  bridge-wide switches, so one chatty listener cannot train the operator to ignore every push.
- **The bridge answers 304 when nothing moved, and pokes the phone instead of being polled.**
  `/api/snapshot` carries an ETag (hashed with `ts` zeroed) and the client hands back the same
  object on a 304, so an unchanged herd costs an empty response and no re-render. Pane reads go
  through a 250 ms cache with an in-flight coalescer, invalidated by herdr events, so a 304 and a
  second tab no longer each cost a herdr round trip. `GET /api/events` is a Server-Sent Events
  stream of `{kind:"snapshot"}` / `{kind:"pane"}` pokes (polling stays the truth; the stream only
  says when to poll), and while it is up the fixed loop relaxes to a 30 s safety net. When it is
  down, `GET /api/pane/:id?wait=1500` long-polls up to 2 s for a change. Bodies go out as brotli
  when the client accepts it; static assets are compressed once in memory. `buildId()` and the
  pairing registry are read once per second instead of `stat`-ed on every request.
- **A followed mirror asks for 200 lines, not 600.** The viewport is what a live tail needs;
  scrolling back or "Load older" still fetches 600 → 1000.
- **Settings, Crew and History paint before their round trip.** The same show-first-fetch-second
  pattern the pane got on 2026-09-10; History opens with 200 turns and extends to 5000 in the
  background.
- **The composer clears on the tap, not on the round trip.** Send is optimistic: the field empties
  and the ✓ / "You sent" chip rises at once; a stalled, blocked or failed send restores the draft.
  The harness guard's probe → send → verify sequence is unchanged, only the pixels moved.
- **The pane screen parses the mirror once per tick.** `useMirrorModel` builds lines and blocks
  once and every derived view — status line, terminal draft, dialog detection, the rendered
  output — reads from it (was four parses and two block builds). `AgentList` and the strips are
  memoised and their handlers identity-stable, so a poll that changed nothing re-renders nothing.
- **The screens a session opens once a week load on demand.** Settings, Updates, Crew and History
  are `React.lazy` chunks; the eager bundle went from 884 KB (256 KB gz) to 529 + 295 KB (158 + 90 KB gz).
- **The mirror re-pins once per frame.** Auto-scroll coalesces its observers behind one
  `requestAnimationFrame`, bails when not following, and reads a fling once per frame; the `<pre>`
  has `contain: layout paint` and rows keep their DOM node when a line shifts. The header's
  backdrop blur is 10px with no `saturate()`.
- **One tap copies a fenced code block off the mirror.** A copy button sits on the closing
  fence; native long-press selection on the mirror already worked and is left alone.
- **The redesign.** Round corners on a real ramp, cool-tinted surfaces with one indigo accent,
  tinted elevation, pill chips and badges, a stadium switch, a filled composer field, a blurred
  header, a floating rounded composer block, sheets with soft top corners — and the phone's own
  typeface as the default, so a fresh device downloads no webfont. Done in the token block, the
  `ui/` primitives and a new fork-only `web/src/skin.css` (by `data-slot`), so upstream's screens
  are structurally untouched. `FORK.md` → "The redesign" says which side to keep on a conflict.
- **Opening a terminal paints before the round trip.** A navigation whose snapshot or mirror is
  already in memory returns it immediately, flagged `pending`, and the root layout revalidates at
  once; the cold path is unchanged. The followed-mirror poll is 1 Hz (was 1.5 s). A 220 ms
  entrance plays when the kind of route changes; a pane→pane hop keeps everything mounted.


**Merged** `v1.8.0` on 2026-09-10, taking `v1.7.0` and `v1.8.0` together. Both releases went out on
the same day and 1.8.0 finishes the rename 1.7.0 began, so merging 1.7.0 first would have meant
resolving the same files twice around a half-renamed middle state. Back to a merge after the one-off
rebase onto 1.6.0, as `FORK.md` says.

**No fork patch was dropped.** Upstream fixed none of the defects this fork carries a patch for, and
the three worth checking every time all came back clean: `sw.ts` was not touched once in the range
and `push-decision.ts` only had `pack` changed to `crew` in its comments, so the iOS silent-push
patch stands; `git log -G'userSelect|user-select|touch-callout|longPress'` over the range is empty,
so the long-press-selects-the-page fix stands; and `bridge/dirs.ts` and `bridge/docs.ts` do not
exist upstream at all, so the folder picker and the document panel are still the fork's alone.

Thirty-one files were contested and seven of them conflicted, every one resolved as "keep both
sides": upstream's `CrewProvider` around the fork's `app-viewport` shell in `root.tsx`, upstream's
scoped `useMuxCapability("createTab", scope)` above the fork's `selectstart` refusal in
`tab-strip.tsx`, the fork's `onLinkOpen` beside upstream's `images` on `AnsiOutput`, the fork's
`kbDocumentResponse` and `/api/dirs` route beside upstream's blob store and `/api/blobs/<hash>` in
`bridge/server.ts`. One assertion had to be re-counted rather than picked: `bridge/server.test.ts`
pins how many session-scoped routes resolve through the gate, and both sides said ten for different
reasons — the fork's `/api/dirs` and upstream's blob route — so the merged tree has eleven.

The pack-to-crew rename costs this deployment nothing: it is solo, `~/.config/collie/.env` holds no
`COLLIE_PACK_*` key, and the state directory has no `pack-*.json` to migrate.

- **The installed PWA takes its icon and its name from the machine that serves it.** This fork now
  runs on two machines — one at the office, one at home — off the same commit, and on an iPhone home
  screen both installs were the same white collie head on black under the same word "Collie". The
  thing that tells them apart therefore cannot be a committed value, so it is a directory outside the
  checkout: `~/.config/collie/branding/`, beside the `.env` that already lives there. Drop an
  `apple-touch-icon.png` in it (and optionally a `branding.json` naming the app) and that machine
  builds its own identity; a machine without the directory builds byte for byte what it built before
  the feature existed, which is what keeps the other install untouched. The overlay replaces
  `publicDir` rather than copying into `dist/` after the build, because vite-plugin-pwa computes each
  precache revision from the bytes the build saw — an icon swapped in afterwards ships under the
  stock file's hash and the service worker serves whichever copy it cached first. Nearly all of it is
  `web/branding.ts`, a new file upstream cannot conflict with; `vite.config.ts` gains thirteen lines.
  The tiles themselves are versioned under `branding/`, which the build never reads — it is how the
  second machine obtains a set through the pull it already makes, and it carries the script that
  redraws them from `web/public/` rather than leaving a PNG nobody can regenerate. The work set is
  Dcard's own brand blue with a small D badge on the iOS tile alone; the badge stays off the
  maskable manifest pair, which Android may crop to exactly where a corner badge sits.

## On top of 1.6.0

**Rebased** onto `v1.6.0` on 2026-09-08, taking `v1.5.6` and `v1.6.0` together. The fork's 18
patches were replayed onto the release rather than merged into it, so this history is linear and
every fork commit's parent chain runs straight to upstream's tag. That is why there is one heading
here and no longer one per release: the "On top of 1.5.3" and "On top of 1.5.5" sections described
merge commits a rebase does not keep, and leaving them would have claimed a history shape `git log`
contradicts. Their still-true findings are folded in below.

**No fork patch was dropped.** Upstream fixed none of the defects this fork carries a patch for. The
one to check every time is the iOS silent-push patch, and upstream did not touch `sw.ts` or
`push-decision.ts` once in the range — upstream's own push work (#178/#179) is on the REGISTRATION
side (`push.ts`, `use-push.ts`, `settings.tsx`), where the defect is a setup that sticks on "setting
up", not a delivered push answered with silence. Different defect, zero file overlap.

Twenty-two files were contested and every one resolved as "keep both sides": the two code bases add
parallel, unrelated things to the same declarations — `controlsOpen` beside upstream's
`expandClippedReply` in `DisplayPrefs`, `docHosts` beside its `upload` capability in three type
declarations, `onLinkOpen` beside its `hideLeadingLines` on `AnsiOutput`, `COLLIE_DIR_ROOTS` beside
`COLLIE_MAX_UPLOAD_MB` in the config roll call. `FONT_MAX` and `web/src/test/setup.ts` were not
touched upstream at all, so the 24px ceiling and the localStorage shim are still the fork's alone.

The one thing removed is the `ImagePlus` icon import in `composer.tsx`: upstream replaced the
picture icon with a paperclip and a two-row picker, so the symbol became unreachable. That is
following upstream's replacement, not dropping a fork patch.

`CHANGELOG.md` did not conflict, which is the whole point of this file.

The suite is green on the rebased tree: 195 web files / 5508 tests, 100 bridge files / 2854 tests,
35 cli files / 1307 tests, 5 script files / 52 tests, both typechecks and oxlint — zero failures.
Upstream's 1.6.0 adds 14 web files and 441 tests to that count and all of them pass here.

Three known-red things that this rebase did NOT cause, each proven against an untouched tree:

- `bridge/pack/harness.test.ts` hangs indefinitely. `git diff v1.6.0..HEAD -- bridge/pack/` is
  empty, so that directory is byte-identical to upstream's and the hang is upstream's.
- `scripts/collie-cli.test.sh` fails one assertion, expecting `collie update` to hand off to
  `systemd-run --user --collect`. A pristine `v1.6.0` worktree fails the same assertion with the
  same message on this machine: the test assumes systemd, and macOS correctly takes the detached-
  child path. This fork never runs `collie update` at all.
- `packaging/refresh.test.sh` fails three checks (new in 1.5.6, which added the Arch and Nix
  recipes). The same pristine `v1.6.0` worktree fails the same three. The fork ships no package.

- **The document panel fills a phone edge to edge.** It shipped inset at `w-[92%]` on every screen,
  holding a strip of backdrop back so iOS's left-edge back-swipe kept its zone and so the strip
  could double as a tap-to-dismiss target. On a 393px phone that strip is ~31px of coloured terminal
  text a few millimetres from the words being read, which reads as an unfinished edge rather than as
  a signal — so below `sm` the panel is `w-full`. The rounded corner and the left rule go with it: a
  `rounded-l-md` against the screen edge would only open two notches of backdrop where the panel no
  longer meets anything. From `sm` up the inset stays, because there the strip is a legible piece of
  terminal beside the document rather than a sliver. What it costs on a phone is stated in the
  component, because it is invisible from the code — there is no backdrop left to tap and the left
  edge is the system's again, so the ways out are the ✕, the header drag and Escape, all of them on
  the panel's own chrome.

- **Tap a knowledge-base link in the mirror and the document opens beside the terminal.** A new
  `GET /api/doc/<slug>` serves one of the operator's own kb documents from Collie's OWN origin,
  fetched over loopback, and the client opens it in a right-side panel you drag away to get back to
  the pane. An iframe of the real page cannot do this and never could: six representative targets
  were measured and all six refuse framing, and the operator's own services are the worst case —
  behind Cloudflare Access, with Safari blocking third-party cookies, a cross-origin frame is handed
  a login page that refuses framing too. Same-origin is what buys all four things at once (Collie
  sets the framing headers, the Access cookie stays first-party so the existing device gate is
  unchanged, `default-src 'self'` already permits the frame with no policy weakened, and loopback
  bypasses Cloudflare so no service token exists to leak). The bytes are contained rather than
  trusted: a kb document is HTML an AGENT wrote, often out of pages on the open web, and 29 of the
  operator's 52 carry an inline `<script>` — so the response goes out under `sandbox` into an opaque
  origin, with `base-uri 'none'` to neutralise the leftover `<base href="about:srcdoc">` in 34 of
  them so in-page anchors work with no script at all. The route lives under `/api/` rather than at a
  prettier `/d/` because an iframe's document load is a NAVIGATION: the service worker answers
  navigations from the precached app shell unless the path is denylisted, and `/^\/api\//` already
  is — at `/d/` the panel would have rendered a second copy of Collie, and would have looked fine in
  a browser tab with no service worker. The slug is an allowlisted charset checked before any string
  is concatenated, because it is interpolated into a loopback call carrying the kb credential.
  `COLLIE_KB_ORIGIN` (refused unless it is loopback), `COLLIE_KB_TOKEN` and `COLLIE_DOC_HOSTS`;
  leave any of them blank and the feature is absent rather than broken — every link stays external,
  which is exactly what a bridge older than the field does. The two halves cannot drift apart
  silently: `bridge/doc-path-contract.test.ts` runs one shared list through the client's classifier
  and the bridge's reader, the same way the `/auth` reservation is pinned.
- **Pick a folder for a new space instead of typing its path.** A new `GET /api/dirs` answers with
  DIRECTORY NAMES and nothing else — no files, no sizes, no contents — rooted at the operator's home
  and enforced on the RESOLVED path, so a `..` or a symlink is refused after the kernel has said
  where it lands rather than before. Gated on write although it writes nothing: a device that may
  not create a space has no use for the list. The sheet browses one tap per level, with a shortcut
  strip built from the directories already open (repo roots first, then pane cwds), and the manual
  path field stays below it for everything the picker deliberately cannot reach. Every filesystem
  call is on a deadline: the operator's own `~` never answered at first, because one symlink in it
  resolves into `~/Library/CloudStorage/`, and the bridge — started by launchd without Full Disk
  Access — waits on that forever. One unresponsive entry now costs its own row and nothing else.
- **The tab strip's "+" can open an agent.** Hold it to choose which launcher row it runs — or a
  plain shell, which is the default and what every install shipped with. The pin is stored as the
  row's `command`, so renaming a row in `launchers.toml` keeps it working and deleting one falls
  back to the shell rather than failing a create nobody remembers configuring. No new plumbing:
  `POST /api/launch` already opened a tab beside a named pane, and the "+" had no way to ask for it.
  Holding it no longer hands iOS the page to highlight. Three rounds, and the first two were the
  wrong model: iOS does not give up when the pressed element is unselectable, it walks UP for the
  nearest SELECTABLE ancestor — so `select-none` on the button moved the selection one level out and
  `select-none` on the scroller moved it out again. The walk ends only at an unselectable ROOT, so on
  a device with no mouse the chrome is now unselectable from `body` down and CONTENT is exempted by
  name (`pre`, `code`, form controls, `[data-selectable]`). Desktop is untouched. Each row in that
  sheet also carries its agent's own mark — the same tile the tab strip and the herd list already
  draw, resolved from the row's COMMAND (`codex --profile work` and `/opt/homebrew/bin/codex` are
  both codex) rather than from a second list of names; a row whose first word names no agent gets
  the neutral initials tile the component already falls back to.
  Antigravity's tile is the real mark now: upstream drew a triangle "A" in white on Google blue —
  the one brand entry with no source cited beside it — and the actual logo is a rounded arch with a
  four-colour gradient. With no official vector to take a path from, this embeds Google's own
  `apple-touch-icon.png` (cropped, 80px WebP, 3.0 kB) through SVG `<image>` in the same tile, rather
  than tracing it by hand the way the wrong one got there. Orca answers this by fetching each
  agent's favicon by domain at runtime; Collie does not copy that — it would need a third-party
  image host in the CSP, tell that host which agents you run, and show nothing offline.

- The mirror's font ceiling goes 16 → 24, for the desktop. Measured in a 1908px browser window: the
  pane view's column is 1400px and the reply field 1320px, but a herdr pane is 84 columns, so at the
  default 10px the terminal draws 504px and the rest of the width has nothing in it. The mirror was
  never narrow — the terminal is — and the only lever that fills the width without touching the
  source pane is the glyph. 16 was a phone's ceiling that had quietly become everyone's.
- **The test suite is green: 181 files, 5067 tests, zero failures.** jsdom 29 defines `Storage` but
  never wires up `globalThis.localStorage`, so 133 tests across 18 files had been failing on it —
  meaning no test in this repo could catch a persistence regression, and a real new failure had to be
  spotted inside a wall of expected ones. `web/src/test/setup.ts` installs a Map-backed Storage whose
  members live on `Storage.prototype`, because that is where this suite's own Safari-private-mode
  spies go. Three assertions that had gone unrun since `controlsOpen` landed are corrected with it.

- The Controls row (Keys / Type / Quick / Agent / ⚙) can be put away, and the status band above it
  is the handle — a surface that was already on screen in both states, so collapsing costs nothing
  to reach. Measured on a 393x852 phone: the terminal mirror gains 40px (the row's 44px plus its
  8px/6px margins, less the 18px the band grows by to stay tappable while it is the only way back).
  Persisted with the other display prefs, so it survives a pane switch and a restart; default is
  open, so an install that never touches it renders exactly what it always did. The band reads
  leading-edge now — handle, machine, state as one group — because a right-aligned word with a lone
  chevron at the far end reads as two unrelated things once the band grows to 32px.
- A home-screen web app fills the screen again, and the fix is the viewport meta rather than any
  CSS height. On iOS 26 `viewport-fit=cover` produced two answers at once: a layout viewport of 793
  on an 852pt screen — already 852 minus a status bar, i.e. sized for an INSET web view — while the
  page was still placed under the status bar and `env(safe-area-inset-top)` still reported 59. iOS
  letterboxed the 59pt difference in page colour above the home indicator, and no CSS reaches it:
  stretching the shell to `lvh` (852) put the composer off the bottom of the screen instead, which
  is what proved whose 793 to believe. Cover is dropped and the status-bar style is `default`, so
  the web view is inset for real, every `env()` reads 0 and the OS paints the bands it reserves.
  The shell stays exactly `100dvh` — the invariant that keeps the Send button reachable.
- …and the home indicator's band is a token, `--safe-bottom`, because with cover gone the platform
  can no longer report it: every `env()` reads 0 by definition, while iOS 26 still runs the page to
  the physical bottom edge, so the composer's last row came out under the indicator — invisible in a
  screenshot, plainly cut on the glass. In standalone the reserve has a floor of 34px (Apple's own
  portrait inset, and therefore what normal looks like); elsewhere `max()` leaves the platform's
  number in charge. Every surface that reserved that band — composer, sheets, toasts, both footers,
  zen — reads the one token now.
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
- `collie-upstream-sync` again after a second review: a strict install is never offered a prerelease
  (upstream's own ADR 0020 rule), the survey exits non-zero when it never reached upstream, the
  contested set comes from the effective diff so a second sync is not wrong, an unreadable upstream
  CHANGELOG is reported rather than read as "no changes", and tests run before the build that
  deploys them.
- **The folder picker answered 403 to every browser, and only to browsers.** `GET /api/dirs` is
  gated on write although it writes nothing, and the access gate refuses a write that arrives with
  no `Origin` from a non-loopback Host — a rule written for POSTs, which browsers always give an
  Origin. Browsers OMIT Origin on same-origin GETs, a fact the same function's doc comment already
  relied on to let the snapshot poll through, so the picker was unreachable from the moment it
  shipped. It survived every probe because loopback is exempt from that rule: the only failing path
  was the only one a real user could take. The Origin requirement is now a statement about the
  METHOD — a safe method cannot be forged into a state change, and an attacker page cannot read the
  answer either, because this API sends no CORS headers. Two existing tests asserted the old rule
  with a GET standing in for a write; they now use POST, which is what a write is on the wire and
  what they meant all along.
- **The folder picker can be pointed at just the projects that matter.** `COLLIE_DIR_ROOTS` names
  the directory trees the picker may list; unset keeps upstream's behaviour, where the operator's
  home is the single root. With several roots declared there is no directory above them the operator
  may see, so the top of the browse is not a place on disk — it is the roots themselves, with no
  path and no way up. One root means that root IS the top, rather than a one-row level to tap
  through, and a root that does not resolve is dropped rather than fatal: one typo must not take the
  picker down. **`POST /api/workspace` enforces the same boundary**, which is the half that makes it
  one: that route took a `cwd` straight from the client and defaulted to `$HOME`, so a limit only
  the picker respected would have been decoration — the phone could still have opened a shell
  anywhere on the disk. Both paths call one resolver, so the browse rule and the create rule cannot
  drift apart. The refusal no longer says "outside the home directory", which stopped being true.
- **The dashboard no longer launches a space from a tap.** Upstream draws the operator's
  `launchers.toml` rows as a Launch strip, and a tap CREATES A THROWAWAY SPACE running that
  command — a control shaped like a picker that behaves like a create, which is what made it
  confusing rather than useful here. The strip is no longer rendered. `launchers.toml` itself is
  kept and unchanged: the tab strip's "+" still reads the same rows for its hold-to-pin sheet, where
  they do the thing their shape promises. The two consumers were already independent, so this
  removes exactly the dashboard strip and nothing else; `home.tsx` records what to put back.
- **`collie doctor` names `launchers.toml`, present or not.** With no rows the tab strip's "+"
  opens a plain shell and its long-press is not wired at all, and nothing on the phone says why —
  a second machine that got its `.env` but never this file reads as a broken gesture. The new
  `launchers` line says "none at <path>" and what that costs, counts and labels the rows when
  the file is there, and warns when a row would be dropped or the file does not parse, judged by
  the bridge's own validator so the two cannot disagree. Absent is `ok`, not `warn`: declaring
  nothing is a choice, and a healthy install still warns about nothing.
