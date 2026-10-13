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

export function drawingStalled(
  before: { scrollTop: number; rowIds: string[] },
  after: { scrollTop: number; rowIds: string[] },
): boolean {
  const moved = before.scrollTop !== after.scrollTop;
  const sameRows = before.rowIds.join("\n") === after.rowIds.join("\n");
  return moved && sameRows;
}

export interface PaceSnapshot {
  now: number;
  lastUserInputAt: number;
  tabHidden: boolean;
  windowLocked: boolean;
  loadsThisVisit: number;
  loadsThisHour: number;
  visitBudget: number | null;
  hourlyBudget: number;
  reachedBeginning: boolean;
  reachedOldest: boolean;
  pushback: string | null;
  stalled: boolean;
  blockedUntil: number | null;
}

export type PaceDecision =
  | { action: "scroll"; pauseMs: number; maxStepRatio: 0.5 }
  | { action: "wait"; reason: string; retryMs: number }
  | { action: "stop"; reason: string; complete: boolean };

export function decidePace(snapshot: PaceSnapshot, rng: () => number = Math.random): PaceDecision {
  const userActive =
    !snapshot.tabHidden &&
    !snapshot.windowLocked &&
    snapshot.now - snapshot.lastUserInputAt < IDLE_MS;
  if (userActive) {
    return { action: "wait", reason: "person is using this tab", retryMs: 1000 };
  }
  if (snapshot.blockedUntil != null && snapshot.now < snapshot.blockedUntil) {
    return { action: "stop", reason: "paused for the rest of the day", complete: false };
  }
  if (snapshot.pushback) {
    return { action: "stop", reason: snapshot.pushback, complete: false };
  }
  if (snapshot.reachedBeginning) {
    return { action: "stop", reason: "reached the start", complete: true };
  }
  if (snapshot.reachedOldest) {
    return { action: "stop", reason: "reached the oldest point", complete: true };
  }
  if (snapshot.visitBudget != null && snapshot.loadsThisVisit >= snapshot.visitBudget) {
    return { action: "stop", reason: "load budget reached", complete: false };
  }
  if (snapshot.loadsThisHour >= snapshot.hourlyBudget) {
    return { action: "stop", reason: "hourly load budget reached", complete: false };
  }
  if (snapshot.stalled && snapshot.tabHidden) {
    return { action: "wait", reason: "drawing stalled", retryMs: 2000 };
  }
  return { action: "scroll", pauseMs: nextPauseMs(rng), maxStepRatio: 0.5 };
}

/** One scrolling job per site across tabs. */
export class SiteScrollLock {
  private holder: number | null = null;

  tryAcquire(tabId: number): boolean {
    if (this.holder == null || this.holder === tabId) {
      this.holder = tabId;
      return true;
    }
    return false;
  }

  release(tabId: number): void {
    if (this.holder === tabId) this.holder = null;
  }
}
