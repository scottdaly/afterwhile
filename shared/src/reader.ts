/** Input that counts as the person using the tab. Scroll is not one of them. */
export const USER_INPUT_EVENTS = ["wheel", "keydown", "mousedown", "mousemove", "touchstart", "pointerdown"] as const;

export const IDLE_MS = 30_000;

export function nextPauseMs(rng: () => number = Math.random): number {
  const roll = rng();
  if (roll < 0.12) {
    return 4000 + Math.floor(rng() * 4000);
  }
  return 500 + Math.floor(rng() * 2001);
}

export function scrollStepPx(visibleHeight: number): number {
  return Math.max(1, Math.floor(visibleHeight / 2));
}

