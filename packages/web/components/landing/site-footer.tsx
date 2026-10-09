import { SealMark } from "@/components/seal-mark";
import { ATTACK_RUN_URL, REPO_URL } from "@/lib/links";

const LINKS = [
  { label: "Docs", href: "/docs", sameTab: true },
  { label: "Employer", href: "/employer", sameTab: true },
  { label: "Worker", href: "/worker", sameTab: true },
  { label: "Accountant", href: "/accountant", sameTab: true },
  { label: "Source", href: REPO_URL },
  { label: "Attack run", href: ATTACK_RUN_URL },
  {
    label: "Threat model",
    href: `${REPO_URL}/blob/main/docs/security/threat-model.md`,
  },
  { label: "License: MIT", href: `${REPO_URL}/blob/main/LICENSE` },
];

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

export function SiteFooter() {
  return (
    <footer
      className="border-t border-line bg-ink"
      style={{ padding: "10vh 4vw 6vh" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-12 gap-y-8">
        <div className="flex items-center gap-3">
          <SealMark size={40} />
          <span
            className="font-display text-[2rem] font-medium text-paper"
            style={{
              fontVariationSettings: '"opsz" 36',
              letterSpacing: "-0.01em",
            }}
          >
            Kalypso
          </span>
        </div>
        <p className="t-lead max-w-[28rem]">
          Payroll on Stellar where nobody can read the salaries except the
          people who should.
        </p>
      </div>

      <nav
        aria-label="Footer"
        className="mt-[8vh] flex flex-wrap gap-[28px]"
      >
        {LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            {...(link.sameTab ? {} : { target: "_blank", rel: "noopener" })}
            className="link-draw text-[0.9375rem]"
          >
            {link.label}
          </a>
        ))}
      </nav>

      <p className="t-label mt-[5vh]" style={PLAIN_CASE}>
        Stellar testnet only. Not audited by a security firm. Built for the
        Find Your Way hackathon.
      </p>
    </footer>
  );
}
