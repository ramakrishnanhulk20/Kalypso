"use client";

import { useEffect, useId, useRef, useState } from "react";

type InlineConfirmProps = {
  /** The button's own words before it asks. */
  label: string;
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  triggerClassName?: string;
};

// The asking state on its own, so a test can render it without clicking.
export function ConfirmAsk({
  question,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  cancelRef,
}: {
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  cancelRef?: React.Ref<HTMLButtonElement>;
}) {
  const questionId = useId();
  return (
    <div
      role="group"
      aria-labelledby={questionId}
      className="flex flex-wrap items-center gap-x-4 gap-y-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <p id={questionId} className="font-sans text-[0.9375rem] text-fg">
        {question}
      </p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-seal" aria-describedby={questionId} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button ref={cancelRef} type="button" className="btn-ghost" aria-describedby={questionId} onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * A button that asks in the page before it acts, never through the browser's own dialog. Asking
 * puts focus on the cancel button, the safe answer; Esc or cancel puts the button back and focus
 * on it, so a keyboard user never loses their place.
 */
export function InlineConfirm({ label, question, confirmLabel, cancelLabel, onConfirm, triggerClassName = "btn-ghost" }: InlineConfirmProps) {
  const [asking, setAsking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focusTrigger = useRef(false);

  useEffect(() => {
    if (asking) cancelRef.current?.focus();
    else if (focusTrigger.current) {
      focusTrigger.current = false;
      triggerRef.current?.focus();
    }
  }, [asking]);

  if (!asking) {
    return (
      <button ref={triggerRef} type="button" className={triggerClassName} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <ConfirmAsk
      question={question}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      cancelRef={cancelRef}
      onConfirm={() => {
        setAsking(false);
        onConfirm();
      }}
      onCancel={() => {
        focusTrigger.current = true;
        setAsking(false);
      }}
    />
  );
}
