// Covers the colour choice for text drawn in the seal hue: the open trigger's label and the Open
// label use seal-hi, and seal-hi reaches 4.5 to 1 as small text on the canvas, on a raised
// surface and on the featured card's gradient from its middle down (where the Open label sits), in
// the light and the dark theme. Plain seal is still fine for icons and borders (3 to 1). Reads the token values and rules from globals.css.
// Does NOT cover the grain laid over the page or any colour other than these, which the browser
// walk samples from real pixels.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(path.join(import.meta.dirname, "../../app/globals.css"), "utf8");

function tokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  const block = CSS.slice(start, CSS.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const mix = (a: Rgb, b: Rgb, share: number): Rgb => a.map((value, i) => value * share + (b[i] as number) * (1 - share)) as Rgb;
const light = (c: Rgb) => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => (Math.max(light(a), light(b)) + 0.05) / (Math.min(light(a), light(b)) + 0.05);

const THEMES = { light: tokens(":root"), dark: tokens("html.dark") };

describe.each(Object.entries(THEMES))("seal-hi text in the %s theme", (_name, t) => {
  const sealHi = rgb(t["seal-hi"] as string);

  it("reaches 4.5 to 1 on the canvas and on a raised surface", () => {
    expect(ratio(sealHi, rgb(t.canvas as string))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(sealHi, rgb(t.raised as string))).toBeGreaterThanOrEqual(4.5);
  });

  it("reaches 4.5 to 1 on the featured card's gradient from its middle down, hovered or not", () => {
    for (const share of [0.22, 0.3]) {
      // The gradient runs from the seal mix to raised, so halfway down it is half of that mix.
      const middle = mix(rgb(t.seal as string), rgb(t.raised as string), share / 2);
      expect(ratio(sealHi, middle)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is needed: plain seal as small text on a raised surface stays under 4.5 to 1", () => {
    expect(ratio(rgb(t.seal as string), rgb(t.raised as string))).toBeLessThan(4.5);
  });
});

describe("the rules that draw seal-hued text", () => {
  const rule = (selector: string) => {
    const start = CSS.indexOf(`${selector} {`);
    return CSS.slice(start, CSS.indexOf("}", start));
  };

  it("colour the open trigger's label and the Open label with seal-hi", () => {
    expect(rule('.site-nav-trigger[aria-expanded="true"]')).toContain("color: var(--color-seal-hi)");
    expect(rule(".site-nav-open")).toContain("color: var(--color-seal-hi)");
  });

  it("keep plain seal for the icon box, which is an icon and a border", () => {
    expect(rule(".site-nav-iconbox")).toContain("var(--color-seal)");
  });
});
