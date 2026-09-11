import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import {
  HANDOFF_SUMMARY_PROMPT,
  SUMMARY_START_TIMEOUT_MS,
  SUMMARY_TOTAL_TIMEOUT_MS,
  SUMMARY_WAIT_START,
  handoffTargets,
  summaryStep,
  type SummaryWait,
} from "@/lib/handoff";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { AgentStatus, AgentView, ArtifactView, Launcher } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK — hand this pane's conversation to another harness (bridge/handoff.ts, lib/handoff.ts).
//
// Three taps: who takes over (a launcher row), what they should do, and whether to ask the current
// agent for its own summary first. The summary is the expensive, valuable step — the agent that did
// the work is the only one who knows what it did — so it is on by default and the sheet WAITS for it:
// the ask is sent as an ordinary reply, and the handoff fires when the pane has been seen working
// and is not any more (lib/handoff.ts `summaryStep`). Two timers keep a pane that never turns
// `working`, or never stops, from holding the sheet forever; a "hand off now" button lets the
// operator skip the rest of a summary they have watched enough of.
//
// A `drawer` arm in agent-chat.tsx like every other sheet there. On success the caller navigates
// into the new pane; the document itself is one of this pane's artifacts from then on.

type Stage = "form" | "summary" | "launching" | "failed";

const INSTRUCTION_MAX = 4000;

export function HandoffSheet({
  open,
  onClose,
  pane,
  status,
  scope,
  launchers,
  onLaunched,
}: {
  open: boolean;
  onClose: () => void;
  pane: AgentView;
  /** The pane's live status — what the summary wait reads. */
  status: AgentStatus | undefined;
  scope?: Scope;
  launchers: readonly Launcher[];
  onLaunched: (paneId: string, artifact: ArtifactView) => void;
}) {
  useLocale();
  const targets = handoffTargets(launchers, pane.agent);
  const [target, setTarget] = useState<string>("");
  const [instruction, setInstruction] = useState("");
  const [askSummary, setAskSummary] = useState(true);
  const [stage, setStage] = useState<Stage>("form");
  const [error, setError] = useState("");
  const wait = useRef<SummaryWait>(SUMMARY_WAIT_START);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const fired = useRef(false);

  // A fresh open is a fresh form: a failed attempt's message would otherwise greet the next one.
  useEffect(() => {
    if (!open) return;
    setStage("form");
    setError("");
    fired.current = false;
    wait.current = SUMMARY_WAIT_START;
  }, [open]);
  useEffect(() => () => clearTimers(), []);

  const chosen = targets.find((row) => row.command === target) ?? targets[0];

  function clearTimers() {
    for (const handle of timers.current) clearTimeout(handle);
    timers.current = [];
  }

  async function fire() {
    if (fired.current || chosen === undefined) return;
    fired.current = true;
    clearTimers();
    setStage("launching");
    try {
      const res = await api.handoffPane(pane.paneId, chosen.command, instruction.trim(), scope);
      if (!res.ok) {
        setError(describeApiError(res));
        setStage("failed");
        fired.current = false;
        return;
      }
      onLaunched(res.pane.paneId, res.artifact);
      onClose();
    } catch (thrown) {
      setError(describeThrownError(thrown));
      setStage("failed");
      fired.current = false;
    }
  }

  // The wait itself: every status the pane reports while the summary is being written goes through
  // the one rule in lib/handoff.ts; a settle fires the handoff.
  useEffect(() => {
    if (stage !== "summary") return;
    const step = summaryStep(wait.current, status);
    wait.current = step.next;
    if (step.settled) void fire();
    // `fire` closes over the current form; it is the effect's own action, not a dependency to track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, status]);

  async function submit() {
    if (chosen === undefined) return;
    setError("");
    if (!askSummary) {
      await fire();
      return;
    }
    setStage("summary");
    wait.current = SUMMARY_WAIT_START;
    try {
      const sent = await api.sendReply(pane.paneId, HANDOFF_SUMMARY_PROMPT, true, scope);
      if (!sent.ok) {
        setError(describeApiError(sent));
        setStage("failed");
        return;
      }
    } catch (thrown) {
      setError(describeThrownError(thrown));
      setStage("failed");
      return;
    }
    // A pane that never turns `working` hands off with what there is; one that never stops does too.
    timers.current.push(
      setTimeout(() => {
        if (!wait.current.sawWorking) void fire();
      }, SUMMARY_START_TIMEOUT_MS),
      setTimeout(() => void fire(), SUMMARY_TOTAL_TIMEOUT_MS),
    );
  }

  const busy = stage === "summary" || stage === "launching";
  return (
    <BottomSheet open={open} onClose={onClose} title={t("handoff.sheet.title")}>
      <div data-slot="handoff-sheet" className="flex flex-col gap-3 px-1 pb-2">
        {targets.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t("handoff.noTargets")}</p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("handoff.target.label")}</span>
              <div role="radiogroup" aria-label={t("handoff.target.label")} className="flex flex-wrap gap-1.5">
                {targets.map((row) => {
                  const on = row.command === chosen?.command;
                  return (
                    <button
                      key={row.command}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={busy}
                      onClick={() => setTarget(row.command)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-sm transition-colors",
                        on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground",
                      )}
                    >
                      {row.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{t("handoff.instruction.label")}</span>
              <textarea
                value={instruction}
                disabled={busy}
                onChange={(e) => setInstruction(e.target.value.slice(0, INSTRUCTION_MAX))}
                rows={3}
                placeholder={t("handoff.instruction.placeholder")}
                className="min-h-20 rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={askSummary}
                disabled={busy}
                onChange={(e) => setAskSummary(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t("handoff.summary.label", { agent: pane.agent })}</span>
            </label>
            <p className="-mt-2 pl-6 text-xs text-muted-foreground">{t("handoff.summary.hint")}</p>
            {stage === "failed" && error !== "" && (
              <p role="alert" className="text-sm text-destructive">
                {t("handoff.failed", { reason: error })}
              </p>
            )}
            {stage === "summary" && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t("handoff.stage.summary", { agent: pane.agent })}
              </p>
            )}
            {stage === "launching" && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t("handoff.stage.launch", { label: chosen?.label ?? "" })}
              </p>
            )}
            <div className="flex gap-2">
              {stage === "summary" ? (
                <Button className="flex-1" variant="outline" onClick={() => void fire()}>
                  {t("handoff.button.now")}
                </Button>
              ) : (
                <Button className="flex-1" disabled={busy || chosen === undefined} onClick={() => void submit()}>
                  <ArrowRightLeft className="size-4" aria-hidden />
                  {t("handoff.button", { label: chosen?.label ?? "" })}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
