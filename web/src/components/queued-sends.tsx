import { useState } from "react";
import { Clock, Loader2, Send, Trash2 } from "lucide-react";

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
          {t("queue.title")}
        </p>
        <ul className="mt-1 flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm">{row.text}</p>
                <p className="text-xs text-muted-foreground">
                  {timeAgoShort(row.queuedAt)}
                  {row.held !== undefined ? ` · ${row.held}` : row.kind === "answer" ? ` · ${t("queue.held")}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 px-2"
                disabled={busy !== null}
                onClick={() => void sendNow(row.id)}
                aria-label={t("queue.sendNow")}
              >
                {busy === row.id ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-muted-foreground"
                disabled={busy === row.id}
                onClick={() => discardSend(row.id)}
                aria-label={t("queue.discard")}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Collapse>
  );
}
