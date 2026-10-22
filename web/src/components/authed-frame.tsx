import { type CSSProperties, useEffect, useState } from "react";

import { fetchAuthedBytes } from "@/lib/api";

// FORK: A BRIDGE PAGE IN A FRAME, LOADED WITH THE PAIRING TOKEN (2026-10-22).
//
// The fork frames three kinds of page the bridge serves: an artifact (`/api/artifacts/<id>/raw`), a
// knowledge-base document (`/api/doc/<slug>`) and an HTML file an agent wrote (`/api/preview/file`).
// Each one used to be `<iframe src="/api/…">`. Since 1.18 (ADR 0086) every `/api` read needs the
// pairing token in an `Authorization` header, and a frame's own request cannot carry a header, so
// all three answered 403 "device not paired" inside the frame from the 1.19.2 merge on.
//
// The fix is upstream's for pictures (lib/authed-url.ts): fetch the bytes WITH the token, then hand
// the element what it needs without a second request. For a page that is `srcdoc`. The posture does
// not change: the frame stays `sandbox=""`, so the page runs no script, sits in an opaque origin and
// cannot reach the app's storage or its API. What changes is only who fetches the bytes.
//
// `data-src` keeps the bridge path on the element, for the tests and for a person reading the DOM.

type Load = { phase: "loading" } | { phase: "ready"; html: string } | { phase: "failed"; detail: string };

/** The page's text, fetched with the pairing token. A new `nonce` fetches again (Reload). */
export function useAuthedText(path: string | null, nonce = 0): Load {
  const [state, setState] = useState<Load>({ phase: "loading" });
  useEffect(() => {
    if (path === null) return;
    const ctl = new AbortController();
    setState({ phase: "loading" });
    void (async () => {
      try {
        const blob = await fetchAuthedBytes(path, ctl.signal);
        const html = await blob.text();
        if (!ctl.signal.aborted) setState({ phase: "ready", html });
      } catch (err) {
        if (!ctl.signal.aborted) setState({ phase: "failed", detail: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => ctl.abort();
  }, [path, nonce]);
  return state;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** What the frame shows when the bytes could not be had: one line, in the frame's own place. */
function failurePage(detail: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;color:#5f6c80;padding:24px">${escapeHtml(detail)}</body>`;
}

export function AuthedFrame({
  path,
  nonce = 0,
  title,
  className,
  style,
}: {
  path: string;
  nonce?: number;
  title: string;
  className?: string;
  style?: CSSProperties;
}) {
  const load = useAuthedText(path, nonce);
  const doc = load.phase === "ready" ? load.html : load.phase === "failed" ? failurePage(load.detail) : "";
  return (
    <iframe
      // `sandbox=""` withholds every capability: no scripts, no forms, no popups, no same-origin.
      sandbox=""
      srcDoc={doc}
      data-src={path}
      data-phase={load.phase}
      title={title}
      className={className}
      style={style}
    />
  );
}

/**
 * A page for a new tab that holds only a sandboxed frame of `html`. The wrapper is a blob URL of the
 * app's own origin, so it carries no script of its own: everything the page brings runs inside the
 * `sandbox=""` frame, exactly as in the panel.
 */
function sandboxedTabUrl(html: string, title: string): string {
  const srcdoc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const wrapper =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>` +
    `<iframe sandbox="" srcdoc="${srcdoc}"></iframe>`;
  return URL.createObjectURL(new Blob([wrapper], { type: "text/html" }));
}

/**
 * Open a bridge page in a new tab, with the pairing token. The tab opens at once (inside the tap, so
 * no popup blocker refuses it) and is pointed at the page when the bytes arrive. HTML and SVG open in
 * a sandboxed wrapper; anything else opens as its own bytes.
 */
export function openAuthedTab(path: string, title: string): void {
  const tab = window.open("", "_blank") ?? null;
  if (tab !== null) tab.opener = null;
  void (async () => {
    try {
      const blob = await fetchAuthedBytes(path);
      const page = /html|svg|xml/i.test(blob.type) ? sandboxedTabUrl(await blob.text(), title) : URL.createObjectURL(blob);
      if (tab !== null) tab.location.replace(page);
      else window.open(page, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(page), 60_000);
    } catch {
      tab?.close();
    }
  })();
}
