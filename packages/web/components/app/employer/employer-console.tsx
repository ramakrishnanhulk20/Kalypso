"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ErrorNote } from "@/components/app/error-note";
import { TextField, SelectField } from "@/components/app/fields";
import { StepButton } from "@/components/app/step-button";
import { useAction } from "@/components/app/use-action";
import { useWallet } from "@/components/app/wallet-session";
import { companyIdFrom, readAdminCompany } from "./company-read";
import { readCompanies, saveCompany } from "./company-store";
import type { SavedCompany } from "./company-store";
import { Dashboard } from "./dashboard";
import { SetupWizard } from "./setup-wizard";

type View = "dashboard" | "wizard";

function OpenById({ onOpened, intro }: { onOpened: (company: SavedCompany) => void; intro?: string }) {
  const t = useTranslations("employer");
  const wallet = useWallet();
  const [text, setText] = useState("");
  const open = useAction(async () => {
    const companyId = await companyIdFrom(text);
    const company = await readAdminCompany(wallet, companyId);
    onOpened({ id: companyId.toString(), label: company.label });
    setText("");
  });

  return (
    <form
      className="w-full max-w-[22rem]"
      onSubmit={(event) => {
        event.preventDefault();
        void open.start();
      }}
    >
      {intro ? <p className="mb-4 font-sans text-base text-muted">{intro}</p> : null}
      <div className="flex items-end gap-3">
        <TextField
          label={t("openById")}
          inputMode="numeric"
          value={text}
          disabled={open.running}
          onChange={(event) => setText(event.target.value)}
          frameClassName="min-w-0 flex-1"
        />
        <StepButton variant="ghost" action={open} disabled={text.trim() === ""} onClick={() => void open.start()}>
          {t("open")}
        </StepButton>
      </div>
      {open.error ? <ErrorNote error={open.error} /> : null}
    </form>
  );
}

export function EmployerConsole() {
  const t = useTranslations("employer");
  const wallet = useWallet();
  const [companies, setCompanies] = useState<SavedCompany[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("dashboard");

  useEffect(() => {
    const list = readCompanies(wallet.address);
    setCompanies(list);
    setSelected(list[0]?.id ?? null);
    setView(list.length > 0 ? "dashboard" : "wizard");
  }, [wallet.address]);

  if (companies === null) return <div style={{ minHeight: "40vh" }} />;

  const adopt = (company: SavedCompany) => {
    setCompanies(saveCompany(wallet.address, company));
    setSelected(company.id);
    setView("dashboard");
  };

  const current = companies.find((company) => company.id === selected);

  return (
    <>
      {companies.length > 0 ? (
        <div className="mb-[6vh] flex flex-wrap items-end gap-x-8 gap-y-5">
          <SelectField
            label={t("company")}
            value={selected ?? ""}
            onChange={(event) => {
              setSelected(event.target.value);
              setView("dashboard");
            }}
            frameClassName="w-full max-w-[22rem]"
          >
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {t("companyOption", { label: company.label, id: company.id })}
              </option>
            ))}
          </SelectField>
          <button type="button" className="link-draw pb-3 text-[0.9375rem]" onClick={() => setView("wizard")}>
            {t("setupAnother")}
          </button>
          <OpenById onOpened={adopt} />
        </div>
      ) : null}

      {view === "wizard" || current === undefined ? (
        <>
          <h1 className="sr-only">{t("srSetup")}</h1>
          <SetupWizard onCreated={adopt} />
          {companies.length === 0 ? (
            <div className="mx-auto mt-10 w-full max-w-[640px]">
              <OpenById onOpened={adopt} intro={t("alreadyHave")} />
            </div>
          ) : null}
        </>
      ) : (
        <Dashboard key={current.id} company={current} />
      )}
    </>
  );
}
