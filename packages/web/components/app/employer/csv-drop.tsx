"use client";

import { useState } from "react";
import type { DragEvent } from "react";
import { useTranslations } from "next-intl";
import { CSV_DEFAULT_MAX_BYTES } from "@kalypso/core";

// Reads at most one byte past the importer's size limit: a bigger file is then refused by the
// parser's own "too large" sentence, without ever holding the whole file in memory.
async function textOf(file: File): Promise<string> {
  return file.slice(0, CSV_DEFAULT_MAX_BYTES + 1).text();
}

export function CsvDrop({ onText, disabled }: { onText: (text: string) => void; disabled: boolean }) {
  const t = useTranslations("employer.payroll");
  const [over, setOver] = useState(false);

  const take = async (file: File | undefined) => {
    if (file) onText(await textOf(file));
  };

  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    if (!disabled) void take(event.dataTransfer.files[0]);
  };

  return (
    <label
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={`block cursor-pointer rounded-card border border-dashed p-8 text-center transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px] has-[:focus-visible]:outline-fg ${
        over
          ? "border-fg bg-raised"
          : "border-line-strong hover:border-fg hover:bg-raised"
      } ${disabled ? "pointer-events-none opacity-40" : ""}`}
    >
      <input
        type="file"
        accept=".csv,text/csv"
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          const input = event.currentTarget;
          void take(input.files?.[0]).then(() => {
            input.value = "";
          });
        }}
      />
      <span className="block font-sans text-base text-fg">{t("drop")}</span>
      <span className="t-label mt-2 block">{t("dropHint")}</span>
    </label>
  );
}
