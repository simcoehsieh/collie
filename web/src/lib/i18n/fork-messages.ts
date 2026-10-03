// Fork-only vocabulary. Upstream's seven dictionaries stay mergeable; locales without a fork
// translation inherit English. The runtime still serves these through t() and useLocale().
export const forkEn = {
  "fork.interrupt.button": "Interrupt agent",
  "fork.interrupt.confirm": "Tap again to interrupt",
  "fork.newTab.target": "New tab: {label}",
  "fork.newTab.current": "+ opens: {label}. Picking a row opens it now and makes it what + does next time.",
} as const;

export type ForkMessageKey = keyof typeof forkEn;
export type ForkDictionary = Record<ForkMessageKey, string>;

export const forkZhTW = {
  "fork.interrupt.button": "中斷代理",
  "fork.interrupt.confirm": "再點一次中斷",
  "fork.newTab.target": "新增分頁：{label}",
  "fork.newTab.current": "+ 目前開啟：{label}。選擇一列會立即開啟，並設為下次 + 的啟動目標。",
} satisfies ForkDictionary;
