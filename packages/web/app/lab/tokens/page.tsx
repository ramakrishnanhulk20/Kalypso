import type { Metadata } from "next";
import { SealMark } from "@/components/seal-mark";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const SWATCHES = [
  { name: "--color-ink", value: "#15100f" },
  { name: "--color-ink-2", value: "#1d1716" },
  { name: "--color-ink-3", value: "#261e1c" },
  { name: "--color-line", value: "rgba(242,236,230,0.10)" },
  { name: "--color-paper", value: "#f2ece6" },
  { name: "--color-muted", value: "#a79c94" },
  { name: "--color-faint", value: "#6e645e" },
  { name: "--color-seal", value: "#c9473a" },
  { name: "--color-seal-hi", value: "#d85a4c" },
  { name: "--color-seal-deep", value: "#8e2e25" },
  { name: "--color-ok", value: "#7fb8a4" },
  { name: "--color-wait", value: "#8e9db3" },
  { name: "--color-fail", value: "#a89be8" },
];

export default function Lab() {
  return (
    <main>
      <section className="flex h-screen items-end p-[4vw]">
        <h1 className="t-poster">KALYPSO</h1>
      </section>

      <section className="flex flex-col gap-20 px-[4vw] py-24">
        <div className="flex flex-wrap gap-6">
          {SWATCHES.map((swatch) => (
            <div key={swatch.name} className="flex flex-col gap-2">
              <div
                className="h-[80px] w-[120px] rounded-card border border-line"
                style={{ background: `var(${swatch.name})` }}
              />
              <p className="t-label">{swatch.name}</p>
              <p className="t-label">{swatch.value}</p>
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
