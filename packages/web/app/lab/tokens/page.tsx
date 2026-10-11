import type { Metadata } from "next";
import { SealMark } from "@/components/seal-mark";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// The swatches read the live tokens, so this sheet shows whichever theme is on.
const SWATCHES = [
  "--color-canvas",
  "--color-raised",
  "--color-raised-2",
  "--color-line",
  "--color-line-strong",
  "--color-fg",
  "--color-muted",
  "--color-faint",
  "--color-seal",
  "--color-seal-hi",
  "--color-seal-hover",
  "--color-seal-deep",
  "--color-on-seal",
  "--color-ok",
  "--color-wait",
  "--color-fail",
  "--color-terminal",
];

export default function Lab() {
  return (
    <main>
      <section className="flex h-screen items-end p-[4vw]">
        <h1 className="t-poster">KALYPSO</h1>
      </section>

      <section className="flex flex-col gap-20 px-[4vw] py-24">
        <div className="flex flex-wrap gap-6">
          {SWATCHES.map((name) => (
            <div key={name} className="flex flex-col gap-2">
              <div
                className="h-[80px] w-[120px] rounded-card border border-line"
                style={{ background: `var(${name})` }}
              />
              <p className="t-label">{name}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-10">
          <p
            className="t-poster"
            style={{ fontSize: "clamp(3rem, 9vw, 9rem)" }}
          >
            Kalypso
          </p>
          <h2 className="t-h2">Try to read the salaries.</h2>
          <p className="t-lead">
            This is a real company&apos;s real October payroll on Stellar
            testnet.
          </p>
          <p className="t-label">Andes Studio (demo) · October 2026 · live</p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <button type="button" className="btn-seal">
            Open the demo
          </button>
          <button type="button" className="btn-ghost">
            Read the docs
          </button>
        </div>

        <div className="flex items-end gap-10">
          <SealMark size={24} />
          <SealMark size={56} />
          <SealMark size={160} />
        </div>
      </section>
    </main>
  );
}
