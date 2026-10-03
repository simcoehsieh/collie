import { useId, useState } from "react";
import { ChevronDown, ChevronUp, Clock, Loader2, Send, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { discardSend, drainSendQueue, useQueuedSends } from "@/lib/send-queue";

// FORK: the sends waiting for the link, drawn above the composer of the pane they belong to. Each
// row is the words, their age, the reason they are waiting when the pane refused them, and the two
// things the operator can do — send now, or let it go. The rows drain on their own when a poll
// proves the link live (lib/send-queue.ts); this is where that is visible, and where an `answer`
// or a held row gets the tap it needs.

interface QueuedSendsProps {
  paneId: string;
  scope?: Scope;
}

export function QueuedSends({ paneId, scope }: QueuedSendsProps) {
  useLocale();
  const rows = useQueuedSends(scope, paneId);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const fieldPrefix = useId();

  async function sendNow(id: string) {
    setBusy(id);
    try {
      await drainSendQueue({ force: id });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Collapse open={rows.length > 0}>
      <div data-slot="queued-sends" className="mx-3 mb-1 rounded-lg border border-status-working/40 bg-status-working/10 px-3 py-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Clock className="size-3" />
          {t("fork.queue.title")}
        </p>
        <ul className="mt-1 flex flex-col gap-1.5">
          {rows.map((row, index) => {
            const label = { number: index + 1, preview: queuePreview(row.text) };
            const fieldId = `${fieldPrefix}-${row.id}`;
            return (
              <li key={row.id} className="flex min-w-0 flex-col gap-1.5">
                <div className="min-w-0">
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-start gap-2 py-1 text-left"
                    aria-expanded={expanded === row.id}
                    aria-label={t(expanded === row.id ? "fork.queue.hideFullFor" : "fork.queue.showFullFor", label)}
                    aria-controls={expanded === row.id ? fieldId : undefined}
                    onClick={() => setExpanded((current) => current === row.id ? null : row.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block whitespace-pre-wrap break-words text-sm">
                        {expanded === row.id ? t("fork.queue.hideFull") : queuePreview(row.text)}
                      </span>
                      {expanded !== row.id && <span className="block text-xs text-muted-foreground">
                        {t("fork.queue.showFull")}
                      </span>}
                    </span>
                    {expanded === row.id ? <ChevronUp className="mt-1 size-4 shrink-0" /> : <ChevronDown className="mt-1 size-4 shrink-0" />}
                  </button>
                  {expanded === row.id && (
                    // Outside the button so its accessible name does not hide the message. A long
                    // message scrolls here, keeping the actions reachable on the phone.
                    <textarea
                      readOnly rows={8}
                      id={fieldId}
                      aria-label={t("fork.queue.fullTextFor", label)}
                      value={row.text}
                      className="max-h-48 w-full resize-none overflow-y-auto overscroll-contain bg-transparent text-sm focus-visible:outline-2 focus-visible:outline-ring"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {timeAgoShort(row.queuedAt)}
                    {row.possiblyDelivered ? ` · ${t("fork.queue.possiblyDelivered")}` :
                      row.held !== undefined ? ` · ${row.held}` : row.kind === "answer" ? ` · ${t("queue.held")}` : ""}
                  </p>
                  {row.possiblyDelivered && row.holdKind === "refused" && row.held !== undefined && (
                    <p className="text-xs text-muted-foreground">{row.held}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="lg"
                    variant="outline"
                    className="min-w-11 gap-1.5 px-3 text-sm"
                    disabled={busy !== null}
                    onClick={() => void sendNow(row.id)}
                    aria-label={t(row.possiblyDelivered ? "fork.queue.sendAgainFor" : "fork.queue.sendNowFor", label)}
                  >
                    {busy === row.id ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                    {t(row.possiblyDelivered ? "fork.queue.sendAgain" : "queue.sendNow")}
                  </Button>
                  <Button
                    size="lg"
                    variant="ghost"
                    className="min-w-11 px-3 text-sm text-muted-foreground"
                    disabled={busy === row.id}
                    onClick={() => discardSend(row.id)}
                    aria-label={t("fork.queue.discardFor", label)}
                  >
                    <Trash2 className="size-4" />
                    {t("queue.discard")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Collapse>
  );
}

/** Keep a small readable preview; expanding renders the untouched full message as React text. */
function queuePreview(text: string): string {
  const preview = Array.from(text.split("\n").slice(0, 2).join("\n")).slice(0, 160).join("");
  return preview === text ? text : `${preview}…`;
}
