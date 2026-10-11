"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AnchorPayment, CashOutRecord, CashOutStart, CashOutStatus, WorkerSession } from "@/lib/worker";
import { ErrorNote } from "@/components/app/error-note";
import type { ShownError } from "@/components/app/errors";
import { StepButton } from "@/components/app/step-button";
import { TxLink } from "@/components/app/tx-link";
import { useAction } from "@/components/app/use-action";
import { useLeaveWarning } from "@/components/app/use-leave-warning";
import { ConfirmBox } from "./confirm-box";
import { approvalWindowClosed } from "./expiry";
import { Rise } from "./rise";
import { afterSendFailure } from "./send-outcome";
import { asShown, failureOf, shownErrors, shownFrom } from "./shown";
import type { WorkerKit } from "./worker-lib";

const FINAL: ReadonlySet<CashOutStatus> = new Set(["completed", "refunded", "expired", "no_market", "too_small", "too_large", "error"]);
const POPUP_NAME = "kalypso-anchor";
// No opener, so the anchor page cannot reach this tab. It cannot post to it either: what the page
// shows comes only from the anchor's own record, read by watchCashOut.
const POPUP_FEATURES = "popup,width=480,height=720,noopener,noreferrer";

// The anchor's own window is opened from a tap on the button, because browsers refuse pop-ups that
// do not come from one. When getting the anchor ready takes longer than the tap stays valid, the
// button reads Preparing, then Open the anchor again with the link ready, and the next tap opens it.
// A window opened without an opener gives nothing back to the page, so whether it opened is not known;
// the button stays for another tap.
export function AnchorStep({ kit, worker }: { kit: WorkerKit; worker: WorkerSession }) {
  const t = useTranslations("worker.anchor");
  const locale = useLocale();
  const [anchor, setAnchor] = useState<CashOutStart | null>(null);
  const [status, setStatus] = useState<{ status: CashOutStatus; message: string } | null>(null);
  const [record, setRecord] = useState<CashOutRecord | null>(null);
  const [payment, setPayment] = useState<AnchorPayment | null>(null);
  const [sentHash, setSentHash] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<ShownError | null>(null);
  const [expired, setExpired] = useState(false);
  const watcher = useRef<AbortController | null>(null);
  const watching = useRef(false);

  useEffect(() => () => watcher.current?.abort(), []);

  // The status's sentence from messages in the page's language. An error the anchor explained keeps
  // the anchor's own words on an English page, since the anchor writes them in English.
  const statusText = (s: { status: CashOutStatus; message: string }): string => (s.status === "error" && locale === "en" ? s.message : t(`status.${s.status}`));

  const build = useAction(async (_onProgress, transactionId: string) => {
    const built = await shownErrors(() => kit.lib.buildAnchorPayment(worker, transactionId));
    setPayment(built);
    setExpired(false);
    return built;
  });

  // Follows the anchor's record. It ends at a final status, or when the anchor is ready for the
  // worker's approval, and then builds the payment for the confirm box.
  const follow = useCallback(
    async (info: CashOutStart) => {
      watcher.current?.abort();
      const controller = new AbortController();
      watcher.current = controller;
      watching.current = true;
      setWatchError(null);
      try {
        const found = await kit.lib.watchCashOut(
          worker,
          info.transactionId,
          (next) => {
            if (!controller.signal.aborted) setStatus(next);
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setRecord(found);
        if (found.status === "pending_user_transfer_start") await build.start(info.transactionId);
      } catch (err) {
        if (!controller.signal.aborted) setWatchError(shownFrom(err));
      } finally {
        if (watcher.current === controller) watching.current = false;
      }
    },
    [kit, worker, build.start],
  );

  const openWindow = (info: CashOutStart) => {
    window.open(info.interactiveUrl, POPUP_NAME, POPUP_FEATURES);
  };

  const prepare = useAction(async (onProgress) => {
    onProgress({ sentence: t("preparing"), done: 0, total: 1 });
    const info = await shownErrors(() => kit.lib.startCashOut(worker));
    setAnchor(info);
    // A tap stays valid for a few seconds only. When it has run out, the button offers the next tap.
    if (navigator.userActivation?.isActive !== false) {
      openWindow(info);
      void follow(info);
    }
    return info;
  });

  const approve = useAction(async (onProgress) => {
    if (payment === null || anchor === null) throw asShown(new kit.lib.WorkerError("INVALID_INPUT"));
    onProgress({ sentence: t("sending"), done: 0, total: 1 });
    try {
      const { hash } = await shownErrors(() => kit.lib.sendAnchorPayment(worker, payment));
      setSentHash(hash);
      setPayment(null);
      void follow(anchor);
      return hash;
    } catch (err) {
      const failure = failureOf(err);
      const after = afterSendFailure(failure, approvalWindowClosed(payment.xdr, kit.networkPassphrase, Date.now()));
      if (after.next === "follow") {
        // The payment is already on its way, so the screen goes back to following the anchor's record.
        if (after.hash !== undefined) setSentHash(after.hash);
        setPayment(null);
        void follow(anchor);
      } else if (after.next === "expired") {
        setExpired(true);
      }
      throw err;
    }
  });
  useLeaveWarning(approve.running);

  const finished = status !== null && FINAL.has(status.status);
  const completed = status?.status === "completed";
  // Until the anchor notices a payment that was sent, its record still says it is ready for one.
  const awaitingNotice = sentHash !== null && status?.status === "pending_user_transfer_start";

  const onOpen = () => {
    if (anchor === null) {
      void prepare.start();
      return;
    }
    openWindow(anchor);
    if (!watching.current && !finished && payment === null) void follow(anchor);
  };

  const reset = () => {
    watcher.current?.abort();
    watching.current = false;
    setAnchor(null);
    setStatus(null);
    setRecord(null);
    setPayment(null);
    setSentHash(null);
    setWatchError(null);
    setExpired(false);
    prepare.reset();
    approve.reset();
    build.reset();
  };

  const prepareError = prepare.error;
  const approveNote =
    !expired && approve.error ? (
      <div>
        <ErrorNote error={approve.error} />
        {approve.error.code === "ANCHOR_RECORD_CHANGED" ? (
          <button type="button" className="btn-ghost mt-4" onClick={reset}>
            {t("startAgain")}
          </button>
        ) : null}
      </div>
    ) : null;
  const paymentHash = sentHash ?? record?.stellarTransactionId ?? null;

  return (
    <div>
      {finished ? null : <p className="mb-4 max-w-[36rem] font-sans text-[0.9375rem] text-muted">{t("windowNote")}</p>}
      {finished ? null : (
        <StepButton action={{ running: prepare.running, progress: prepare.progress, flash: false }} disabled={prepare.running} onClick={onOpen}>
          {t("open")}
        </StepButton>
      )}
      {prepareError ? <ErrorNote error={prepareError} /> : null}

      <div role="status" aria-live="polite">
        {status && !awaitingNotice ? (
          <p className={`mt-4 font-sans text-[0.9375rem] ${completed ? "text-fg" : finished ? "text-fail" : "text-muted"}`}>{statusText(status)}</p>
        ) : null}
      </div>

      {paymentHash !== null && (sentHash !== null || completed) ? (
        <p className="mt-3 flex items-center gap-3">
          <span className="t-label">{t("payment")}</span>
          <TxLink hash={paymentHash} />
        </p>
      ) : null}
      {record?.moreInfoUrl ? (
        <a href={record.moreInfoUrl} target="_blank" rel="noopener noreferrer" className="link-draw mt-3 text-[0.9375rem]">
          {t("more")}
        </a>
      ) : null}
      {finished ? (
        <button type="button" className="btn-ghost mt-4" onClick={reset}>
          {completed ? t("cashOutAgain") : t("startAgain")}
        </button>
      ) : null}

      {watchError ? (
        <div>
          <ErrorNote error={watchError} />
          {anchor !== null ? (
            <button type="button" className="btn-ghost mt-4" onClick={() => void follow(anchor)}>
              {t("checkAgain")}
            </button>
          ) : null}
        </div>
      ) : null}

      {payment !== null && !finished ? (
        <Rise>
          <ConfirmBox payment={payment} fee={record?.amountFee ?? null} receive={record?.amountOut ?? null}>
            {expired ? (
              <div>
                <p role="alert" className="font-sans text-[0.9375rem] text-fail">
                  {t("expired")}
                </p>
                <div className="mt-4">
                  <StepButton action={{ running: build.running, progress: build.progress, flash: false }} onClick={() => anchor && void build.start(anchor.transactionId)}>
                    {t("buildAgain")}
                  </StepButton>
                </div>
                {build.error ? <ErrorNote error={build.error} /> : null}
              </div>
            ) : (
              <div>
                <StepButton action={{ running: approve.running, progress: approve.progress, flash: false }} className="max-sm:w-full" onClick={() => void approve.start()}>
                  {t("approve")}
                </StepButton>
                {approveNote}
              </div>
            )}
          </ConfirmBox>
        </Rise>
      ) : null}

      {payment === null && !finished ? approveNote : null}
      {payment === null && !finished && build.error ? (
        <div>
          <ErrorNote error={build.error} />
          {anchor !== null ? (
            <div className="mt-4">
              <StepButton action={{ running: build.running, progress: build.progress, flash: false }} onClick={() => void build.start(anchor.transactionId)}>
                {t("buildAgain")}
              </StepButton>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
