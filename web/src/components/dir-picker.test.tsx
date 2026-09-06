import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { DirPicker } from "./dir-picker";

// The folder picker for a new space. The rule it exists to keep is that the HEADER is the answer:
// whatever it names is what a create would use, so there is never a chosen directory the operator
// cannot see — which is exactly the failure the typed-path field had, where a typo looked like a
// path and opened somewhere else.

/** Drives the picker the way the sheet does: one piece of state, shown so a test can read it back. */
function Harness({ shortcuts }: { shortcuts?: readonly string[] } = {}) {
  const [value, setValue] = useState("");
  return (
    <>
      <output data-testid="chosen">{value}</output>
      <DirPicker value={value} onChange={setValue} shortcuts={shortcuts} />
    </>
  );
}

const chosen = () => screen.getByTestId("chosen").textContent;

describe("DirPicker", () => {
  it("opens on the home directory and shows it shortened", async () => {
    render(<Harness />);
    // `~`, not `/home/op` — the operator reads paths the way their shell prints them, and the home
    // dir arrives from the answering host so this holds on a peer too.
    expect(await screen.findByText("~")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /git/ })).toBeInTheDocument();
  });

  it("a row BOTH descends and chooses — one tap per level, no separate commit", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /git/ }));

    // Chosen…
    await waitFor(() => expect(chosen()).toBe("/home/op/git"));
    // …and browsed into, which is the half that makes it one tap rather than two.
    expect(await screen.findByRole("button", { name: /ai-stock/ })).toBeInTheDocument();
    expect(await screen.findByText("~/git")).toBeInTheDocument();
  });

  it("goes back up, and cannot go above home", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // At home the up control is offered but refuses — the listing says `parent: null`, and saying so
    // is what keeps the UI from offering a step the bridge would then refuse.
    const up = await screen.findByRole("button", { name: /up one level/i });
    expect(up).toBeDisabled();

    await user.click(await screen.findByRole("button", { name: /git/ }));
    await waitFor(() => expect(chosen()).toBe("/home/op/git"));
    await waitFor(() => expect(screen.getByRole("button", { name: /up one level/i })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: /up one level/i }));
    // Up CHOOSES too, for the same reason a row does: the header is the answer, so it may never
    // name a directory the create would not use.
    await waitFor(() => expect(chosen()).toBe("/home/op"));
  });

  it("a shortcut jumps the browser AND chooses, and marks itself", async () => {
    const user = userEvent.setup();
    render(<Harness shortcuts={["/home/op/git/collie"]} />);
    const chip = await screen.findByRole("button", { name: "collie" });
    expect(chip.className).not.toMatch(/border-primary/);

    await user.click(chip);
    await waitFor(() => expect(chosen()).toBe("/home/op/git/collie"));
    // The mark is on the CHIP, not only in the header: the strip is where the eye is after tapping.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "collie" }).className).toMatch(/border-primary/),
    );
  });

  it("says a directory is empty rather than rendering nothing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /git/ }));
    await user.click(await screen.findByRole("button", { name: /ai-stock/ }));
    expect(await screen.findByText(/no sub-folders/i)).toBeInTheDocument();
  });

  it("a refused listing keeps the last one on screen and says the read failed", async () => {
    // The recovery for every refusal is the same — step back out, or type the path in the field
    // below — so the picker must not blank itself and strand the operator in a directory with no
    // rows and no way up.
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(await screen.findByRole("button", { name: /git/ }));
    await screen.findByRole("button", { name: /ai-stock/ });

    server.use(http.get("/api/dirs", () => new HttpResponse("outside the home directory", { status: 403 })));
    await user.click(screen.getByRole("button", { name: /collie/ }));

    expect(await screen.findByText(/couldn't read that folder/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ai-stock/ })).toBeInTheDocument();
  });

  it("says when a listing was cut short instead of silently showing part of it", async () => {
    server.use(
      http.get("/api/dirs", () =>
        HttpResponse.json({
          ok: true,
          path: "/home/op",
          parent: null,
          home: "/home/op",
          entries: [{ name: "one", path: "/home/op/one" }],
          truncated: true,
        }),
      ),
    );
    render(<Harness />);
    expect(await screen.findByText(/showing the first 1/i)).toBeInTheDocument();
  });

  it("never sends a `path` for the home directory, so the bridge picks it", async () => {
    // The client does not know the home dir before the first answer, and must not guess one: the
    // bridge resolves an absent path to the operator's home, and that is the only place that fact
    // lives.
    const asked: (string | null)[] = [];
    server.use(
      http.get("/api/dirs", ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("path"));
        return HttpResponse.json({
          ok: true,
          path: "/home/op",
          parent: null,
          home: "/home/op",
          entries: [],
          truncated: false,
        });
      }),
    );
    render(<Harness />);
    await screen.findByText("~");
    expect(asked).toEqual([null]);
  });
});
