import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

// FORK: the "?" cheat sheet for the desktop shortcuts (hooks/use-hotkeys.ts). Keys are literal —
// they are the thing being taught, not a sentence to translate — and the meanings are.
const ROWS: readonly [keys: string, meaning: Parameters<typeof t>[0]][] = [
  ["j / k", "hotkeys.rows"],
  ["Enter", "hotkeys.open"],
  ["1 – 9", "hotkeys.nth"],
  ["g o", "hotkeys.overview"],
  ["g h", "hotkeys.home"],
  ["g s", "hotkeys.settings"],
  ["⌘K / Ctrl+K", "hotkeys.palette"],
  ["/", "hotkeys.composer"],
  ["Esc", "hotkeys.escape"],
  ["?", "hotkeys.help"],
];

export function HotkeysSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useLocale();
  return (
    <BottomSheet open={open} onClose={onClose} title={t("hotkeys.title")}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm" data-slot="hotkeys">
        {ROWS.map(([keys, meaning]) => (
          <div key={keys} className="contents">
            <dt>
              <kbd className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
            </dt>
            <dd className="text-muted-foreground">{t(meaning)}</dd>
          </div>
        ))}
      </dl>
    </BottomSheet>
  );
}
