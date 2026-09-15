import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { NotifyPrefsControl } from "@/components/notify-prefs-control";
import type { PaneNotifyRule } from "@/lib/types";
import type { CacheWatchListEntry } from "@/lib/types";

// NotifyPrefsControl fetches the bridge-wide prefs on mount and toggles them optimistically. We drive
// it through MSW: the GET seeds the switches, the POST captures the single-key partial and echoes the
// merged prefs back; a failing POST must leave the switch where it started (revert).
//
// The fourth switch (cache, ADR 0042) and the Watched panes list underneath it get their own
// describe block below, with their own fixture entries and their own list/forget handlers.

/** The bridge-wide notification prefs, exactly as `/api/notifications/prefs` carries them. */
interface Prefs {
  blocked: boolean;
  done: boolean;
  updates: boolean;
  panes?: PaneNotifyRule[];
  operatorPanes?: PaneNotifyRule[];
  cache: boolean;
}

// The control sends ONE key per toggle, so a patch is a partial of the same contract — which is
// also what the cases assert (`toEqual({ updates: false })`).
let lastPatch: Partial<Prefs> | undefined;
let currentPrefs: Prefs;

beforeEach(() => {
  lastPatch = undefined;
  currentPrefs = { blocked: true, done: false, updates: true, cache: false, panes: [] };
  server.use(
    http.get("/api/notifications/prefs", () => HttpResponse.json(currentPrefs)),
    http.post<never, Partial<Prefs>>("/api/notifications/prefs", async ({ request }) => {
      lastPatch = await request.json();
      currentPrefs = { ...currentPrefs, ...lastPatch };
      return HttpResponse.json(currentPrefs);
    }),
  );
});

describe("NotifyPrefsControl", () => {
  test("renders the fetched prefs onto the switches", async () => {
    render(<NotifyPrefsControl />);
    const needs = await screen.findByRole("switch", { name: /needs input/i });
    const finished = await screen.findByRole("switch", { name: /finished/i });
    const updates = await screen.findByRole("switch", { name: /app updates/i });
    expect(needs).toBeChecked(); // blocked default on
    expect(finished).not.toBeChecked(); // done default off
    expect(updates).toBeChecked(); // updates default on
  });

  test("toggling App updates POSTs the single-key partial update", async () => {
    const user = userEvent.setup();
    render(<NotifyPrefsControl />);
    const updates = await screen.findByRole("switch", { name: /app updates/i });

    await user.click(updates); // on → off

    await waitFor(() => expect(lastPatch).toEqual({ updates: false }));
    await waitFor(() => expect(updates).not.toBeChecked());
  });

  test("toggling a row POSTs the single-key partial update", async () => {
    const user = userEvent.setup();
    render(<NotifyPrefsControl />);
    const finished = await screen.findByRole("switch", { name: /finished/i });

    await user.click(finished);

    await waitFor(() => expect(lastPatch).toEqual({ done: true }));
    await waitFor(() => expect(finished).toBeChecked());
  });

  test("reverts the optimistic toggle when the POST fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/notifications/prefs", () => new HttpResponse(null, { status: 500 })),
    );
    render(<NotifyPrefsControl />);
    const needs = await screen.findByRole("switch", { name: /needs input/i });
    expect(needs).toBeChecked();

    await user.click(needs); // optimistic → off, POST 500 → revert to on

    await waitFor(() => expect(needs).toBeChecked());
  });
});

// FORK: per-pane rules beneath the switches.
describe("NotifyPrefsControl — per pane", () => {
  test("lists each agent pane with its mode, and a mode tap POSTs the whole rule list", async () => {
    const user = userEvent.setup();
    render(<NotifyPrefsControl panes={fixtureAgents} />);
    const claude = await screen.findByRole("radiogroup", { name: "claude" });
    expect(screen.getByRole("radiogroup", { name: "codex" })).toBeInTheDocument();
    expect(within(claude).getByRole("radio", { name: /default/i })).toHaveAttribute("aria-checked", "true");

    await user.click(within(claude).getByRole("radio", { name: "Mute" }));

    // The rule names the pane by id AND by its space, so it outlives a multiplexer restart.
    await waitFor(() => expect(lastPatch).toEqual({ panes: [{ paneId: "w1:p1", label: "webapp", mode: "mute" }] }));
    await waitFor(() =>
      expect(within(claude).getByRole("radio", { name: "Mute" })).toHaveAttribute("aria-checked", "true"),
    );
    // The other pane is untouched.
    expect(
      within(screen.getByRole("radiogroup", { name: "codex" })).getByRole("radio", { name: /default/i }),
    ).toHaveAttribute("aria-checked", "true");
  });

  test("a pane snooze creates a default-mode rule with a deadline about an hour out", async () => {
    const user = userEvent.setup();
    render(<NotifyPrefsControl panes={[fixtureAgents[0]!]} />);
    await screen.findByRole("radiogroup", { name: "claude" });
    const before = Date.now();
    await user.click(screen.getByRole("button", { name: /snooze 1h/i }));
    await waitFor(() => expect(lastPatch?.panes).toHaveLength(1));
    const rule = lastPatch!.panes![0]!;
    expect(rule).toMatchObject({ paneId: "w1:p1", label: "webapp", mode: "default" });
    expect(rule.snoozedUntil!).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(rule.snoozedUntil!).toBeLessThan(before + 61 * 60_000);
    // Resume clears the deadline, and a rule left saying nothing goes with it.
    await screen.findByRole("button", { name: /resume/i });
    await user.click(screen.getByRole("button", { name: /resume/i }));
    await waitFor(() => expect(lastPatch).toEqual({ panes: [] }));
  });

  test("a rule no open pane claims is listed as not open, and can be removed", async () => {
    const user = userEvent.setup();
    currentPrefs = { ...currentPrefs, panes: [{ paneId: "w9:p9", mode: "mute" }, { paneId: "w1:p1", mode: "blocked" }] };
    render(<NotifyPrefsControl panes={[fixtureAgents[0]!]} />);
    const remove = await screen.findByRole("button", { name: /remove rule: w9:p9/i });
    expect(screen.getByText(/not open/i)).toBeInTheDocument();
    // The live pane's own rule is shown on its row, not as an orphan.
    expect(screen.queryByRole("button", { name: /remove rule: w1:p1/i })).not.toBeInTheDocument();
    await user.click(remove);
    await waitFor(() => expect(lastPatch).toEqual({ panes: [{ paneId: "w1:p1", mode: "blocked" }] }));
  });

  test("a label rule that catches a pane shows on that pane's row as inherited", async () => {
    currentPrefs = { ...currentPrefs, panes: [{ label: "webapp", mode: "mute" }] };
    render(<NotifyPrefsControl panes={[fixtureAgents[0]!]} />);
    const claude = await screen.findByRole("radiogroup", { name: "claude" });
    await waitFor(() => expect(within(claude).getByRole("radio", { name: "Mute" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText("“webapp”")).toBeInTheDocument();
    expect(screen.queryByText(/not open/i)).not.toBeInTheDocument();
  });

  test("with no panes and no rules the section says so", async () => {
    render(<NotifyPrefsControl />);
    expect(await screen.findByText(/no panes right now/i)).toBeInTheDocument();
  });
});

// ── FORK: rules from the operator's notify.toml ──────────────────────────────
// The bridge answers them read-only beside the phone's own; the row shows the mode the bridge will
// apply and says the file's name, and a tap adds a phone rule that wins over it.
describe("NotifyPrefsControl — rules from notify.toml", () => {
  test("a file rule shows as the applied mode, named after the file; a tap overrides it with a phone rule", async () => {
    currentPrefs = { blocked: true, done: true, updates: true, cache: false, panes: [], operatorPanes: [{ label: "webapp", mode: "blocked" }] };
    const user = userEvent.setup();
    const pane = fixtureAgents[0]!;
    render(<NotifyPrefsControl panes={[pane]} />);
    const row = (await screen.findAllByRole("listitem")).find((li) => li.getAttribute("data-pane") === pane.paneId)!;
    expect(within(row).getByRole("radio", { name: "Needs input" })).toHaveAttribute("aria-checked", "true");
    expect(within(row).getByText("notify.toml: “webapp”")).toBeInTheDocument();
    await user.click(within(row).getByRole("radio", { name: "Mute" }));
    await waitFor(() => expect(lastPatch?.panes?.[0]).toMatchObject({ paneId: pane.paneId, mode: "mute" }));
    // The phone's rule now applies, and the file's name is gone from the row.
    await waitFor(() => expect(within(row).queryByText("notify.toml: “webapp”")).not.toBeInTheDocument());
  });
});

describe("NotifyPrefsControl — the fourth switch and the panes it watches", () => {
  const ENTRIES: CacheWatchListEntry[] = [
    { id: "e1", label: "web-worker" },
    { id: "e2", label: "backend", host: "minibuch" },
  ];

  beforeEach(() => {
    server.use(
      http.get("/api/notifications/cache-watch/list", () => HttpResponse.json({ entries: ENTRIES })),
      http.post<never, { id: string }>("/api/notifications/cache-watch/forget", async ({ request }) => {
        const { id } = await request.json();
        return HttpResponse.json({ entries: ENTRIES.filter((e) => e.id !== id) });
      }),
    );
  });

  test("renders four switch rows, the fourth for the cache warning", async () => {
    render(<NotifyPrefsControl />);
    expect(await screen.findByRole("switch", { name: /needs input/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /finished/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /app updates/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /cache about to go cold/i })).toBeInTheDocument();
  });

  test("toggling the fourth switch POSTs {cache: true}", async () => {
    const user = userEvent.setup();
    render(<NotifyPrefsControl />);
    const cache = await screen.findByRole("switch", { name: /cache about to go cold/i });
    expect(cache).not.toBeChecked();

    await user.click(cache);

    await waitFor(() => expect(lastPatch).toEqual({ cache: true }));
    await waitFor(() => expect(cache).toBeChecked());
  });

  test("the Watched panes heading renders from the first frame, before the list answers", () => {
    render(<NotifyPrefsControl />);
    // Synchronous: no findBy/waitFor. The heading is part of the card's static shape (ROWS is
    // static too), so it must be there on the very first render, before any fetch resolves.
    expect(screen.getByText("Watched panes")).toBeInTheDocument();
  });

  test("two watched entries render with a remove button each, the peer one showing its host", async () => {
    render(<NotifyPrefsControl />);

    expect(await screen.findByText("web-worker")).toBeInTheDocument();
    expect(screen.getByText("backend")).toBeInTheDocument();
    expect(screen.getByText("minibuch")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /stop watching/i })).toHaveLength(2);
  });

  test("tapping remove forgets the entry and its row goes", async () => {
    const user = userEvent.setup();
    render(<NotifyPrefsControl />);
    await screen.findByText("web-worker");

    await user.click(screen.getByRole("button", { name: "Stop watching web-worker" }));

    await waitFor(() => expect(screen.queryByText("web-worker")).not.toBeInTheDocument());
    expect(screen.getByText("backend")).toBeInTheDocument();
  });
});
