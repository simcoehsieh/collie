// The deployment's update policy, shared by the phone and CLI doctor. Changing this ONE switch
// restores self-managed updates. It never authorises the updater to overwrite a foreign origin.
export const FORK_UPDATE_POLICY = {
  maintainerManaged: true,
  repository: "simcoehsieh/collie",
} as const;

// Like the fork's other shape gates, upstream tests keep exercising the upstream flow. Fork
// behavior tests explicitly enable this gate; the CLI classification reads the policy itself.
export const MAINTAINER_MANAGED_UPDATES: boolean =
  FORK_UPDATE_POLICY.maintainerManaged && import.meta.env.MODE !== "test";

export function upstreamReleaseUrl(version: string): string {
  return `https://github.com/AltanS/collie/releases/tag/v${encodeURIComponent(version.replace(/^v/, ""))}`;
}
