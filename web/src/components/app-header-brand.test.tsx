import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { __resetConnectionHealth } from "@/lib/connection-health";
import { AppHeaderHost, RouteHeader, SettingsGear } from "./app-header";

// FORK. The header on a BRANDED machine: `~/.config/collie/branding/branding.json` gave this build
// a name and asked for no multiplexer logo. `__BRAND__` is a compile-time `define`, so the branded
// case cannot be reached by stubbing a global — the module in front of it is mocked instead, which
// is the reason src/lib/brand.ts exists as a module at all. app-header.test.tsx covers the stock
// brand this mock replaces.
vi.mock("@/lib/brand", () => ({
  BRAND: { shortName: "Meow", hideMux: true },
  BRAND_WORD: "Meow",
}));

function renderHeader() {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        element: (
          <AppHeaderHost bridge="connected" error={false}>
            <RouteHeader wordmark rightTrail={<SettingsGear />} />
          </AppHeaderHost>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("the header on a branded machine", () => {
  beforeEach(() => {
    __resetConnectionHealth();
    __resetOperatorCommands();
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          mux: {
            name: "reference",
            capabilities: {},
            unsupportedKeys: [],
            notes: {},
            logoUrl: "/api/mux/logo.svg",
          },
        }),
      ),
    );
  });
  afterEach(() => __resetOperatorCommands());

  it("prints the machine's own name alone — no \"on <mux>\" line and no mux logo", async () => {
    const { container } = renderHeader();
    await waitFor(() => expect(screen.getByText("Meow")).toBeInTheDocument());
    // Give /api/config a beat to land, then check the mux line never appeared with it.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/on reference/)).toBeNull();
    expect(screen.queryByText("Collie")).toBeNull();
    // The bridge published a logo URL; `hideMux` dropped the line it would have sat on.
    expect(container.querySelector('img[src*="logo"]')).toBeNull();
    // The name is the block's flow child at line size, not an eyebrow over an empty line.
    const name = screen.getByText("Meow");
    expect(name.tagName).toBe("SPAN");
    expect(name.className).toContain("text-base");
  });
});
