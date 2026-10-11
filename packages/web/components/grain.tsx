// Film grain over everything. Overlay blending reads as grain on ink and as paper texture on the
// light canvas; the opacity is a token, lighter by day, so it never muddies the paper.
export function Grain() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none fixed inset-0 z-50 h-full w-full mix-blend-overlay"
      style={{ opacity: "var(--grain-opacity)" }}
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
