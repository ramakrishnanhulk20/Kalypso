// Builds the wax outlines once, so components carry fixed strings.
// Run: node scripts/seal-path.mjs
// Each of the 48 points becomes a curve control point, and the curve passes
// through the midpoints between neighbours, which keeps the edge smooth.
// Prints two lines: SEAL_BODY for components/seal-mark.tsx and LENS_RING for
// components/key-lens/lens-ring.tsx.

const POINTS = 48;

const round = (n) => Math.round(n * 100) / 100;
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const fmt = (p) => `${round(p.x)} ${round(p.y)}`;

function waxOutline({ centre, base, ripple, drift }) {
  const points = Array.from({ length: POINTS }, (_, i) => {
    const theta = (i * 7.5 * Math.PI) / 180;
    const radius =
      base + ripple * Math.sin(12 * theta) + drift * Math.sin(5 * theta + 1);
    return {
      x: centre + radius * Math.cos(theta),
      y: centre + radius * Math.sin(theta),
    };
  });

  const start = midpoint(points[POINTS - 1], points[0]);
  let d = `M${fmt(start)}`;

  for (let i = 0; i < POINTS; i += 1) {
    const control = points[i];
    const end = midpoint(points[i], points[(i + 1) % POINTS]);
    d += `Q${fmt(control)} ${fmt(end)}`;
  }

  return `${d}Z`;
}

const sealBody = waxOutline({ centre: 32, base: 28, ripple: 1.6, drift: 0.6 });

// The lens ring is the same wax edge scaled up, with a round hole cut out of
// the middle by drawing the inner circle as a second subpath (fill-rule evenodd).
const LENS_CENTRE = 88;
const LENS_HOLE = 78;
const lensEdge = waxOutline({
  centre: LENS_CENTRE,
  base: 86,
  ripple: 2.2,
  drift: 0.8,
});
const lensHole =
  `M${LENS_CENTRE - LENS_HOLE} ${LENS_CENTRE}` +
  `A${LENS_HOLE} ${LENS_HOLE} 0 1 0 ${LENS_CENTRE + LENS_HOLE} ${LENS_CENTRE}` +
  `A${LENS_HOLE} ${LENS_HOLE} 0 1 0 ${LENS_CENTRE - LENS_HOLE} ${LENS_CENTRE}Z`;

console.log(`SEAL_BODY=${sealBody}`);
console.log(`LENS_RING=${lensEdge}${lensHole}`);
