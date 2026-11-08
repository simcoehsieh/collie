import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IdleLock } from "./idle-lock";
import { Wordmark } from "./wordmark";

// FORK (2026-11-09): on a branded machine the product's name on screen is the install's, not
// "Collie". The brand module is mocked for the same reason as app-header-brand.test.tsx. The
// translated copy is pinned in lib/i18n/rebrand.fork.test.ts (setup loads i18n before this mock).
vi.mock("@/lib/brand", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/brand")>()),
  BRAND: { shortName: "Meow", hideMux: true },
  BRAND_WORD: "Meow",
}));

describe("branded product name", () => {
  it("the idle lock names the install", () => {
    render(<IdleLock onUnlock={() => {}} />);
    expect(screen.getByText("Meow")).toBeInTheDocument();
    expect(screen.queryByText("Collie")).toBeNull();
  });

  it("the large-screen wordmark is the install's name, with no PWA suffix", () => {
    const { container } = render(<Wordmark />);
    expect(container.textContent).toBe("Meow");
  });

});
