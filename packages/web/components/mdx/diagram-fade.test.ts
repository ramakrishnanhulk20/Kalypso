// Covers the decision to show the right-edge fade on a wide diagram. Does NOT cover the scroll and
// resize listeners or how the gradient looks; the headless browser check in scratchpad/web-lens does.
import { describe, expect, it } from "vitest";
import { showsRightFade } from "./diagram-fade";

describe("showsRightFade", () => {
  it("shows while a wide diagram has more to the right", () => {
    expect(showsRightFade({ scrollLeft: 0, clientWidth: 600, scrollWidth: 1000 })).toBe(true);
    expect(showsRightFade({ scrollLeft: 398, clientWidth: 600, scrollWidth: 1000 })).toBe(true);
  });

  it("hides once the box is scrolled to its end, with a pixel of rounding", () => {
    expect(showsRightFade({ scrollLeft: 400, clientWidth: 600, scrollWidth: 1000 })).toBe(false);
    expect(showsRightFade({ scrollLeft: 399, clientWidth: 600, scrollWidth: 1000 })).toBe(false);
    expect(showsRightFade({ scrollLeft: 399.5, clientWidth: 600, scrollWidth: 1000 })).toBe(false);
  });

  it("hides when the diagram fits, exactly or within a pixel", () => {
    expect(showsRightFade({ scrollLeft: 0, clientWidth: 800, scrollWidth: 800 })).toBe(false);
    expect(showsRightFade({ scrollLeft: 0, clientWidth: 800, scrollWidth: 801 })).toBe(false);
    expect(showsRightFade({ scrollLeft: 0, clientWidth: 800, scrollWidth: 802 })).toBe(true);
  });
});
