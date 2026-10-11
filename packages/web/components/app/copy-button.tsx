"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

const COPIED_MS = 1500;

// Copies text to the clipboard. The label turns to "Copied" for a moment, and the same word goes
// to a hidden live region so a screen reader hears it too.
export function CopyButton({ text, what, className = "" }: { text: string; what: string; className?: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setFailed(false);
      setCopied(true);
    } catch {
      setCopied(false);
      setFailed(true);
    }
    timer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, COPIED_MS);
  };

  return (
    <>
      <button type="button" className={`btn-ghost shrink-0 ${className}`} style={{ padding: "0.45rem 0.9rem" }} aria-label={t("copyWhat", { what })} onClick={() => void copy()}>
        {copied ? t("copied") : failed ? t("copyByHand") : t("copy")}
      </button>
      <span role="status" className="sr-only">
        {copied ? t("copied") : ""}
      </span>
    </>
  );
}
