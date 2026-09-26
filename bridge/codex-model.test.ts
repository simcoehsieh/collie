import { describe, expect, test } from "bun:test";
import {
  ADVANCED_TITLE,
  EFFORT_TITLE,
  MODEL_TITLE,
  confirmed,
  driveCodexModel,
  findEffortRow,
  findModelRow,
  parsePicker,
} from "./codex-model.ts";
import { AuditLog } from "./audit.ts";
import type { MuxAck, MuxGrid, MuxOutcome } from "./mux/types.ts";
import { codexModelPane } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentView, CodexHandoffModel } from "./types.ts";

// Screens captured from Codex 0.156.1 in a 120-column tmux pane (2026-09-26), trailing blanks trimmed.
const MODELS_SCREEN = `  Tip: Try the Desktop app. Run 'codex app' or visit https://chatgpt.com/codex?app-landing-page=true
  Select Model and Effort
  1. GPT-6-Astra (default)  Frontier intelligence for the most demanding work.
› 2. GPT-6-Sol (current)    Workhorse model for coding and everyday work.
  3. GPT-6-Luna             Fast and affordable model for easier tasks.
  4. GPT-5.6-Sol            Older coding model for complex work.
  5. GPT-5.6-Terra          Older balanced model for straightforward work.
  6. GPT-5.6-Luna           Older fast and efficient model.
  7. GPT-5.5                Legacy coding model.
  enter select · esc back`;
const EFFORTS_SCREEN = `  Select Reasoning Level for GPT-6-Sol
  1. Low                         Fast responses with lighter reasoning
› 2. Medium (default) (current)  Balances speed and reasoning depth for everyday tasks
  3. High                        Greater reasoning depth for complex problems
  4. Extra high                  Extra high reasoning depth for complex problems
  5. More reasoning…             Max and Ultra consume usage limits faster
  enter default · s session · esc back`;
const ADVANCED_SCREEN = `  Advanced Reasoning
  ⚠ Consumes usage limits faster
› 1. Max    For difficult problems when quality matters more than speed · higher usage
  2. Ultra  For demanding work using multiple agents · highest usage
  enter default · s session · esc back`;

const SOL: CodexHandoffModel = { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" };
const LUNA: CodexHandoffModel = { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" };

describe("parsePicker — Codex 0.156 /model screens", () => {
  test("reads the model rows, their numbers, and the cursor, markers stripped", () => {
    const p = parsePicker(MODELS_SCREEN, MODEL_TITLE)!;
    expect(p.rows.map((r) => r.label)).toEqual(["GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna", "GPT-5.6-Sol", "GPT-5.6-Terra", "GPT-5.6-Luna", "GPT-5.5"]);
    expect(p.cursor).toBe(1);
    expect(findModelRow(p, LUNA)).toBe(2);
  });
  test("reads the effort rows and maps the catalog's xhigh onto 'Extra high'", () => {
    const p = parsePicker(EFFORTS_SCREEN, EFFORT_TITLE)!;
    expect(p.rows.map((r) => r.label)).toEqual(["Low", "Medium", "High", "Extra high", "More reasoning…"]);
    expect(p.cursor).toBe(1);
    expect(findEffortRow(p, "xhigh")).toBe(3);
    expect(findEffortRow(p, "ultra")).toBe(-1);
  });
  test("reads the advanced screen past its warning line", () => {
    const p = parsePicker(ADVANCED_SCREEN, ADVANCED_TITLE)!;
    expect(p.rows.map((r) => r.label)).toEqual(["Max", "Ultra"]);
    expect(findEffortRow(p, "ultra")).toBe(1);
  });
  test("a screen without the title is not that picker", () => {
    expect(parsePicker("› Ask Codex to do anything", MODEL_TITLE)).toBeNull();
  });
  test("only the session-only confirmation counts", () => {
    expect(confirmed("• Model changed to gpt-6-sol ultra for this session only", "gpt-6-sol", "ultra")).toBe(true);
    expect(confirmed("• Model changed to gpt-6-sol ultra", "gpt-6-sol", "ultra")).toBe(false);
  });
});

/**
 * A Codex pane small enough to reason about: a composer, the three pickers, and the two ways a pick
 * ends — `s` (this session) or a digit / Enter (the DEFAULT, which rewrites config.toml).
 * `paintAfter` is how many reads a new picker takes to appear, which is what the real one does.
 */
function fakeCodex(opts: { paintAfter?: number; busy?: boolean } = {}) {
  const paintAfter = opts.paintAfter ?? 2;
  const catalog = ["GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna"];
  const efforts = ["Low", "Medium", "High", "Extra high", "More reasoning…"];
  const advanced = ["Max", "Ultra"];
  let screen: "composer" | "models" | "efforts" | "advanced" = "composer";
  let draft = "";
  let cursor = 0;
  let model = "";
  let pending = 0; // reads left before the current picker paints
  const log: string[] = [];
  const typedWhileHidden: string[] = [];
  let changed = "";
  let wroteDefault = false;

  const open = (next: typeof screen, at: number) => {
    screen = next;
    cursor = at;
    pending = paintAfter;
  };
  const rows = (names: string[]) => names.map((n, i) => `${i === cursor ? "›" : " "} ${i + 1}. ${n}  desc`).join("\n");
  const finish = (effort: string, session: boolean) => {
    changed = `• Model changed to ${model.toLowerCase()} ${effort.toLowerCase().replace("extra high", "xhigh")}${session ? " for this session only" : ""}`;
    wroteDefault = !session;
    screen = "composer";
  };

  const client = {
    async readGrid(paneId: string): Promise<MuxOutcome<MuxGrid>> {
      let text = changed ? `${changed}\n› Ask Codex to do anything` : `› ${draft || "Ask Codex to do anything"}`;
      if (screen !== "composer") {
        if (pending > 0) {
          pending--;
        } else if (screen === "models") {
          text = `  ${MODEL_TITLE}\n${rows(catalog)}\n  enter select · esc back`;
        } else if (screen === "efforts") {
          text = `  ${EFFORT_TITLE} ${model}\n${rows(efforts)}\n  enter default · s session · esc back`;
        } else {
          text = `  ${ADVANCED_TITLE}\n  ⚠ Consumes usage limits faster\n${rows(advanced)}\n  enter default · s session · esc back`;
        }
      }
      return { ok: true, value: { paneId, text, truncated: false, revision: log.length } };
    },
    async typeText(_paneId: string, t: string): Promise<MuxAck> {
      log.push(`type:${t}`);
      draft += t;
      return { ok: true, value: undefined };
    },
    async sendKeys(_paneId: string, keys: readonly string[]): Promise<MuxAck> {
      for (const k of keys) {
        log.push(k);
        const painted = screen !== "composer" && pending === 0;
        if (screen === "composer" || !painted) {
          if (k === "Enter" && draft === "/model" && screen === "composer" && !opts.busy) {
            draft = "";
            open("models", 1);
          } else if (k !== "Enter" && k !== "Escape") {
            typedWhileHidden.push(k); // the batch bug: a key that reached no picker
            draft += k;
          }
          continue;
        }
        const list = screen === "models" ? catalog : screen === "efforts" ? efforts : advanced;
        if (k === "Escape") screen = screen === "advanced" ? "efforts" : screen === "efforts" ? "models" : "composer";
        else if (k === "Down") cursor = (cursor + 1) % list.length;
        else if (k === "Up") cursor = (cursor - 1 + list.length) % list.length;
        else if (/^\d$/u.test(k) || k === "Enter") {
          const i = k === "Enter" ? cursor : Number(k) - 1;
          if (screen === "models") {
            model = catalog[i]!;
            open("efforts", 1);
          } else if (screen === "efforts" && i === 4) open("advanced", 0);
          else finish(list[i]!, false);
        } else if (k === "s" && screen !== "models") finish(list[cursor]!, true);
      }
      return { ok: true, value: undefined };
    },
  };
  return {
    client,
    log,
    get typedWhileHidden() { return typedWhileHidden; },
    get wroteDefault() { return wroteDefault; },
    get changed() { return changed; },
    get screen() { return screen; },
  };
}

// A clock that only moves when the driver sleeps, so a timeout is a count of polls, not wall time.
function fakeClock() {
  let t = 0;
  return { sleep: async (ms: number) => { t += ms; }, now: () => t };
}

describe("driveCodexModel", () => {
  test("waits for each screen, then picks the model by number and the effort with s (session only)", async () => {
    const codex = fakeCodex({ paintAfter: 3 });
    const out = await driveCodexModel(codex.client, "p1", SOL, "high", fakeClock());
    expect(out).toEqual({ ok: true });
    expect(codex.changed).toBe("• Model changed to gpt-6-sol high for this session only");
    expect(codex.log).toEqual(["type:/model", "Enter", "2", "Down", "s"]);
    expect(codex.typedWhileHidden).toEqual([]);
    expect(codex.wroteDefault).toBe(false);
  });

  test("reaches max and ultra through More reasoning…", async () => {
    const codex = fakeCodex();
    const out = await driveCodexModel(codex.client, "p1", SOL, "ultra", fakeClock());
    expect(out).toEqual({ ok: true });
    expect(codex.log).toEqual(["type:/model", "Enter", "2", "5", "Down", "s"]);
    expect(codex.wroteDefault).toBe(false);
  });

  test("moves the cursor up as well as down", async () => {
    const codex = fakeCodex();
    expect(await driveCodexModel(codex.client, "p1", LUNA, "low", fakeClock())).toEqual({ ok: true });
    expect(codex.log.slice(-2)).toEqual(["Up", "s"]);
  });

  test("a picker that never opens is reported, and nothing is typed after it", async () => {
    const codex = fakeCodex({ busy: true });
    const out = await driveCodexModel(codex.client, "p1", SOL, "high", fakeClock());
    expect(out.ok).toBe(false);
    expect(codex.log).toEqual(["type:/model", "Enter"]);
  });

  test("a model the picker does not list backs out with Escape and changes nothing", async () => {
    const codex = fakeCodex();
    const gone = { ...SOL, id: "gpt-9", label: "GPT-9" };
    const out = await driveCodexModel(codex.client, "p1", gone, "high", fakeClock());
    expect(out).toEqual({ ok: false, reason: "GPT-9 is not in Codex's /model list" });
    expect(codex.screen).toBe("composer");
    expect(codex.changed).toBe("");
  });
});

describe("POST /api/pane/:id/model", () => {
  function pane(agent: string): AgentView {
    return { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "Space", workspaceNumber: 1, tabId: "w1:t1", agent, status: "idle", cwd: "/tmp", focused: false };
  }
  function engine(agents: AgentView[]): StateEngine {
    const stub: Partial<StateEngine> = { current: () => ({ agents, shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }) };
    // SAFETY: the route reads only `current()` for its pane lookup.
    return stub as StateEngine;
  }
  function post(body: { model: string; effort: string }): Request {
    return new Request("http://localhost/api/pane/w1%3Ap1/model", { method: "POST", body: JSON.stringify(body) });
  }
  const audited: string[] = [];
  const audit = new AuditLog((line) => { audited.push(line); });

  test("switches a Codex pane and answers ok", async () => {
    const codex = fakeCodex();
    const res = await codexModelPane(
      { herdr: codex.client, engine: engine([pane("codex")]), submitKeys: ["Enter"], getModels: async () => [SOL], drive: fakeClock() },
      "w1:p1", post({ model: "gpt-6-sol", effort: "xhigh" }), audit, null, "default",
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(codex.changed).toBe("• Model changed to gpt-6-sol xhigh for this session only");
  });

  test("refuses before typing anything: not Codex, unknown pane, or outside the catalog", async () => {
    const codex = fakeCodex();
    const deps = (agents: AgentView[]) => ({ herdr: codex.client, engine: engine(agents), submitKeys: ["Enter"], getModels: async () => [LUNA], drive: fakeClock() });
    expect((await codexModelPane(deps([pane("claude")]), "w1:p1", post({ model: "gpt-6-luna", effort: "low" }), audit, null, "default")).status).toBe(400);
    expect((await codexModelPane(deps([]), "w1:p1", post({ model: "gpt-6-luna", effort: "low" }), audit, null, "default")).status).toBe(404);
    expect((await codexModelPane(deps([pane("codex")]), "w1:p1", post({ model: "gpt-6-luna", effort: "ultra" }), audit, null, "default")).status).toBe(400);
    expect((await codexModelPane(deps([pane("codex")]), "w1:p1", post({ model: "gpt-6-sol", effort: "low" }), audit, null, "default")).status).toBe(400);
    expect(codex.log).toEqual([]);
  });
});
