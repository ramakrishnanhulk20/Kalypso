"use client";

import { CopyButton } from "../copy-button";
import { shortAddress } from "./text";

// Who is signed in, with a way to copy the full address and a way out. Signing out only forgets
// the session held in this tab; the passkey itself stays with the device. address is null until
// the chain has shown the worker's wallet trusting this passkey. While it is null nothing of the
// address is shown or copied (C51), because until then it could belong to whoever deployed there first.
export function SessionBar({ address, onSignOut }: { address: string | null; onSignOut: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="t-label">Signed in</span>
        {address === null ? (
          <span className="font-sans text-[0.875rem] text-muted">Wallet not set up yet</span>
        ) : (
          <>
            <span className="font-mono text-[0.875rem] text-paper">{shortAddress(address)}</span>
            <CopyButton text={address} what="your address" />
          </>
        )}
      </div>
      <button type="button" className="link-draw text-[0.9375rem]" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}
