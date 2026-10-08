// FORK: NO DASHBOARD FOOTER (operator, 2026-09-27). Upstream 1.13.1 put a Panes / Focus / Changes tab
// bar under the dashboard (ADR 0066, ADR 0068); on this install it is a row of chrome nobody used, so
// the dashboard is the Panes list alone. Changes stays reachable from a pane's menu (the diff row);
// the belt's Changes pill is off too (lib/belt-pins.ts).
//
// Off at this one gate, like the glide (lib/glide.ts): routes/home.tsx asks it twice, for whether
// to draw the TabBar and for which view to show. The view is forced to "panes" as well as the bar
// hidden, because a device that stored "focus" or "changes" before the bar went away would
// otherwise be stuck on that list with no way back. Everything else upstream wrote around the bar
// (the Focus filter, ChangesTabBody, the dash prefs' `dashView`) stays in the tree and merges
// untouched.
//
// Upstream's own unit tests still run with the bar (vitest's MODE is "test");
// routes/home-no-tabs.test.tsx pins the fork's shape by mocking this module. Upstream's
// `dashboard-footer` e2e spec runs the production bundle and fails here by design.
export const FORK_DASH_TABS_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO "+" ON THE WORKSPACE HEADINGS (operator, 2026-09-27, at the 1.14 merge). Upstream 1.14.0
// ends every dashboard heading with a "+" that opens a new tab in that workspace, in a plain shell.
// Every tab on this install is opened from a launcher (claude / codex / agy), which the tab strip's
// "+" hold already picks, so a heading "+" would be one more control per heading opening the wrong
// thing. Off at this gate: routes/home.tsx passes no `newTab`, and agent-list.tsx then draws no "+"
// and drops the `min-h-7` it reserved for one. Tests run with it (MODE "test"), and
// routes/home-no-tabs.test.tsx pins the fork's shape.
export const FORK_HEADING_NEW_TAB_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO BARE SHELLS IN THE DASHBOARD LIST (operator, 2026-10-04: "空的 shell 不用呈現吧"). A shell
// pane has no status to watch and nothing to answer, so on a phone its row is a line of chrome — and a
// workspace holding nothing but a shell (`Survey`, `folio`) became a whole heading for it. The
// dashboard list is agents only; a shell stays one tap away in SPACES (whose counts still include
// it), the tab strip and the pane switcher. The snapshot carries no foreground process, so "bare"
// cannot be told from "running a dev server" without a per-poll process read; this gate takes every
// shell off the list and leaves the rest of the app as it was. routes/home.tsx asks it once.
// Tests run with shells (MODE "test"); routes/home-no-tabs.test.tsx pins the fork's shape.
export const FORK_DASH_SHELLS_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO ORDER TOGGLE OR NEEDS-YOU SWITCH ON THE DASHBOARD SUMMARY LINE (2026-10-08, at the 1.17
// merge). Upstream 1.17.0 put a clock/hourglass order toggle (Activity, Cache) and a circle-dot
// needs-you switch beside the summary line, and made the dashboard follow an order chosen in the pane
// switcher. This install's dashboard is the operator's design: workspace groups in place order, no
// controls on that line. Off at this gate: routes/home.tsx passes no `order`, `onOrderChange` or
// `onNeedsYouOnlyChange`, so agent-list.tsx draws neither control, and `needsYouOnly` is forced off —
// 1.17 migrates a stored Focus tab into that switch, ON, which would otherwise filter the list with no
// way to turn it off. The switcher keeps its own order. Tests run with them (MODE "test").
export const FORK_DASH_SUMMARY_CONTROLS_ON: boolean = import.meta.env.MODE === "test";
