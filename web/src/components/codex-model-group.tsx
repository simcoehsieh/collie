import { createContext, useContext, useEffect, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import type { EchoPhase } from "@/hooks/use-action-echo";
import * as api from "@/lib/api";
import { t as translate } from "@/lib/i18n";
import { tf } from "@/lib/i18n/fork-strings";
import { modelLabel, type ModelFacts } from "@/lib/model-label";
import { scopeKey, type Scope } from "@/lib/scope";
import type { CodexHandoffModel } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK — A CODEX PANE'S MODEL AND EFFORT, FROM THE QUICK DOCK (2026-09-26), FOLDED TO ONE ROW
// (survey round 3, 2026-10-03).
//
// Quick on a Codex pane used to open on this host's whole Codex catalog — eight models, two to a row,
// 40px each — ABOVE the operator's own phrases, so "commit and push" sat under two hundred pixels of a
// control used twice in four weeks (both on the day it shipped). It is now one row that says what the
// pane is on and opens in place: "Model / effort: gpt-6-astra·high ›". Tap it for the models, a model
// for its efforts, an effort to switch — the same two taps as before, the same bridge route, the same
// session-only `s` (bridge/codex-model.ts). And the row sits BELOW the operator's groups
// (quick-actions.tsx), where a rarely used control belongs.
//
// What the pane is on comes from the agent's own log (bridge/session-facts.ts → the snapshot's `model`
// and `effort`), handed down by the pane view through `CodexFactsContext` — the composer between them
// never needed the value and is not asked to carry it. A switch lands in the log with the pane's next
// turn, so the row can trail a pick by one turn; the dock closes on the pick's ✓ anyway.

/** The open pane's model and effort, as its own log last stated them. Null outside a pane view. */
export const CodexFactsContext = createContext<ModelFacts | null>(null);

/** The echo id of one model+effort pick — distinct from any reply text, which is never this shape. */
export const codexPickId = (model: string, effort: string) => `\u0000codex:${model}:${effort}`;

export function CodexModelGroup({
  scope,
  disabled,
  busy,
  phaseOf,
  onFire,
}: {
  scope?: Scope;
  disabled?: boolean;
  busy: boolean;
  phaseOf: (id: string) => EchoPhase;
  onFire: (model: string, effort: string) => void;
}) {
  const facts = useContext(CodexFactsContext);
  const [models, setModels] = useState<readonly CodexHandoffModel[] | null>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState("");
  const key = scopeKey(scope);
  useEffect(() => {
    let live = true;
    void api
      .fetchLaunchers(scope)
      .then((res) => {
        if (live) setModels(res.handoffModels ?? []);
        return undefined;
      })
      .catch(() => {
        if (live) setModels([]);
      });
    return () => {
      live = false;
    };
    // `scope` is keyed by value: a fresh object for the same scope must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // No catalog on this host: say nothing — the harness row's Model button still opens the picker.
  if (models !== null && models.length === 0) return null;
  const current = modelLabel(facts ?? {}) ?? tf("quick.codexModel.unknown");
  const model = models?.find((m) => m.id === chosen);

  return (
    <div data-slot="codex-model-group">
      {/* ONE ROW, then the picker in place — the shape of the "others" fold above it, a whole-width
          target that reads as a thing you press. */}
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="h-10 w-full justify-between gap-1.5 px-3 text-sm font-medium"
      >
        <span className="min-w-0 truncate">{tf("quick.codexModel.row", { current })}</span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </Button>
      <Collapse open={open}>
        {models === null ? (
          <p className="pt-2 text-xs text-muted-foreground">{translate("handoff.model.loading")}</p>
        ) : (
          <div className="pt-2">
            <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {translate("handoff.model.label")}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {models.map((m) => (
                <Button
                  key={m.id}
                  type="button"
                  variant={m.id === chosen ? "default" : "outline"}
                  aria-pressed={m.id === chosen}
                  disabled={disabled || busy}
                  onClick={() => setChosen((prev) => (prev === m.id ? "" : m.id))}
                  className="h-10 text-sm font-medium"
                >
                  {m.label}
                </Button>
              ))}
            </div>
            {model && (
              <>
                <p className="mb-1.5 mt-3 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {translate("handoff.effort.label")}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {model.efforts.map((effort) => {
                    const phase = phaseOf(codexPickId(model.id, effort));
                    return (
                      <Button
                        key={effort}
                        type="button"
                        variant={phase === "idle" ? "outline" : "default"}
                        disabled={disabled || busy}
                        onClick={() => onFire(model.id, effort)}
                        className={cn("h-12 gap-1.5 text-sm font-medium", phase !== "idle" && "disabled:opacity-100")}
                      >
                        {phase === "pending" && <Loader2 className="size-4 animate-spin" />}
                        {phase === "done" && <Check className="size-4" />}
                        {effort}
                      </Button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </Collapse>
    </div>
  );
}
