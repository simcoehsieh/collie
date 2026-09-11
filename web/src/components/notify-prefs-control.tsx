import { BellRing, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useNotifyPrefs, type NotifySwitch } from "@/hooks/use-notify-prefs";
import { useLocale } from "@/hooks/use-locale";
import { clockTime } from "@/lib/format";
import { t, type MessageKey } from "@/lib/i18n";
import {
  orphanRules,
  ownRule,
  ruleFor,
  ruleSnoozed,
  withMode,
  withSnooze,
  without,
} from "@/lib/notify-rules";
import { cn } from "@/lib/utils";
import { paneDisplayName, type AgentView, type PaneNotifyMode, type PaneNotifyRule } from "@/lib/types";

// Which lifecycle events are worth a push. Bridge-wide (fans out to every device, like the snooze),
// so the copy says so. Three switches: "Needs input" (blocked, default on), "Finished" (done,
// default off), and "App updates" (updates, default on). Optimistic toggle with revert on failure —
// see useNotifyPrefs.
//
// FORK: beneath the switches, one row per open agent pane with its own override (Default / All /
// Needs input / Mute) and a one-hour snooze. Rules are matched the way the bridge matches them
// (lib/notify-rules.ts), so a row shows what will actually happen to that pane; a rule left over
// from a pane that closed is listed as "not open" with a remove button, so nothing lingers unseen.

const ROWS: ReadonlyArray<{ key: NotifySwitch; labelKey: MessageKey; hintKey: MessageKey }> = [
  { key: "blocked", labelKey: "settings.notify.blocked.label", hintKey: "settings.notify.blocked.hint" },
  { key: "done", labelKey: "settings.notify.done.label", hintKey: "settings.notify.done.hint" },
  {
    key: "updates",
    labelKey: "settings.notify.updates.label",
    hintKey: "settings.notify.updates.hint",
  },
];

const MODES: ReadonlyArray<{ mode: PaneNotifyMode; labelKey: MessageKey }> = [
  { mode: "default", labelKey: "settings.notify.panes.mode.default" },
  { mode: "all", labelKey: "settings.notify.panes.mode.all" },
  { mode: "blocked", labelKey: "settings.notify.panes.mode.blocked" },
  { mode: "mute", labelKey: "settings.notify.panes.mode.mute" },
];

/** How long a per-pane snooze lasts. One preset: the row is a quick mute, the global card has the ladder. */
const PANE_SNOOZE_MS = 60 * 60_000;

/** A stable empty roster, so a caller that passes nothing does not hand a fresh array per render. */
const NO_PANES: readonly AgentView[] = [];

export function NotifyPrefsControl({ panes = NO_PANES }: { panes?: readonly AgentView[] }) {
  useLocale();
  const { prefs, busy, toggle, setPanes } = useNotifyPrefs();
  const rules = prefs?.panes ?? [];
  // FORK: the operator's `notify.toml` rules — matched after the phone's, exactly as the bridge
  // does, so the mode a row shows is the mode the bridge will apply. Never edited from here.
  const operator = prefs?.operatorPanes ?? [];
  const applied = [...rules, ...operator];
  const agentPanes = panes.filter((p) => p.kind !== "shell");
  const orphans = prefs ? orphanRules(rules, agentPanes) : [];

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <BellRing className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.notify.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.notify.description")}</p>
          </div>
        </div>
        {!prefs && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {/* Rendered before `prefs` lands, not after. ROWS is static, so the card's SHAPE is known from
          the first frame — only the switch values are pending. Gating the whole list on `prefs` grew
          this card by ~180px a moment after paint and pushed the rest of the page down with it. The
          switches stay disabled until the real values arrive, so nothing can be toggled from a
          placeholder state. */}
      {ROWS.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between gap-4 border-t border-border px-4 py-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{t(row.labelKey)}</div>
              <p className="text-xs text-muted-foreground">{t(row.hintKey)}</p>
            </div>
            <Switch
              checked={prefs?.[row.key] ?? false}
              disabled={busy || !prefs}
              onCheckedChange={(next) => void toggle(row.key, next)}
              aria-label={t(row.labelKey)}
            />
          </div>
      ))}

      {/* FORK: per-pane overrides. The section is always drawn (same no-jump argument as above);
          its rows come from the snapshot the settings page already holds. */}
      <div data-slot="notify-panes" className="border-t border-border px-4 py-3">
        <div className="text-sm font-medium">{t("settings.notify.panes.title")}</div>
        <p className="text-xs text-muted-foreground">{t("settings.notify.panes.hint")}</p>
        {agentPanes.length === 0 && orphans.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">{t("settings.notify.panes.empty")}</p>
        )}
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {agentPanes.map((pane) => {
            const hit = ruleFor(applied, pane);
            return (
              <PaneRuleRow
                key={pane.paneId}
                pane={pane}
                rule={hit}
                own={ownRule(rules, pane) !== null}
                fromFile={hit !== null && operator.includes(hit)}
                disabled={busy || !prefs}
                onMode={(mode) => void setPanes(withMode(rules, pane, mode))}
                onSnooze={(until) => void setPanes(withSnooze(rules, pane, until))}
              />
            );
          })}
          {orphans.map((rule, i) => (
            <OrphanRuleRow
              key={`${rule.paneId ?? ""}|${rule.label ?? ""}|${i}`}
              rule={rule}
              disabled={busy}
              onRemove={() => void setPanes(without(rules, rule))}
            />
          ))}
        </ul>
      </div>
    </Card>
  );
}

function PaneRuleRow({
  pane,
  rule,
  own,
  fromFile,
  disabled,
  onMode,
  onSnooze,
}: {
  pane: AgentView;
  /** The rule the bridge will apply — the pane's own, or a label hit on another's. */
  rule: PaneNotifyRule | null;
  /** Whether that rule names this pane by id (an edit changes it) vs. a label hit (an edit adds one). */
  own: boolean;
  /** FORK: the rule came from the operator's `notify.toml`; an edit here adds a phone rule that wins. */
  fromFile: boolean;
  disabled: boolean;
  onMode: (mode: PaneNotifyMode) => void;
  onSnooze: (until: number | null) => void;
}) {
  const mode: PaneNotifyMode = rule?.mode ?? "default";
  const snoozed = ruleSnoozed(rule);
  const name = paneDisplayName(pane);
  const where = pane.workspaceLabel !== name ? pane.workspaceLabel : null;
  return (
    <li className="flex flex-col gap-2 py-2.5" data-pane={pane.paneId}>
      <div className="flex min-w-0 items-baseline gap-1 text-sm">
        <span className="min-w-0 truncate font-medium">{name}</span>
        {where !== null && <span className="min-w-0 shrink truncate text-xs text-muted-foreground">· {where}</span>}
        {rule !== null && !own && (
          /* A label hit: the row inherits another rule's mode; the rule's own text says which — and
             FORK: whose it is, when the operator's file wrote it. */
          <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
            {fromFile ? t("settings.notify.panes.fromFile", { label: rule.label ?? rule.paneId ?? "" }) : `“${rule.label}”`}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={name}>
        {MODES.map((m) => (
          <Button
            key={m.mode}
            size="sm"
            variant={m.mode === mode ? "secondary" : "outline"}
            role="radio"
            aria-checked={m.mode === mode}
            disabled={disabled}
            className={cn("h-7 px-2.5 text-xs", m.mode === mode && "ring-1 ring-ring")}
            onClick={() => onMode(m.mode)}
          >
            {t(m.labelKey)}
          </Button>
        ))}
        {snoozed ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            className="h-7 px-2 text-xs"
            onClick={() => onSnooze(null)}
            aria-label={`${t("settings.notify.panes.snoozed", { time: clockTime(rule!.snoozedUntil!) })} — ${t("settings.notify.panes.resume")}`}
          >
            {t("settings.notify.panes.snoozed", { time: clockTime(rule!.snoozedUntil!) })} · {t("settings.notify.panes.resume")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            className="h-7 px-2 text-xs"
            onClick={() => onSnooze(Date.now() + PANE_SNOOZE_MS)}
          >
            {t("settings.notify.panes.snooze")}
          </Button>
        )}
      </div>
    </li>
  );
}

function OrphanRuleRow({
  rule,
  disabled,
  onRemove,
}: {
  rule: PaneNotifyRule;
  disabled: boolean;
  onRemove: () => void;
}) {
  const label = rule.label ?? rule.paneId ?? "";
  const modeKey = MODES.find((m) => m.mode === rule.mode)?.labelKey ?? "settings.notify.panes.mode.default";
  return (
    <li className="flex items-center gap-2 py-2.5 text-sm" data-orphan-rule>
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        · {t(modeKey)} · {t("settings.notify.panes.gone")}
      </span>
      <Button
        size="icon"
        variant="ghost"
        disabled={disabled}
        className="ml-auto size-7"
        onClick={onRemove}
        aria-label={`${t("settings.notify.panes.remove")}: ${label}`}
      >
        <X />
      </Button>
    </li>
  );
}
