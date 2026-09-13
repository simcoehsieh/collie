import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { __resetQuotaCache } from "@/lib/api";
import { __resetQuota } from "@/lib/quota";
import type { QuotaResponse } from "@/lib/types";
import { server } from "@/test/setup";
import { QuotaCard, formatCountdown } from "./quota-card";

// FORK: the usage section. Three rows, always; two bars each; the rest behind a tap.

afterEach(() => {
  __resetQuota();
  __resetQuotaCache();
});

const body = (over: Partial<QuotaResponse> = {}): QuotaResponse => ({
  ok: true,
  fetchedAt: "2026-09-10T16:26:50Z",
  agents: [
    {
      key: "claude",
      name: "claude",
      status: "ok",
      plan: "Claude MAX",
      windows: [
        { kind: "5h", label: "5h Rolling Limit", usedPercent: 16, resetAt: null, resetAfterSeconds: 13391, status: "allowed" },
        { kind: "weekly", label: "7-Day Window", usedPercent: 75, resetAt: null, resetAfterSeconds: 34391, status: "allowed" },
      ],
    },
    {
      key: "codex",
      name: "codex",
      status: "ok",
      plan: "ChatGPT PROLITE",
      windows: [{ kind: "weekly", label: "7-Day Window", usedPercent: 4, resetAt: null, resetAfterSeconds: 486029, status: "allowed" }],
      models: [{ label: "GPT-5.3-Codex-Spark", usedPercent: 0, resetAfterSeconds: 18000 }],
      credits: "$0",
    },
    {
      key: "agy",
      name: "agy",
      status: "ok",
      plan: "Google Antigravity",
      windows: [
        { kind: "5h", label: "5h (Gemini)", usedPercent: 0, resetAt: null, resetAfterSeconds: 17997, status: "allowed" },
        { kind: "weekly", label: "Weekly (Gemini)", usedPercent: 17.8, resetAt: null, resetAfterSeconds: 8048, status: "allowed" },
        { kind: "other", label: "Weekly Limit (Claude & GPT)", usedPercent: 0, resetAt: null, resetAfterSeconds: 604797, status: "allowed" },
      ],
    },
  ],
  ...over,
});

function serve(reply: () => QuotaResponse, seen?: string[]) {
  server.use(
    http.get("/api/quota", ({ request }) => {
      seen?.push(new URL(request.url).search);
      return HttpResponse.json(reply(), { headers: { etag: `"q${seen?.length ?? 0}"` } });
    }),
  );
}

describe("QuotaCard", () => {
  it("draws the three agents in order with their five-hour and weekly bars", async () => {
    serve(body);
    render(<QuotaCard open onOpenChange={() => {}} />);
    await screen.findByText("claude");
    const rows = screen.getAllByTestId(/^quota-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["quota-row-claude", "quota-row-codex", "quota-row-agy"]);
    const claude = within(rows[0]!);
    expect(claude.getByRole("progressbar", { name: "5h" })).toHaveAttribute("aria-valuenow", "16");
    expect(claude.getByRole("progressbar", { name: "Weekly" })).toHaveAttribute("aria-valuenow", "75");
    expect(claude.getByText("Claude MAX")).toBeInTheDocument();
    // No five-hour window on codex: the slot is drawn empty, the week is drawn.
    const codex = within(rows[1]!);
    expect(codex.queryByRole("progressbar", { name: "5h" })).toBeNull();
    expect(codex.getByRole("progressbar", { name: "Weekly" })).toHaveAttribute("aria-valuenow", "4");
  });

  it("a tap on a row shows the rest; a row with nothing more is not a toggle", async () => {
    serve(body);
    const user = userEvent.setup();
    render(<QuotaCard open onOpenChange={() => {}} />);
    await screen.findByText("agy");
    const agy = within(screen.getByTestId("quota-row-agy"));
    expect(agy.queryByText("Weekly Limit (Claude & GPT)")).toBeNull();
    await user.click(agy.getByRole("button"));
    expect(agy.getByText("Weekly Limit (Claude & GPT)")).toBeInTheDocument();
    const codex = within(screen.getByTestId("quota-row-codex"));
    await user.click(codex.getByRole("button"));
    expect(codex.getByText("GPT-5.3-Codex-Spark")).toBeInTheDocument();
    expect(codex.getByText(/\$0/)).toBeInTheDocument();
    // Only one open at a time.
    expect(agy.queryByText("Weekly Limit (Claude & GPT)")).toBeNull();
    const claude = within(screen.getByTestId("quota-row-claude"));
    expect(claude.getByRole("button")).not.toHaveAttribute("aria-expanded");
  });

  it("the refresh glyph asks the bridge to rerun, and the section folds", async () => {
    const seen: string[] = [];
    serve(body, seen);
    const user = userEvent.setup();
    let open = true;
    const { rerender } = render(<QuotaCard open={open} onOpenChange={(o) => (open = o)} />);
    await screen.findByText("claude");
    await user.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(seen).toContain("?refresh=1"));
    await user.click(screen.getByRole("button", { name: /Usage/ }));
    expect(open).toBe(false);
    rerender(<QuotaCard open={open} onOpenChange={() => {}} />);
    expect(screen.queryByTestId("quota-row-claude")).toBeNull();
  });

  it("an agent the CLI could not read shows its words; one it did not report says so", async () => {
    serve(() =>
      body({
        agents: [
          { key: "claude", name: "claude", status: "error", windows: [], error: "keychain locked" },
          { key: "codex", name: "codex", status: "missing", windows: [] },
          body().agents[2]!,
        ],
      }),
    );
    render(<QuotaCard open onOpenChange={() => {}} />);
    await screen.findByText("keychain locked");
    expect(screen.getByText("not configured")).toBeInTheDocument();
    expect(screen.getByTestId("quota-row-agy")).toBeInTheDocument();
  });

  it("a bridge with no quota source is one muted line, not a crash", async () => {
    server.use(http.get("/api/quota", () => HttpResponse.text("no quota source", { status: 404 })));
    render(<QuotaCard open onOpenChange={() => {}} />);
    await screen.findByText(/404/);
    expect(screen.queryByTestId("quota-row-claude")).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("spells days, hours and minutes at the right granularity", () => {
    expect(formatCountdown(5 * 86400 + 15 * 3600 + 30 * 60)).toBe("5d 15h");
    expect(formatCountdown(3 * 3600 + 43 * 60 + 11)).toBe("3h 43m");
    expect(formatCountdown(12 * 60 + 59)).toBe("12m");
    expect(formatCountdown(30)).toBe("1m");
    expect(formatCountdown(0)).toBe("resetting");
  });
});
