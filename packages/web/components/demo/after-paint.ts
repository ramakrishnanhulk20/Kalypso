/**
 * Runs `work` once the next frame has been painted. A frame callback runs before the paint, so the
 * work waits one more task. A hidden tab never paints, so there the work runs at once. Returns a
 * function that cancels it.
 */
export function afterPaint(work: () => void): () => void {
  if (document.visibilityState === "hidden") {
    work();
    return () => undefined;
  }
  let timer = 0;
  const frame = requestAnimationFrame(() => {
    timer = window.setTimeout(work, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
  };
}
