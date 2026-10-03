// FORK: shared deployment policy. This module has no browser, Vite, CLI or bridge dependencies.
export interface UpdatePolicy {
  readonly maintainerManaged: boolean;
  readonly repository: string;
  readonly upstreamRepository: string;
}

export const FORK_UPDATE_POLICY = {
  maintainerManaged: true,
  repository: "simcoehsieh/collie",
  upstreamRepository: "AltanS/collie",
} as const satisfies UpdatePolicy;

/** Only the expected fork observing its upstream is informational; other origins keep their guard. */
export function maintainerManagedSource(configured: string, originRepo: string | null): boolean {
  return FORK_UPDATE_POLICY.maintainerManaged &&
    configured.toLowerCase() === FORK_UPDATE_POLICY.upstreamRepository.toLowerCase() &&
    originRepo?.toLowerCase() === FORK_UPDATE_POLICY.repository.toLowerCase();
}
