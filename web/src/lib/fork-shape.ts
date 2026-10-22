import { FORK_UPDATE_POLICY } from "../../../fork/update-policy";

// Like the fork's other shape gates, upstream tests keep exercising the upstream flow. Fork
// behavior tests explicitly enable this gate; the CLI classification reads the policy itself.
export const MAINTAINER_MANAGED_UPDATES: boolean =
  FORK_UPDATE_POLICY.maintainerManaged && import.meta.env.MODE !== "test";

export function upstreamReleaseUrl(version: string): string {
  return `https://github.com/AltanS/collie/releases/tag/v${encodeURIComponent(version.replace(/^v/, ""))}`;
}

// FORK: THE PANE HEADER IS ONE TAP (2026-10-08, at the 1.17 merge). Upstream 1.17.0 split the header's
// identity block into two buttons — the name line opens Pane settings, the place line opens the space.
// This install keeps the block as one target that opens the space, as it was: the split is a restyle
// of a screen the operator already uses by feel, and Pane settings stays on the ⋮ menu. Off here,
// components/agent-chat.tsx routes the name line's tap to the space too. Tests run with the split.
export const FORK_HEADER_NAME_TAP_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO LOST BADGE ON THE HEADER MARK (2026-10-11, at the 1.19 merge). Upstream 1.18.0 made the
// connection strip dismissable and put a badge on the mark so the state survives the dismissal. This
// install keeps the fork's four-cause banner, which is not dismissable, and the mark already dims and
// greys while lost, so the badge would be a second signal for a state already on screen. Off here,
// components/collie-home.tsx draws no badge. Tests run with it.
export const FORK_MARK_LOST_BADGE_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO BRANCH ON THE DASHBOARD ROW OR THE PANE HEADER (2026-10-11, at the 1.19 merge). Upstream
// 1.18.0 leads every dashboard row's second line with the pane's git branch, and adds it after the
// workspace in the pane header. The row's standing shape is one line per pane (FORK.md), and the
// header's second line is the workspace and the model (the operator's call, 2026-09-17). Off here,
// components/agent-card.tsx and agent-chat.tsx draw no branch; the Files header still names it.
// Tests run with it.
export const FORK_BRANCH_LABEL_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO MODEL TAG IN THE PANE'S CORNER (2026-10-11, at the 1.19 merge). Upstream 1.19.0 labels the
// mirror's bottom-right corner with the agent's model. This install already shows the model and its
// effort on the header's second line (lib/model-label.ts), so the corner would say it twice. Off here,
// components/agent-chat.tsx draws no ModelTag. Tests run with it.
export const FORK_MODEL_TAG_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO NEW PAGE (operator, 2026-10-11, at the 1.19 merge: 「New 頁：不要」). Upstream 1.19.0 starts
// agents, commands and worktrees from one page at /new, reached from the SPACES header's folder button,
// a pane's "New agent on a branch" and the empty dashboard's "Start your first agent" (it also folded
// away the old new-space sheet those doors used to open). Off here: routes/home.tsx and
// components/agent-chat.tsx pass none of the three doors, and space-overview.tsx draws no folder button
// without one. The route itself stays in the router, unreachable from the app. Tabs still open from
// the tab strip's "+" (a launcher on its hold). Tests run with the page.
export const FORK_NEW_PAGE_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO TASKS PILL ON THE BELT (2026-10-22, at the 1.23 merge). Upstream 1.23.0 adds a "Tasks
// done/total" pill to the actions belt that opens the pane's task list. The belt keeps its own set of
// verbs (lib/belt-pins.ts says why the operator wants nothing extra there), and the terminal-first pane
// already shows the agent's own task list on screen. Off here, components/actions-row.tsx draws no
// Tasks pill; the bridge still serves the list. Tests run with it.
export const FORK_BELT_TASKS_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO SCREEN PILL ON THE BELT (2026-10-22, at the 1.23 merge). Upstream 1.22.0 adds a Screen pill
// that shows the terminal's raw rows without cards. The pane here opens on the terminal already
// (lib/pane-view.ts), so the pill would be a second door to the view the pane is in. Off here, the belt
// draws no Screen pill; a contested read's notice still names the terminal view. Tests run with it.
export const FORK_BELT_SCREEN_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO THEME PICKER (2026-10-22, at the 1.23 merge). Upstream 1.22.0 ships four themes (Collie,
// Nightwatch, Daylight, Harbour) with import and export, picked from Settings. This install's look is
// the fork's redesign (FORK.md, "The redesign": skin.css and lib/design.ts), which the new themes do
// not know and would draw over. Off here, Settings shows no Theme select, import or export, and the
// app stays on the default theme under the fork's skin. Tests run with the picker.
export const FORK_THEMES_ON: boolean = import.meta.env.MODE === "test";

// FORK: NO VIEWPORT LINE UNDER THE BUILD STAMP (2026-10-22, at the 1.23 merge). Upstream 1.20.0 shows
// `vp inner/visual/screen` under the stamp on every dev build. This install's live build is always a
// `-dev` build, so the line would stay on the phone. Off here, components/build-stamp.tsx draws none.
export const FORK_VIEWPORT_STAMP_ON: boolean = import.meta.env.MODE === "test";
