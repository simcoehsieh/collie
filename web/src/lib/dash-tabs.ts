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
