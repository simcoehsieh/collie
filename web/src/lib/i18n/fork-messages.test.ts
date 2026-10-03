import { en } from "./messages/en";
import { __resetLocale, setLocale, t, whenLocaleReady } from "./index";
import { forkEn, forkZhTW } from "./fork-messages";

// The fork's own vocabulary, served through upstream's `t()` (fork-overrides.ts adds it to every
// dictionary as it enters the runtime). What is pinned is what would fail quietly: a key that
// shadows an upstream one, a translation that drifted short or lost a slot, a locale with no table
// that must still answer, and a frame that shows the two layers in different languages.

/** An upstream key whose Traditional Chinese differs from its English — the control for the "in
 *  step" case below. */
const UPSTREAM = "queue.sendNow";

/** The `{slot}` names a message fills, sorted, so two translations can be compared by them. */
function slots(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).toSorted();
}

beforeEach(() => {
  localStorage.clear();
  __resetLocale();
});

describe("fork-messages", () => {
  it("answers in English by default", () => {
    expect(t("fork.paneActions.more")).toBe("More");
    expect(t("fork.diff.workspaceChanges")).toBe("Workspace changes");
  });

  it("answers in Traditional Chinese once the zh-TW bundle has landed", async () => {
    setLocale("zh-TW");
    await whenLocaleReady();
    expect(t("fork.paneActions.more")).toBe("更多");
    expect(t("fork.diff.workspaceChanges")).toBe("工作區變更");
    expect(t("fork.queue.sendAgain")).toBe("再送一次");
  });

  it("switches in step with upstream's own strings, so no frame mixes the two languages", async () => {
    setLocale("zh-TW");
    // Chosen, not yet loaded: both layers are still English.
    expect(t("fork.paneActions.more")).toBe(forkEn["fork.paneActions.more"]);
    expect(t(UPSTREAM)).toBe(en[UPSTREAM]);
    await whenLocaleReady();
    expect(t("fork.paneActions.more")).toBe(forkZhTW["fork.paneActions.more"]);
    expect(t(UPSTREAM)).not.toBe(en[UPSTREAM]);
  });

  it("falls back to English for a locale with no fork table", async () => {
    setLocale("de");
    await whenLocaleReady();
    expect(t("fork.paneActions.group.manage")).toBe("Manage");
    expect(t("fork.quick.codexModel.unknown")).toBe("not read yet");
  });

  it("fills a slot in either language", async () => {
    expect(t("fork.quick.codexModel.row", { current: "gpt-6-astra·high" })).toBe("Model / effort: gpt-6-astra·high");
    setLocale("zh-TW");
    await whenLocaleReady();
    expect(t("fork.quick.codexModel.row", { current: "gpt-6-astra·high" })).toBe("模型／推理強度：gpt-6-astra·high");
  });

  // The layer is spread over upstream's dictionary, so a fork key spelled like an upstream one would
  // silently replace upstream's string everywhere it is used. The prefix is what keeps them apart.
  it("every key is a fork. key and none shadows an upstream key", () => {
    for (const key of Object.keys(forkEn)) {
      expect([key, key.startsWith("fork."), Object.hasOwn(en, key)]).toEqual([key, true, false]);
    }
  });

  // The type already demands every key; it cannot demand a non-empty string or the same slots, and
  // a translation that dropped `{preview}` would print the braces nowhere and the message half-said.
  it("the zh-TW table is complete: every key, none empty, the same slots as English", () => {
    expect(Object.keys(forkZhTW).toSorted()).toEqual(Object.keys(forkEn).toSorted());
    for (const [key, english] of Object.entries(forkEn)) {
      const chinese = Object.entries(forkZhTW).find(([k]) => k === key)?.[1] ?? "";
      expect([key, chinese !== "", slots(chinese)]).toEqual([key, true, slots(english)]);
    }
  });
});
