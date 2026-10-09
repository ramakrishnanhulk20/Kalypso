import { useId } from "react";
import type { Ref } from "react";
import type { KeyMode } from "@/hooks/use-sealed-payroll";

// Output of scripts/seal-path.mjs (LENS_RING). Regenerate it there, never compute it at runtime.
const LENS_RING =
  "M173.01 82.51Q174.67 88 175.45 93.81Q176.24 99.62 173.94 105.01Q171.64 110.41 168.6 115.27Q165.55 120.12 163.86 125.47Q162.16 130.82 159.78 136.03Q157.4 141.25 152.83 144.76Q148.26 148.26 143.48 151.17Q138.7 154.07 134.84 158.26Q130.98 162.45 126.45 166.18Q121.93 169.91 116.19 170.86Q110.46 171.81 104.75 171.82Q99.04 171.83 93.52 173.13Q88 174.43 82.25 174.91Q76.5 175.38 71.19 172.96Q65.88 170.55 61.06 167.62Q56.23 164.69 50.79 163.28Q45.36 161.86 39.94 159.78Q34.51 157.7 30.79 153.32Q27.07 148.93 24.05 144.16Q21.03 139.39 16.93 135.39Q12.83 131.4 9.37 126.7Q5.91 122 5.3 116.16Q4.7 110.32 4.94 104.61Q5.19 98.9 3.93 93.45Q2.67 88 2.01 82.3Q1.34 76.59 3.42 71.24Q5.5 65.89 8.11 60.94Q10.71 55.99 11.96 50.4Q13.2 44.82 15.33 39.34Q17.45 33.87 22.04 30.25Q26.64 26.64 31.65 23.87Q36.67 21.11 40.83 17.3Q44.98 13.49 49.7 10.21Q54.42 6.94 60.18 6.3Q65.94 5.67 71.55 5.66Q77.16 5.66 82.58 4.05Q88 2.43 93.76 1.46Q99.52 0.49 104.96 2.45Q110.4 4.41 115.38 7.13Q120.37 9.85 125.86 11.38Q131.36 12.91 136.63 15.33Q141.9 17.76 145.3 22.53Q148.69 27.31 151.34 32.33Q154 37.36 157.89 41.38Q161.79 45.4 165.33 49.95Q168.88 54.5 169.86 60.15Q170.83 65.8 171.09 71.42Q171.35 77.03 173.01 82.51ZM10 88A78 78 0 1 0 166 88A78 78 0 1 0 10 88Z";

const ACCOUNTANT_STOPS = ["#d85a4c", "#c9473a", "#a8392e"];
const STRANGER_STOPS = ["#8a7f78", "#6e645e", "#4e4642"];
const STOP_OFFSETS = ["0%", "70%", "100%"];

type LensRingProps = {
  mode: KeyMode;
  hidden: boolean;
  /** The element moved across the card every frame. */
  positionRef: Ref<HTMLDivElement>;
  /** The element the entrance animation scales and fades. */
  bodyRef: Ref<HTMLDivElement>;
};

export function LensRing({ mode, hidden, positionRef, bodyRef }: LensRingProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const accountantId = `lens-wax-accountant-${id}`;
  const strangerId = `lens-wax-stranger-${id}`;
  const stranger = mode === "stranger";

  return (
    <div
      ref={positionRef}
      className="lens-ring-pos"
      data-hidden={hidden}
      data-lens-ring
    >
      <div ref={bodyRef} className="relative" style={{ opacity: 0 }}>
        <svg
          viewBox="0 0 176 176"
          aria-hidden="true"
          focusable="false"
          className="block overflow-visible"
          style={{
            width: "var(--ring)",
            height: "var(--ring)",
            filter: "drop-shadow(0 18px 30px rgba(0,0,0,0.55))",
          }}
        >
          <defs>
            <radialGradient id={accountantId} cx="38%" cy="32%">
              {ACCOUNTANT_STOPS.map((color, i) => (
                <stop key={color} offset={STOP_OFFSETS[i]} stopColor={color} />
              ))}
            </radialGradient>
            <radialGradient id={strangerId} cx="38%" cy="32%">
              {STRANGER_STOPS.map((color, i) => (
                <stop key={color} offset={STOP_OFFSETS[i]} stopColor={color} />
              ))}
            </radialGradient>
          </defs>
          <g>
            <path
              d={LENS_RING}
              fill={`url(#${accountantId})`}
              fillRule="evenodd"
            />
            <circle
              cx="88"
              cy="88"
              r="78.6"
              fill="none"
              stroke="var(--color-seal-deep)"
              strokeWidth="1.6"
            />
          </g>
          <g
            style={{
              opacity: stranger ? 1 : 0,
              transition: "opacity 300ms ease-out",
            }}
          >
            <path
              d={LENS_RING}
              fill={`url(#${strangerId})`}
              fillRule="evenodd"
            />
            <circle
              cx="88"
              cy="88"
              r="78.6"
              fill="none"
              stroke="#3a3330"
              strokeWidth="1.6"
            />
          </g>
          <path
            d="M10.95 59.95A82 82 0 0 1 59.95 10.95"
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.18"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full"
          style={{
            inset: "5.682%",
            boxShadow: "inset 0 0 26px rgba(0,0,0,0.55)",
          }}
        />
        <span
          className="t-label absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-[6px] bg-ink-3 px-2 py-1 max-md:hidden"
          style={{ lineHeight: 1.4, color: "var(--color-muted)" }}
        >
          {stranger ? "Stranger's key" : "Accountant's key"}
        </span>
      </div>
    </div>
  );
}
