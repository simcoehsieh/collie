import { fireEvent, render, screen } from "@testing-library/react";

import { claimAxis, DISMISS_PX, FLING_PX_PER_MS, RightSheet, SLOP, shouldDismiss } from "./right-sheet";

// What is and is not simulated here, stated up front because the split is deliberate (the same one
// hooks/use-sheet-pull.test.ts makes): jsdom has no layout and no real touch, so the DRAG ITSELF is
// never driven. Instead the two decisions it turns on — which axis a gesture claimed, and whether a
// release dismisses — are pure exported functions with their own decision tables below, and the
// wiring that a jsdom test CAN see (where the listener is attached, and with what options) is
// asserted directly against the DOM.

// Focus + labelling: the sheet is role=dialog/aria-modal, so it should be named by its title,
// described by the URL line (which is the only way to tell WHICH document is open — an
// opaque-origin iframe contributes nothing to this document's accessibility tree), move focus
// inside on open, restore it on close, and expose exactly ONE accessible "Close".
describe("RightSheet — focus & labelling", () => {
  it("labels the dialog with its title (aria-labelledby)", () => {
    render(
      <RightSheet open onClose={vi.fn()} title="Collie bridge notes">
        body
      </RightSheet>,
    );
    expect(screen.getByRole("dialog", { name: "Collie bridge notes" })).toBeInTheDocument();
  });

  it("describes the dialog with the subtitle, so the URL of the open document is announced", () => {
    // If this stopped holding, a screen-reader user would be told only "dialog, <title>" about a
    // panel whose entire content is a frame they cannot see into.
    render(
      <RightSheet open onClose={vi.fn()} title="Notes" subtitle="https://knowledge.agnex.dev/d/notes">
        body
      </RightSheet>,
    );
    expect(screen.getByRole("dialog", { description: "https://knowledge.agnex.dev/d/notes" })).toBeInTheDocument();
  });

  it("exposes a single accessible Close (✕); the backdrop is aria-hidden but still dismisses on a real tap (down+up on it)", () => {
    const onClose = vi.fn();
    const { container } = render(
      <RightSheet open onClose={onClose} title="Notes">
        body
      </RightSheet>,
    );
    // Only the header ✕ is in the a11y tree — no giant duplicate "Close" from the full-screen backdrop.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
    const backdrop = container.querySelector('button[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop!);
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the panel on open and restores it to the opener on close", () => {
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <RightSheet open onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <RightSheet open={false} onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

// Same on-device bug the bottom sheet was fixed for: a long-press that opens a sheet leaves the
// finger down at mount time, the browser's release `click` lands wherever the finger now is — the
// backdrop — and closing on ANY backdrop click meant the sheet closed in the instant it opened. The
// dismiss is armed only when the pointer went DOWN on the backdrop too. This sheet is opened by a
// tap on a link in the mirror rather than by a long-press, but the anchor's own release click lands
// the same way, so the guard is not optional here either.
describe("RightSheet — backdrop dismiss requires press AND release on the backdrop", () => {
  it("stays open when pointerdown happened elsewhere (not the backdrop) and only the click lands on it", () => {
    const onClose = vi.fn();
    const { container } = render(
      <RightSheet open onClose={onClose} title="Notes">
        body
      </RightSheet>,
    );
    fireEvent.pointerDown(document.body);
    const backdrop = container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("the ✕ button still closes regardless of the backdrop arm state", () => {
    const onClose = vi.fn();
    render(
      <RightSheet open onClose={onClose} title="Notes">
        body
      </RightSheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape still closes regardless of the backdrop arm state", () => {
    const onClose = vi.fn();
    render(
      <RightSheet open onClose={onClose} title="Notes">
        body
      </RightSheet>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-arms per open: a stale arm from a previous open doesn't leak into the next one", () => {
    const onClose = vi.fn();
    const { container, rerender } = render(
      <RightSheet open onClose={onClose} title="Notes">
        body
      </RightSheet>,
    );
    const backdrop = () => container.querySelector('button[aria-hidden="true"]')!;
    fireEvent.pointerDown(backdrop());
    // Close via Escape instead of the (now-armed) backdrop click, leaving the arm flag set to true.
    fireEvent.keyDown(window, { key: "Escape" });
    rerender(
      <RightSheet open={false} onClose={onClose} title="Notes">
        body
      </RightSheet>,
    );
    rerender(
      <RightSheet open onClose={onClose} title="Notes">
        body
      </RightSheet>,
    );
    onClose.mockClear();
    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Closed means GONE, not hidden. The caller mounts this beside the terminal mirror, which re-renders
// on every 1.5s snapshot; a sheet that stayed in the tree with `display:none` would keep a framed
// cross-origin document — and whatever it is doing — alive behind the terminal for the rest of the
// session. Both sheets in ui/sheet.tsx hold the same property and it is why they need no unmount
// bookkeeping at all.
describe("RightSheet — the closed state", () => {
  it("renders nothing at all when closed", () => {
    const { container } = render(
      <RightSheet open={false} onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("enters from the right edge, not from the left the way the existing drawer does", () => {
    const { container } = render(
      <RightSheet open onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    const panel = container.querySelector<HTMLElement>('div[tabindex="-1"]')!;
    expect(panel.className).toMatch(/\bslide-in-from-right\b/);
    expect(panel.className).not.toMatch(/\bslide-in-from-left\b/);
  });
});

// THE PANEL IS A RAISED SURFACE, and the ground says so — the same argument ui/sheet.tsx's two
// sheets settled: `bg-background` is the token of the page the panel floats over, which in dark left
// a --border hairline at 1.26:1 as the whole separation and the operator reported the drawer as hard
// to make out. `--card` is a real step up; `--rule` is the token for a cut between REGIONS rather
// than a component's own outline (DESIGN.md §4). A colour with no width paints nothing (§7 trap 1),
// so the border half is pinned too.
//
// The width and the two safe-area edges are pinned in the same place because all three are things a
// reader would "tidy" into the wrong answer — in BOTH directions here. Collapsing the responsive
// width to a bare `w-[92%]` puts an 8px sliver of terminal back beside a phone-width document,
// which the operator reported as an unfinished edge; collapsing it to a bare `w-full` hands the
// desktop panel's whole left edge to iOS's back-swipe, which eats the drag. And
// `env(safe-area-inset-bottom)` looks like the honest spelling of the bottom until it reports 0 on
// the one device this fork serves.
describe("RightSheet — surface, width, and the two safe-area edges", () => {
  it("stands on the raised surface, edged with the region rule on the side that faces the app", () => {
    const { container } = render(
      <RightSheet open onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    const panel = container.querySelector('div[tabindex="-1"]')!;
    expect(panel.className).toMatch(/(?:^|\s)bg-card(?=\s|$)/);
    expect(panel.className).not.toMatch(/(?:^|\s)bg-background(?=\s|$)/);
    // Inset-only, like the rounded corner: full-bleed on a phone there is no cut to draw. The
    // colour is unconditional and the WIDTH is what the breakpoint moves, because a colour with no
    // width paints nothing either way.
    expect(panel.className).toMatch(/(?:^|\s)border-rule(?=\s|$)/);
    expect(panel.className).toMatch(/(?:^|\s)border-l-0(?=\s|$)/);
    expect(panel.className).toMatch(/(?:^|\s)sm:border-l(?=\s|$)/);
    // The header rides the same surface — a header in the page's colour would cut the panel in two.
    const grab = container.querySelector('[data-slot="right-sheet-grab"]')!;
    expect(grab.className).toContain("bg-card/95");
  });

  it("fills a phone edge to edge, and leaves the left edge to iOS from `sm` up", () => {
    // In a home-screen PWA a swipe from the physical left edge is the system's back gesture, so a
    // panel reaching that edge cannot also be dragged away from it — the system wins. From `sm` up
    // the uncovered strip is what keeps the two gestures apart (and doubles as the tap-to-dismiss
    // zone). On a phone that strip is a sliver of coloured terminal beside the words being read, so
    // the panel is full-bleed there and the ways out are the ✕, the header drag, and Escape — all
    // of them on the panel's own chrome, none of them on the edge iOS owns.
    const { container } = render(
      <RightSheet open onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    const panel = container.querySelector('div[tabindex="-1"]')!;
    expect(panel.className).toMatch(/(?:^|\s)w-full(?=\s|$)/);
    expect(panel.className).toMatch(/(?:^|\s)sm:w-\[92%\](?=\s|$)/);
    // The corner is inset-only too: `rounded-l-md` against the screen edge would only open two
    // notches of backdrop where the panel no longer meets anything.
    expect(panel.className).toMatch(/(?:^|\s)sm:rounded-l-md(?=\s|$)/);
    expect(panel.className).not.toMatch(/(?:^|\s)rounded-l-md(?=\s|$)/);
    // Still capped: 92% of a landscape 13-inch iPad is 1257px of prose measure. Wider than
    // BottomSheet's row column on purpose — a document is not a list of phone-width rows. Below
    // `sm` the cap is slack, since the viewport is narrower than it.
    expect(panel.className).toMatch(/\bmax-w-2xl\b/);
  });

  it("reserves the bottom through the --safe-bottom token and the right through env() directly", () => {
    // The two edges are spelled differently on purpose. index.css gives --safe-bottom a 34px floor
    // in standalone because iOS 26 reports env(safe-area-inset-bottom) = 0 in this app's own
    // home-screen install while still placing content under the home indicator; "simplifying" the
    // bottom to a bare env() would put the last line of a document back under the indicator on the
    // one phone this fork serves. The right inset has no such measured lie behind it.
    const { container } = render(
      <RightSheet open onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    const panel = container.querySelector('div[tabindex="-1"]')!;
    expect(panel.className).toContain("pb-[calc(var(--safe-bottom)_+_0.5rem)]");
    expect(panel.className).not.toContain("safe-area-inset-bottom");
    expect(panel.className).toContain("[padding-right:env(safe-area-inset-right)]");
  });
});

// WHERE THE LISTENER LIVES IS THE WHOLE FEATURE. The body of this sheet holds a cross-document
// iframe framed into an opaque origin; touches that begin inside it dispatch in that document and
// never reach us. Attaching the drag to the panel — which is exactly what ui/sheet.tsx's BottomSheet
// does, and the obvious thing to copy — produces a listener that never fires for any finger landing
// on the page being read, and jsdom would never notice: it looks correct, and it is dead on glass.
describe("RightSheet — the drag lives on the header, outside the framed document", () => {
  it("keeps the grab region clear of the body that holds the framed document", () => {
    const { container } = render(
      <RightSheet open onClose={vi.fn()} title="Notes">
        {/* `sandbox=""` because that is what the real caller passes: the document is agent-written
            HTML served from Collie's own origin, so it is framed into an opaque origin with no
            script — see muxLogoResponse in bridge/server.ts for the same technique. */}
        <iframe title="doc" sandbox="" />
      </RightSheet>,
    );
    const grab = container.querySelector('[data-slot="right-sheet-grab"]')!;
    expect(grab.contains(screen.getByTitle("doc"))).toBe(false);
  });

  it("registers touchmove on the header NON-passively, so the gesture can suppress the browser's own pan", () => {
    // A passive listener cannot call preventDefault(). If this regressed to the default, a rightward
    // drag would race the browser's horizontal overscroll instead of owning the axis it claimed.
    const seen: { el: unknown; type: string; options: unknown }[] = [];
    const original = Element.prototype.addEventListener;
    const spy = vi
      .spyOn(Element.prototype, "addEventListener")
      .mockImplementation(function (
        this: Element,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        seen.push({ el: this, type, options });
        original.call(this, type, listener, options);
      });
    const { container } = render(
      <RightSheet open onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    spy.mockRestore();

    const grab = container.querySelector('[data-slot="right-sheet-grab"]')!;
    const panel = container.querySelector('div[tabindex="-1"]')!;
    const onGrab = seen.filter((r) => r.type === "touchmove" && r.el === grab);
    expect(onGrab).toHaveLength(1);
    expect(onGrab[0]!.options).toEqual({ passive: false });
    // ...and nothing was attached to the panel, whose lower half is the iframe.
    expect(seen.some((r) => r.type === "touchmove" && r.el === panel)).toBe(false);
  });

  it("declares the same arbitration to the browser that the JS enforces", () => {
    // touch-action: pan-y says "horizontal is mine, vertical is yours" before the first move, so the
    // browser never has to start a pan and then be told to stop.
    const { container } = render(
      <RightSheet open onClose={vi.fn()} title="Notes">
        body
      </RightSheet>,
    );
    const grab = container.querySelector('[data-slot="right-sheet-grab"]')!;
    expect(grab.className).toContain("[touch-action:pan-y]");
  });
});

// The axis rule, as a decision table. The failure it prevents is the diagonal ambush: a finger that
// is mostly scrolling but drifts sideways, or a genuine dismiss drag that wobbles vertical
// mid-travel. Deciding once and latching is what stops the panel flickering between "following the
// thumb" and "letting go" inside a single gesture.
describe("claimAxis", () => {
  it("stays undecided inside the slop circle, so a tap is never a drag", () => {
    expect(claimAxis("undecided", SLOP, SLOP)).toBe("undecided");
    expect(claimAxis("undecided", 0, 0)).toBe("undecided");
  });

  it("claims a dominant rightward move", () => {
    expect(claimAxis("undecided", 40, 5)).toBe("dismiss");
    expect(claimAxis("undecided", 40, -5)).toBe("dismiss");
  });

  it("declines a vertical-dominant move — that finger is scrolling the document", () => {
    expect(claimAxis("undecided", 10, 40)).toBe("declined");
    expect(claimAxis("undecided", 10, -40)).toBe("declined");
  });

  it("declines a leftward move — this sheet only leaves to the right", () => {
    expect(claimAxis("undecided", -40, 0)).toBe("declined");
  });

  it("declines a dead-even diagonal: a tie goes to the axis the browser was already panning", () => {
    expect(claimAxis("undecided", 40, 40)).toBe("declined");
    expect(claimAxis("undecided", 40, -40)).toBe("declined");
  });

  it("latches a declined gesture, even if the finger later turns hard right", () => {
    // Without the latch, a vertical flick that curves right at the end yanks the panel sideways.
    expect(claimAxis("declined", 200, 0)).toBe("declined");
  });

  it("latches a claimed gesture, even if the finger later goes vertical", () => {
    // Without the latch, a rightward drag that wobbles drops the panel back mid-flight.
    expect(claimAxis("dismiss", 0, 200)).toBe("dismiss");
  });
});

// The release rule. Same shape as `shouldOpen` in hooks/use-sheet-pull.ts because it is the same
// question on the other axis: far enough, OR fast enough.
describe("shouldDismiss", () => {
  it("snaps back after a short, slow drag", () => {
    expect(shouldDismiss(40, 0.1)).toBe(false);
  });

  it("dismisses once the drag reaches DISMISS_PX, regardless of speed", () => {
    expect(shouldDismiss(DISMISS_PX, 0)).toBe(true);
  });

  it("dismisses on a short drag that is a fast fling", () => {
    expect(shouldDismiss(SLOP + 1, FLING_PX_PER_MS)).toBe(true);
  });

  it("a fling under SLOP still doesn't dismiss — that's noise, not a drag", () => {
    // A stationary finger reports a jittery velocity; without the travel floor it would throw the
    // panel off screen while the operator was only resting a thumb on the header.
    expect(shouldDismiss(SLOP, 10)).toBe(false);
  });

  it("never dismisses on a leftward (zero-travel) release", () => {
    expect(shouldDismiss(0, 5)).toBe(false);
  });
});
