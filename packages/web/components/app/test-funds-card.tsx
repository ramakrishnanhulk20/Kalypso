"use client";

import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { formatUsdc } from "@kalypso/core";
import { FaucetError, claimTestFunds } from "@/lib/faucet";
import type { FaucetAsset, FaucetCode } from "@/lib/faucet";
import type { WalletPort } from "@/lib/wallet/port";
import { ErrorNote } from "./error-note";
import type { ShownError } from "./errors";
import { loadEmployer } from "./loaders";
import { StepButton } from "./step-button";
import { TxLink } from "./tx-link";
import { useAction } from "./use-action";

const DISPLAY_36 = { fontVariationSettings: '"opsz" 36' } as const;
const ROOT_ID = "test-funds";
// The site nav is fixed to the top, so a jump to the card stops below it.
const ROOT_STYLE = { scrollMarginTop: 96 } as const;

type ChainState = { account: boolean; trustline: boolean } | null;

/** Reads whether the account exists and whether it can hold USDC, from the ledger. Null when the read fails. */
async function readChain(address: string): Promise<ChainState> {
  try {
    const { ledger } = (await loadEmployer()).consoleContext();
    const xlm = await ledger.xlmBalance(address);
    if (xlm === null) return { account: false, trustline: false };
    return { account: true, trustline: (await ledger.usdcBalance(address)) !== null };
  } catch {
    return null;
  }
}

/**
 * Whether the card should start open: the account is not on testnet yet, or, when USDC is among the
 * assets, it holds none. Null until the read is done; a read that fails counts as "no".
 */
export function useFundsNeed(address: string, assets: readonly FaucetAsset[]): boolean | null {
  const [need, setNeed] = useState<boolean | null>(null);
  const wantsUsdc = assets.includes("usdc");
  useEffect(() => {
    let current = true;
    setNeed(null);
    loadEmployer()
      .then(async (lib) => {
        const { ledger } = lib.consoleContext();
        if ((await ledger.xlmBalance(address)) === null) return true;
        if (!wantsUsdc) return false;
        const usdc = await ledger.usdcBalance(address);
        return usdc === null || usdc === 0n;
      })
      .then(
        (value) => current && setNeed(value),
        () => current && setNeed(false),
      );
    return () => {
      current = false;
    };
  }, [address, wantsUsdc]);
  return need;
}

function Check() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
      style={{ color: "var(--color-ok)" }}
    >
      <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
    </svg>
  );
}

function Row({ title, sub, action, children }: { title: string; sub: string; action: ReactNode; children?: ReactNode }) {
  return (
    <li className="border-t border-line py-4 first:border-t-0">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-sans text-base text-fg">{title}</h3>
          <p className="mt-1 font-sans text-[0.9375rem] text-muted">{sub}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">{action}</div>
      </div>
      {children}
    </li>
  );
}

/** A refusal as the shape ErrorNote shows. The key and values let every other language look the sentence up by code. */
function shownFaucetError(code: FaucetCode, message: string, values: Record<string, string>): ShownError {
  return { message, code, family: undefined, key: `testFunds.errors.${code}`, values, rebuildable: false, damaged: false, kind: "FaucetError" };
}

const ASSET_NAMES: Record<FaucetAsset, string> = { xlm: "XLM", usdc: "USDC" };

// These two are not failures to report: they are the next step, shown as a button and a hint.
const NEXT_STEP_CODES: ReadonlySet<FaucetCode> = new Set(["no_account", "no_trustline"]);

type Claim = { error: ShownError | null; cause: unknown; state: { phase: string } };

/** After this long a claim's button says it is waiting for the network, not sending. */
export const CONFIRMING_AFTER_MS = 10_000;

const BALANCE_LOOKS = 4;
const BALANCE_GAP_MS = 2_500;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The wallet's balance once this browser's own read shows the payout in it: at least `amount`
 * more than before the claim, where null (no account, or no USDC line) counts as zero. It looks a
 * few times, since the read can trail the chain by a ledger or two, and a failed read is just one
 * look. Null when the funds never show, so the screen says the payout is not confirmed yet rather
 * than that it arrived (C55).
 */
export async function balanceShowing(
  read: () => Promise<bigint | null>,
  before: bigint | null,
  amount: bigint,
  wait: (ms: number) => Promise<void> = sleep,
  looks = BALANCE_LOOKS,
): Promise<bigint | null> {
  for (let look = 1; look <= looks; look++) {
    try {
      const now = await read();
      if (now !== null && now - (before ?? 0n) >= amount) return now;
    } catch {
      /* the next look may answer */
    }
    if (look < looks) await wait(BALANCE_GAP_MS);
  }
  return null;
}

type Step = { sentence: string; done: number; total: number };

/** Runs `work` with the sending sentence on the button, and switches to the confirming one if it is still running after CONFIRMING_AFTER_MS. */
export async function withConfirmingLabel<T>(onProgress: (p: Step) => void, sentences: { sending: string; confirming: string }, work: () => Promise<T>): Promise<T> {
  onProgress({ sentence: sentences.sending, done: 0, total: 1 });
  const later = setTimeout(() => onProgress({ sentence: sentences.confirming, done: 0, total: 1 }), CONFIRMING_AFTER_MS);
  try {
    return await work();
  } finally {
    clearTimeout(later);
  }
}

/** The hash of a payout the server sent but could not yet see on chain, or null. */
function unconfirmedHash(action: Claim): string | null {
  const cause = action.cause;
  if (action.state.phase !== "failed" || !(cause instanceof FaucetError) || cause.code !== "payout_unconfirmed") return null;
  return cause.hash ?? null;
}

/** Not a failure: the money may still arrive, so the sentence says so and links the payout to check. */
export function UnconfirmedNote({ hash }: { hash: string }) {
  const t = useTranslations("testFunds");
  return (
    <p role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[0.9375rem] text-fg">
      <span>{t("errors.payout_unconfirmed")}</span>
      <TxLink hash={hash} />
    </p>
  );
}

/**
 * Free test money, one click per asset. `open` says whether the card starts open; once open it stays
 * open, so a success line is never taken away by the balance it just changed. `anchor` is true for
 * the one card that owns the #test-funds link; a copy shown under an error passes false.
 */
export function TestFundsCard({
  address,
  assets,
  wallet,
  open,
  onFunded,
  anchor = true,
}: {
  address: string;
  assets: ("xlm" | "usdc")[];
  wallet?: WalletPort;
  open: boolean;
  onFunded?: () => void;
  anchor?: boolean;
}) {
  const t = useTranslations("testFunds");
  const headingId = useId();
  const [shown, setShown] = useState(open);
  const [noAccount, setNoAccount] = useState(false);
  const [trustlineMissing, setTrustlineMissing] = useState(false);
  const wantsXlm = assets.includes("xlm");
  const wantsUsdc = assets.includes("usdc");

  useEffect(() => {
    if (open) setShown(true);
  }, [open]);

  // A link to #test-funds anywhere on the page opens the card, whether it starts folded or not.
  useEffect(() => {
    if (!anchor) return;
    const reveal = () => {
      if (window.location.hash === `#${ROOT_ID}`) setShown(true);
    };
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(`a[href="#${ROOT_ID}"]`)) setShown(true);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", reveal);
      document.removeEventListener("click", onClick);
    };
  }, [anchor]);

  const apply = (chain: ChainState) => {
    if (chain === null) return;
    setNoAccount(!chain.account);
    setTrustlineMissing(chain.account && !chain.trustline);
  };

  useEffect(() => {
    if (!shown || !wantsUsdc) return;
    let current = true;
    void readChain(address).then((chain) => current && apply(chain));
    return () => {
      current = false;
    };
  }, [shown, wantsUsdc, address]);

  const claim = (asset: FaucetAsset) => async (onProgress: (p: Step) => void) =>
    withConfirmingLabel(onProgress, { sending: t("sending"), confirming: t("confirming") }, async () => {
      const { ledger } = (await loadEmployer()).consoleContext();
      const read = () => (asset === "xlm" ? ledger.xlmBalance(address) : ledger.usdcBalance(address));
      // Unknown when this read fails: then no later read can show the payout, and the note says so.
      const before = await read().then(
        (value) => ({ value }),
        () => undefined,
      );
      try {
        const paid = await claimTestFunds(address, asset);
        if (asset === "xlm") void readChain(address).then(apply);
        else {
          setNoAccount(false);
          setTrustlineMissing(false);
        }
        const balance = before === undefined ? null : await balanceShowing(read, before.value, paid.amount);
        onFunded?.();
        return { ...paid, balance };
      } catch (err) {
        if (err instanceof FaucetError && asset === "usdc") {
          if (err.code === "no_account") setNoAccount(true);
          if (err.code === "no_trustline") {
            setNoAccount(false);
            setTrustlineMissing(true);
          }
          // A line that exists but cannot take the payout has its own fix, said in its own sentence.
          if (err.code === "trustline_full" || err.code === "trustline_unauthorized") {
            setNoAccount(false);
            setTrustlineMissing(false);
          }
        }
        throw err;
      }
    });
  const xlm = useAction(claim("xlm"));
  const usdc = useAction(claim("usdc"));

  const addUsdc = useAction(async (onProgress) => {
    if (!wallet) throw new Error(t("errors.unknown"));
    const lib = await loadEmployer();
    const line = await lib.ensureUsdcTrustline(wallet, (p) => onProgress({ ...p, sentence: t("addingUsdc") }));
    setTrustlineMissing(false);
    return line;
  });

  const errorOf = (action: Claim, asset: FaucetAsset): ShownError | null => {
    if (action.state.phase !== "failed" || unconfirmedHash(action) !== null) return null;
    if (action.cause instanceof FaucetError) {
      // Only already_claimed names the asset; the other sentences ignore the value.
      const values = { asset: ASSET_NAMES[asset] };
      return NEXT_STEP_CODES.has(action.cause.code) ? null : shownFaucetError(action.cause.code, t(`errors.${action.cause.code}`, values), values);
    }
    return action.error;
  };

  if (!shown) {
    return (
      <div id={anchor ? ROOT_ID : undefined} style={ROOT_STYLE}>
        <button type="button" className="link-draw text-[0.9375rem]" onClick={() => setShown(true)}>
          {t("open")}
        </button>
      </div>
    );
  }

  const amountOf = (value: { amount: bigint } | undefined) => (value ? formatUsdc(value.amount) : "");
  const addStep = wantsUsdc && wallet !== undefined && trustlineMissing && !noAccount;

  return (
    <section
      id={anchor ? ROOT_ID : undefined}
      aria-labelledby={headingId}
      className="rounded-card border border-line bg-raised p-6"
      style={ROOT_STYLE}
    >
      <p className="t-label">{t("label")}</p>
      <h2 id={headingId} className="mt-3 font-display text-[1.5rem] font-medium leading-[1.15] text-fg" style={DISPLAY_36}>
        {t("title")}
      </h2>
      <p className="mt-2 max-w-[36rem] font-sans text-[0.9375rem] text-muted">{t("lead")}</p>

      <ul className="mt-5">
        {wantsXlm ? (
          <Row
            title={t("xlm.title")}
            sub={t("xlm.sub")}
            action={
              <StepButton action={xlm} className="max-sm:w-full" onClick={() => void xlm.start()}>
                {t("xlm.button")}
              </StepButton>
            }
          >
            {xlm.value && xlm.value.balance !== null ? (
              <p role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[0.9375rem] text-fg">
                <Check />
                <span>{t("xlm.added", { amount: amountOf(xlm.value), balance: formatUsdc(xlm.value.balance) })}</span>
                <TxLink hash={xlm.value.hash} />
              </p>
            ) : null}
            {xlm.value && xlm.value.balance === null ? <UnconfirmedNote hash={xlm.value.hash} /> : null}
            {unconfirmedHash(xlm) ? <UnconfirmedNote hash={unconfirmedHash(xlm)!} /> : null}
            {errorOf(xlm, "xlm") ? <ErrorNote error={errorOf(xlm, "xlm")!} /> : null}
          </Row>
        ) : null}

        {wantsUsdc ? (
          <Row
            title={t("usdc.title")}
            sub={t("usdc.sub")}
            action={
              addStep ? (
                <StepButton action={addUsdc} className="max-sm:w-full" onClick={() => void addUsdc.start()}>
                  {t("usdc.addButton")}
                </StepButton>
              ) : (
                <StepButton action={usdc} className="max-sm:w-full" onClick={() => void usdc.start()}>
                  {t("usdc.button")}
                </StepButton>
              )
            }
          >
            {addStep ? <p className="mt-3 font-sans text-[0.9375rem] text-muted">{t("errors.no_trustline")}</p> : null}
            {noAccount ? <p className="mt-3 font-sans text-[0.9375rem] text-muted">{t("errors.no_account")}</p> : null}
            {usdc.value && usdc.value.balance !== null ? (
              <p role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-[0.9375rem] text-fg">
                <Check />
                <span>{t("usdc.added", { amount: amountOf(usdc.value), balance: formatUsdc(usdc.value.balance) })}</span>
                <TxLink hash={usdc.value.hash} />
              </p>
            ) : null}
            {usdc.value && usdc.value.balance === null ? <UnconfirmedNote hash={usdc.value.hash} /> : null}
            {unconfirmedHash(usdc) ? <UnconfirmedNote hash={unconfirmedHash(usdc)!} /> : null}
            {errorOf(usdc, "usdc") ? <ErrorNote error={errorOf(usdc, "usdc")!} /> : null}
            {addUsdc.error ? <ErrorNote error={addUsdc.error} /> : null}
          </Row>
        ) : null}
      </ul>
    </section>
  );
}
