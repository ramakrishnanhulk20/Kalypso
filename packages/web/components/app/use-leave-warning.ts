"use client";

import { useEffect } from "react";

// While a payment, a deposit, a join or a sandbox run is being sent, closing the tab asks first,
// with the browser's own wording. Every one of these carries on from the chain after a reload, so
// this only saves a person from a wait they did not mean to cut short.
export function useLeaveWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);
}
