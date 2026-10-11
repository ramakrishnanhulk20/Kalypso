import { useTranslations } from "next-intl";
import { shortId } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";

// A transaction hash shortened 6 and 4, linking to its stellar.expert testnet page.
export function TxLink({ hash, className = "" }: { hash: string; className?: string }) {
  const t = useTranslations("common");
  return (
    <a
      href={`${EXPLORER_URL}/tx/${hash}`}
      target="_blank"
      rel="noopener"
      aria-label={t("openTransaction", { id: shortId(hash) })}
      className={`font-mono text-[0.875rem] text-muted transition-colors hover:text-fg ${className}`}
    >
      {shortId(hash)}
    </a>
  );
}
