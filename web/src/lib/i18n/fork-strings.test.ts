import { __resetLocale, setLocale } from "./index";
import { FORK_MESSAGE_KEYS, FORK_MESSAGE_LOCALES, forkTable, tf } from "./fork-strings";

// The fork's own string layer. What is pinned is what would fail quietly: a table that drifted
// short of English, a locale with no table that must still answer, and a slot that must fill.

beforeEach(() => {
  localStorage.clear();
  __resetLocale();
});

describe("fork-strings", () => {
  it("answers in English by default", () => {
    expect(tf("paneActions.more")).toBe("More");
  });

  it("answers in the chosen language as soon as it is chosen — the table is in the main chunk", () => {
    setLocale("zh-TW");
    expect(tf("paneActions.more")).toBe("更多");
    expect(tf("diff.workspaceChanges")).toBe("工作區變更");
  });

  it("falls back to English for a locale that carries no table", () => {
    setLocale("de");
    expect(forkTable("de")).toBeUndefined();
    expect(tf("paneActions.group.manage")).toBe("Manage");
  });

  it("fills a slot", () => {
    expect(tf("quick.codexModel.row", { current: "gpt-6-astra·high" })).toBe("Model / effort: gpt-6-astra·high");
    setLocale("zh-TW");
    expect(tf("quick.codexModel.row", { current: "gpt-6-astra·high" })).toBe("模型／推理強度：gpt-6-astra·high");
  });

  // A key added to English and forgotten in a table would silently answer in English on the
  // operator's own phone. The type allows a partial table on purpose (a locale nobody reads here
  // has none at all), so completeness is pinned here instead.
  it("every table it carries is complete against English", () => {
    expect(FORK_MESSAGE_KEYS.length).toBeGreaterThan(0);
    expect(FORK_MESSAGE_LOCALES.length).toBeGreaterThan(0);
    for (const locale of FORK_MESSAGE_LOCALES) {
      const table = forkTable(locale);
      for (const key of FORK_MESSAGE_KEYS) {
        // The key travels with the verdict, so a failure names which string is missing where.
        expect([locale, key, (table?.[key] ?? "") !== ""]).toEqual([locale, key, true]);
      }
    }
  });
});
