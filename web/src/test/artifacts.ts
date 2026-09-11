import type { ArtifactView } from "@/lib/types";

/** One artifact as the bridge lists it (bridge/artifacts.ts) — override what a case is about. */
export function fixtureArtifact(over: Partial<ArtifactView> = {}): ArtifactView {
  return {
    id: "mf8a1b2c-0123abcd",
    slug: "q3-report",
    version: 1,
    title: "Q3 report",
    kind: "html",
    ext: "html",
    mime: "text/html; charset=utf-8",
    size: 2048,
    sha256: "00".repeat(32),
    sourcePath: "/home/you/webapp/out/report.html",
    createdMs: Date.parse("2026-07-25T06:22:30.000Z"),
    tags: ["finance"],
    pinned: false,
    kbSlug: null,
    harness: "claude",
    origin: null,
    pane: { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "webapp", agent: "claude" },
    ...over,
  };
}
