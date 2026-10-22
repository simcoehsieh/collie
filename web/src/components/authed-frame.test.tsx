import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { __resetPairing, setDeviceToken } from "@/lib/pairing";
import { server } from "@/test/setup";

import { AuthedFrame } from "./authed-frame";

// FORK. The regression this pins: from the 1.19.2 merge on, every framed bridge page (an artifact, a
// knowledge-base document, an agent's HTML file) showed "device not paired", because a frame's own
// request cannot carry the pairing token that every `/api` read needs since 1.18 (ADR 0086). The
// frame now gets its page as `srcdoc`, read with the token, and stays `sandbox=""`.

const PATH = "/api/artifacts/a1/raw";

function serveOnlyWithToken() {
  server.use(
    http.get(PATH, ({ request }) =>
      request.headers.get("authorization") === "Bearer tok-1"
        ? new HttpResponse("<h1>the report</h1>", { headers: { "content-type": "text/html" } })
        : new HttpResponse("device not paired", { status: 403 }),
    ),
  );
}

afterEach(() => __resetPairing());

describe("AuthedFrame", () => {
  it("reads the page with the pairing token and frames it as srcdoc, sandboxed with nothing granted", async () => {
    setDeviceToken("tok-1");
    serveOnlyWithToken();
    render(<AuthedFrame path={PATH} title="Report" />);
    const frame = screen.getByTitle("Report");
    await waitFor(() => expect(frame).toHaveAttribute("data-phase", "ready"));
    expect(frame.getAttribute("srcdoc")).toContain("<h1>the report</h1>");
    expect(frame).toHaveAttribute("sandbox", "");
    // No `src`: a frame that fetched the page itself would go without the token.
    expect(frame).not.toHaveAttribute("src");
  });

  it("says why in the frame when the bridge refuses the read", async () => {
    serveOnlyWithToken();
    render(<AuthedFrame path={PATH} title="Report" />);
    const frame = screen.getByTitle("Report");
    await waitFor(() => expect(frame).toHaveAttribute("data-phase", "failed"));
    expect(frame.getAttribute("srcdoc")).toContain("403");
  });
});
