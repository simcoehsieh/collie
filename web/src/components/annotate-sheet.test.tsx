import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "@/test/setup";
import { AnnotateSheet } from "./annotate-sheet";

describe("Screenshot setup", () => {
  const props = { open: true, onClose: vi.fn(), paneId: "w1:p1", initialUrl: "http://127.0.0.1:4318/api/snapshot", onDraft: vi.fn(), maxUploadBytes: 10_000_000 };
  it("explains the workflow and never offers a terminal's API probe as a website", () => {
    render(<AnnotateSheet {...props} />);
    expect(screen.getByLabelText("Page address")).toHaveValue("");
    expect(screen.getByText("Capture a website running on your Mac")).toBeInTheDocument();
    expect(screen.getByText("Add it to your draft, describe the change, then send.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take a shot" })).toBeDisabled();
  });
  it("keeps the typed address on terminal updates and submits the chosen viewport", async () => {
    const requests: unknown[] = [];
    server.use(http.post("/api/pane/w1%3Ap1/shot", async ({ request }) => {
      requests.push(await request.json());
      return HttpResponse.json({ ok: false, error: "fixture: no browser" });
    }));
    const user = userEvent.setup();
    const view = render(<AnnotateSheet {...props} />);
    await user.type(screen.getByLabelText("Page address"), "http://localhost:5173/app");
    await user.click(screen.getByRole("button", { name: "Tablet · 768" }));
    view.rerender(<AnnotateSheet {...props} initialUrl="http://localhost:6000/" />);
    expect(screen.getByLabelText("Page address")).toHaveValue("http://localhost:5173/app");
    await user.click(screen.getByRole("button", { name: "Take a shot" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ url: "http://localhost:5173/app", width: 768, height: 1024 });
    expect(props.onDraft).not.toHaveBeenCalled();
  });
});
