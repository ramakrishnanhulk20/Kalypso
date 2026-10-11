"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { PageHeading } from "@/components/app/page-heading";
import type { SandboxResult } from "@/lib/sandbox/engine";
import { amountsFrom } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";
import { contracts } from "@/lib/stack";
import { afterPaint } from "./after-paint";
import type { Engine } from "./engine";
import { KeySwitcher } from "./key-switcher";
import type { KeyId } from "./key-switcher";
import { PayrollCard } from "./payroll-card";
import { PayslipView } from "./payslip-view";
import { useKeyRead } from "./use-key-read";

const DEFAULT_KEY: KeyId = "accountant";

type ResultViewProps = {
  result: SandboxResult;
  engine: Engine;
  onStartOver: () => void;
};

export function ResultView({ result, engine, onStartOver }: ResultViewProps) {
  const t = useTranslations("sandbox.result");
  const common = useTranslations("common");
  const [selected, setSelected] = useState<KeyId>(DEFAULT_KEY);

  const accountant = useKeyRead(useCallback(() => engine.openAsAccountant(), [engine]));
  const stranger = useKeyRead(useCallback(() => engine.openAsStranger(), [engine]));
  const worker1 = useKeyRead(useCallback(() => engine.openAsWorker(0), [engine]));
  const worker2 = useKeyRead(useCallback(() => engine.openAsWorker(1), [engine]));
  const worker3 = useKeyRead(useCallback(() => engine.openAsWorker(2), [engine]));
  const reads = { accountant, stranger, worker1, worker2, worker3 };

  const openAccountant = accountant.open;
  useEffect(() => {
    openAccountant();
  }, [openAccountant]);

  const pendingOpens = useRef(new Set<() => void>());
  useEffect(() => {
    const pending = pendingOpens.current;
    return () => pending.forEach((cancel) => cancel());
  }, []);

  // The tab is chosen at once. Opening a key does some work before its first wait, so it starts
  // after the chosen tab has painted, never in front of it.
  const choose = (id: KeyId) => {
    setSelected(id);
    pendingOpens.current.add(afterPaint(() => reads[id].open()));
  };

  const label = t("sandboxLabel", { short: result.treasury.slice(0, 4) });
  const workerIndex = selected === "worker1" ? 1 : selected === "worker2" ? 2 : 3;
  const opening =
    selected === "accountant" ? t("openingAccountant") : selected === "stranger" ? t("openingStranger") : t("openingWorker", { n: workerIndex });

  const asAccountant = accountant.read;
  const chip =
    asAccountant === undefined || asAccountant.status === "loading"
      ? { phase: "history" as const, complete: false }
      : asAccountant.status === "error"
        ? { phase: "error" as const, complete: false }
        : { phase: "done" as const, complete: asAccountant.value.complete };

  const tableRead = selected === "stranger" ? stranger.read : accountant.read;
  const tableLoading = tableRead === undefined || tableRead.status === "loading";
  const payroll = tableRead?.status === "done" ? tableRead.value : null;
  const payments = (payroll ?? (asAccountant?.status === "done" ? asAccountant.value : null))?.payments ?? null;
  const workerRead = selected === "worker1" ? worker1 : selected === "worker2" ? worker2 : worker3;

  return (
    <section>
      <PageHeading eyebrow={t("eyebrow")} title={t("title")} lead={t("lead")} />

      <div className="mt-8 flex flex-wrap items-center gap-6">
        <a
          href={`${EXPLORER_URL}/account/${result.treasury}`}
          target="_blank"
          rel="noopener"
          className="link-draw text-[0.9375rem]"
        >
          {t("treasuryLink")}
        </a>
        <a
          href={`${EXPLORER_URL}/contract/${contracts.payroll}`}
          target="_blank"
          rel="noopener"
          className="link-draw text-[0.9375rem]"
        >
          {t("payrollLink")}
        </a>
        <button type="button" className="link-draw text-[0.9375rem]" onClick={onStartOver}>
          {common("startOver")}
        </button>
      </div>

      <div className="mt-10">
        <KeySwitcher value={selected} onChange={choose} />
      </div>

      <div className="mt-6">
        {selected === "accountant" || selected === "stranger" ? (
          <PayrollCard
            title={label}
            companyId={result.companyId}
            chip={chip}
            opening={tableLoading ? opening : null}
            payments={payments}
            amounts={amountsFrom(payroll)}
            failed={tableRead?.status === "error"}
            onRetry={reads[selected].retry}
          />
        ) : (
          <PayslipView
            worker={workerIndex}
            companyLabel={label}
            runId={result.runId}
            read={workerRead.read}
            opening={opening}
            onRetry={workerRead.retry}
          />
        )}
      </div>

      <div className="mt-[12vh] flex flex-wrap items-center gap-x-8 gap-y-4">
        <p className="font-display text-[1.5rem] font-medium text-fg" style={{ fontVariationSettings: '"opsz" 36' }}>
          {t("closing")}
        </p>
        <Link href="/docs/how-it-works" className="btn-ghost">
          {t("readHow")}
        </Link>
      </div>
    </section>
  );
}
