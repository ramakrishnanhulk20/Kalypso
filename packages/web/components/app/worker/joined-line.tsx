import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { PubliclyReadable } from "./public-chip";

// What a join leaves on the page: the company, its accept transaction (children), and the Publicly
// readable chip when the company is bound to the published demo accountant key (C47).
export function JoinedLine({ label, publiclyReadable, children }: { label: string; publiclyReadable: boolean; children?: ReactNode }) {
  const t = useTranslations("worker");
  return (
    <>
      <span className="t-label break-words">{t("joined", { label })}</span>
      {children}
      {publiclyReadable ? <PubliclyReadable /> : null}
    </>
  );
}
