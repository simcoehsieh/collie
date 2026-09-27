// FORK: NO PINNED PILLS ON THE BELT (operator, 2026-09-27). Upstream pins icons at the actions belt's
// right end: the Switch mark (Layers, the pane switcher, since 1.9), the Changes pill (GitCompare,
// since 1.13.1) and, from 1.14.0, the composer's X that empties the text box (Undo after a tap). The
// operator does not want any of them on screen; the X came in under the same gate because it stands
// in the same place, and a clear is the phone keyboard's own select-all + delete.
//
// Off at this one gate, like the glide (lib/glide.ts) and the dashboard footer (lib/dash-tabs.ts):
// components/actions-row.tsx asks it once, in `pinnedCount`, and with it false the pinned block, its
// scroll spacer and the fade that steps around it are all absent, so the belt scrolls edge to edge.
// What stays, on purpose: the belt is still the DRAG SURFACE (`handle.ref`), so a pull up on it
// still brings the pane switcher; only the tap target is gone. Lost with the mark: its red dot for
// "another pane needs you". Changes stays reachable from the pane menu's diff row.
//
// Upstream's own tests still run with the pills (vitest's MODE is "test");
// components/actions-row-no-pins.test.tsx pins the fork's shape by mocking this module.
export const FORK_BELT_PINS_ON: boolean = import.meta.env.MODE === "test";
