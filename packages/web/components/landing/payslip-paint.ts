export type Step = 1 | 2 | 3 | 4 | 5;

// Everything the payslip card draws with code instead of markup. A timeline
// tweens these numbers and paintPose writes them to the DOM, so React never
// re-renders per frame.
export type Pose = {
  /** 0 shows the opened amount, 1 shows the sealed hex. */
  scramble: number;
  /** Ring travel from the card's right edge (0) to its resting point (1). */
  slide: number;
  /** Lens window size: 0 is closed, 1 is the ring's hole. */
  lens: number;
  /** 0 keeps the lens at ring size, 1 grows it past every corner of the card. */
  grow: number;
  /** Ring opacity. */
  ring: number;
};

export const POSES: Record<Step, Pose> = {
  1: { scramble: 0, slide: 0, lens: 0, grow: 0, ring: 0 },
  2: { scramble: 1, slide: 0, lens: 0, grow: 0, ring: 0 },
  3: { scramble: 1, slide: 0, lens: 0, grow: 0, ring: 0 },
  4: { scramble: 1, slide: 1, lens: 1, grow: 0, ring: 1 },
  5: { scramble: 1, slide: 1, lens: 1, grow: 1, ring: 0 },
};

// Twenty hex characters of the sealed amount, then an ellipsis.
export const CHAR_COUNT = 21;

export const MORPH_SECONDS = 0.8;
const CYCLE_TICKS = 6;
const TICK_SECONDS = 0.04;
const CYCLE_SECONDS = CYCLE_TICKS * TICK_SECONDS;
const LABEL_FADE_SECONDS = 0.2;

const HEX = "0123456789abcdef";

// Each position shows six random digits before it settles. They are drawn once
// so scrubbing back and forth replays the same flicker.
const CYCLES = Array.from({ length: CHAR_COUNT }, () =>
  Array.from(
    { length: CYCLE_TICKS },
    () => HEX[Math.floor(Math.random() * HEX.length)] ?? "0",
  ),
);

type Parts = {
  chars: HTMLElement[];
  label: HTMLElement | null;
  speech: HTMLElement | null;
  ringBody: HTMLElement | null;
};

type Geometry = {
  startX: number;
  restX: number;
  restY: number;
  clipOffsetX: number;
  clipOffsetY: number;
  lensR: number;
  coverScale: number;
};

const parts = new WeakMap<HTMLElement, Parts>();
const geometry = new WeakMap<HTMLElement, Geometry>();
const lastWrite = new WeakMap<HTMLElement, string>();

function partsOf(card: HTMLElement): Parts {
  const known = parts.get(card);
  if (known) return known;
  const found: Parts = {
    chars: Array.from(card.querySelectorAll<HTMLElement>("[data-char]")),
    label: card.querySelector<HTMLElement>("[data-part=usdc]"),
    speech: card.querySelector<HTMLElement>("[data-part=amount-speech]"),
    ringBody: card.querySelector<HTMLElement>("[data-lens-ring] > div"),
  };
  if (found.chars.length > 0) parts.set(card, found);
  return found;
}

// Call when the card's markup was rebuilt, for example when the data arrived.
export function forgetCard(card: HTMLElement) {
  parts.delete(card);
  geometry.delete(card);
  lastWrite.delete(card);
}

function writeChar(element: HTMLElement, text: string, state: string) {
  const key = `${state}|${text}`;
  if (lastWrite.get(element) === key) return;
  lastWrite.set(element, key);
  element.textContent = text;
  element.dataset.s = state;
}

// Left to right, each character shows the opened amount, cycles through six
// random hex digits at 40ms, then settles on the sealed hex at its position.
// The last one settles exactly when the morph ends.
function paintMorph(
  chars: HTMLElement[],
  progress: number,
  amount: string,
  sealed: string,
) {
  const time = progress >= 1 ? Number.POSITIVE_INFINITY : progress * MORPH_SECONDS;
  const lastIndex = Math.max(1, chars.length - 1);

  chars.forEach((element, index) => {
    const start = ((MORPH_SECONDS - CYCLE_SECONDS) * index) / lastIndex;
    if (time <= start) {
      writeChar(element, amount[index] ?? "", "amount");
    } else if (time < start + CYCLE_SECONDS) {
      const tick = Math.min(
        CYCLE_TICKS - 1,
        Math.floor((time - start) / TICK_SECONDS),
      );
      writeChar(element, CYCLES[index]?.[tick] ?? "0", "cycle");
    } else {
      writeChar(element, sealed[index] ?? "", "hex");
    }
  });
}

// Reads where things sit, in the card's own coordinates. The ring and the lens
// window share one centre, so both are placed from the same numbers.
export function measureCard(card: HTMLElement) {
  const opened = card.querySelector<HTMLElement>("[data-part=opened]");
  const number = card.querySelector<HTMLElement>("[data-part=opened-number]");
  if (!opened || !number) {
    geometry.delete(card);
    return;
  }

  const cardBox = card.getBoundingClientRect();
  const openedBox = opened.getBoundingClientRect();
  const numberBox = number.getBoundingClientRect();
  const originX = cardBox.left + card.clientLeft;
  const originY = cardBox.top + card.clientTop;

  const lensR =
    parseFloat(getComputedStyle(card).getPropertyValue("--lens-r")) || 0;
  const restX = numberBox.left + numberBox.width / 2 - originX;
  const restY = numberBox.top + numberBox.height / 2 - originY;
  const width = card.clientWidth;
  const height = card.clientHeight;
  const farthest = Math.max(
    Math.hypot(restX, restY),
    Math.hypot(width - restX, restY),
    Math.hypot(restX, height - restY),
    Math.hypot(width - restX, height - restY),
  );

  geometry.set(card, {
    startX: width,
    restX,
    restY,
    clipOffsetX: openedBox.left - originX,
    clipOffsetY: openedBox.top - originY,
    lensR,
    coverScale: lensR > 0 ? Math.max(1, (farthest + 2) / lensR) : 1,
  });
}

function setVars(card: HTMLElement, vars: Record<string, string>) {
  const key = JSON.stringify(vars);
  if (lastWrite.get(card) === key) return;
  lastWrite.set(card, key);
  Object.entries(vars).forEach(([name, value]) =>
    card.style.setProperty(name, value),
  );
}

export function paintPose(card: HTMLElement, pose: Pose) {
  const amount = card.dataset.amount;
  const sealed = card.dataset.sealed;
  const found = partsOf(card);
  if (amount === undefined || sealed === undefined || found.chars.length === 0) {
    return;
  }

  paintMorph(found.chars, pose.scramble, amount, sealed);

  if (found.label) {
    const fade = Math.min(1, (pose.scramble * MORPH_SECONDS) / LABEL_FADE_SECONDS);
    found.label.style.opacity = String(1 - fade);
  }

  if (found.speech) {
    const opened = pose.scramble < 0.5 || pose.grow >= 1;
    const text = opened ? `${amount} USDC, opened` : "Sealed";
    if (found.speech.textContent !== text) found.speech.textContent = text;
  }

  const g = geometry.get(card);
  if (!g) return;

  const scale = 1 + (g.coverScale - 1) * pose.grow;
  const x = g.startX + (g.restX - g.startX) * pose.slide;
  setVars(card, {
    "--lx": `${x.toFixed(2)}px`,
    "--ly": `${g.restY.toFixed(2)}px`,
    "--lcx": `${(x - g.clipOffsetX).toFixed(2)}px`,
    "--lcy": `${(g.restY - g.clipOffsetY).toFixed(2)}px`,
    "--lr": `${(g.lensR * pose.lens * scale).toFixed(2)}px`,
  });

  if (found.ringBody) {
    found.ringBody.style.opacity = String(pose.ring);
    found.ringBody.style.transform = `scale(${scale.toFixed(3)})`;
  }
}
