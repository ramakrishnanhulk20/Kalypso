export function Grain() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none fixed inset-0 z-50 h-full w-full opacity-[0.07] mix-blend-overlay"
    >
      <filter id="kalypso-grain">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.8"
          numOctaves="3"
          stitchTiles="stitch"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#kalypso-grain)" />
    </svg>
  );
}
