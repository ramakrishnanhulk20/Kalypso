import { useTranslations } from "next-intl";
import { useErrorText } from "@/lib/i18n/errors";
import { SealMark } from "../../seal-mark";
import { PublicNote, PubliclyReadable } from "./public-chip";
import type { InviteState } from "./use-invite";

// Above everything on the page whenever the link names a company, signed in or not. A company
// bound to the published demo accountant key carries the Publicly readable chip here too (C47).
export function InviteStrip({ invite, onRetry }: { invite: InviteState; onRetry: () => void }) {
  const t = useTranslations("worker.invite");
  const errorText = useErrorText();
  if (invite.status === "none") return null;
  return (
    <div className="mb-10 flex items-start gap-4 rounded-card border border-line bg-raised px-5 py-4">
      <SealMark size={28} className="mt-[2px] shrink-0" />
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className="t-label">{t("label")}</p>
        {invite.status === "loading" ? (
          <span className="skeleton-bar mt-3 block" style={{ width: "min(100%, 18rem)" }} />
        ) : invite.status === "found" ? (
          <>
            <p className="mt-1 break-words font-sans text-base text-fg">{t("text", { label: invite.label })}</p>
            {invite.publiclyReadable ? (
              <div className="mt-2">
                <PubliclyReadable />
                <PublicNote className="mt-1" />
              </div>
            ) : null}
          </>
        ) : invite.status === "missing" ? (
          <p className="mt-1 font-sans text-base text-fail">{t("missing")}</p>
        ) : (
          <>
            <p className="mt-1 font-sans text-base text-fail">{errorText(invite.error)}</p>
            <button type="button" className="btn-ghost mt-3" onClick={onRetry}>
              {t("retry")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
