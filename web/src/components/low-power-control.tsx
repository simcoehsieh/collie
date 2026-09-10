import { BatteryLow } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { useLocale } from "@/hooks/use-locale";
import { saveDataRequested } from "@/hooks/use-polling";
import { t } from "@/lib/i18n";

// FORK: the Low power switch. A per-device decision like haptics and zen — "how this phone treats
// you" — so it sits with them. What it changes is the poll cadence (hooks/use-polling.ts): the
// followed mirror reads every 3 s instead of every second, a send's burst every second instead of
// three times a second. The live feed stays open, because one stream is cheaper than the polls it
// spares. The phone's own Data Saver counts as the switch being on, and the card says so rather
// than showing a switch that reads off while the cadence is slow.
export function LowPowerControl() {
  useLocale();
  const { prefs, setLowPower } = useDashPrefs();
  const forced = saveDataRequested();
  return (
    <Card className="gap-0 py-0" data-slot="low-power-control">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <BatteryLow className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.lowPower.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.lowPower.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={prefs.lowPower || forced}
            disabled={forced}
            onCheckedChange={setLowPower}
            aria-label={t("settings.lowPower.title")}
          />
        </div>
      </div>
      {forced && (
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t("settings.lowPower.saveData")}
        </p>
      )}
    </Card>
  );
}
