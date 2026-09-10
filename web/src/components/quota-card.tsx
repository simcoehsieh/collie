import { memo, useCallback, useEffect, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { countdownParts, secondsUntil, usageTone, useQuota, type UsageTone } from "@/lib/quota";
import type { QuotaAgent, QuotaAgentKey, QuotaModel, QuotaWindow } from "@/lib/types";
import { cn } from "@/lib/utils";

// FORK: the dashboard's usage section — what each of the three agents has left.
//
// One row per agent, always the same three in the same order (the bridge guarantees that, so the
// section never reflows as providers come and go), and on each row the two numbers that decide
// whether to start something now: the rolling five hours and the week. Everything else a provider
// reports — agy's four cross-product windows, codex's per-model quotas, a balance — is behind a
// tap on the row, because it is worth having and not worth the height.
//
// The countdown is computed HERE from `resetAt`, once a minute, rather than read off the body: the
// bridge serves a body up to a minute old and the phone re-reads every five, and a "3h 43m" that
// only moved when a request happened to land would read as stuck.

/** The bar's fill by how full it is — the theme's own status hues, never a hex. */
const TONE = {
  ok: "bg-primary",
  warn: "bg-status-working",
  high: "bg-status-blocked",
} satisfies Record<UsageTone, string>;

/** Once a minute, so a countdown ticks without a request. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** "3h 43m" / "5d 15h" / "12m" from the seconds left, in the locale's spelling. */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return t("quota.resetNow");
  const { days, hours, minutes } = countdownParts(seconds);
  if (days > 0) return t("quota.time.days", { d: days, h: hours });
  if (hours > 0) return t("quota.time.hours", { h: hours, m: minutes });
  return t("quota.time.minutes", { m: Math.max(1, minutes) });
}

function Bar({ label, window, now, compact }: { label: string; window: QuotaWindow | null; now: number; compact?: boolean }) {
  if (window === null) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
          <span className="truncate">{label}</span>
          <span aria-hidden>—</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-muted" />
      </div>
    );
  }
  const seconds = secondsUntil(window.resetAt, now) ?? window.resetAfterSeconds;
  const tone = usageTone(window.usedPercent);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className={cn("shrink-0 tabular-nums font-medium", tone === "high" && "text-status-blocked")}>
          {t("quota.used", { percent: window.usedPercent })}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent}
        aria-label={label}
      >
        <div className={cn("h-full rounded-full", TONE[tone])} style={{ width: `${window.usedPercent}%` }} />
      </div>
      {!compact && seconds !== null && (
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {t("quota.reset", { time: formatCountdown(seconds) })}
        </span>
      )}
    </div>
  );
}

function ModelRow({ model }: { model: QuotaModel }) {
  const tone = usageTone(model.usedPercent);
  return (
    <li className="flex items-center gap-2 text-[11px]">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{model.label}</span>
      <span className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cn("block h-full rounded-full", TONE[tone])} style={{ width: `${model.usedPercent}%` }} />
      </span>
      <span className="w-10 shrink-0 text-right tabular-nums">{t("quota.used", { percent: model.usedPercent })}</span>
    </li>
  );
}

const QuotaRow = memo(function QuotaRow({
  agent,
  now,
  expanded,
  onToggle,
}: {
  agent: QuotaAgent;
  now: number;
  expanded: boolean;
  onToggle: (key: QuotaAgentKey) => void;
}) {
  const five = agent.windows.find((w) => w.kind === "5h") ?? null;
  const weekly = agent.windows.find((w) => w.kind === "weekly") ?? null;
  const others = agent.windows.filter((w) => w.kind === "other");
  const hasMore = others.length > 0 || (agent.models?.length ?? 0) > 0 || agent.credits !== undefined;
  const bodyId = `quota-${agent.key}-more`;

  if (agent.status !== "ok") {
    return (
      <div className="flex items-center gap-2.5 px-3.5 py-2.5" data-testid={`quota-row-${agent.key}`}>
        <AgentIcon agent={agent.name} className="size-6 opacity-60" />
        <span className="font-medium">{agent.name}</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
          {agent.status === "missing" ? t("quota.missing") : (agent.error ?? t("quota.error"))}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col" data-testid={`quota-row-${agent.key}`}>
      <button
        type="button"
        onClick={() => hasMore && onToggle(agent.key)}
        aria-expanded={hasMore ? expanded : undefined}
        aria-controls={hasMore ? bodyId : undefined}
        aria-label={t("quota.row.aria", { agent: agent.name })}
        className={cn(
          "flex w-full flex-col gap-2 px-3.5 py-2.5 text-left transition-colors",
          hasMore && "active:bg-muted/60",
        )}
      >
        <div className="flex items-center gap-2.5">
          <AgentIcon agent={agent.name} className="size-6" />
          <span className="font-medium">{agent.name}</span>
          {agent.plan && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{agent.plan}</span>}
          {hasMore && (
            <ChevronRight
              className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
              aria-hidden
            />
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Bar label={t("quota.window.5h")} window={five} now={now} />
          <Bar label={t("quota.window.weekly")} window={weekly} now={now} />
        </div>
      </button>
      {hasMore && expanded && (
        <div id={bodyId} className="flex flex-col gap-2.5 border-t border-border/60 px-3.5 py-2.5">
          {others.map((w) => (
            <Bar key={w.label} label={w.label} window={w} now={now} />
          ))}
          {agent.models && agent.models.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t("quota.models")}</span>
              <ul className="flex flex-col gap-1">
                {agent.models.map((m) => (
                  <ModelRow key={m.label} model={m} />
                ))}
              </ul>
            </div>
          )}
          {agent.credits !== undefined && (
            <span className="text-[11px] text-muted-foreground">{t("quota.credits", { credits: agent.credits })}</span>
          )}
        </div>
      )}
    </div>
  );
});

export function QuotaCard({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useLocale();
  const { data, error, refreshing, refresh } = useQuota();
  const now = useMinuteTick();
  const [expanded, setExpanded] = useState<QuotaAgentKey | null>(null);
  const toggle = useCallback((key: QuotaAgentKey) => setExpanded((cur) => (cur === key ? null : key)), []);

  return (
    <section className="flex flex-col gap-2 px-4 py-4" data-slot="quota">
      <SectionHeader
        label={t("quota.title")}
        open={open}
        onToggle={onOpenChange}
        controls="quota-body"
        trailing={
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label={t("quota.refresh.aria")}
            aria-busy={refreshing}
            className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-100"
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
          </button>
        }
      />
      {open && (
        <ListGroup id="quota-body">
          {data === null ? (
            <p className="px-3.5 py-2.5 text-xs text-muted-foreground">{error ?? t("quota.loading")}</p>
          ) : (
            data.agents.map((agent) => (
              <QuotaRow key={agent.key} agent={agent} now={now} expanded={expanded === agent.key} onToggle={toggle} />
            ))
          )}
          {data !== null && error !== null && (
            <p className="px-3.5 py-2 text-[11px] text-muted-foreground">{error}</p>
          )}
        </ListGroup>
      )}
    </section>
  );
}
