import { useId } from "react";

import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";
import { AGENT_BRANDS } from "@/components/agent-icon-data";

// Resolve a Herdr-detected agent name (`pane.agent`) to a brand key, tolerating variants like
// "claude-code" / "opencode-dev". Mirrors the matching in lib/agent-commands.ts.
function brandKey(agent: string): string | undefined {
  const k = agent.toLowerCase().trim();
  if (AGENT_BRANDS.has(k)) return k;
  if (k.startsWith("claude")) return "claude";
  if (k.startsWith("codex")) return "codex";
  if (k.startsWith("opencode")) return "opencode";
  if (k === "pi" || k.startsWith("pi-") || k.startsWith("pi.")) return "pi";
  // Bare prefix, exactly as canonicalAgent folds it (lib/operator-scope.ts): `omp` is its own
  // prefix, and the `pi` rule above must not claim it — oh-my-pi is not pi.dev.
  if (k.startsWith("omp")) return "omp";
  if (k === "agy" || k.startsWith("agy-") || k.startsWith("agy.") || k.startsWith("antigravity")) return "agy";
  return undefined;
}

/**
 * A square "app icon" tile for an agent, rendered as inline SVG (CSP-safe, theme-independent — the
 * tile carries its own brand background so the mark reads on any UI theme). Falls back to a neutral
 * monogram tile — the SAME svg, the same viewBox, the same `rx` — for agents we don't have a logo
 * for, so a roster reads as one system rather than as a pile of logos. Size comes from `className`
 * (e.g. `size-9`), and the shape holds at every one of them because the radius is drawn in the
 * tile's own units.
 */
export function AgentIcon({
  agent,
  className,
}: {
  agent: string | null | undefined;
  className?: string;
}) {
  const brand = agent ? AGENT_BRANDS.get(brandKey(agent) ?? "") : undefined;
  // One id per mounted tile, sanitised the way collie-mark.tsx does it and for the same two
  // reasons: an id inside an inline SVG is DOCUMENT-scoped, so a dashboard column of tiles would
  // otherwise name one gradient and let the first render win; and React's own id carries glyphs a
  // `url(#…)` reference has no business quoting once a CSS context gets hold of it.
  const gradId = `agent-icon-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  if (!brand) {
    // FORK — THE FALLBACK IS THE SAME TILE, NOT A DIFFERENT COMPONENT.
    //
    // It was an HTML `<span>` with `rounded-md` and a border, and at the sizes this is actually
    // drawn at that is not a squircle: `--radius-md` is a CONSTANT, so on a 16px tile it rounds
    // nearly to a circle while the SVG brands beside it keep `rx="5.3"` of a 24-unit box — 22% of
    // whatever they are drawn at. One column therefore held orange squircles, black squircles and a
    // grey CIRCLE with letters in it, which reads as a different component rather than a roster.
    //
    // So the monogram is drawn the same way the brands are: same viewBox, same `rx`, same inset, so
    // the shape is identical at every size by construction and cannot drift again. The border goes
    // with it — no brand tile has one, and an edge on only the unknown agents is the same "this one
    // is different" claim in a second channel. `--muted` / `--muted-foreground` because an agent we
    // have no mark for should be quiet, not invented.
    return (
      <svg
        viewBox="0 0 24 24"
        className={cn("shrink-0", className)}
        role="img"
        aria-label={agent ? `${agent} icon` : "agent icon"}
      >
        <rect width="24" height="24" rx="5.3" fill="var(--muted)" />
        <text
          x="12"
          y="12"
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--muted-foreground)"
          fontSize="11"
          fontWeight="600"
          letterSpacing="0.3"
        >
          {initials(agent ?? "")}
        </text>
      </svg>
    );
  }

  // ARTWORK, not a path — the same tile, the same inset, the same accessible name, so nothing about
  // this component's contract changes for the one brand that has no vector source to take a path
  // from (agent-icon-data.ts says why). `<image>` inside the SVG rather than a sibling `<img>`: the
  // tile stays one element with one role, and the mark inherits the padding every other logo gets.
  if (brand.kind === "image") {
    return (
      <svg
        viewBox="0 0 24 24"
        className={cn("shrink-0", className)}
        role="img"
        aria-label={`${agent} logo`}
      >
        <rect width="24" height="24" rx="5.3" fill={brand.bg} />
        <image
          href={brand.src}
          x="4.6"
          y="4.6"
          width="14.8"
          height="14.8"
          preserveAspectRatio="xMidYMid meet"
        />
      </svg>
    );
  }

  const stroke = brand.mode === "stroke";
  // A local, not `brand.grad` inline: narrowing survives into the map callback, so the stops need no
  // non-null assertion. omp's official mark is a gradient, so its paint is a fragment reference.
  const grad = brand.grad;
  const paint = grad ? `url(#${gradId})` : brand.fg;
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("shrink-0", className)}
      role="img"
      aria-label={`${agent} logo`}
    >
      {grad && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            {grad.map((stop, i) => (
              <stop key={stop + i} offset={i / (grad.length - 1)} stopColor={stop} />
            ))}
          </linearGradient>
        </defs>
      )}
      <rect width="24" height="24" rx="5.3" fill={brand.bg} />
      {/* Inset the 24×24 mark to ~62% so every logo carries uniform app-icon padding. */}
      <g
        transform="translate(4.6 4.6) scale(0.617)"
        fill={stroke ? "none" : paint}
        stroke={stroke ? paint : undefined}
        strokeWidth={stroke ? 2 : undefined}
        strokeLinecap={stroke ? "square" : undefined}
      >
        <path d={brand.d} />
      </g>
    </svg>
  );
}
