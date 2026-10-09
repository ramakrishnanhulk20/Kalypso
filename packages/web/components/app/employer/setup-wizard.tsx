"use client";

import { useState } from "react";
import type { ReactNode } from "react";
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line font-mono text-[0.8125rem] text-muted"
        >
          {number}
        </span>
        <h2 className="font-display text-[1.25rem] font-medium text-paper" style={DISPLAY_36}>
          {title}
        </h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function SetupWizard({ onCreated }: { onCreated: (company: SavedCompany) => void }) {
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
  const nameError =
    bytes > MAX_LABEL_BYTES || (nameTouched && bytes === 0) ? "The company name must be 1 to 64 bytes long." : null;

  const create = useAction(async (onProgress) => {
    if (!checked) throw new Error("The accountant has not been checked.");
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
    <div className="mx-auto w-full max-w-[640px] rounded-card border border-line bg-ink-2 p-7 sm:p-9" style={{ boxShadow: "0 30px 80px rgba(0,0,0,0.45)" }}>
      <Section number={1} title="Your accountant" locked={false}>
        <p className="font-sans text-base text-muted">
          Ask your accountant to open the accountant page, register their key and send you two things: their accountant id and their address.
        </p>
        <div className="mt-5 flex flex-col gap-4">
          <TextField
            label="Accountant id"
            inputMode="numeric"
            value={idText}
            disabled={check.running || create.running}
            onChange={(event) => {
              setIdText(event.target.value);
              accountantChanged();
            }}
          />
          <TextField
            label="Accountant address"
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
            Check
          </StepButton>
        </div>
        {check.error ? <ErrorNote error={check.error} /> : null}
        {checked ? (
          <div className="mt-5 rounded-button bg-ink-3 p-4">
            <p className="t-label">Confirmation code</p>
            <p className="mt-2 font-mono text-[1.25rem] text-paper">{checked.shortKeyHex}</p>
            <p className="mt-3 font-sans text-[0.9375rem] text-muted">
              Ask your accountant to read you the code on their screen. Continue only if it matches.
            </p>
            <Checkbox className="mt-4" label="The code matches" checked={matches} onChange={(event) => setMatches(event.target.checked)} />
          </div>
        ) : null}
      </Section>

      <Section number={2} title="Company name" locked={!secondOpen}>
        <TextField
          label="Name shown on payslips"
          value={name}
          error={nameError}
          disabled={create.running}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setNameTouched(true)}
          hint={<span className="t-label">{bytes}/{MAX_LABEL_BYTES}</span>}
        />
      </Section>

      <Section number={3} title="Create" locked={!thirdOpen}>
        <p className="font-sans text-base text-muted">
          Freighter will ask you to approve two transactions: registering the treasury with the confidential token, and creating the company.
        </p>
        <div className="mt-5">
          <StepButton action={create} disabled={!thirdOpen} onClick={() => void create.start()}>
            Create the company
          </StepButton>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Section>
    </div>
  );
}
