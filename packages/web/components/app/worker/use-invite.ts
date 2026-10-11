"use client";

import { useCallback, useEffect, useState } from "react";
import type { ShownError } from "@/components/app/errors";
import { shownFrom } from "./shown";
import { companyIdFromQuery } from "./text";
import type { WorkerKit } from "./worker-lib";

export type InviteState =
  | { status: "none" }
  | { status: "loading"; companyId: bigint }
  | { status: "found"; companyId: bigint; label: string; publiclyReadable: boolean }
  | { status: "missing"; companyId: bigint }
  | { status: "failed"; companyId: bigint; error: ShownError };

// The company an invite link names (/worker?company=12), its name and whether anyone can read its
// amounts, read from the chain. A link with no company, or one that is not a whole number, is no
// invite at all. retry reads it again after a failure.
export function useInvite(kit: WorkerKit | null): { invite: InviteState; retry: () => void } {
  const [companyId, setCompanyId] = useState<bigint | null>(null);
  const [state, setState] = useState<InviteState>({ status: "none" });
  const [attempt, setAttempt] = useState(0);

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
      (err: unknown) => current && setState({ status: "failed", companyId, error: shownFrom(err) }),
    );
    return () => {
      current = false;
    };
  }, [kit, companyId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { invite: state, retry };
}
