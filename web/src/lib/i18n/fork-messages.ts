// Fork-only vocabulary. Upstream's seven dictionaries stay mergeable; locales without a fork
// translation inherit English. The runtime still serves these through t() and useLocale().
export const forkEn = {
  "fork.interrupt.button": "Interrupt agent",
  "fork.interrupt.confirm": "Tap again to interrupt",
  "fork.newTab.target": "New tab: {label}",
  "fork.newTab.current": "+ opens: {label}. Picking a row opens it now and makes it what + does next time.",
  "fork.updates.title": "Update information",
  "fork.updates.card": "Upstream releases",
  "fork.updates.managed": "This installation is updated by maintainer merges.",
  "fork.updates.available": "Upstream v{version} released · This installation is updated by maintainer merges",
  "fork.updates.notes": "Release notes",
  "fork.updates.restart": "Bridge restart needed · This installation is maintained by its maintainer",
  "fork.updates.failed": "An update failed · Check the update details",
  "fork.queue.possiblyDelivered": "May already have been sent; check the pane first",
  "fork.queue.showFull": "Show full message",
  "fork.queue.hideFull": "Collapse message",
  "fork.queue.fullText": "Full message",
} as const;

export type ForkMessageKey = keyof typeof forkEn;
export type ForkDictionary = Record<ForkMessageKey, string>;

export const forkZhTW = {
  "fork.interrupt.button": "中斷代理",
  "fork.interrupt.confirm": "再點一次中斷",
  "fork.newTab.target": "新增分頁：{label}",
  "fork.newTab.current": "+ 目前開啟：{label}。選擇一列會立即開啟，並設為下次 + 的啟動目標。",
  "fork.updates.title": "更新資訊",
  "fork.updates.card": "上游版本",
  "fork.updates.managed": "此安裝由維護者合併更新。",
  "fork.updates.available": "上游 v{version} 已發佈 · 此安裝由維護者合併更新",
  "fork.updates.notes": "版本說明",
  "fork.updates.restart": "橋接程式需要重新啟動 · 此安裝由維護者維護",
  "fork.updates.failed": "更新失敗 · 請查看更新詳情",
  "fork.queue.possiblyDelivered": "可能已送出，請先看畫面",
  "fork.queue.showFull": "展開完整訊息",
  "fork.queue.hideFull": "收合訊息",
  "fork.queue.fullText": "完整訊息",
} satisfies ForkDictionary;
