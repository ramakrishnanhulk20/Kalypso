"use client";

export type KeyId = "worker1" | "worker2" | "worker3" | "accountant" | "stranger";

export const KEYS: { id: KeyId; label: string; who: string }[] = [
  { id: "worker1", label: "Worker 1", who: "Worker 1" },
  { id: "worker2", label: "Worker 2", who: "Worker 2" },
  { id: "worker3", label: "Worker 3", who: "Worker 3" },
  { id: "accountant", label: "Accountant", who: "the accountant" },
  { id: "stranger", label: "Stranger", who: "a stranger" },
];

// Native radio buttons sharing one name give the arrow-key behaviour of a radiogroup for free.
export function KeySwitcher({ value, onChange }: { value: KeyId; onChange: (id: KeyId) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Which key"
      data-lenis-prevent
      className="-m-[6px] flex gap-2 overflow-x-auto p-[6px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {KEYS.map((key) => (
        <label key={key.id} className="relative shrink-0 cursor-pointer">
          <input
            type="radio"
            name="sandbox-key"
            value={key.id}
            checked={value === key.id}
            onChange={(event) => {
              onChange(key.id);
              event.currentTarget.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
            className="peer sr-only"
          />
          <span className="block whitespace-nowrap rounded-button border border-line px-4 py-[0.6rem] font-sans text-[0.9375rem] text-muted transition-colors hover:text-paper peer-checked:border-[rgba(242,236,230,0.28)] peer-checked:bg-ink-3 peer-checked:text-paper peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-paper">
            {key.label}
          </span>
        </label>
      ))}
    </div>
  );
}
