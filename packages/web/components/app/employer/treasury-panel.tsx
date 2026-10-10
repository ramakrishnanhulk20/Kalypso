"use client";

import { useEffect, useState } from "react";
import type { RebuiltTreasury, TreasuryBalance } from "@/lib/employer";
import { ErrorNote } from "@/components/app/error-note";
import type { ShownError } from "@/components/app/errors";
import { describeError } from "@/components/app/errors";
import { TextField } from "@/components/app/fields";
import { loadEmployer } from "@/components/app/loaders";
import { Block, Panel } from "@/components/app/panel";
import { RebuildResult, expectedText } from "@/components/app/recovery";
import { StepButton } from "@/components/app/step-button";
import { TxLink } from "@/components/app/tx-link";
import { useAction } from "@/components/app/use-action";
import { useLeaveWarning } from "@/components/app/use-leave-warning";
import { useWallet } from "@/components/app/wallet-session";
import { displayUsdc } from "@/lib/money";
import { depositAmount } from "./deposit-amount";

const DISPLAY_144 = { fontVariationSettings: '"opsz" 144' } as const;

type BalanceState = { phase: "loading" } | { phase: "done"; balance: TreasuryBalance } | { phase: "failed"; error: ShownError };

// Reads the sealed balance whenever the company or `tick` changes. A slower older read never
// overwrites a newer one.
function useBalance(companyId: bigint, tick: number): BalanceState {
  const wallet = useWallet();
  const [state, setState] = useState<BalanceState>({ phase: "loading" });
  useEffect(() => {
    let current = true;
    setState({ phase: "loading" });
    loadEmployer()
      .then((lib) => lib.treasuryBalance(wallet, companyId))
      .then(
        (balance) => current && setState({ phase: "done", balance }),
        (err: unknown) => current && setState({ phase: "failed", error: describeError(err) }),
      );
    return () => {
      current = false;
    };
  }, [wallet, companyId, tick]);
  return state;
}

export function TreasuryPanel({
  companyId,
  tick,
  refresh,
  recovered,
}: {
  companyId: bigint;
  tick: number;
  refresh: () => void;
  recovered: RebuiltTreasury | null;
}) {
  const wallet = useWallet();
  const balance = useBalance(companyId, tick);
  const [amountText, setAmountText] = useState("");
  const deposit = depositAmount(amountText);
  const { amount } = deposit;

  // The click passes the amount its own render showed on the button, so the deposit is that figure.
  const fund = useAction(async (onProgress, shown: bigint) => {
    const lib = await loadEmployer();
    await lib.ensureUsdcTrustline(wallet, onProgress);
    const funded = await lib.fundTreasury(wallet, { amount: shown }, onProgress);
    refresh();
    return funded;
  });

  const rebuild = useAction(async (onProgress) => {
    const lib = await loadEmployer();
    const rebuilt = await lib.rebuildTreasury(wallet, companyId, onProgress);
    refresh();
    return rebuilt;
  });

  const funded = fund.value;
  useLeaveWarning(fund.running);
  // A first deposit on a device has nothing saved to compare with, and what a device saved before this
  // deposit is short by exactly the deposit, so neither is a warning. Anything else is.
  const deviceDiffers =
    funded !== undefined && !funded.matchesDevice && funded.deviceExpected !== undefined && funded.deviceExpected + funded.deposited !== funded.value;

  return (
    <Panel eyebrow="01" title="Treasury">
      <Block>
        {balance.phase === "loading" ? (
          <div role="status">
            <span className="skeleton-bar block" style={{ height: 40, width: 220 }} />
            <p className="t-label mt-3" style={{ textTransform: "none", letterSpacing: "0.04em" }}>
              Opening your treasury with your key
            </p>
          </div>
        ) : balance.phase === "done" ? (
          <div>
            <p className="font-display text-[clamp(2rem,4vw,3rem)] font-medium leading-none text-paper" style={DISPLAY_144}>
              {displayUsdc(balance.balance.value)}
            </p>
            <p className="t-label mt-3">USDC · sealed on chain, opened with your key</p>
          </div>
        ) : (
          <ErrorNote error={balance.error} />
        )}
        {recovered ? (
          <div className="mt-4">
            <RebuildResult result={recovered} />
          </div>
        ) : null}
      </Block>

      <Block label="Add funds" className="mt-12">
        <div className="flex flex-wrap items-start gap-4">
          <TextField
            label="Amount (USDC)"
            inputMode="decimal"
            value={amountText}
            error={deposit.error}
            disabled={fund.running}
            onChange={(event) => setAmountText(event.target.value)}
            frameClassName="w-full max-w-[16rem]"
          />
          {/* Lines up with the input whether or not its error line is showing under it. */}
          <div className="sm:mt-[2.1rem]">
            <StepButton
              action={fund}
              disabled={amount === null}
              onClick={() => {
                if (amount !== null) void fund.start(amount);
              }}
            >
              {deposit.button}
            </StepButton>
          </div>
        </div>
        {deposit.confirm ? <p className="mt-3 font-sans text-[0.9375rem] text-paper">{deposit.confirm}</p> : null}
        {fund.error ? <ErrorNote error={fund.error} /> : null}
        {funded ? (
          <div role="status" className="mt-4 space-y-2 font-sans text-[0.9375rem] text-muted">
            {funded.resumed ? (
              <p>
                A deposit from earlier finished first: <span className="text-paper">{displayUsdc(funded.deposited)} USDC</span> was added. Nothing
                new was deposited.
              </p>
            ) : null}
            {deviceDiffers ? (
              <p>
                The chain holds <span className="text-paper">{displayUsdc(funded.value)} USDC</span>; this device expected {expectedText(funded.deviceExpected)}.
                The chain&apos;s value is now saved.
              </p>
            ) : null}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="t-label">Deposit</span>
              <TxLink hash={funded.depositTx} />
              <span className="t-label">Merge</span>
              <TxLink hash={funded.mergeTx} />
            </p>
          </div>
        ) : null}
        <p className="mt-5 max-w-[36rem] font-sans text-[0.9375rem] text-muted">
          Need test USDC? Swap test XLM for USDC on the{" "}
          <a href="https://lab.stellar.org" target="_blank" rel="noopener" className="link-draw text-[0.9375rem] text-paper">
            Stellar Laboratory
          </a>{" "}
          or any testnet DEX, then add it here.
        </p>
      </Block>

      <Block className="mt-12">
        <details className="group">
          <summary className="t-label inline-flex cursor-pointer list-none items-center gap-2 transition-colors hover:text-paper [&::-webkit-details-marker]:hidden">
            Treasury tools
            <svg
              width="10"
              height="10"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
            >
              <path d="M2.5 4.5 6 8l3.5-3.5" />
            </svg>
          </summary>
          <div className="mt-4">
            <StepButton variant="ghost" action={rebuild} onClick={() => void rebuild.start()}>
              Rebuild from chain
            </StepButton>
            {rebuild.error ? <ErrorNote error={rebuild.error} /> : null}
            {rebuild.value ? (
              <div className="mt-4">
                <RebuildResult result={rebuild.value} />
              </div>
            ) : null}
          </div>
        </details>
      </Block>
    </Panel>
  );
}
