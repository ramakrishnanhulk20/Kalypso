"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/app/page-heading";
import type { SandboxResult } from "@/lib/sandbox/engine";
import { amountsFrom } from "@/lib/ledger";
import { EXPLORER_URL } from "@/lib/links";
import { contracts } from "@/lib/stack";
import type { Engine } from "./engine";
import { KEYS, KeySwitcher } from "./key-switcher";
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

  const choose = (id: KeyId) => {
    setSelected(id);
    reads[id].open();
  };

  const label = `Sandbox ${result.treasury.slice(0, 4)}`;
  const who = KEYS.find((key) => key.id === selected)?.who ?? "";
  const opening = `Opening with ${who}'s key in your browser`;

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
  const workerIndex = selected === "worker1" ? 1 : selected === "worker2" ? 2 : 3;
  const workerRead = selected === "worker1" ? worker1 : selected === "worker2" ? worker2 : worker3;

  return (
    <section>
      <PageHeading
        eyebrow="Done · on Stellar testnet"
        title="Your payroll is on chain."
        lead="Anyone can see that three people were paid. Only the keys below can open how much. Every key here lives in this browser and was used only here."
      />

      <div className="mt-8 flex flex-wrap items-center gap-6">
        <a
          href={`${EXPLORER_URL}/account/${result.treasury}`}
          target="_blank"
          rel="noopener"
          className="link-draw text-[0.9375rem]"
        >
          Company treasury on stellar.expert
        </a>
        <a
          href={`${EXPLORER_URL}/contract/${contracts.payroll}`}
          target="_blank"
          rel="noopener"
          className="link-draw text-[0.9375rem]"
        >
          Payroll contract
        </a>
        <button type="button" className="link-draw text-[0.9375rem]" onClick={onStartOver}>
          Start over
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
        <p className="font-display text-[1.5rem] font-medium text-paper" style={{ fontVariationSettings: '"opsz" 36' }}>
          That is Kalypso.
        </p>
        <Link href="/docs/how-it-works" className="btn-ghost">
          Read how it works
        </Link>
      </div>
    </section>
  );
}
