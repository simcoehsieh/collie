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
