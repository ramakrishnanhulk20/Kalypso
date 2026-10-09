import { SealMark } from "../../seal-mark";
import { PubliclyReadable } from "./public-chip";
import type { InviteState } from "./use-invite";

const MISSING = "This invite link points to a company that does not exist. Ask your employer for a new link.";

// Above everything on the page whenever the link names a company, signed in or not. A company
// bound to the published demo accountant key carries the Publicly readable chip here too (C47).
export function InviteStrip({ invite }: { invite: InviteState }) {
  if (invite.status === "none") return null;
  return (
    <div className="mb-10 flex items-start gap-4 rounded-card border border-line bg-ink-2 px-5 py-4">
      <SealMark size={28} className="mt-[2px] shrink-0" />
      <div className="min-w-0" aria-live="polite">
        <p className="t-label">Invitation</p>
        {invite.status === "loading" ? (
          <span className="skeleton-bar mt-3 block" style={{ width: "min(100%, 18rem)" }} />
        ) : invite.status === "found" ? (
          <>
            <p className="mt-1 break-words font-sans text-base text-paper">{invite.label} invited you to receive your pay through Kalypso.</p>
            {invite.publiclyReadable ? (
              <div className="mt-2">
                <PubliclyReadable />
              </div>
            ) : null}
          </>
        ) : invite.status === "missing" ? (
          <p className="mt-1 font-sans text-base text-fail">{MISSING}</p>
        ) : (
          <p className="mt-1 font-sans text-base text-fail">{invite.message}</p>
        )}
      </div>
    </div>
  );
}
