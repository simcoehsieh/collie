// The macOS source checkout's complete check set, with test paths substituted. The CLI test
// compares this fixture with preflight() over fake IO; both bridge and web consume the same report.
export const MAINTAINER_PREFLIGHT = {
  schema: 1,
  verdict: "green",
  installKind: "detached-checkout",
  checks: [
    { id: "doctor", verdict: "green", reason: "collie doctor is clean" },
    { id: "disk", verdict: "green", reason: "47.7 GB free at /opt/collie" },
    { id: "bun", verdict: "green", reason: "bun 1.3.14" },
    { id: "tree", verdict: "green", reason: "the checkout has no tracked-file changes (untracked files are ignored)" },
    { id: "upstream", verdict: "green", reason: "github.com/simcoehsieh/collie — maintainer-managed merges from github.com/AltanS/collie" },
    { id: "service", verdict: "green", reason: "the LaunchAgent at /home/pat/Library/LaunchAgents/herdr.collie.plist is in place — the update can restart it" },
  ],
} as const;
