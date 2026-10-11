"use client";

import { useTranslations } from "next-intl";

export type KeyId = "worker1" | "worker2" | "worker3" | "accountant" | "stranger";

/** The key's name on its chip. t is the sandbox.result namespace. */
export function keyLabel(t: (key: string, values?: Record<string, string | number>) => string, id: KeyId): string {
  if (id === "accountant") return t("keyAccountant");
  if (id === "stranger") return t("keyStranger");
  return t("keyWorker", { n: Number(id.slice(-1)) });
}

const GROUPS: readonly (readonly KeyId[])[] = [
  ["worker1", "worker2", "worker3"],
  ["accountant", "stranger"],
];

// Native radio buttons sharing one name give the arrow-key behaviour of a radiogroup for free.
// Below 860px the two groups stack instead of scrolling sideways, so no pill is ever cut off: the
// three workers on the first line, the accountant and the stranger on the second.
export function KeySwitcher({ value, onChange }: { value: KeyId; onChange: (id: KeyId) => void }) {
  const t = useTranslations("sandbox.result");
  return (
    <div role="radiogroup" aria-label={t("keysLabel")} className="-m-[6px] flex flex-col gap-2 p-[6px] min-[860px]:flex-row">
      {GROUPS.map((group) => (
        <div key={group.join()} className="flex flex-wrap gap-2">
          {group.map((id) => (
            <label key={id} className="relative shrink-0 cursor-pointer">
              <input type="radio" name="sandbox-key" value={id} checked={value === id} onChange={() => onChange(id)} className="peer sr-only" />
              <span className="block whitespace-nowrap rounded-button border border-line-strong px-4 py-[0.6rem] font-sans text-[0.9375rem] text-muted transition-colors hover:text-fg peer-checked:border-fg peer-checked:bg-raised-2 peer-checked:text-fg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-fg">
                {keyLabel(t, id)}
              </span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}
