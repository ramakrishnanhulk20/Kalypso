// Reads colour tokens out of the stylesheet, for the two places that paint with code instead of
// CSS: the WebGL hero scene and the Mermaid diagrams. Both follow the theme by reading again
// whenever it changes.

export type Rgb = [number, number, number];

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16) / 255;
}

/** A #rrggbb token as three 0..1 channels. Anything else reads as black. */
export function rgbOf(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  return hex ? [channel(hex, 0), channel(hex, 2), channel(hex, 4)] : [0, 0, 0];
}

export function tokenValue(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Relative luminance, enough to tell a paper canvas from an ink one. */
export function luminanceOf([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
