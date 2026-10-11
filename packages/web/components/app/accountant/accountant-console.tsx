"use client";

import { useTranslations } from "next-intl";
import { BooksPanel } from "./books-panel";
import { KeyPanel } from "./key-panel";

export function AccountantConsole() {
  const t = useTranslations("accountant");
  return (
    <>
      <h1 className="sr-only">{t("srTitle")}</h1>
      <KeyPanel />
      <BooksPanel />
    </>
  );
}
