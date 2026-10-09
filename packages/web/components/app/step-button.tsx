"use client";

import type { ReactNode } from "react";
import type { ButtonAction } from "./use-action";

type StepButtonProps = {
  action: ButtonAction;
  onClick: () => void;
  children: ReactNode;
  variant?: "seal" | "ghost";
  disabled?: boolean;
  className?: string;
};

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
    </svg>
  );
}

// While the step runs the button shows the lib's current sentence in place of its text, so a wait
// of many seconds always says what it is waiting for. A button's own text is not announced as it
// changes, so the same sentence goes to a hidden live region beside it.
export function StepButton({ action, onClick, children, variant = "seal", disabled = false, className = "" }: StepButtonProps) {
  const { running, progress, flash } = action;
  return (
    <>
      <button
        type="button"
        className={`${variant === "seal" ? "btn-seal" : "btn-ghost"} max-w-full text-left ${className}`}
        disabled={disabled || running}
        aria-busy={running}
        onClick={onClick}
      >
        {running ? (
          <>
            <span aria-hidden="true" className="spinner" />
            <span>{progress ?? children}</span>
          </>
        ) : flash ? (
          <>
            <Check />
            <span>Done</span>
          </>
        ) : (
          children
        )}
      </button>
      <span role="status" className="sr-only">
        {running ? (progress ?? "") : flash ? "Done" : ""}
      </span>
    </>
  );
}
