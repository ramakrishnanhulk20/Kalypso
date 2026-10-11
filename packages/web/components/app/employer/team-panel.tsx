"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CopyButton } from "@/components/app/copy-button";
import { describeError } from "@/components/app/errors";
import { FIELD, TextAreaField } from "@/components/app/fields";
import { loadEmployer } from "@/components/app/loaders";
import { Block, Panel } from "@/components/app/panel";
import { RowChip } from "@/components/app/row-chip";
import type { ChipTone } from "@/components/app/row-chip";
import { StepButton } from "@/components/app/step-button";
import { TxLink } from "@/components/app/tx-link";
import { useAction } from "@/components/app/use-action";
import { useWallet } from "@/components/app/wallet-session";
import { useProgressText } from "./progress-text";
import { useErrorText } from "@/lib/i18n/errors";
import { shortId } from "@/lib/ledger";
import { ConsoleErrorNote } from "./console-error-note";

type InviteRow = {
  address: string;
  status: "invited" | "already-invited" | "joined" | "refused" | "not-sent";
  txHash?: string;
  reason?: string;
};

const TONE: Record<InviteRow["status"], ChipTone> = {
  invited: "wait",
  "already-invited": "muted",
  joined: "muted",
  refused: "fail",
  "not-sent": "muted",
};

// Each address goes in its own call, so a refusal belongs to one row and the rows before it keep
// their result. The lib numbers a one-address call "worker 1 of 1"; the screen uses the real place.
// The lib's English reason names "Worker 1"; on a list the row already says which address.
function reasonOf(message: string): string {
  return message.replace(/^Worker 1: /, "").replace(/^Worker 1 is /, "This address is ");
}

export function TeamPanel({ companyId }: { companyId: bigint }) {
  const t = useTranslations("employer.team");
  const locale = useLocale();
  const errorText = useErrorText();
  const wallet = useWallet();
  const progressText = useProgressText();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<InviteRow[]>([]);
  const chipText = {
    invited: t("invited"),
    "already-invited": t("alreadyInvited"),
    joined: t("alreadyJoined"),
    refused: t("refused"),
    "not-sent": t("notSent"),
  };

  const invite = useAction(async (onProgress) => {
    const lib = await loadEmployer();
    const addresses = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (addresses.length === 0 || addresses.length > lib.MAX_INVITES) {
      throw new lib.ConsoleError("WORKERS_INVALID", { message: t("listSize", { max: lib.MAX_INVITES }) });
    }
    const done: InviteRow[] = [];
    setRows([]);
    for (const [index, address] of addresses.entries()) {
      try {
        // Each address is invited on its own, so the lib counts "1 of 1"; the list's own count replaces it.
        const [result] = await lib.inviteWorkers(wallet, { companyId, workers: [address] }, (p) =>
          progressText(onProgress)({ ...p, values: { ...p.values, n: index + 1, total: addresses.length } }),
        );
        if (!result) throw new Error("No result.");
        const row: InviteRow = { address, status: result.status === "active" ? "joined" : result.status };
        if (result.txHash) row.txHash = result.txHash;
        done.push(row);
      } catch (err) {
        const shown = describeError(err);
        done.push({ address, status: "refused", reason: locale === "en" ? reasonOf(shown.message) : errorText(shown) });
        // A line the lib refused to read sent nothing, so the rest can go on. Anything else (a
        // declined signature, the network) would only repeat for every line after it.
        if (shown.code !== "WORKERS_INVALID") {
          for (const rest of addresses.slice(index + 1)) done.push({ address: rest, status: "not-sent" });
          setRows([...done]);
          break;
        }
      }
      setRows([...done]);
    }
    return done;
  });

  const link = `${window.location.origin}/worker?company=${companyId}`;

  return (
    <Panel eyebrow={t("eyebrow")} title={t("title")}>
      <Block>
        <TextAreaField
          label={t("addresses")}
          rows={5}
          value={text}
          disabled={invite.running}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="mt-4">
          <StepButton action={invite} disabled={text.trim() === ""} onClick={() => void invite.start()}>
            {t("invite")}
          </StepButton>
        </div>
        {invite.error ? <ConsoleErrorNote error={invite.error} /> : null}
        {rows.length > 0 ? (
          <ul className="mt-6 border-t border-line" aria-label={t("invitesLabel")}>
            {rows.map((row, index) => (
              <li key={`${row.address}/${index}`} className="border-b border-line py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <span className="font-mono text-[0.9375rem] text-fg">{shortId(row.address)}</span>
                  <span className="flex items-center gap-4">
                    {row.txHash ? <TxLink hash={row.txHash} /> : null}
                    <RowChip tone={TONE[row.status]}>{chipText[row.status]}</RowChip>
                  </span>
                </div>
                {row.reason ? <p className="mt-2 font-sans text-[0.875rem] text-fail">{row.reason}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Block>

      <Block label={t("linkLabel")} className="mt-12">
        <div className="flex flex-wrap items-center gap-3">
          <input
            readOnly
            aria-label={t("linkAria")}
            value={link}
            onFocus={(event) => event.currentTarget.select()}
            className={`${FIELD} min-w-0 flex-1 font-mono text-[0.9375rem]`}
          />
          <CopyButton text={link} what={t("linkWhat")} />
        </div>
        <p className="mt-4 max-w-[36rem] font-sans text-[0.9375rem] text-muted">{t("linkText")}</p>
      </Block>
    </Panel>
  );
}
