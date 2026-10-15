export type BackfillRange = "recent" | "30d" | "all";
export interface BackfillProgress {
  oldestAt: string | null;
  range: BackfillRange;
  batchLoads: number;
  resumeAt: number | null;
  reachedBoundary: boolean;
  boundaryKind: "start" | "range" | null;
}
export const BACKFILL_PAUSE_MS = 60_000;
export const progressKey = (sourceId: string) => `slackBackfill:${sourceId}`;
export const statsKey = (sourceId: string) => `slackSourceStats:${sourceId}`;
export function backfillRange(value: unknown): BackfillRange {
  return value === "recent" || value === "all" ? value : "30d";
}
export function rangeDays(range: BackfillRange): number {
  return range === "all" ? Infinity : range === "recent" ? 7 : 30;
}
export function rangeLabel(range: BackfillRange): string {
  return range === "all" ? "all available history" : range === "recent" ? "past 7 days" : "past 30 days";
}
export function readProgress(value: Partial<BackfillProgress> | null | undefined, range: BackfillRange, now: number): BackfillProgress {
  const sameRange = value?.range === range;
  const resumeAt = sameRange && typeof value?.resumeAt === "number" && value.resumeAt > now ? value.resumeAt : null;
  return {
    oldestAt: typeof value?.oldestAt === "string" && Number.isFinite(Date.parse(value.oldestAt)) ? value.oldestAt : null,
    range,
    batchLoads: sameRange && (value?.resumeAt == null || resumeAt != null) ? Math.max(0, Number(value?.batchLoads) || 0) : 0,
    resumeAt,
    reachedBoundary: sameRange && value?.reachedBoundary === true,
    boundaryKind: sameRange && value?.reachedBoundary ? value.boundaryKind === "start" || range === "all" ? "start" : "range" : null,
  };
}
export function progressText(progress: BackfillProgress, status: string): string {
  const reached = progress.oldestAt ? `Oldest saved ${new Date(progress.oldestAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · ` : "";
  return `${reached}${status}`;
}
