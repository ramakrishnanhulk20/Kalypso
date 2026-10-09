import { PageHeading } from "@/components/app/page-heading";
import { SalaryCard } from "./salary-card";
import type { Salaries } from "./salary-card";

const PROMISES = [
  "Every step is a real testnet transaction you can open on stellar.expert.",
  "The keys live only in this browser. Close the tab and come back to resume.",
  "Free test XLM comes from Stellar's friendbot; nothing here costs real money.",
];

export function Intro({ onStart }: { onStart: (amounts: Salaries) => void }) {
  return (
    <section className="grid grid-cols-1 gap-y-12 lg:grid-cols-12 lg:gap-x-[4vw]">
      <div className="lg:col-span-6">
        <PageHeading
          eyebrow="Sandbox · Stellar testnet"
          title="Run a real payroll in three minutes."
          lead="Your browser creates a company, its accountant and three workers on Stellar testnet, funds them with test money, and pays the team through Kalypso with real zero-knowledge proofs. No wallet, no sign-up. Then you open the payroll as each of them."
        />
        <ul className="mt-9 flex max-w-[34rem] flex-col gap-4">
          {PROMISES.map((text) => (
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
