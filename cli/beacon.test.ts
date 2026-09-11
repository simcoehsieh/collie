import { describe, expect, test } from "bun:test";

import { beaconFileName, beaconKey } from "../bridge/beacon/paths.ts";
import { BEACON_SCHEMA_VERSION } from "../bridge/beacon/types.ts";
import { parseBeacon, parseStatusLine } from "../bridge/beacon/parse.ts";
import { statusLineFileName, statusLineKey, STATUS_LINE_SCHEMA_VERSION } from "../bridge/beacon/status-line.ts";
import type { AgentSessionRef } from "../bridge/journal/types.ts";
import {
  BEACON_HARNESS,
  BEACON_HOOKS,
  type BeaconEmitDeps,
  type BeaconStatusDeps,
  cmdBeaconEmit,
  cmdBeaconStatus,
  readEnvMarkers,
  runBeaconEmit,
} from "./beacon.ts";
import { context, fakeFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import type { Environment } from "./context.ts";
import type { JsonObject } from "../bridge/json.ts";

// `collie beacon emit`. Everything here is driven through the two seams (`cli/sys.ts`), so no test
// reads a real `/proc`, writes a real state dir, or touches stdin.
//
// The load-bearing assertion in this file is the boring one: EVERY path returns `EXIT.OK`. A hook
// that exits non-zero blocks the operator's prompt, so a beacon that cannot be written must be a
// beacon that is simply absent.

/** The pid the fake `/proc` knows about, and the start time it reports for it. */
const AGENT_PID = 4242;
const START_TIME = 987_654;
const PROC = `/proc/${AGENT_PID}/stat`;
/** A real `/proc/<pid>/stat` shape: the comm field carries spaces AND brackets on purpose. */
const STAT = `${AGENT_PID} (claude (dev)) S 4200 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} ${START_TIME} 0 0`;

const TMUX: Environment = { TMUX_PANE: "%7", TMUX: "/tmp/tmux-1000/default,3311,0" };
const SESSION = "ff2dd3c2-e3d5-40db-9474-eea02e606c6c";

function payload(over: JsonObject = {}): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: "/home/pat/.claude/projects/-x/y.jsonl",
    cwd: "/home/pat/work",
    hook_event_name: "UserPromptSubmit",
    ...over,
  });
}

function deps(
  over: { env?: Environment; stdin?: string; proc?: string | null; pid?: number } = {},
): BeaconEmitDeps & { files: ReturnType<typeof fakeFiles> } {
  const files = fakeFiles(over.proc === null ? {} : { [PROC]: over.proc ?? STAT });
  return {
    ctx: context(over.env ?? TMUX),
    files,
    readStdin: () => Promise.resolve(over.stdin ?? payload()),
    agentPid: over.pid ?? AGENT_PID,
    now: () => 1_700_000_000_000,
  };
}

/** The beacon files a run left behind, by name. */
function beacons(files: ReturnType<typeof fakeFiles>): Map<string, string> {
  const found = new Map<string, string>();
  for (const [path, entry] of files.entries) {
    if (path.startsWith(`${STATE}/beacons/`) && path.endsWith(".json")) {
      found.set(path.slice(`${STATE}/beacons/`.length), entry.text);
    }
  }
  return found;
}

describe("the environment gate", () => {
  test("reads tmux's pane raw, and the SOCKET out of $TMUX — never the server pid with it", () => {
    expect(readEnvMarkers(TMUX)).toEqual([
      { namespace: "tmux", scope: "/tmp/tmux-1000/default", pane: "%7" },
    ]);
  });

  test("reads zellij's pane raw — the `terminal_` prefix belongs to the join, not here", () => {
    expect(readEnvMarkers({ ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "herd" })).toEqual([
      { namespace: "zellij", scope: "herd", pane: "3" },
    ]);
  });

  test("records BOTH when the pane is nested — the emitter cannot know which one Collie drives", () => {
    expect(readEnvMarkers({ ...TMUX, ZELLIJ_PANE_ID: "3", ZELLIJ_SESSION_NAME: "herd" })).toHaveLength(2);
  });

  test("skips a namespace with no scope: `%7` on another server is another pane", () => {
    expect(readEnvMarkers({ TMUX_PANE: "%7" })).toEqual([]);
    expect(readEnvMarkers({ ZELLIJ_PANE_ID: "3" })).toEqual([]);
  });

  test("a plain terminal has nothing at all", () => {
    expect(readEnvMarkers({ HOME: "/home/pat" })).toEqual([]);
  });
});

describe("the status map", () => {
  test("is paseo's four rows, plus `SessionStart` → idle so a launched agent is not a shell", () => {
    expect(BEACON_HOOKS.map((r) => [r.event, r.matcher, r.status])).toEqual([
      ["SessionStart", undefined, "idle"],
      ["UserPromptSubmit", undefined, "working"],
      ["Stop", undefined, "idle"],
      ["SessionEnd", undefined, "idle"],
      ["Notification", "idle_prompt", "waiting"],
    ]);
  });

  test("each event writes its own status", async () => {
    for (const registration of BEACON_HOOKS) {
      const d = deps({ stdin: payload({ hook_event_name: registration.event }) });
      expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
      const [text] = [...beacons(d.files).values()];
      expect(parseBeacon(text ?? "")?.status).toBe(registration.status);
    }
  });

  test("`SessionStart` writes an idle beacon before the first prompt, whatever its `source`", async () => {
    for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
      const d = deps({ stdin: payload({ hook_event_name: "SessionStart", source }) });
      expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
      const written = beacons(d.files);
      expect(written.size).toBe(1);
      const [text] = [...written.values()];
      const record = parseBeacon(text ?? "");
      expect(record?.status).toBe("idle");
      // The session ref is set from the first moment — that is what the journal looks history up by.
      expect(record?.session).toEqual({ kind: "id", value: SESSION });
    }
  });

  test("`SessionEnd` with reason `clear` is not the agent leaving — it is an ordinary overwrite", async () => {
    const d = deps({ stdin: payload({ hook_event_name: "SessionEnd", reason: "clear" }) });
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    const [name] = [...beacons(d.files).keys()];
    // Same pane, so the same file the `UserPromptSubmit` above wrote: the next prompt re-keys it.
    const fresh = deps();
    await cmdBeaconEmit(fresh);
    expect([...beacons(fresh.files).keys()]).toEqual([name!]);
  });
});

describe("the beacon it writes", () => {
  test("is one file, named by the digest of its own markers, and the reader accepts it", async () => {
    const d = deps();
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    const written = beacons(d.files);
    expect(written.size).toBe(1);
    const [name, text] = [...written.entries()][0]!;
    const record = parseBeacon(text)!;
    expect(record).toEqual({
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: BEACON_HARNESS,
      session: { kind: "id", value: SESSION },
      status: "working",
      pid: AGENT_PID,
      pidStartTime: START_TIME,
      markers: [{ namespace: "tmux", scope: "/tmp/tmux-1000/default", pane: "%7" }],
      heartbeatMs: 1_700_000_000_000,
    });
    // The reader refuses a record whose name is not its markers' digest, so this is the join working.
    expect(name).toBe(beaconFileName(beaconKey(record.markers)));
  });

  test("carries the session ID, never the payload's transcript_path (.adr/0024)", async () => {
    const d = deps();
    await cmdBeaconEmit(d);
    const [text] = [...beacons(d.files).values()];
    expect(text).not.toContain("transcript_path");
    expect(text).not.toContain(".jsonl");
  });

  test("lands by rename, not by writing the live file — and the temp file does not survive", async () => {
    const d = deps();
    await cmdBeaconEmit(d);
    const renames = d.files.ops.filter((op) => op.startsWith("mv "));
    expect(renames).toHaveLength(1);
    expect(renames[0]).toContain(`${STATE}/beacons/`);
    expect([...d.files.entries.keys()].filter((p) => p.endsWith(".tmp"))).toEqual([]);
  });

  test("the directory is owner-only — anything that can write one can name a pane's agent", async () => {
    const modes: number[] = [];
    const d = deps();
    const spy = { ...d, files: { ...d.files, mkdirp: (_p: string, mode?: number) => void modes.push(mode ?? -1) } };
    await cmdBeaconEmit(spy);
    expect(modes).toEqual([0o700]);
  });
});

describe("it never fails, and it never speaks", () => {
  const silent = async (over: Parameters<typeof deps>[0]): Promise<Map<string, string>> => {
    const d = deps(over);
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    return beacons(d.files);
  };

  test("outside a multiplexer it writes nothing — and does not even read stdin", async () => {
    let read = false;
    const d = {
      ...deps({ env: {} }),
      readStdin: () => {
        read = true;
        return Promise.resolve(payload());
      },
    };
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
    expect(read).toBe(false);
    expect(beacons(d.files).size).toBe(0);
  });

  test("garbage on stdin is exit 0 and no file", async () => {
    for (const junk of ["not json", "", "[]", "null", '"a string"', "{", '{"a":']) {
      expect((await silent({ stdin: junk })).size).toBe(0);
    }
  });

  test("a subagent's payload is ignored — its session id is not the pane's", async () => {
    expect((await silent({ stdin: payload({ agent_id: "sub-1", agent_type: "explore" }) })).size).toBe(0);
  });

  test("an unregistered event writes nothing", async () => {
    for (const event of ["SessionResume", "PreToolUse", "StopFailure", ""]) {
      expect((await silent({ stdin: payload({ hook_event_name: event }) })).size).toBe(0);
    }
  });

  test("a missing or unusable session id writes nothing", async () => {
    for (const id of [undefined, "", "../../etc/passwd", "a/b", { kind: "id" }, false, 12]) {
      expect((await silent({ stdin: payload({ session_id: id }) })).size).toBe(0);
    }
  });

  test("an unreadable pid start time writes nothing rather than a beacon that reads dead", async () => {
    expect((await silent({ proc: null })).size).toBe(0);
    expect((await silent({ proc: "not a stat line" })).size).toBe(0);
  });

  test("an unwritable state dir is exit 0, not a blocked prompt", async () => {
    const d = deps();
    const boom = {
      ...d,
      files: {
        ...d.files,
        write: () => {
          throw new Error("ENOSPC: no space left on device");
        },
      },
    };
    expect(await cmdBeaconEmit(boom)).toBe(EXIT.OK);
  });

  test("a context that cannot even be resolved is exit 0", async () => {
    expect(
      await runBeaconEmit(() => {
        throw new Error('COLLIE_INSTANCE="v1" needs an explicit COLLIE_PORT');
      }),
    ).toBe(EXIT.OK);
  });

  test("stdin that never resolves as text is exit 0", async () => {
    const d = { ...deps(), readStdin: () => Promise.reject(new Error("EIO")) };
    expect(await cmdBeaconEmit(d)).toBe(EXIT.OK);
  });
});

// ── FORK: `collie beacon status "<line>"` ────────────────────────────────────────────────────────
//
// The agent says what it is working on; Collie shows the sentence under the pane name. Unlike `emit`
// this one is TYPED, so it may speak — and the two things it says are the two a human can act on.
// Everything else pinned here is the boundary: the file is keyed by the SESSION (herdr reports no
// pane marker, so env markers cannot key it), a subagent writes nothing, and the sentence is
// flattened before it is ever stored.
describe("collie beacon status", () => {
  const CLAUDE_SESSION = "9c4a1b77-3e2f-4a10-9d55-0b2c3d4e5f60";
  const AGENT_ENV: Environment = { CLAUDE_CODE_SESSION_ID: CLAUDE_SESSION };
  const REF: AgentSessionRef = { kind: "id", value: CLAUDE_SESSION };
  const FILE = `${STATE}/beacons/status/${statusLineFileName(statusLineKey(REF))}`;
  const WRITTEN = 1_700_000_000_000;

  function statusDeps(env: Environment = AGENT_ENV) {
    const files = fakeFiles();
    const err: string[] = [];
    const out: string[] = [];
    const statusVerbDeps: BeaconStatusDeps = {
      ctx: context(env),
      files,
      io: { out: (l) => out.push(l), err: (l) => err.push(l) },
      now: () => WRITTEN,
    };
    return { deps: statusVerbDeps, files, err, out };
  }

  test("writes one status-line file, keyed by the agent's own session", () => {
    const { deps: verb, files, err, out } = statusDeps();
    expect(cmdBeaconStatus(verb, ["rewriting", "the", "journal", "adapter"])).toBe(EXIT.OK);
    // Quiet on the happy path — a status line is a side errand, not the task.
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    const written = files.entries.get(FILE);
    expect(written).toBeDefined();
    expect(JSON.parse(written!.text)).toEqual({
      schemaVersion: STATUS_LINE_SCHEMA_VERSION,
      session: REF,
      line: "rewriting the journal adapter",
      writtenMs: WRITTEN,
    });
    // Owner-only, like every other file Collie drops in a state dir.
    expect(written!.mode).toBe(0o600);
  });

  test("what it wrote is what the bridge will read back", () => {
    const { deps: verb, files } = statusDeps();
    cmdBeaconStatus(verb, ["running the migration"]);
    const parsed = parseStatusLine(files.entries.get(FILE)!.text);
    expect(parsed?.line).toBe("running the migration");
    expect(statusLineKey(parsed!.session)).toBe(statusLineKey(REF));
  });

  test("the sentence is flattened before it is stored, never on the way out of a phone", () => {
    const { deps: verb, files } = statusDeps();
    cmdBeaconStatus(verb, [`two\nlines${String.fromCodePoint(0x1b)}[31m and an escape`]);
    expect(JSON.parse(files.entries.get(FILE)!.text).line).toBe("two lines [31m and an escape");
  });

  test("an empty line CLEARS it — saying nothing is a thing to say", () => {
    const { deps: verb, files } = statusDeps();
    cmdBeaconStatus(verb, ["something"]);
    expect(files.entries.has(FILE)).toBe(true);
    expect(cmdBeaconStatus(verb, [])).toBe(EXIT.OK);
    expect(files.entries.has(FILE)).toBe(false);
  });

  test("no agent session in the environment says so, and writes nothing", () => {
    const { deps: verb, files, err } = statusDeps({});
    expect(cmdBeaconStatus(verb, ["working"])).toBe(EXIT.USAGE);
    expect(files.entries.size).toBe(0);
    expect(err.join(" ")).toMatch(/CLAUDE_CODE_SESSION_ID/);
  });

  // A SUBAGENT IS NOT THE PANE — the same rule `emit` applies to a payload's `agent_id`. A line
  // written from inside a Task would replace the pane's own with a conversation nobody can see.
  test("a subagent writes nothing at all", () => {
    const { deps: verb, files } = statusDeps({ ...AGENT_ENV, CLAUDE_CODE_CHILD_SESSION: "1" });
    expect(cmdBeaconStatus(verb, ["working"])).toBe(EXIT.USAGE);
    expect(files.entries.size).toBe(0);
  });

  test("codex is read from its own variable", () => {
    const codexSession = "1111aaaa-2222-bbbb-3333-cccc4444dddd";
    const { deps: verb, files } = statusDeps({ CODEX_SESSION_ID: codexSession });
    expect(cmdBeaconStatus(verb, ["planning"])).toBe(EXIT.OK);
    const file = `${STATE}/beacons/status/${statusLineFileName(statusLineKey({ kind: "id", value: codexSession }))}`;
    expect(files.entries.has(file)).toBe(true);
  });

  test("a session id of the wrong shape never reaches the filesystem", () => {
    const { deps: verb, files } = statusDeps({ CLAUDE_CODE_SESSION_ID: "../../etc/passwd" });
    expect(cmdBeaconStatus(verb, ["working"])).toBe(EXIT.USAGE);
    expect(files.entries.size).toBe(0);
  });

  test("an unwritable state dir says so rather than failing silently", () => {
    const { deps: verb, files, err } = statusDeps();
    files.write = () => {
      throw new Error("read-only file system");
    };
    expect(cmdBeaconStatus(verb, ["working"])).toBe(EXIT.FAIL);
    expect(err.join(" ")).toMatch(/read-only file system/);
  });
});
