"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

const EASE_PER_FRAME = 0.2;
const RESTING_ROW = 2;

type LensMotionInput = {
  /** Gets the --lx and --ly custom properties. */
  cardRef: RefObject<HTMLElement | null>;
  /** The box the lens coordinates are measured in: the table area. */
  fieldRef: RefObject<HTMLElement | null>;
  ringRef: RefObject<HTMLElement | null>;
  running: boolean;
  reduceMotion: boolean;
  /** Changes whenever the rows change, so the resting point is measured again. */
  layoutKey: unknown;
};

// The loop only writes two CSS variables per frame. React never re-renders for
// the lens.
export function useLensMotion({
  cardRef,
  fieldRef,
  ringRef,
  running,
  reduceMotion,
  layoutKey,
}: LensMotionInput) {
  const position = useRef({ x: 0, y: 0, placed: false });

  useEffect(() => {
    const card = cardRef.current;
    const field = fieldRef.current;
    const ring = ringRef.current;
    if (!running || !card || !field || !ring) return;

    const rest = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };
    let hovering = false;
    let dragging = false;

    // Offsets rather than bounding boxes, so a row that is mid-entrance and
    // shifted down 16px does not move the resting point.
    const measureRest = () => {
      const rows = field.querySelectorAll<HTMLElement>(
        'table[data-layer="sealed"] tr[data-payment-row]',
      );
      const cell = (rows[RESTING_ROW] ?? rows[rows.length - 1])
        ?.lastElementChild as HTMLElement | undefined;
      if (cell) {
        // Right-aligned values end at the cell's content edge. The lens sits
        // so that edge is 8px inside its rim, which keeps a whole value, even
        // "No key fits", in view.
        const radius =
          parseFloat(getComputedStyle(card).getPropertyValue("--lens-r")) || 0;
        const contentRight =
          cell.offsetLeft +
          cell.offsetWidth -
          (parseFloat(getComputedStyle(cell).paddingRight) || 0);
        rest.x = contentRight - radius + 8;
        rest.y = cell.offsetTop + cell.offsetHeight / 2;
      } else {
        rest.x = field.clientWidth * 0.75;
        rest.y = Math.min(field.clientHeight / 2, 160);
      }
      if (!position.current.placed) {
        position.current.x = rest.x;
        position.current.y = rest.y;
        position.current.placed = true;
        write();
      }
    };

    let written = "";
    const write = () => {
      const x = `${position.current.x.toFixed(2)}px`;
      const y = `${position.current.y.toFixed(2)}px`;
      if (x + y === written) return;
      written = x + y;
      card.style.setProperty("--lx", x);
      card.style.setProperty("--ly", y);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse") hovering = true;
      else if (!dragging) return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    const onPointerLeave = (event: PointerEvent) => {
      if (event.pointerType === "mouse") hovering = false;
    };
    // A finger or pen drags the lens only when it grabs the ring itself, so a
    // touch anywhere else on the card still scrolls the page.
    const onRingDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      dragging = true;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      ring.setPointerCapture(event.pointerId);
    };
    const onRingUp = () => {
      dragging = false;
    };

    card.addEventListener("pointermove", onPointerMove);
    card.addEventListener("pointerleave", onPointerLeave);
    ring.addEventListener("pointerdown", onRingDown);
    ring.addEventListener("pointerup", onRingUp);
    ring.addEventListener("pointercancel", onRingUp);
    ring.addEventListener("lostpointercapture", onRingUp);

    const resizeObserver = new ResizeObserver(measureRest);
    resizeObserver.observe(field);
    measureRest();

    let frame = 0;
    const tick = () => {
      let targetX = rest.x;
      let targetY = rest.y;
      if (hovering || dragging) {
        const box = field.getBoundingClientRect();
        targetX = pointer.x - box.left;
        targetY = pointer.y - box.top;
      }
      const current = position.current;
      if (reduceMotion) {
        current.x = targetX;
        current.y = targetY;
      } else {
        current.x += (targetX - current.x) * EASE_PER_FRAME;
        current.y += (targetY - current.y) * EASE_PER_FRAME;
      }
      write();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      card.removeEventListener("pointermove", onPointerMove);
      card.removeEventListener("pointerleave", onPointerLeave);
      ring.removeEventListener("pointerdown", onRingDown);
      ring.removeEventListener("pointerup", onRingUp);
      ring.removeEventListener("pointercancel", onRingUp);
      ring.removeEventListener("lostpointercapture", onRingUp);
    };
  }, [cardRef, fieldRef, ringRef, running, reduceMotion, layoutKey]);
}
