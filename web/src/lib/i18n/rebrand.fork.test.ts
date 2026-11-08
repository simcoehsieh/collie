import { describe, expect, it } from "vitest";

import { rebrand } from "@/lib/brand";
import { __brandDictionary, withForkOverrides } from "./fork-overrides";
import { en } from "./messages/en";
import { zhTW } from "./messages/zh-TW";

// FORK (2026-11-09): a branded install says its own name wherever upstream's copy says "Collie".
// Tests run the stock build (BRAND.shortName null), so the branded word is passed in explicitly.

describe("rebrand", () => {
  it("replaces the product's name in prose", () => {
    expect(rebrand("Collie 無法讀取此畫面。", "Meow")).toBe("Meow 無法讀取此畫面。");
    expect(rebrand("Back to Collie's settings", "Meow")).toBe("Back to Meow's settings");
    expect(rebrand("so two Collies on one host", "Meow")).toBe("so two Meows on one host");
    expect(rebrand("此 Collie 無法讀取", "Meow")).toBe("此 Meow 無法讀取");
  });

  it("keeps what the operator types: commands, env vars, headers, paths", () => {
    const typed = "執行 collie doctor；檢查 COLLIE_SEND_PROTOCOL、X-Collie-Lead-Row、~/.config/collie";
    expect(rebrand(typed, "Meow")).toBe(typed);
  });

  it("the stock build changes nothing", () => {
    expect(rebrand("Collie 無法讀取此畫面。", null)).toBe("Collie 無法讀取此畫面。");
  });
});

describe("branded dictionaries", () => {
  for (const [name, locale, dictionary] of [
    ["zh-TW", "zh-TW", zhTW],
    ["en", "en", en],
  ] as const) {
    it(`${name}: no "Collie" survives as a word once branded`, () => {
      const branded = __brandDictionary(withForkOverrides(locale, dictionary), "Meow");
      const left = Object.entries(branded).filter(([, v]) => /(?<![-\w])Collie/.test(v));
      expect(left).toEqual([]);
    });
  }

  it("zh-TW reads Meow where it read Collie, and the command stays collie", () => {
    const branded = __brandDictionary(withForkOverrides("zh-TW", zhTW), "Meow");
    expect(branded["composer.protocol.unconfirmed"]).toMatch(/^Meow 無法讀取此畫面/);
    expect(branded["composer.held.versionUnread"]).toContain("collie doctor");
    expect(branded["composer.held.versionUnread"]).toContain("Meow 無法讀取");
  });

  it("stock: the dictionary passes through untouched", () => {
    const stock = withForkOverrides("zh-TW", zhTW);
    expect(__brandDictionary(stock, null)).toBe(stock);
  });
});
