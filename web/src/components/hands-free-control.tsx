import { Volume2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { setReadAloudEnabled, ttsSupported, useReadAloud } from "@/hooks/use-tts";

// FORK: THE READ-ALOUD ROW, ALONE (2026-10-22, at the 1.23 merge). This file was upstream's Settings
// hands-free card, and the fork hung its Read aloud switch under that card's switch (hooks/use-tts.ts).
// Upstream 1.20.0 folded the card into Settings → Voice (components/speech-control.tsx,
// `HandsFreeCard`) and deleted this file. The card is upstream's now; what is left here is the fork's
// row, drawn as a second row inside that card, which mounts it under its own hands-free switch.
//
// The other half of the hands-free loop — read each new reply aloud while hands-free is on. Only
// offered where the browser can speak; only ACTS while hands-free is on, which is why it sits under
// that switch rather than beside it, and is disabled while hands-free is off.
export function ReadAloudRow({ handsFree }: { handsFree: boolean }) {
  useLocale();
  const readAloud = useReadAloud();
  if (!ttsSupported()) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Volume2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("settings.readAloud.title")}</div>
          <p className="text-sm text-muted-foreground">{t("settings.readAloud.description")}</p>
        </div>
      </div>
      <div className="flex h-6 w-11 shrink-0 items-center justify-center">
        <Switch
          checked={readAloud}
          disabled={!handsFree}
          onCheckedChange={setReadAloudEnabled}
          aria-label={t("settings.readAloud.ariaLabel")}
        />
      </div>
    </div>
  );
}
