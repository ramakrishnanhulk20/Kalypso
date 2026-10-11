"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { Company } from "@kalypso/core";
import type { RebuiltTreasury } from "@/lib/employer";
import { ErrorNote } from "@/components/app/error-note";
import { describeError } from "@/components/app/errors";
import type { ShownError } from "@/components/app/errors";
import { PageHeading } from "@/components/app/page-heading";
import { RecoveryProvider } from "@/components/app/recovery";
import { useWallet } from "@/components/app/wallet-session";
import { shortId } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";
import { contracts } from "@/lib/stack";
import { AccountantFact } from "./accountant-fact";
import { publiclyReadable, readAdminCompany } from "./company-read";
import type { SavedCompany } from "./company-store";
import { PayrollPanel } from "./payroll-panel";
import { TeamPanel } from "./team-panel";
import { TreasuryPanel } from "./treasury-panel";

const TITLE_SIZE = { fontSize: "clamp(2.25rem, 4vw, 3.5rem)" } as const;
const FACT = "link-draw t-label";

function short4(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

type Read = { phase: "loading" } | { phase: "done"; company: Company; publiclyReadable: boolean } | { phase: "failed"; error: ShownError };

function Facts({ treasury, accountantId, readable }: { treasury: string; accountantId: number | null; readable: boolean }) {
  const t = useTranslations("employer.dashboard");
  const plain = { textTransform: "none", letterSpacing: "0.04em" } as const;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-2">
      <a href={`${EXPLORER_URL}/account/${treasury}`} target="_blank" rel="noopener" className={FACT} style={plain}>
        {t("treasury", { short: short4(treasury) })}
      </a>
      <AccountantFact accountantId={accountantId} publiclyReadable={readable} />
      <a href={`${EXPLORER_URL}/contract/${contracts.payroll}`} target="_blank" rel="noopener" className={FACT} style={plain}>
        {t("payrollContract", { short: shortId(contracts.payroll) })}
      </a>
    </div>
  );
}

export function Dashboard({ company }: { company: SavedCompany }) {
  const t = useTranslations("employer.dashboard");
  const wallet = useWallet();
  const companyId = useMemo(() => BigInt(company.id), [company.id]);
  const [read, setRead] = useState<Read>({ phase: "loading" });
  const [tick, setTick] = useState(0);
  // Reading the company again after a failure, without touching the panels' own refresh count.
  const [attempt, setAttempt] = useState(0);
  // The result of a rebuild made from an error note. The balance error it answered goes away once the
  // balance reads again, and the rebuilt figure and any mismatch must not go with it.
  const [recovered, setRecovered] = useState<RebuiltTreasury | null>(null);
  const refresh = useCallback(() => {
    setRecovered(null);
    setTick((value) => value + 1);
  }, []);
  const onRebuilt = useCallback((result: RebuiltTreasury) => {
    setRecovered(result);
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let current = true;
    setRead({ phase: "loading" });
    readAdminCompany(wallet, companyId)
      .then(async (found) => ({ found, open: await publiclyReadable(found) }))
      .then(
        ({ found, open }) => current && setRead({ phase: "done", company: found, publiclyReadable: open }),
        (err: unknown) => current && setRead({ phase: "failed", error: describeError(err) }),
      );
    return () => {
      current = false;
    };
  }, [wallet, companyId, attempt]);

  const recovery = useMemo(() => ({ wallet, companyId, onRebuilt }), [wallet, companyId, onRebuilt]);

  return (
    <RecoveryProvider value={recovery}>
      <PageHeading
        eyebrow={t("eyebrow", { id: company.id })}
        title={read.phase === "done" ? read.company.label : company.label}
        titleClassName="t-h2 mt-4 [overflow-wrap:anywhere]"
        titleStyle={TITLE_SIZE}
        lead={
          <Facts
            treasury={wallet.address}
            accountantId={read.phase === "done" ? read.company.auditorId : null}
            readable={read.phase === "done" && read.publiclyReadable}
          />
        }
        leadClassName=""
        className="pb-[6vh]"
      />
      {read.phase === "failed" ? (
        <div>
          <ErrorNote error={read.error} />
          <button type="button" className="btn-ghost mt-4" onClick={() => setAttempt((n) => n + 1)}>
            {t("retry")}
          </button>
        </div>
      ) : null}
      {read.phase === "done" ? (
        <>
          <TreasuryPanel companyId={companyId} tick={tick} refresh={refresh} recovered={recovered} />
          <TeamPanel companyId={companyId} />
          <PayrollPanel companyId={companyId} refresh={refresh} />
        </>
      ) : null}
    </RecoveryProvider>
  );
}
