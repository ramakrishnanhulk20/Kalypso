"use client";

import { useMemo } from "react";
import type { SealedPayment } from "@kalypso/core";
import { useSealedPayrollState } from "@/hooks/use-sealed-payroll";

export type FirstPayment = { payment: SealedPayment; amount: bigint };

// The newest payment the accountant key opened. It watches the read the lens
// already runs and never starts one of its own.
export function useFirstPayment(): FirstPayment | null {
  const { payroll } = useSealedPayrollState("accountant");
  const payment = payroll?.payments[0];

  return useMemo(() => {
    if (!payment || payment.amount === null) return null;
    return { payment, amount: payment.amount };
  }, [payment]);
}
