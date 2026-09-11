// DEV-ONLY entry. Paired with `web/playground.html`, which is not a build input — see that file's
// header and `playground-entry.test.ts`. No `lib/pwa` import here on purpose: the playground must
// never register a service worker, or it would start precaching a page that does not ship.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PlaygroundApp } from "./app";
import "@/index.css";
// FORK: and the skin, which is half the design. Without it this page — the one page whose whole job
// is "every UI state Collie can reach, on one page" — rendered without the blurred header, the
// chrome block's 24px corners and lift shadow, the composer's segmented trough, the mirror's own
// ground and well, the route entrance and the thin desktop scrollbars. Every design judgement made
// here was a judgement about a build nobody runs. Loaded AFTER index.css, which is the cascade order
// src/main.tsx uses and the order skin.css's own header depends on.
import "@/skin.css";
import "./playground.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <PlaygroundApp />
  </StrictMode>,
);
