import type { Coverage } from "./types.ts";

export function coverageHint(coverage: Coverage, title: string): string {
  const name = title || "this source";
  if (coverage.complete) return `${name} is fully captured.`;
  if (coverage.gaps.length > 0) {
    const lines = coverage.gaps
      .map(([start, end]) => (start === end ? `${start}` : `${start}–${end}`))
      .join(", ");
    return `Open ${name} to finish lines ${lines}.`;
  }
  if (coverage.reason) {
    return `${name} is only partly saved (${coverage.reason}). Open it and scroll to capture more.`;
  }
  return `${name} is only partly saved. Open it and scroll to capture more.`;
}

export function exactCoverage(sourceId: string, expected: number, positions: Iterable<number>, reason: string | null = null, now = new Date()): Coverage {
  const have = new Set(Array.from(positions).filter((n) => Number.isInteger(n) && n >= 1 && n <= expected));
  const gaps: Array<[number, number]> = [];
  let start: number | null = null;
  for (let n = 1; n <= expected + 1; n++) {
    if (n <= expected && !have.has(n)) { start ??= n; }
    else if (start != null) { gaps.push([start, n - 1]); start = null; }
  }
  return { sourceId, expected, have: have.size, gaps, complete: gaps.length === 0, reason: gaps.length ? reason : null, updatedAt: now.toISOString() };
}
