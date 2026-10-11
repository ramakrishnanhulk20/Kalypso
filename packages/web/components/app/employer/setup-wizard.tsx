"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ErrorNote } from "@/components/app/error-note";
import { Checkbox, TextField } from "@/components/app/fields";
import { loadEmployer } from "@/components/app/loaders";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { useWallet } from "@/components/app/wallet-session";
import { MAX_LABEL_BYTES, labelBytes } from "./label";
import type { SavedCompany } from "./company-store";

const DISPLAY_36 = { fontVariationSettings: '"opsz" 36' } as const;

function Section({ number, title, locked, children }: { number: number; title: string; locked: boolean; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      // inert keeps a locked section out of the tab order and away from screen readers until it opens.
      inert={locked}
      className={`border-t border-line py-7 first:border-t-0 first:pt-0 last:pb-0 transition-opacity duration-300 motion-reduce:transition-none ${locked ? "opacity-40" : ""}`}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-[0.8125rem] text-muted"
        >
          {number}
        </span>
        <h2 className="font-display text-[1.25rem] font-medium text-fg" style={DISPLAY_36}>
          {title}
        </h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function SetupWizard({ onCreated }: { onCreated: (company: SavedCompany) => void }) {
  const t = useTranslations("employer.wizard");
  const wallet = useWallet();
  const [idText, setIdText] = useState("");
  const [address, setAddress] = useState("");
  const [matches, setMatches] = useState(false);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);

  const check = useAction(async () => {
    const lib = await loadEmployer();
    const trimmed = idText.trim();
    // A value that is not whole digits goes to the lib as NaN, which gives its own refusal sentence.
    const accountantId = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    return lib.checkAccountant({ accountantId, accountant: address.trim() });
  });

  const checked = check.value;
  const bytes = labelBytes(name);
  const nameValid = bytes >= 1 && bytes <= MAX_LABEL_BYTES;
  const nameError = bytes > MAX_LABEL_BYTES || (nameTouched && bytes === 0) ? t("nameError") : null;

  const create = useAction(async (onProgress) => {
    if (!checked) throw new Error(t("notChecked"));
    const lib = await loadEmployer();
    const made = await lib.setUpCompany(
      wallet,
      { accountantId: checked.accountantId, accountant: checked.accountant, accountantKeyHex: checked.keyHex, label: name.trim() },
      onProgress,
    );
    onCreated({ id: made.companyId.toString(), label: made.label });
    return made;
  });

  const accountantChanged = () => {
    check.reset();
    setMatches(false);
  };

  const secondOpen = checked !== undefined && matches;
  const thirdOpen = secondOpen && nameValid;

  return (
    <div className="mx-auto w-full max-w-[640px] rounded-card border border-line bg-raised p-7 sm:p-9" style={{ boxShadow: "var(--shadow-card)" }}>
      <Section number={1} title={t("accountant")} locked={false}>
        <p className="font-sans text-base text-muted">{t("accountantText")}</p>
        <div className="mt-5 flex flex-col gap-4">
          <TextField
            label={t("idLabel")}
            inputMode="numeric"
            value={idText}
            disabled={check.running || create.running}
            onChange={(event) => {
              setIdText(event.target.value);
              accountantChanged();
            }}
          />
          <TextField
            label={t("addressLabel")}
            mono
            placeholder="G..."
            value={address}
            disabled={check.running || create.running}
            onChange={(event) => {
              setAddress(event.target.value);
              accountantChanged();
            }}
          />
        </div>
        <div className="mt-5">
          <StepButton action={check} disabled={create.running} onClick={() => void check.start()}>
            {t("check")}
          </StepButton>
        </div>
        {check.error ? <ErrorNote error={check.error} /> : null}
        {checked ? (
          <div className="mt-5 rounded-button bg-raised-2 p-4">
            <p className="t-label">{t("code")}</p>
            <p className="mt-2 font-mono text-[1.25rem] text-fg">{checked.shortKeyHex}</p>
            <p className="mt-3 font-sans text-[0.9375rem] text-muted">{t("codeText")}</p>
            <Checkbox className="mt-4" label={t("matches")} checked={matches} onChange={(event) => setMatches(event.target.checked)} />
          </div>
        ) : null}
      </Section>

      <Section number={2} title={t("name")} locked={!secondOpen}>
        <TextField
          label={t("nameLabel")}
          value={name}
          error={nameError}
          disabled={create.running}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setNameTouched(true)}
          hint={<span className="t-label">{t("counter", { n: bytes, max: MAX_LABEL_BYTES })}</span>}
        />
      </Section>

      <Section number={3} title={t("create")} locked={!thirdOpen}>
        <p className="font-sans text-base text-muted">{t("createText")}</p>
        <div className="mt-5">
          <StepButton action={create} disabled={!thirdOpen} onClick={() => void create.start()}>
            {t("createButton")}
          </StepButton>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Section>
    </div>
  );
}
