"use client";

import { useState } from "react";
import Link from "next/link";
import { PayrollCard } from "@/components/demo/payroll-card";
import { ErrorNote } from "@/components/app/error-note";
import { TextField } from "@/components/app/fields";
import { companyIdFrom } from "@/components/app/employer/company-read";
import { loadAccountant } from "@/components/app/loaders";
import { Block, Panel } from "@/components/app/panel";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { useWallet } from "@/components/app/wallet-session";
import { NoKeyFits, WithheldTotal, totalOf } from "@/components/key-lens/ledger-table";
import { amountsFrom } from "@/lib/ledger";
import { displayUsdc } from "@/lib/money";

const CSV_TYPE = "text/csv;charset=utf-8";

// The file reaches the person through a short-lived link to an in-memory copy. Nothing is sent anywhere.
function download(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: CSV_TYPE }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BooksPanel() {
  const wallet = useWallet();
  const [text, setText] = useState("");
  const [asked, setAsked] = useState<string | null>(null);

  const open = useAction(async (onProgress) => {
    const lib = await loadAccountant();
    const companyId = await companyIdFrom(text);
    setAsked(companyId.toString());
    return lib.openBooks(wallet, { companyId }, onProgress);
  });

  const books = open.value;
  const exportCsv = useAction(async () => {
    if (!books) throw new Error("No books are open.");
    const lib = await loadAccountant();
    const file = await lib.exportBooks(wallet, { companyId: books.companyId });
    download(file.filename, file.csv);
    return file.filename;
  });

  const loading = open.running;
  const showCard = loading || books !== undefined;
  const payments = books?.payments ?? null;
  const amounts = amountsFrom(books ?? null);
  // With one run its own subtotal already says the total, so the grand total only appears for two or more.
  const runCount = new Set(payments?.map((payment) => payment.runId)).size;
  const grand = books && amounts ? totalOf(books.payments, amounts, books.complete) : null;

  return (
    <Panel eyebrow="02" title="Open a company's books">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void open.start();
        }}
      >
        <TextField
          label="Company id"
          inputMode="numeric"
          value={text}
          onChange={(event) => setText(event.target.value)}
          frameClassName="max-w-[22rem]"
        />
        <div className="mt-4">
          <StepButton action={open} onClick={() => void open.start()}>
            Open the books
          </StepButton>
        </div>
      </form>
      {open.error ? <ErrorNote error={open.error} /> : null}

      {showCard ? (
        <div className="mt-10">
          <PayrollCard
            title={books?.label ?? `Company ${asked ?? ""}`}
            companyId={books?.companyId ?? BigInt(asked ?? "0")}
            chip={books ? { phase: "done", complete: books.complete } : { phase: "history", complete: false }}
            opening={loading ? (open.progress ?? "Opening the books with your key in your browser") : null}
            payments={payments}
            amounts={amounts}
            failed={false}
            onRetry={() => void open.start()}
          />
          {books && books.payments.length === 0 ? (
            <p className="mt-4 font-sans text-[0.9375rem] text-muted">This company has not made a payment yet.</p>
          ) : null}
          {books ? (
            <>
              {runCount >= 2 && grand ? (
                <div className="mt-5 flex items-baseline justify-between border-t border-line pt-[14px]">
                  <span className="font-sans text-base text-paper">Total</span>
                  {grand.kind === "total" ? (
                    <span>
                      <span className="font-display text-[1.25rem] font-semibold text-paper">{displayUsdc(grand.value)}</span>{" "}
                      <span className="t-label">USDC</span>
                    </span>
                  ) : grand.kind === "withheld" ? (
                    <WithheldTotal />
                  ) : (
                    <NoKeyFits />
                  )}
                </div>
              ) : null}
              <Block className="mt-6">
                <StepButton variant="ghost" action={exportCsv} onClick={() => void exportCsv.start()}>
                  Export CSV
                </StepButton>
                {exportCsv.value ? <p className="mt-3 font-sans text-[0.9375rem] text-muted">Saved {exportCsv.value}</p> : null}
                {exportCsv.error ? <ErrorNote error={exportCsv.error} /> : null}
              </Block>
            </>
          ) : null}
        </div>
      ) : null}

      <p className="mt-10 font-sans text-[0.9375rem] text-muted">
        Want to see it first? The demo company&apos;s key is public on the{" "}
        <Link href="/#lens" className="text-paper underline decoration-line underline-offset-[3px] transition-colors hover:decoration-paper">
          home page
        </Link>
        .
      </p>
    </Panel>
  );
}
