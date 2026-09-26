import type { MuxAdapter } from "./mux/types.ts";
import type { CodexHandoffModel } from "./types.ts";

// FORK: pick a Codex pane's model and reasoning effort from the Quick dock (2026-09-26).
//
// WHY THE PICKER IS DRIVEN, NOT BYPASSED. Codex 0.156 takes no arguments on `/model` —
// `/model gpt-6-luna low` goes to the MODEL as a prompt — and a running TUI has no other door: `-m` and
// `-c model_reasoning_effort=` are launch flags. So the only way to change a live pane is the one a
// person uses: open `/model`, pick a row, pick an effort. A phone can already do that by hand (Model
// button, then digits from the Keys tray), but a digit on the effort screen means "set as DEFAULT",
// which rewrites ~/.codex/config.toml for every Codex session on the machine. This drives the same
// screens and finishes with `s` — "for this session only" — which touches nothing on disk.
//
// WHY ONE STEP AT A TIME. A batch (`/model`, Enter, `2`, `3` in one send) loses the digits: they
// arrive before the picker has painted and land in the composer instead (measured on 0.156.1). So
// every step waits for the screen it needs, read off the pane's own grid, and gives up with the
// picker dismissed rather than typing into a screen it does not recognise.
//
// Screens, as Codex 0.156.1 paints them (captures in codex-model.test.ts):
//   Select Model and Effort              1. GPT-6-Astra (default) …   digit = choose that model
//   Select Reasoning Level for <Model>   1. Low … 5. More reasoning…  `s` = this session only
//   Advanced Reasoning                   1. Max  2. Ultra             `s` = this session only
//   • Model changed to gpt-6-sol ultra for this session only

export const MODEL_TITLE = "Select Model and Effort";
export const EFFORT_TITLE = "Select Reasoning Level for";
export const ADVANCED_TITLE = "Advanced Reasoning";
/** The row on the effort screen that opens {@link ADVANCED_TITLE}. */
const MORE_ROW = /^more reasoning/i;

export interface PickerRow {
  /** The number Codex prints before the row, 1-based. */
  readonly n: number;
  /** The row's name with Codex's `(default)` / `(current)` markers taken off. */
  readonly label: string;
}

export interface PickerScreen {
  readonly rows: readonly PickerRow[];
  /** Index into `rows` of the row under Codex's `›` cursor, or -1 when none is drawn. */
  readonly cursor: number;
}

const ROW = /^\s*(›)?\s*(\d+)\.\s+(.+?)\s*$/u;
const MARKERS = /\s*\((?:default|current)\)/giu;

/**
 * The picker whose title is `title`, read off a screen — or null when that picker is not the one
 * showing. The LAST title on screen wins: an earlier picker's title can still be in the scrollback
 * above a newer one.
 */
export function parsePicker(screen: string, title: string): PickerScreen | null {
  const lines = screen.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes(title)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const rows: PickerRow[] = [];
  let cursor = -1;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*enter\b/u.test(line)) break; // the key-hint footer closes the list
    const m = ROW.exec(line);
    if (!m) continue;
    // The description column sits two or more spaces after the name.
    const name = m[3]!.split(/\s{2,}/u)[0]!.replace(MARKERS, "").trim();
    if (m[1] !== undefined) cursor = rows.length;
    rows.push({ n: Number(m[2]), label: name });
  }
  return rows.length === 0 ? null : { rows, cursor };
}

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/gu, "");

/** The row that names this model: Codex prints the catalog's display name (`GPT-6-Sol`). */
export function findModelRow(screen: PickerScreen, model: CodexHandoffModel): number {
  return screen.rows.findIndex((r) => squash(r.label) === squash(model.label) || squash(r.label) === squash(model.id));
}

/** The row that names this effort. The catalog says `xhigh`; the screen says `Extra high`. */
export function findEffortRow(screen: PickerScreen, effort: string): number {
  const want = squash(effort);
  const alias = want.startsWith("x") ? `extra${want.slice(1)}` : want;
  return screen.rows.findIndex((r) => squash(r.label) === want || squash(r.label) === alias);
}

/** The confirmation line — only the session-only kind counts, since that is the only one sent. */
export function confirmed(screen: string, model: string, effort: string): boolean {
  const want = `Model changed to ${model} ${effort} for this session only`;
  return screen.split("\n").some((line) => line.includes(want));
}

type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DriveOptions {
  readonly sleep?: SleepFn;
  readonly now?: () => number;
  /** Gap between two reads of the pane while waiting for a screen. */
  readonly pollMs?: number;
  /** How long one screen may take to appear before the switch is abandoned. */
  readonly stepMs?: number;
  /** The keys that submit the composer (`COLLIE_SUBMIT_KEYS`). */
  readonly submitKeys?: readonly string[];
}

export type DriveOutcome = { ok: true } | { ok: false; reason: string };

/** The three multiplexer calls a switch makes — the real adapter in the bridge, a fake in tests. */
export type CodexModelClient = Pick<MuxAdapter, "readGrid" | "typeText" | "sendKeys">;

/**
 * Switch a live Codex pane to `model` at `effort`, for this session only.
 *
 * Every refusal after the picker opened sends Escape until the picker is gone, so a failed switch
 * leaves the pane where it was rather than parked on a half-finished menu.
 */
export async function driveCodexModel(
  client: CodexModelClient,
  paneId: string,
  model: CodexHandoffModel,
  effort: string,
  opts: DriveOptions = {},
): Promise<DriveOutcome> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 150;
  const stepMs = opts.stepMs ?? 4000;
  const submitKeys = opts.submitKeys ?? ["Enter"];

  const read = async (): Promise<string | null> => {
    try {
      const grid = await client.readGrid(paneId, { scope: "viewport", lines: 60, styling: "strip" });
      return grid.ok ? grid.value.text : null;
    } catch {
      return null;
    }
  };
  /** Poll until `pick` finds what it wants on screen, or the step's time runs out. */
  const waitFor = async <T>(pick: (screen: string) => T | null): Promise<T | null> => {
    const started = now();
    for (;;) {
      const screen = await read();
      const found = screen === null ? null : pick(screen);
      if (found !== null) return found;
      if (now() - started >= stepMs) return null;
      await sleep(pollMs);
    }
  };
  const keys = async (k: readonly string[]): Promise<string | null> => {
    try {
      const sent = await client.sendKeys(paneId, k);
      return sent.ok ? null : sent.detail;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  // Up to three Escapes: Advanced → effort → model → closed. An extra one on a closed picker is a
  // no-op in Codex's composer (it only clears an empty draft's hint).
  const abandon = async (reason: string): Promise<DriveOutcome> => {
    for (let i = 0; i < 3; i++) {
      const screen = await read();
      if (screen === null) break;
      if (![MODEL_TITLE, EFFORT_TITLE, ADVANCED_TITLE].some((t) => parsePicker(screen, t) !== null && lastTitleIsOpen(screen, t)))
        break;
      await keys(["Escape"]);
      await sleep(pollMs);
    }
    return { ok: false, reason };
  };
  /** Move the cursor to `target` and press `s`, then check the cursor really moved there first. */
  const chooseForSession = async (title: string, target: number): Promise<string | null> => {
    const screen = await waitFor((s) => parsePicker(s, title));
    if (screen === null) return `the ${title} screen went away`;
    const delta = target - screen.cursor;
    if (screen.cursor < 0) return "no cursor on the reasoning screen";
    if (delta !== 0) {
      const failed = await keys(Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "Down" : "Up")));
      if (failed !== null) return failed;
      const moved = await waitFor((s) => {
        const p = parsePicker(s, title);
        return p !== null && p.cursor === target ? p : null;
      });
      if (moved === null) return "the cursor did not reach the chosen effort";
    }
    return keys(["s"]);
  };

  // 1. Open the picker.
  try {
    const typed = await client.typeText(paneId, "/model");
    if (!typed.ok) return { ok: false, reason: typed.detail };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  await sleep(350); // the same settle a reply takes before its submit key
  const submitted = await keys(submitKeys);
  if (submitted !== null) return { ok: false, reason: submitted };
  const models = await waitFor((s) => (lastTitleIsOpen(s, MODEL_TITLE) ? parsePicker(s, MODEL_TITLE) : null));
  if (models === null) return abandon("the /model picker did not open — Codex may be busy");

  // 2. The model: its number, when it has a single digit; otherwise walk the cursor and Enter.
  const row = findModelRow(models, model);
  if (row < 0) return abandon(`${model.label} is not in Codex's /model list`);
  const n = models.rows[row]!.n;
  const pickModel =
    n <= 9
      ? await keys([String(n)])
      : await keys([
          ...Array.from({ length: Math.abs(row - models.cursor) }, () => (row > models.cursor ? "Down" : "Up")),
          "Enter",
        ]);
  if (pickModel !== null) return abandon(pickModel);

  // 3. The effort, possibly one level down under "More reasoning…".
  const efforts = await waitFor((s) => (lastTitleIsOpen(s, EFFORT_TITLE) ? parsePicker(s, EFFORT_TITLE) : null));
  if (efforts === null) return abandon("the reasoning screen did not open");
  let title = EFFORT_TITLE;
  let target = findEffortRow(efforts, effort);
  if (target < 0) {
    const more = efforts.rows.findIndex((r) => MORE_ROW.test(r.label));
    if (more < 0) return abandon(`${model.label} offers no ${effort} effort`);
    const opened = await keys([String(efforts.rows[more]!.n)]);
    if (opened !== null) return abandon(opened);
    const advanced = await waitFor((s) => (lastTitleIsOpen(s, ADVANCED_TITLE) ? parsePicker(s, ADVANCED_TITLE) : null));
    if (advanced === null) return abandon("the advanced reasoning screen did not open");
    title = ADVANCED_TITLE;
    target = findEffortRow(advanced, effort);
    if (target < 0) return abandon(`${model.label} offers no ${effort} effort`);
  }
  const chose = await chooseForSession(title, target);
  if (chose !== null) return abandon(chose);

  // 4. Codex's own word that it took.
  const done = await waitFor((s) => (confirmed(s, model.id, effort) ? true : null));
  return done === null ? { ok: false, reason: "Codex did not confirm the change" } : { ok: true };
}

/**
 * Whether `title`'s picker is the thing on screen now, not a closed one still in the scrollback: its
 * key-hint footer is still drawn below it and no confirmation line has been printed after it.
 */
function lastTitleIsOpen(screen: string, title: string): boolean {
  const at = screen.lastIndexOf(title);
  if (at < 0) return false;
  const after = screen.slice(at);
  return /\n\s*enter\b[^\n]*esc\b/u.test(after) && !after.includes("Model changed to");
}
