"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "@/components/app/copy-button";
import { ErrorNote } from "@/components/app/error-note";
import { Block, Panel } from "@/components/app/panel";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { loadAccountant } from "@/components/app/loaders";
import { useWallet } from "@/components/app/wallet-session";
import { readAccountantId, saveAccountantId } from "./accountant-store";

function CodeBox({ code }: { code: string }) {
  return (
    <div className="mt-6 rounded-button bg-ink-3 p-4">
      <p className="t-label">Confirmation code</p>
      <p className="mt-2 font-mono text-[1.25rem] text-paper">{code}</p>
    </div>
  );
}

function ShareRow({ label, value, what, mono = false }: { label: string; value: string; what: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <p className="font-sans text-[0.9375rem] text-muted">{label}</p>
        <p className={`mt-1 break-all text-paper ${mono ? "font-mono text-[0.9375rem]" : "font-display text-[1.25rem] font-medium"}`}>{value}</p>
      </div>
      <CopyButton text={value} what={what} />
    </div>
  );
}

export function KeyPanel() {
  const wallet = useWallet();
  const [knownId, setKnownId] = useState<number | undefined>(undefined);

  useEffect(() => {
    setKnownId(readAccountantId(wallet.address));
  }, [wallet.address]);

  const derive = useAction(async (onProgress) => {
    const lib = await loadAccountant();
    return lib.deriveAccountantKey(wallet, onProgress);
  });

  const register = useAction(async (onProgress) => {
    const lib = await loadAccountant();
    const registered = await lib.registerAccountantKey(wallet, knownId === undefined ? {} : { knownId }, onProgress);
    saveAccountantId(wallet.address, registered.accountantId);
    setKnownId(registered.accountantId);
    return registered;
  });

  const code = register.value?.shortKeyHex ?? derive.value?.shortKeyHex;

  return (
    <Panel eyebrow="01" title="Your key">
      <Block>
        <StepButton action={derive} onClick={() => void derive.start()}>
          Derive my key
        </StepButton>
        <p className="mt-3 max-w-[34rem] font-sans text-[0.9375rem] text-muted">
          Freighter asks you to sign the same message twice; that proves your wallet always rebuilds the same key.
        </p>
        {derive.error ? <ErrorNote error={derive.error} /> : null}
        {code ? <CodeBox code={code} /> : null}
      </Block>

      <Block className="mt-12">
        <StepButton action={register} onClick={() => void register.start()}>
          Register my key
        </StepButton>
        {register.error ? <ErrorNote error={register.error} /> : null}
        {register.value ? (
          <div className="mt-6 rounded-card border border-line bg-ink-2 p-6">
            <p className="t-label mb-4">Give these to the employer</p>
            <ShareRow label="Accountant id" value={String(register.value.accountantId)} what="accountant id" />
            <ShareRow label="Address" value={register.value.address} what="address" mono />
            <p className="mt-4 border-t border-line pt-4 font-sans text-[0.9375rem] text-muted">
              Read them this code if they ask: <span className="font-mono text-paper">{register.value.shortKeyHex}</span>
            </p>
          </div>
        ) : null}
      </Block>
    </Panel>
  );
}
