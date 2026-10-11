import { useTranslations } from "next-intl";
import { SealMark } from "@/components/seal-mark";
import { ATTACK_RUN_URL, REPO_URL } from "@/lib/links";

const LINKS: { key: "docs" | "employer" | "worker" | "accountant" | "source" | "attackRun" | "threatModel" | "license"; href: string; sameTab?: boolean }[] = [
  { key: "docs", href: "/docs", sameTab: true },
  { key: "employer", href: "/employer", sameTab: true },
  { key: "worker", href: "/worker", sameTab: true },
  { key: "accountant", href: "/accountant", sameTab: true },
  { key: "source", href: REPO_URL },
  { key: "attackRun", href: ATTACK_RUN_URL },
  { key: "threatModel", href: `${REPO_URL}/blob/main/docs/security/threat-model.md` },
  { key: "license", href: `${REPO_URL}/blob/main/LICENSE` },
];

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

export function SiteFooter() {
  const t = useTranslations("landing.footer");
  return (
    <footer
      className="border-t border-line bg-canvas"
      style={{ padding: "10vh 4vw 6vh" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-12 gap-y-8">
        <div className="flex items-center gap-3">
          <SealMark size={40} />
          <span
            className="font-display text-[2rem] font-medium text-fg"
            style={{
              fontVariationSettings: '"opsz" 36',
              letterSpacing: "-0.01em",
            }}
          >
            Kalypso
          </span>
        </div>
        <p className="t-lead max-w-[28rem]">{t("tagline")}</p>
      </div>

      <nav
        aria-label={t("label")}
        className="mt-[8vh] flex flex-wrap gap-[28px]"
      >
        {LINKS.map((link) => (
          <a
            key={link.key}
            href={link.href}
            {...(link.sameTab ? {} : { target: "_blank", rel: "noopener" })}
            className="link-draw text-[0.9375rem]"
          >
            {t(link.key)}
          </a>
        ))}
      </nav>

      <p className="t-label mt-[5vh]" style={PLAIN_CASE}>
        {t("note")}
      </p>
    </footer>
  );
}
