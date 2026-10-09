"use client";

import { useId } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

// The same field the sandbox's salary card uses: ink-3, 8px radius, a brighter border on focus.
// 16px text so a phone never zooms in on focus.
export const FIELD =
  "w-full rounded-button border border-line bg-ink-3 px-3 py-[0.65rem] font-sans text-base text-paper placeholder:text-faint transition-colors hover:border-[rgba(242,236,230,0.2)] focus:border-[rgba(242,236,230,0.4)] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-paper aria-[invalid=true]:border-fail";

type FieldFrameProps = {
  label: ReactNode;
  id: string;
  error?: string | null;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
};

function FieldFrame({ label, id, error, hint, className = "", children }: FieldFrameProps) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="font-sans text-base text-paper">
          {label}
        </label>
        {hint}
      </div>
      <div className="mt-2">{children}</div>
      {error ? (
        <p id={`${id}-error`} className="mt-2 font-sans text-[0.875rem] text-fail">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  mono?: boolean;
  frameClassName?: string;
};

export function TextField({ label, error, hint, mono = false, frameClassName, className = "", ...rest }: TextFieldProps) {
  const id = useId();
  return (
    <FieldFrame label={label} id={id} error={error} hint={hint} className={frameClassName}>
      <input
        {...rest}
        id={id}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${FIELD} ${mono ? "font-mono" : ""} ${className}`}
      />
    </FieldFrame>
  );
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  label: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  frameClassName?: string;
};

export function TextAreaField({ label, error, hint, frameClassName, className = "", ...rest }: TextAreaFieldProps) {
  const id = useId();
  return (
    <FieldFrame label={label} id={id} error={error} hint={hint} className={frameClassName}>
      <textarea
        {...rest}
        id={id}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${FIELD} resize-y font-mono text-[0.9375rem] leading-6 ${className}`}
      />
    </FieldFrame>
  );
}

type SelectFieldProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
  label: ReactNode;
  frameClassName?: string;
};

// A native select, so the keyboard and the phone's own picker both work, with the page's chevron.
export function SelectField({ label, frameClassName, className = "", children, ...rest }: SelectFieldProps) {
  const id = useId();
  return (
    <FieldFrame label={label} id={id} className={frameClassName}>
      <div className="relative">
        <select {...rest} id={id} className={`${FIELD} cursor-pointer appearance-none pr-10 ${className}`}>
          {children}
        </select>
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-muted"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </div>
    </FieldFrame>
  );
}

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & { label: ReactNode };

export function Checkbox({ label, className = "", ...rest }: CheckboxProps) {
  const id = useId();
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <input
        {...rest}
        id={id}
        type="checkbox"
        className="peer h-[18px] w-[18px] shrink-0 cursor-pointer rounded-[4px] accent-[var(--color-seal)] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-paper"
      />
      <label htmlFor={id} className="cursor-pointer font-sans text-base text-muted transition-colors hover:text-paper peer-checked:text-paper">
        {label}
      </label>
    </div>
  );
}
