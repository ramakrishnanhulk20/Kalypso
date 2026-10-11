"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import type { ConsoleProgress } from "@/lib/employer/progress";
import type { Progress } from "@/components/app/use-action";

/**
 * Wraps a step button's progress callback for the employer and accountant libraries: they report
 * a step id and its values, and the sentence is progress.<id> from the page's messages, so a
 * library's English never reaches a page in another language.
 */
export function useProgressText(): (onProgress: (p: Progress) => void) => (p: ConsoleProgress) => void {
  const t = useTranslations("progress");
  return useCallback(
    (onProgress) =>
      ({ step, values, done, total, txHash }) => {
        const sentence = t(step, values);
        onProgress(txHash === undefined ? { sentence, done, total } : { sentence, done, total, txHash });
      },
    [t],
  );
}
