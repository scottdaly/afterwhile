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
