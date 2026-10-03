import { getLocaleSnapshot, type Locale } from "./index";
import { interpolate, type TemplateVars } from "./template";

// FORK — THE STRINGS THIS FORK ADDS, KEPT OUT OF THE SEVEN DICTIONARIES.
//
// `t()` is typed by upstream's `messages/en.ts`, so a new key there means a new line in all seven
// dictionaries, and every upstream release that appends to them conflicts in seven files at once
// (CHANGELOG.fork.md, the 1.15.3 merge). A string that only this fork renders lives here instead:
// English is the source of truth and the type, Traditional Chinese is the operator's own language,
// and every other locale falls back to English until somebody here reads it.
//
// The locale is the one the operator CHOSE, read straight off the store. Upstream's `t()` serves
// English until a lazy bundle lands; this table is in the main chunk, so it can be in the chosen
// language at once. The two can disagree for the few hundred milliseconds a bundle takes to arrive,
// which is a cheaper fault than a fork string that waits on a chunk it does not live in.
//
// A component that calls `tf()` subscribes through `useLocale()` exactly as one that calls `t()`
// does — the store is the same one.

const EN = {
  // The ⋮ pane menu's sections (components/pane-actions-sheet.tsx).
  "paneActions.group.read": "Read this pane",
  "paneActions.group.view": "View",
  "paneActions.group.output": "Output",
  "paneActions.group.manage": "Manage",
  "paneActions.more": "More",
  // The diff sheet's tool row (components/diff-sheet.tsx): Back's face, short enough that four tools
  // fit a phone's row (its accessible name stays the full sentence), and the door to upstream's
  // workspace Changes view.
  "diff.backShort": "Back",
  "diff.workspaceChanges": "Workspace changes",
  "diff.workspaceChangesAria": "Open every repo's changes in this workspace",
  // The Codex model row in Quick (components/codex-model-group.tsx).
  "quick.codexModel.row": "Model / effort: {current}",
  "quick.codexModel.unknown": "not read yet",
} as const;

/** Every string this layer carries. English is the type, so a key nobody wrote is a compile error. */
export type ForkMessageKey = keyof typeof EN;

const TABLES = {
  "zh-TW": {
    "paneActions.group.read": "閱讀這個窗格",
    "paneActions.group.view": "檢視",
    "paneActions.group.output": "產出",
    "paneActions.group.manage": "管理",
    "paneActions.more": "更多",
    "diff.backShort": "返回",
    "diff.workspaceChanges": "工作區變更",
    "diff.workspaceChangesAria": "開啟這個工作區每個 repo 的變更",
    "quick.codexModel.row": "模型／推理強度：{current}",
    "quick.codexModel.unknown": "尚未讀到",
  },
} satisfies Partial<Record<Locale, Record<ForkMessageKey, string>>>;

// SAFETY: `Object.keys` of an object literal answers exactly the literal's own keys, and TABLES is a
// literal declared above that nothing extends afterwards — so every string here IS a key of TABLES.
const tableLocales = Object.keys(TABLES) as readonly (keyof typeof TABLES)[];
// SAFETY: the same invariant for EN, a literal declared above and never extended: its own keys are
// exactly `ForkMessageKey`, which is defined as `keyof typeof EN`.
const englishKeys = Object.keys(EN) as readonly ForkMessageKey[];

/** The locales that carry a full table — what the completeness test walks. */
export const FORK_MESSAGE_LOCALES = tableLocales;

/** Every key English carries — the list a table is held complete against. */
export const FORK_MESSAGE_KEYS = englishKeys;

/** One table by locale, or none — the test seam for completeness. */
export function forkTable(locale: Locale): Readonly<Partial<Record<ForkMessageKey, string>>> | undefined {
  // Narrowed by `in`, the way fork-overrides.ts narrows its own table: most locales carry none.
  if (!(locale in TABLES)) return undefined;
  // SAFETY: the `in` guard on the line above is the check — `locale` is a key of TABLES here, and
  // `satisfies` has already proved every key of TABLES is itself a Locale.
  return TABLES[locale as keyof typeof TABLES];
}

/** Translate one of the fork's own keys into the chosen language, filling any `{slot}`s. */
export function tf(key: ForkMessageKey, vars?: TemplateVars): string {
  const text = forkTable(getLocaleSnapshot().locale)?.[key] ?? EN[key];
  return interpolate(text, vars);
}
