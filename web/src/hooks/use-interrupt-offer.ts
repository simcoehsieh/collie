import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { usePendingConfirm } from "./use-pending-confirm";

interface InterruptOfferOptions {
  target: string;
  keys: readonly string[] | undefined;
  eligible: boolean;
  obstructed: boolean;
  sendKeys: (keys: string[]) => Promise<boolean>;
}

/** A two-tap interrupt belongs to one visible pane and expires after two seconds. */
export function useInterruptOffer({ target, keys, eligible, obstructed, sendKeys }: InterruptOfferOptions) {
  const offered = eligible && keys !== undefined;
  const { pending, confirm, reset } = usePendingConfirm(2000);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => reset(), [target, reset]);
  useEffect(() => {
    if (!offered || obstructed) reset();
  }, [offered, obstructed, reset]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState !== "visible") reset(); };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) reset();
    };
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("pagehide", reset);
    window.addEventListener("blur", reset);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("pagehide", reset);
      window.removeEventListener("blur", reset);
    };
  }, [reset]);

  async function press() {
    if (!offered || obstructed || inFlight.current || keys === undefined ||
        document.visibilityState !== "visible" || document.querySelector('[aria-modal="true"]')) {
      reset();
      return;
    }
    if (!confirm(target)) {
      setStatus(t("fork.interrupt.confirm"), "info", 2000);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      await sendKeys([...keys]);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { offered, armed: pending === target && offered && !obstructed, busy, press };
}
