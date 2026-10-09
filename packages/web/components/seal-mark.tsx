import { useId } from "react";

// Output of scripts/seal-path.mjs. Regenerate it there, never compute it at runtime.
const WAX_BODY =
  "M59.44 30.26Q60.5 32 61.22 33.97Q61.94 35.94 60.71 37.65Q59.47 39.36 57.98 40.75Q56.49 42.14 56.25 44Q56.01 45.86 55.53 47.78Q55.05 49.69 53.22 50.54Q51.38 51.38 49.61 52.01Q47.84 52.64 46.91 54.43Q45.99 56.22 44.72 57.94Q43.46 59.66 41.43 59.63Q39.39 59.6 37.46 59.17Q35.52 58.73 33.76 59.53Q32 60.32 30.07 60.81Q28.14 61.3 26.5 59.98Q24.86 58.66 23.49 57.25Q22.12 55.84 20.19 55.82Q18.27 55.79 16.2 55.53Q14.14 55.28 13.12 53.58Q12.11 51.89 11.4 50.12Q10.69 48.35 8.96 47.32Q7.23 46.3 5.72 44.91Q4.2 43.52 4.49 41.41Q4.78 39.29 5.4 37.36Q6.03 35.42 5.27 33.71Q4.5 32 3.88 30.11Q3.25 28.21 4.31 26.54Q5.38 24.87 6.55 23.4Q7.71 21.94 7.61 19.9Q7.51 17.86 7.8 15.76Q8.09 13.65 9.94 12.72Q11.79 11.79 13.74 11.27Q15.69 10.75 16.84 9.24Q17.99 7.73 19.39 6.35Q20.8 4.97 22.85 5.24Q24.9 5.51 26.76 5.95Q28.63 6.39 30.31 5.35Q32 4.32 33.94 3.46Q35.87 2.6 37.61 3.58Q39.35 4.56 40.84 5.81Q42.33 7.06 44.3 7.18Q46.27 7.29 48.22 7.8Q50.17 8.31 50.94 10.3Q51.71 12.29 52.14 14.25Q52.58 16.21 54.16 17.25Q55.73 18.3 57.31 19.58Q58.89 20.86 58.88 22.83Q58.87 24.8 58.62 26.66Q58.38 28.53 59.44 30.26Z";

type SealMarkProps = {
  size: number;
  className?: string;
};

export function SealMark({ size, className }: SealMarkProps) {
  // Each copy needs its own gradient id, or hiding one copy breaks the others.
  const gradientId = `seal-wax-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={gradientId} cx="38%" cy="32%">
          <stop offset="0%" stopColor="#d85a4c" />
          <stop offset="70%" stopColor="#c9473a" />
          <stop offset="100%" stopColor="#a8392e" />
        </radialGradient>
      </defs>
      <path d={WAX_BODY} fill={`url(#${gradientId})`} />
      <circle
        cx="32"
        cy="32"
        r="19.5"
        fill="none"
        stroke="#8e2e25"
        strokeWidth="1.4"
      />
      <g
        fill="none"
        stroke="#8e2e25"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="27" y1="22" x2="27" y2="42" />
        <line x1="39" y1="22" x2="28.5" y2="32.5" />
        <line x1="30.5" y1="31" x2="40" y2="42" />
      </g>
      <ellipse
        cx="24"
        cy="22"
        rx="7"
        ry="4"
        fill="#ffffff"
        opacity="0.1"
        transform="rotate(-30 24 22)"
      />
    </svg>
  );
}
