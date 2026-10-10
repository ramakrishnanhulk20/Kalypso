// Fractional scroll positions and zoom can leave a pixel of rounding, so a diagram counts as
// scrolled to its end, or as fitting, when it is within this much.
const SLACK_PX = 1;

export type ScrollBox = { scrollLeft: number; clientWidth: number; scrollWidth: number };

/** True while the box holds more to the right than it shows: it overflows and is not yet at its end. */
export function showsRightFade({ scrollLeft, clientWidth, scrollWidth }: ScrollBox): boolean {
  if (scrollWidth - clientWidth <= SLACK_PX) return false;
  return scrollLeft + clientWidth < scrollWidth - SLACK_PX;
}
