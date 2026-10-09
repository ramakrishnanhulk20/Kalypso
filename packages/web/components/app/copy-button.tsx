"use client";

import { useEffect, useRef, useState } from "react";

const COPIED_MS = 1500;

// Copies text to the clipboard. The label turns to "Copied" for a moment, and the same word goes
// to a hidden live region so a screen reader hears it too.
export function CopyButton({ text, what, className = "" }: { text: string; what: string; className?: string }) {
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
      <button type="button" className={`btn-ghost shrink-0 ${className}`} style={{ padding: "0.45rem 0.9rem" }} aria-label={`Copy ${what}`} onClick={() => void copy()}>
        {copied ? "Copied" : failed ? "Select and copy by hand" : "Copy"}
      </button>
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
