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

- **The same reply is pushed once.** A "done" push remembers which assistant turn it carried, per pane, and a second `done` for the same turn sends nothing — the status had flapped (`done` → `idle` → `done`, which happens while the phone is looking at the pane), not finished anything new. A new turn is a new push. (bridge/notifications.ts, bridge/reply-peek.ts)
- **Hand a pane's conversation to another agent.** A session cannot move between harnesses, so what moves is a document: the pane menu's new "Hand off" row asks the current agent for its own summary (one more turn, skippable), the bridge folds that together with the recent turns, the pane's artifacts and what the operator wants next into a markdown handoff kept as the pane's own artifact, then launches the chosen launcher row (claude, codex or agy) beside the pane with one opening instruction: read that file and continue. The phone lands in the new pane. (bridge/handoff.ts, `POST /api/pane/:id/handoff`, components/handoff-sheet.tsx)
- **The "/rc" row is gone from the pane's status area.** Claude Code's remote-control indicator, painted right-aligned among its status rows, is about the desktop's own link and said nothing on the phone. (harness/claude/chrome.ts)
- **Stop, and edit what you just sent — in the Send button's own slot.** After a send, while the agent works and the box is empty, Send becomes Stop: one tap sends Esc to the pane and puts the message back in the box to change and send again. Typing brings Send back (a new message while the agent works still queues). Offered only for the message that put the agent to work, and dropped by any outcome that already restores the draft. (components/composer.tsx)
- **The pane header no longer shows the work tree's totals.** The "N files · +a −b" chip took width off the pane name and was never tapped; the Changes row in the pane menu still opens the same sheet, and the mirror's file chips still draw from the same read. (components/agent-chat.tsx)
- **No more "Nothing needs you" after every reply on the iPhone.** A retraction push is not sent to Apple's endpoints at all: WebKit revokes a subscription after three silent pushes, so the worker had to draw a placeholder for each one, and every reply the operator sent settled a `done` alert and produced one. The alert now stays until the next one replaces it in the same slot; other push services still get the silent close. (bridge/push.ts)
- **A "done" push that carries the agent's line is headed by the pane, not by a verb.** "AI Live · claude" over "<what it said>", instead of "claude is done" over "AI Live · <what it said>" — the verb line said nothing the body did not. An empty title was tried and is worse: iOS fills it with the app's name. ("from Meow" beneath the title is iOS's own attribution for a web push and stays.) (bridge/notifications.ts)
- **Attaching a photo no longer trips the outage banner.** A picture upload is a long upload exactly as a voice clip is: the poll stands down and the connection clock does not escalate while it is in flight. Before, the megabytes going up a mobile uplink queued the snapshot poll behind them, the bar went amber at 4 s and red with Reload at 15 s, and Reload killed the upload it was blaming — no phone-attached picture had ever reached the bridge. (lib/api.ts, lib/connection-health.ts)
- **Drawing on a camera photo no longer kills the app.** The annotate canvas capped its backing store at 12 Mpx: a 4032×3024 photo at DPR 3 asked for 109 Mpx, past iOS Safari's 16.7 Mpx ceiling. (`canvasScaleFor`, lib/markup.ts)
- **What an agent made is kept beside the conversation that made it.** `collie artifact add <file> [--title …] [--slug …] [--tag …] [--origin …]` copies the file into `<stateDir>/artifacts/` (bytes first, record last, 5 MiB cap) with the harness session id; the bridge joins that id against the multiplexer's own agent list and stamps the pane onto the record, then remembers it. The phone gets a card under the turn that made it, a header chip and sheet on the pane, `/artifacts` (search, pinned first, newest version of each slug) and `/artifacts/:id` (versions, pin, two-tap delete, a note on the whole artifact sent back to the pane, "kb" once promoted). HTML is framed `sandbox=""` under `DOCUMENT_CSP` — the object preview and the kb panel use; markdown and text are served `text/plain` and rendered by the thread's own renderer; anything else is an attachment. The preview panel gains Keep (`POST /api/artifacts`, read through preview's own jail). `collie artifact promote <id> --folder …` pushes and promotes through the operator's `kb` CLI and writes the slug back. An `artifacts` SSE poke refetches every mounted list. (bridge/artifacts.ts)
- The live feed's keepalive was slower than Bun's 10 s `idleTimeout`, so a quiet stream died every nine seconds and reconnected through the tunnel: ping 15 s → 5 s, and the idle timeout is written down (150 s) rather than inherited.
- `GET /api/boot` answers the snapshot, config, launcher rows, notification prefs and (when the card is on) the quota in one response, so a cold boot is one round trip instead of six in a row.
- `/api/config` is fetched once per boot instead of three times, from a memo all three callers share.
- The four non-hashed dist files carry an ETag and compress — `sw.js` was 25 KB fetched once a minute per open screen with no validator, and is now 7.7 KB, or nothing at all.
- `/api/pane/:id/history` validates on its body's hash, so the reply card's settle-triggered read costs a 304 rather than a page of turns.
- An SSE poke carries the version it is about, and a page already holding those bytes skips the fetch it can prove would answer 304.
- The Overview's tails ride the page's live feed instead of a 3 s timer of their own: 123 requests a minute at six panes becomes about five.
- A finished pane's Overview card shows the agent's newest reply from its journal instead of six rows of its own input box.
- The service worker stops precaching six locale chunks nobody reads and a sprite nothing draws: 34 entries / 1440 KiB → 27 / 1038 KiB.
- **An agent pane opens on its conversation, and the terminal is one tap away.** The mirror is a 51-row photograph of a TUI whose top edge cuts every long answer in half; chat mode renders the journal's thread in the same slot the latest-reply card took, with one segmented control in the Controls row that already exists (no third band, #186) and the choice remembered per pane and per device. A dialog that owns the keyboard takes the mirror back on its own, and so does find — it is never a view you can get stuck in. A streaming turn has not been written to the harness's JSONL yet, so a working pane says so instead of looking stalled.
- **Tool cards say what kind of work they were, and how far they got.** Zed's ACP vocabulary (read/edit/delete/move/search/execute/think/fetch/other) is mapped from the tool name alone, so 700 identical wrenches become nine glyphs, with pending/in-progress/completed/failed derived from the result and the pane's own state. Bodies stay collapsed.
- **The plan is kept whole and pinned.** `TodoWrite` (Claude Code) and `update_plan` (Codex) reach the phone as a `todo` part carrying every item and its state, not as the first line of the first one, and the pane pins the latest as a checklist above the thread. A harness with no such tool pins nothing.
- **A pane you have not opened for an hour leads with what happened.** Turns, tool mix, the diff stat from the endpoint the Changes sheet already uses, and the age of the standing question — all counted, none summarised, no model asked. A tap dismisses it.
- **A "done" push says what the agent said.** One journal read, only for a single alert that survived the debounce and the notify rules, puts the reply's first line in the body beside the space. The push always goes out: a missing line leaves the body the address it was.
- **An agent can say what it is working on.** `collie beacon status "<line>"` writes one sentence that the herd list shows under the pane's name — display-only, keyed by the agent's session, dimmed past fifteen minutes and never hidden, gone after a day.
- **A diff hunk, a transcript turn or a document can be held to write a note about it, and the notes go as one prompt.** Long-press (or "+ note" with a mouse) opens a sheet with the excerpt, a field and bug/change/question chips; saved notes wear a numbered pin, count in a header chip, and "Send N notes" builds one Markdown document in Orca's shape — `## Feedback:`, a `###` per note, bold field labels, the human's sentence last — delivered through the guarded reply path, or through the offline queue when the pane is working. Per pane in `localStorage`, 20 notes, 2000 characters of comment, 500 of excerpt; re-noting the same anchor updates that note rather than stacking a second. Sent notes are dimmed, not deleted.
- **The composer shows what will ride along, and asks once.** Pending notes appear as deletable chips above the input; sending an ordinary reply while notes wait offers Include / Not now inline, never as a modal. `n` opens the list on a desk.
- **A file of the work tree opens beside the terminal, not just its patch.** `GET /api/pane/:id/file` serves one text file of the pane's own tree (512 KiB cap, truncated rather than refused; a binary is a 415, decided by a NUL sniff plus a strict UTF-8 decode) through bridge/diff.ts's jail, with a third containment check on the realpath. The sheet is mono, pans rather than wraps, and windows a long file the way History does. No syntax highlighting: a highlighter emits an HTML string, which this app's XSS boundary cannot take.
- **The page the agent just wrote opens in a panel.** `GET /api/preview/file` frames an `.html` file from the pane's own `cwd` under the knowledge base's exact CSP — the same constant, so a relaxation for either surface fails both tests — sandboxed into an opaque origin on both the response and the iframe. Reload, a 390/768/fit width toggle and Open in browser; a live dev server is deliberately not served, because `default-src 'none'` refuses it.
- **The mirror grows chips: open a URL, preview a local server, open a file.** A line with an `http(s)://` URL gets a chip beside it; `localhost:PORT` gets Preview; a line naming a path the pane's diff list already holds gets one that opens the viewer — a lookup, not a path heuristic. Each is a trailing ornament inside the `<pre>`, so no row is added and no find offset moves, and a bare `host:port` is still not a link. The pane header gains "3 files · +82 −11" from the same read.
- **Draw on a screenshot of the Mac's own page and ask about what you circled.** `POST /api/pane/:id/shot` and `/probe` run the operator's own headless-Chrome command (`COLLIE_SHOT_COMMAND`, `bridge/shot.ts`, the `quota.ts` seam again); the phone paints the shot into a canvas, draws pen/highlight/arrow/box/circle/text with undo-redo-clear, taps an element for a numbered pin and a tag/selector/component card, and "Attach & ask" uploads the flattened WebP through the existing chain and seeds the draft. It never sends.
- **The screenshot is taken at the phone's own viewport, not the desktop's.** 390×844 by default, 768 and 1280 a tap away; WebP at q0.85, because a DPR-3 PNG of a full page blows the 10 MB upload cap.
- **A shot can only ever be of this machine.** Loopback plus `COLLIE_SHOT_HOSTS`, checked in the bridge as well as in the command; Orca's attribute allowlist and narrow secret redaction are applied in the page and again in the bridge.
- **Tap an attached picture to draw on it before you ask about it.** The chip appears after an image upload, so attaching still costs the taps it did.
- **A status dot is a fill, and the values tuned for text rasterised to mud.** `--status-X-mark` joins `--status-X`, light halves only, hue kept: blocked `#d93539`, working `#e48f00`, done `#1a9951`, idle `#6f7c89`, unknown `#677380`. StatusDot, the quota bars and the section bullets take the mark half; every chip, badge and word keeps the text half, so no contrast ratio changed.
- **The mirror is a well now, not a hue shift.** It measured 1.013:1 light and 1.034:1 dark against the page; `--rule` on both edges plus a short inset shadow give 1.338/1.566 and 1.157/1.023.
- **The composer's segmented row exists.** `--muted` and `--chrome` are the same value in light, so the container's fill composited to its own ground; a new `--trough` cuts a real step (1.12 light / 1.09 dark) with a 1px inset ring.
- **One rule for the accent:** tonal `--control-on` marks state, solid `--primary` marks the one action a screen wants. `--control-on` gains a hover and a pressed step.
- **Light `--primary` stopped shouting.** `#145ec1` → `#3a6fbd`, 4.89:1 under white, the same chroma as dark's.
- **The terminal keeps its structure when it wraps.** line-height 1.4, a per-line hanging indent behind `@supports (text-indent: -2ch each-line)`, and the default mirror size 10 → 11px.
- **The status bar stops being a stripe.** `theme-color` and the manifest carried the mirror's `#f5f5f5`/`#0a0a0a`; they are the page's `#f1f4f7`/`#0d0f15`.
- **The dock's fold handle is the whole band.** 97×14 → 354×24; it always claimed to be full-width.
- **Nothing is tighter than the radius ramp.** Ten bare `rounded` corners become `rounded-sm`, and the paired-device pill becomes a `<Badge>`.
- **One red.** `--destructive` is retuned onto `--status-blocked`'s hue and chroma — `#c21725` light at 5.84:1.
- **The states playground renders the skin it is auditioning.**
- **The tab strip dissolves instead of being cut**, and only when it overflows.
- **The boot splash is the brand, not the disabled colour.** Mark in `--foreground`, cursor in `--primary`, and a 260 ms hand-off into the header slot.
- **The cat is the herd's state.** Four states driven from the same `worstTriage` the chips use — ears flatten when an agent needs you, one slow blink when the herd is done.
- **One accent, two jobs.** Tonal `--control-on` marks state; solid `--primary` marks the one action a screen wants. Space/tab chips, pane pills, the Appearance three-way and the docs tag filter go tinted; Send, "Tap to resume" and the update CTA stay solid, and a status dot on a selected pill gets its contrast back.
- **Screens that are arriving draw themselves.** A fork-only skeleton primitive and four screen shapes replace the lazy routes' blank fallback, the dashboard's "Waiting for Herdr…" and the push switch's spinner; a 120 ms CSS delay keeps a precached chunk from flashing anything.
- **A route arrives from the direction it came from.** `data-route-enter` gains push / pop / modal, decided by navigation type and path depth, on iOS's own curve at 260 ms; a pane→pane hop still remounts nothing.
- **The Keys pad is one keyboard.** One 4-column grid (Space ×4, Shift ×2), keycaps with a real bottom edge on a `--card` panel that sits over the dock, and "Keys" stops naming three things on one screen.
- **Empty and error screens get the app's own shape.** `<EmptyState>` extracted from the idle lock and mounted on the overview, the dashboard, the root error boundary and a 404 — which now says "No such page" instead of "Unknown error".
- **One squircle for every agent.** The monogram tile is drawn with the brands' own viewBox and radius, so a roster is one shape at one size whether a logo exists or not.
- **The cat stops speaking dog.** A fork-only i18n override layer replaces the animal nouns in the four locales that used one, leaving upstream's seven dictionaries a pure-insertion diff; the unmounted galloping-dog sprite and its CSS are deleted.
- **Cinema mode.** A second pull down on the composer's handle folds the header and both strips; a 28 px capsule over the mirror's corner keeps the mark, the pane's status dot and its name, and a pull up or a tap brings the chrome back.
- **The mark inside the app is the cat, and the header says the machine's own name.** A fork-only
  `MeowMark` takes `CollieMark`'s props and every host (header, boot splash, idle lock, playground)
  uses it; loading blinks the cursor in the accent colour and lets the eyes glance. `branding.json`
  gains `hideMux`, which drops the header's whole "on herdr" line so the name stands alone; the brand
  word is `shortName`. Upstream's generated `collie-mark.tsx` is untouched and its hash test still holds.
- **The home page shows what each of the three agents has left.** A "Usage" section under Spaces
  lists claude, codex and agy with their 5-hour and weekly windows as bars, the reset countdown
  ticking client-side, and a tap opening the other windows, model quotas and credits. Fed by
  `GET /api/quota`, which runs `COLLIE_QUOTA_COMMAND` (this machine: ai-live's `ai-quota --json`)
  behind a 60 s cache that serves stale while refreshing; unset means no route and no card. The
  command's output never reaches a response body — it reads keychain tokens.
- **A chunked kb answer is read under the cap, not refused.** kb is Go's net/http and sends any
  body past its 4 KB write buffer chunked with no Content-Length — the tag list and a full page of
  documents both are — and `body()` had refused those as "unusable" while a three-row search came
  through. It now streams a lengthless answer chunk by chunk and drops it where it crosses the cap.
- **Two panels beside the terminal: what the agent changed, and the knowledge base.** A read-only
  `GET /api/pane/:id/diff` (git status + numstat, one file's unified diff; 5 s deadline, 512 KB cap,
  jailed to the home directory, no write verb) feeds a "What changed" sheet in the pane's actions.
  `GET /api/docs` and `/api/docs/tags` proxy the kb list, search and tag endpoints over the same
  loopback-only, credential-never-leaves discipline as `/api/doc/<slug>`, and the document panel
  grew a browser: search, tag chips, recent, and a back stack so a doc opened from a link is one tap
  from the list.
- **A send the link failed is kept and resent, not handed back to be retyped.** A reply that died
  on the transport (network, timeout, Cloudflare 52x, an Access redirect) goes into a per-pane queue
  in `localStorage` (24 h, 8 KiB each), shown above the composer with Send now / Discard, and drains
  in order when the feed or the network comes back. A queued prompt answer never auto-drains.
- **The red banner says where the connection broke.** `/api/health` is probed and the verdict
  names it: Herdr down, "Collie is restarting" (auto re-probe, no Retry to hammer), "Sign in again"
  on an Access redirect, or the tunnel. A changed build id after the first sighting posts one line
  saying Collie restarted, so pane ids changing under the operator is explained.
- **Four panes on one screen, each with its last six lines.** `/overview` is a grid of memoised
  cards (status, title, plain-text tail) refreshed on a 3 s beat, paused when hidden, read without
  `x-collie-seen` so a glance does not clear "Ready · unseen". Entry glyph on the home header.
- **A long press pins a pane to the top of the dashboard, in the operator's order.** Pinned rows
  lead the triage list; a sheet reorders them; pins are pruned when their pane is gone.
- **The desk gets keyboard shortcuts, and the phone is left alone.** Fine-pointer only, never in a
  field: `j`/`k`, Enter, `1`–`9`, `g o` / `g h` / `g s`, `/`, `?`, Esc, and ⌘K opens the palette.
- **Low power stretches the two fast poll gaps and leaves the feed alone.** A Settings switch (or
  `navigator.connection.saveData`) takes HOT 1 s → 3 s and the post-send burst 300 ms → 1 s; the
  event stream stays up because it is cheaper than polling. A glyph in the header says it is on.
- **The phone reads a reply aloud.** A speaker on the latest-reply card, and a "Read replies aloud"
  switch under hands-free that speaks each new reply on-device via `speechSynthesis`; stops on a
  send, a pane change, or the mirror moving on. Off by default.
- **A Shortcut can hand text to the last pane, as a draft, never a send.** `/pane/last?send=…`
  redirects to the most recently opened pane and seeds the composer; the manifest declares a
  `share_target` and two app shortcuts. iOS ignores `share_target`, so the working path there is a
  Shortcuts "Open URL" action.
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
