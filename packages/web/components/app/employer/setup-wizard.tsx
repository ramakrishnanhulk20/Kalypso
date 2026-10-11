"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { readAccountantId, saveAccountantId } from "@/components/app/accountant/accountant-store";
import { Checkbox, TextField } from "@/components/app/fields";
import { loadAccountant, loadEmployer } from "@/components/app/loaders";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { useWallet } from "@/components/app/wallet-session";
import { useProgressText } from "./progress-text";
import { ConsoleErrorNote } from "./console-error-note";
import { MAX_LABEL_BYTES, labelBytes } from "./label";
import type { SavedCompany } from "./company-store";

const DISPLAY_36 = { fontVariationSettings: '"opsz" 36' } as const;

export type BooksChoice = "own" | "other";

const CHOICES: readonly BooksChoice[] = ["own", "other"];

// Native radio buttons sharing one name give the arrow-key behaviour of a radiogroup for free.
export function BooksChoiceCards({
  value,
  onChange,
  disabled = false,
  ownTaken = false,
}: {
  value: BooksChoice;
  onChange: (choice: BooksChoice) => void;
  disabled?: boolean;
  /** The treasury is bound to an outside accountant's key number, so own books cannot be chosen. */
  ownTaken?: boolean;
}) {
  const t = useTranslations("employer.wizard");
  return (
    <div role="radiogroup" aria-label={t("accountant")} className="grid gap-3 sm:grid-cols-2">
      {CHOICES.map((choice) => {
        const selected = value === choice;
        const off = disabled || (choice === "own" && ownTaken);
        return (
          <label key={choice} className={`relative block ${off ? "cursor-not-allowed" : "cursor-pointer"} ${choice === "own" && ownTaken ? "opacity-60" : ""}`}>
            <input
              type="radio"
              name="accountant-choice"
              value={choice}
              checked={selected}
              disabled={off}
              onChange={() => onChange(choice)}
              className="peer sr-only"
            />
            <span
              data-choice={choice}
              className={`flex h-full items-start gap-3 rounded-card border p-4 transition-colors duration-200 motion-reduce:transition-none peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-fg ${selected ? "border-seal-hi bg-raised-2" : "border-line hover:border-line-strong"}`}
            >
              <span
                aria-hidden="true"
                className={`mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? "border-seal-hi" : "border-line-strong"}`}
              >
                {selected ? <span className="h-2 w-2 rounded-full bg-seal-hi" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block font-sans text-base text-fg">{choice === "own" ? t("ownChoice") : t("otherChoice")}</span>
                {choice === "own" ? <span className="mt-1 block font-sans text-[0.9375rem] text-muted">{ownTaken ? t("ownTaken") : t("ownChoiceText")}</span> : null}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

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
  const progressText = useProgressText();
  const [choice, setChoice] = useState<BooksChoice>("own");
  // What the chain says about this wallet's treasury. Until it is read, nothing is disabled: the lib
  // refuses own books for an outsider-bound treasury anyway.
  const [treasury, setTreasury] = useState<{ bound: number | null; ownable: boolean } | null>(null);

  useEffect(() => {
    let current = true;
    loadAccountant()
      .then((lib) => lib.readOwnBooksState(wallet))
      .then(
        (state) => {
          if (!current) return;
          setTreasury(state);
          if (!state.ownable) setChoice("other");
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [wallet]);
  const ownTaken = treasury !== null && !treasury.ownable;
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

  // The own-books path makes this wallet its own accountant. The lib runs the same C43 owner and key
  // read the Check button runs for someone else's id, and setUpCompany reads both again before the
  // treasury registers.
  const own = useAction(async (onProgress) => {
    const lib = await loadAccountant();
    const knownId = readAccountantId(wallet.address);
    const made = await lib.keepOwnBooks(wallet, knownId === undefined ? {} : { knownId }, progressText(onProgress));
    // The Accountant page then finds this id instead of registering the same key again.
    saveAccountantId(wallet.address, made.accountantId);
    return made;
  });

  const checked = check.value;
  // There is no confirmation code to tick on the own-books path: the code would be read off this
  // screen and compared with this same screen, because the person is checking against themselves.
  const accountant = choice === "own" ? own.value : matches ? checked : undefined;
  const bytes = labelBytes(name);
  const nameValid = bytes >= 1 && bytes <= MAX_LABEL_BYTES;
  const nameError = bytes > MAX_LABEL_BYTES || (nameTouched && bytes === 0) ? t("nameError") : null;

  const create = useAction(async (onProgress) => {
    if (!accountant) throw new Error(t("notChecked"));
    const lib = await loadEmployer();
    const made = await lib.setUpCompany(
      wallet,
      { accountantId: accountant.accountantId, accountant: accountant.accountant, accountantKeyHex: accountant.keyHex, label: name.trim() },
      progressText(onProgress),
    );
    onCreated({ id: made.companyId.toString(), label: made.label });
    return made;
  });

  const accountantChanged = () => {
    check.reset();
    setMatches(false);
  };

  const busy = check.running || own.running || create.running;
  const secondOpen = accountant !== undefined;
  const thirdOpen = secondOpen && nameValid;

  return (
    <div className="mx-auto w-full max-w-[640px] rounded-card border border-line bg-raised p-7 sm:p-9" style={{ boxShadow: "var(--shadow-card)" }}>
      <Section number={1} title={t("accountant")} locked={false}>
        {treasury !== null && treasury.bound !== null ? <p className="mb-5 font-sans text-[0.9375rem] text-muted">{t("sharedKey")}</p> : null}
        <BooksChoiceCards value={choice} onChange={setChoice} disabled={busy} ownTaken={ownTaken} />
        {choice === "own" ? (
          <div className="mt-6">
            <StepButton action={own} disabled={create.running} onClick={() => void own.start()}>
              {t("ownButton")}
            </StepButton>
            {own.error ? <ConsoleErrorNote error={own.error} /> : null}
            {own.value ? (
              <div role="status" className="mt-5 rounded-button bg-raised-2 p-4">
                <p className="font-sans text-[0.9375rem] text-fg">{t("ownDone", { id: own.value.accountantId })}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-6">
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
            {check.error ? <ConsoleErrorNote error={check.error} /> : null}
            {checked ? (
              <div className="mt-5 rounded-button bg-raised-2 p-4">
                <p className="t-label">{t("code")}</p>
                <p className="mt-2 font-mono text-[1.25rem] text-fg">{checked.shortKeyHex}</p>
                <p className="mt-3 font-sans text-[0.9375rem] text-muted">{t("codeText")}</p>
                <Checkbox className="mt-4" label={t("matches")} checked={matches} onChange={(event) => setMatches(event.target.checked)} />
              </div>
            ) : null}
          </div>
        )}
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
        {create.error ? <ConsoleErrorNote error={create.error} /> : null}
      </Section>
    </div>
  );
}
