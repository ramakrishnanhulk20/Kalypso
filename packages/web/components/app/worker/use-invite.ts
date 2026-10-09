"use client";

import { useEffect, useState } from "react";
import { shownFrom } from "./shown";
import { companyIdFromQuery } from "./text";
import type { WorkerKit } from "./worker-lib";

export type InviteState =
  | { status: "none" }
  | { status: "loading"; companyId: bigint }
  | { status: "found"; companyId: bigint; label: string; publiclyReadable: boolean }
  | { status: "missing"; companyId: bigint }
  | { status: "failed"; companyId: bigint; message: string };

// The company an invite link names (/worker?company=12), its name and whether anyone can read its
// amounts, read from the chain. A link with no company, or one that is not a whole number, is no
// invite at all.
export function useInvite(kit: WorkerKit | null): InviteState {
  const [companyId, setCompanyId] = useState<bigint | null>(null);
  const [state, setState] = useState<InviteState>({ status: "none" });

  useEffect(() => {
    setCompanyId(companyIdFromQuery(window.location.search));
  }, []);

  useEffect(() => {
    if (companyId === null) {
      setState({ status: "none" });
      return;
    }
    setState({ status: "loading", companyId });
    if (kit === null) return;
    let current = true;
    kit.company(companyId).then(
      (facts) => current && setState(facts === null ? { status: "missing", companyId } : { status: "found", companyId, ...facts }),
      (err: unknown) => current && setState({ status: "failed", companyId, message: shownFrom(err).message }),
    );
    return () => {
      current = false;
    };
  }, [kit, companyId]);

  return state;
}
