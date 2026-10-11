import { useTranslations } from "next-intl";
import { PageHeading } from "@/components/app/page-heading";
import { SalaryCard } from "./salary-card";
import type { Salaries } from "./salary-card";

export function Intro({ onStart }: { onStart: (amounts: Salaries) => void }) {
  const t = useTranslations("sandbox.intro");
  const promises = [t("promise1"), t("promise2"), t("promise3")];
  return (
    <section className="grid grid-cols-1 gap-y-12 lg:grid-cols-12 lg:gap-x-[4vw]">
      <div className="lg:col-span-6">
        <PageHeading eyebrow={t("eyebrow")} title={t("title")} lead={t("lead")} />
        <ul className="mt-9 flex max-w-[34rem] flex-col gap-4">
          {promises.map((text) => (
            <li key={text} className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-[10px] h-[6px] w-[6px] shrink-0 rounded-full bg-seal" />
              <span className="font-sans text-base text-muted">{text}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="lg:col-span-5 lg:col-start-8">
        <SalaryCard onStart={onStart} />
      </div>
    </section>
  );
}
