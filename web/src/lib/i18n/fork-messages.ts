// Fork-only vocabulary. Upstream's seven dictionaries stay mergeable; locales without a fork
// translation inherit English. The runtime still serves these through t() and useLocale().
export const forkEn = {
  "fork.interrupt.button": "Interrupt agent",
  "fork.interrupt.confirm": "Tap again to interrupt",
} as const;

export type ForkMessageKey = keyof typeof forkEn;
export type ForkDictionary = Record<ForkMessageKey, string>;

export const forkZhTW = {
  "fork.interrupt.button": "中斷代理",
  "fork.interrupt.confirm": "再點一次中斷",
} satisfies ForkDictionary;
