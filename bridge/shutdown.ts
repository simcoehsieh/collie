// FORK: how the bridge stops its HTTP server on SIGTERM.
//
// Bun's `server.stop()` without `true` waits for every in-flight request to finish, and the fork's
// live feed (`/api/events`, a server-sent-events stream) never finishes on its own: a phone with Meow
// open holds one for as long as it is open. So a graceful stop could wait forever, and on 2026-10-08
// it did — `collie restart` booted the launchd job out, the old bridge sat draining that stream, all
// three `launchctl bootstrap` retries hit the teardown window, and the new bridge fell back to an
// unsupervised process (no restart-on-crash, nothing at login) while the old one ignored SIGTERM
// until it was killed by hand.
//
// The graceful stop gets a short window, and then every connection is closed. A dropped live feed is
// harmless: the page reconnects to the new bridge and re-reads the snapshot.

/** How long in-flight requests get to finish before the server closes every connection. */
export const SHUTDOWN_DRAIN_MS = 1_000;

/** The part of Bun's `Server` this needs. */
export interface StoppableServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/** Stop gracefully, or forcibly once `drainMs` has passed. Resolves `true` when it had to force. */
export async function stopWithin(
  server: StoppableServer,
  drainMs: number = SHUTDOWN_DRAIN_MS,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  const drained = server.stop().then(() => "drained" as const);
  const outcome = await Promise.race([drained, wait(drainMs).then(() => "timeout" as const)]);
  if (outcome === "drained") return false;
  await server.stop(true);
  return true;
}

/** How long the whole shutdown may take before the process exits regardless of what is still open. */
export const SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Exit after `ms` whatever the shutdown is still waiting on. The bounded server stop above was not
 * enough: at the 1.17.2 deploy a bridge logged "shutting down" and was still alive ten seconds later,
 * so some later step (a poll loop's dispose, a flush) also waits. A restart must never depend on every
 * step finishing; the steps are logged (`[bridge] shutdown: …`) so the next hang names itself. The
 * timer is unref'd, so a shutdown that finishes first exits without it.
 */
export function armShutdownDeadline(
  ms: number = SHUTDOWN_DEADLINE_MS,
  exit: (code: number) => void = (code) => process.exit(code),
  log: (line: string) => void = (line) => console.log(line),
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    log(`[bridge] shutdown: still running after ${String(ms)} ms, exiting`);
    exit(0);
  }, ms);
  timer.unref?.();
  return timer;
}
