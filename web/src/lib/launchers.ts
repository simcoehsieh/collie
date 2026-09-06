import { useEffect, useState } from "react";

import { fetchLaunchers } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import type { Launcher } from "@/lib/types";

// THIS scope's own launcher rows — deliberately NOT part of lib/operator-config.ts's one-shot
// `/api/config` cache. Rows must come from the host that RUNS them: a pack peer keeps its own
// `launchers.toml`, and the lead's single startup fetch can only ever answer for itself. So this
// reads `GET /api/launchers` (session-scoped, forwarded on `?host=` — server.ts) fresh on every
// mount and whenever `scope` changes, rather than once per page load — the file is read live on the
// bridge behind an mtime check, so a fresh look is what "live" is supposed to buy the operator.
//
// A FAILED FETCH IS NOT AN ERROR STATE, on the same terms lib/operator-config.ts's read is: this
// leaves the rows exactly as they were (empty on a first failed mount) and any later mount — the
// switcher sheet reopened, the dashboard revisited — tries again.

/**
 * The launcher the tab strip's "+" is pinned to, or `undefined` for a plain shell.
 *
 * The pin is stored as a row's COMMAND (hooks/use-dash-prefs.ts says why), and this is the whole of
 * what that costs: a lookup that fails is not an error, it is the shell. Two cases resolve to
 * `undefined` and both are ordinary — the operator never pinned anything (`""`), and the row they
 * pinned has since left `launchers.toml`. The second is the one worth having a named function for:
 * the alternative is a "+" that fails a create nobody remembers configuring, on a host whose config
 * file is not the one they edited.
 *
 * Pure, and exported for its own test — the rule matters more than the one line it takes.
 */
export function pinnedLauncher(
  launchers: readonly Launcher[],
  command: string,
): Launcher | undefined {
  if (command === "") return undefined;
  return launchers.find((row) => row.command === command);
}

/**
 * Which agent a launcher row RUNS, as far as a logo is concerned — the command's first token, with
 * any path stripped.
 *
 * A launcher row is a shell line, not an agent name: `codex --profile work` and
 * `/opt/homebrew/bin/codex` are both codex, and `make -C ~/dev/collie test` is not an agent at all.
 * The first token is the whole of the signal available here, and it is enough for the three shapes
 * that actually occur — a bare name, a name with flags, and an absolute path.
 *
 * NOT a lookup against a list of known agents. `AgentIcon` already resolves a name to a brand and
 * already falls back to a neutral initials tile for one it does not know, so a row this cannot name
 * gets a legible tile rather than a hole — and a new agent becomes recognisable by adding a brand
 * there, not by editing a second list here. `env FOO=1 claude` reads as "env" and takes the
 * fallback, which is the honest answer to a line whose agent is not its first word.
 */
export function launcherAgent(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  // `?? ""` and not `?? first`: a token with no name in it (`/`) has no agent, and handing the
  // separator on as one would put a slash in an initials tile. Empty is what `AgentIcon` already
  // treats as "no agent", so the nameless case lands on the fallback it already has.
  return first.split("/").findLast((segment) => segment !== "") ?? "";
}

export interface LaunchersState {
  launchers: readonly Launcher[];
  home: string;
}

const EMPTY: LaunchersState = { launchers: [], home: "" };

/**
 * Reactive read of one scope's launcher rows. The dashboard calls this with the ambient scope (no
 * `?h=`); the switcher sheet in agent-chat.tsx calls it with the current pane's scope, which is
 * already ambient there.
 */
export function useLaunchers(scope?: Scope): LaunchersState {
  const host = scope?.host;
  const session = scope?.session;
  const [state, setState] = useState<LaunchersState>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchLaunchers(host === undefined && session === undefined ? undefined : { host, session });
        if (!cancelled) setState({ launchers: res.launchers, home: res.home });
      } catch {
        // See the header: leave the previous rows in place and let the next mount retry.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, session]);

  return state;
}
