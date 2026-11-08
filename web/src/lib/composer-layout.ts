// How the composer is laid out: the reader of the theme's surface word `composer`
// (lib/theme/surface.ts). `field` is one text field with its row of controls; `box` is the boxed one. The word sets no CSS
// property, as `zoom` does not; the composer reads it here and chooses its classes.

import { FORK_NEW_LOOK_ON } from "@/lib/fork-shape";
import type { SurfaceWord } from "@/lib/theme/surface";

/**
 * The layout a theme word names; a theme that leaves it out gets `field` (the theme `collie` names `box` in its file).
 *
 * FORK: always `field` in the shipped app. Upstream 1.27.0's default theme names `box`, part of its new
 * look, which this install does not take (lib/fork-shape.ts FORK_NEW_LOOK_ON): the composer stays the
 * fork's field with its row of controls. Tests run with the word.
 */
export function composerLayout(word: SurfaceWord<"composer"> | undefined): "field" | "box" {
  if (!FORK_NEW_LOOK_ON) return "field";
  return word === "box" ? "box" : "field";
}
