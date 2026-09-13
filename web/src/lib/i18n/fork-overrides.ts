import type { Locale } from "./locale";
import type { Dictionary, MessageKey } from "./messages/en";

// FORK — THE CAT SPEAKS CAT.
//
// The mark is a cat, the app installs as "Meow", and the boot splash said "Connecting to the herd…".
// A mixed metaphor is the one thing a visitor notices immediately, and it undercuts an otherwise
// very specific identity.
//
// WHY A LAYER AND NOT AN EDIT. The seven dictionaries are upstream's, and this fork has never
// changed a value in any of them — every i18n diff against `upstream/main` to date is pure
// insertions (`git diff upstream/main -- web/src/lib/i18n`). That is worth keeping: a merge that
// touches a translated line is a conflict in seven files at once, in six languages nobody here
// reads. Overriding after the fact costs one object and leaves upstream's files byte for byte
// mergeable.
//
// WHAT IS IN SCOPE, and it is deliberately small. Only nouns that name the wrong ANIMAL, and only
// where the locale actually uses one — "Connecting…" is already animal-free in Spanish, Korean and
// both Chinese bundles, so those carry no entry for it and inherit upstream's line unchanged. This
// is not a rebranding sweep: "Collie" is the product's name (the binary is `bin/collie`, the config
// is `~/.config/collie`, the bridge answers to it), and renaming the product inside its own error
// messages would make every one of them unsearchable. The cat is this INSTALL's identity, carried
// by `branding.json`; the dog is the software's name.
//
// The word "herd" as the app's own term for "every pane on every machine" is likewise left alone
// where it is doing work the reader needs (`crew`, the triage sections) — what goes is the handful
// of places the metaphor is addressed AT the reader as if the app were a dog.
//
// `satisfies`, not an annotation: the constraint still catches a typo'd locale or a key that does
// not exist, while inference keeps the literal shape — an annotation here would widen the table into
// "any locale, any key", which is exactly the evidence a reader of this file wants kept (ADR 0019).
const OVERRIDES = {
  en: {
    // The first sentence the app ever shows, and it named a livestock animal. Nothing is lost by
    // saying what is happening: this screen is a spinner with words.
    "error.boot.connecting": "Connecting…",
    "idle.catchingUp.body": "Fetching what every pane is doing.",
  },
  de: {
    "error.boot.connecting": "Verbindung wird aufgebaut…",
    "idle.catchingUp.body": "Ruft den aktuellen Zustand aller Panes ab.",
  },
  es: {
    // "Estableciendo conexión..." is already animal-free; only the idle cover says "la manada".
    "idle.catchingUp.body": "Obteniendo el estado actual de todos los paneles.",
  },
  ja: {
    // 「ホスト群」/「群れ」— both read as a herd of animals rather than as a set of machines.
    "error.boot.connecting": "接続中...",
    "idle.catchingUp.body": "すべてのペインの最新状態を取得しています。",
  },
} satisfies Partial<Record<Locale, Partial<Record<MessageKey, string>>>>;

/**
 * Apply this fork's overrides to a dictionary as it becomes available.
 *
 * Called at the ONE place each bundle enters the runtime (module scope for English, the dynamic
 * import's resolution for the rest), never per lookup: `t()` runs on every rendered string, and a
 * spread there would allocate a dictionary per call.
 */
export function withForkOverrides(locale: Locale, dictionary: Dictionary): Dictionary {
  // Narrowed by `in`, not by an assertion: most locales carry no entry at all (that is the point of
  // the layer being small), and the guard is what tells the compiler which ones do. `satisfies`
  // above has already proved every key here IS a Locale, so this cannot select something that is not.
  if (!(locale in OVERRIDES)) return dictionary;
  // SAFETY: the `in` guard on the line above is the check — `locale` is a key of OVERRIDES at this
  // point, and `satisfies` has already proved every key of OVERRIDES is itself a Locale.
  const patch: Partial<Record<MessageKey, string>> = OVERRIDES[locale as keyof typeof OVERRIDES];
  return { ...dictionary, ...patch };
}
