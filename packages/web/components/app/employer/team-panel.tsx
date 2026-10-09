"use client";

import { useState } from "react";
import { CopyButton } from "@/components/app/copy-button";
import { ErrorNote } from "@/components/app/error-note";
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
import { shortId } from "@/lib/ledger";

type InviteRow = {
  address: string;
  status: "invited" | "already-invited" | "joined" | "refused" | "not-sent";
  txHash?: string;
  reason?: string;
};

const CHIP: Record<InviteRow["status"], { tone: ChipTone; text: string }> = {
  invited: { tone: "wait", text: "invited" },
  "already-invited": { tone: "muted", text: "already invited" },
  joined: { tone: "muted", text: "already joined" },
  refused: { tone: "fail", text: "refused" },
  "not-sent": { tone: "muted", text: "not sent" },
};

// Each address goes in its own call, so a refusal belongs to one row and the rows before it keep
// their result. The lib numbers a one-address call "worker 1 of 1"; the screen uses the real place.
function renumber(sentence: string, index: number, total: number): string {
  return sentence.replace(/(worker )1 of 1/i, `$1${index + 1} of ${total}`);
}

function reasonOf(message: string): string {
  return message.replace(/^Worker 1: /, "").replace(/^Worker 1 is /, "This address is ");
}

export function TeamPanel({ companyId }: { companyId: bigint }) {
  const wallet = useWallet();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<InviteRow[]>([]);

  const invite = useAction(async (onProgress) => {
    const lib = await loadEmployer();
    const addresses = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (addresses.length === 0 || addresses.length > lib.MAX_INVITES) {
      throw new lib.ConsoleError("WORKERS_INVALID", { message: `List 1 to ${lib.MAX_INVITES} worker addresses.` });
    }
    const done: InviteRow[] = [];
    setRows([]);
    for (const [index, address] of addresses.entries()) {
      try {
        const [result] = await lib.inviteWorkers(wallet, { companyId, workers: [address] }, (p) =>
          onProgress({ ...p, sentence: renumber(p.sentence, index, addresses.length) }),
        );
        if (!result) throw new Error("No result.");
        const row: InviteRow = { address, status: result.status === "active" ? "joined" : result.status };
        if (result.txHash) row.txHash = result.txHash;
        done.push(row);
      } catch (err) {
        const shown = describeError(err);
        done.push({ address, status: "refused", reason: reasonOf(shown.message) });
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
    <Panel eyebrow="02" title="Team">
      <Block>
        <TextAreaField
          label="Worker addresses, one per line"
          rows={5}
          value={text}
          disabled={invite.running}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="mt-4">
          <StepButton action={invite} disabled={text.trim() === ""} onClick={() => void invite.start()}>
            Invite
          </StepButton>
        </div>
        {invite.error ? <ErrorNote error={invite.error} /> : null}
        {rows.length > 0 ? (
          <ul className="mt-6 border-t border-line" aria-label="Invites">
            {rows.map((row, index) => (
              <li key={`${row.address}/${index}`} className="border-b border-line py-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <span className="font-mono text-[0.9375rem] text-paper">{shortId(row.address)}</span>
                  <span className="flex items-center gap-4">
                    {row.txHash ? <TxLink hash={row.txHash} /> : null}
                    <RowChip tone={CHIP[row.status].tone}>{CHIP[row.status].text}</RowChip>
                  </span>
                </div>
                {row.reason ? <p className="mt-2 font-sans text-[0.875rem] text-fail">{row.reason}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Block>

      <Block label="Invite link" className="mt-12">
        <div className="flex flex-wrap items-center gap-3">
          <input
            readOnly
            aria-label="Invite link to share"
            value={link}
            onFocus={(event) => event.currentTarget.select()}
            className={`${FIELD} min-w-0 flex-1 font-mono text-[0.9375rem]`}
          />
          <CopyButton text={link} what="invite link" />
        </div>
        <p className="mt-4 max-w-[36rem] font-sans text-[0.9375rem] text-muted">
          Send this link to each worker. They join with Face ID or a wallet, and you never see their keys.
        </p>
      </Block>
    </Panel>
  );
}
