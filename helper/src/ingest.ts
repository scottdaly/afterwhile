import { exactCoverage } from "../../shared/src/coverage.ts";
import { rmSync } from "fs";
import path from "path";
import { sourceSlug, type CaptureRecord, type Coverage } from "../../shared/src/index.ts";
import { isCaptureRecord, type InsertSummary, type RecordDatabase } from "./database.ts";
import { log } from "./log.ts";
import { markdownFile, renderDay, writeDayFile } from "./markdown.ts";

export interface AcceptResult extends InsertSummary {
  rejected: number;
  todayCount: number;
}

export function acceptRecords(db: RecordDatabase, filesRoot: string, records: unknown[]): AcceptResult {
  const valid = records.filter(isCaptureRecord).filter((record) => {
    if (record.connection !== "teams") return true;
    const previous = db.coverage(record.source.id);
    const expected = record.fields?.expected;
    const mismatch = previous?.reason === "transcript extent changed" || (previous?.expected != null && expected !== previous.expected);
    if (mismatch && typeof expected === "number") {
      acceptCoverage(db, { sourceId: record.source.id, expected, have: 0, gaps: [], complete: false, reason: "transcript extent changed", updatedAt: record.capturedAt });
    }
    return !mismatch;
  });
  const summary = db.insertRecords(valid);
  // A retry may follow a crash after SQLite committed but before Markdown was written.
  refreshRecords(db, filesRoot, valid.map((record) => record.id));
  // Coverage can arrive before the queued batch reaches the helper.
  for (const sourceId of new Set(valid.filter((record) => record.connection === "slack" || record.connection === "teams").map((record) => record.source.id))) {
    const coverage = db.coverage(sourceId);
    if (coverage) acceptCoverage(db, coverage);
  }
  log(
    `records new=${summary.inserted} revisions=${summary.revisions} deleted=${summary.deleted} unchanged=${summary.unchanged} rejected=${records.length - valid.length} ids=${summary.ids.join(",")}`,
  );
  return { ...summary, rejected: records.length - valid.length, todayCount: db.todayCount() };
}

export function acceptCoverage(db: RecordDatabase, coverage: Coverage): void {
  // A reopened Slack tab knows only its current visit. Coverage's saved total
  // must include earlier visits, and exclude superseded/deleted revisions.
  const slack = coverage.sourceId.startsWith("slack:") && coverage.expected == null;
  const saved = slack
    ? db.sources("slack").find((source) => source.sourceId === coverage.sourceId)
    : null;
  const current = slack
    ? { ...coverage, have: saved?.recordCount ?? 0 }
    : coverage;
  let savedCoverage = current;
  if (coverage.sourceId.startsWith("teams:") && coverage.expected != null) {
    const previous = db.coverage(coverage.sourceId);
    const positions = db.getSource(coverage.sourceId).map((r) => r.position!).filter((p) => p != null);
    const invalid = previous?.reason === "transcript extent changed" || coverage.reason === "transcript extent changed"
      || (previous?.expected != null && previous.expected !== coverage.expected)
      || positions.some((p) => p < 1 || p > coverage.expected!);
    savedCoverage = exactCoverage(coverage.sourceId, coverage.expected, positions, coverage.reason, new Date(coverage.updatedAt));
    if (invalid) savedCoverage = { ...savedCoverage, have: new Set(positions).size, complete: false, reason: "transcript extent changed" };
  }
  db.updateCoverage(savedCoverage);
  log(`coverage source=${savedCoverage.sourceId} have=${savedCoverage.have} complete=${savedCoverage.complete} reason=${savedCoverage.reason ?? ""}`);
}

export function forgetSaved(
  db: RecordDatabase,
  filesRoot: string,
  scope: "source" | "connection",
  id: string,
): { removed: number } {
  const result = db.forget(scope, id);
  for (const source of result.sources) {
    rmSync(path.join(filesRoot, source.connection, sourceSlug(source.sourceId)), { recursive: true, force: true });
  }
  log(`forget scope=${scope} id=${id} removed=${result.removed}`);
  return { removed: result.removed };
}

export function refreshRecords(db: RecordDatabase, filesRoot: string, recordIds: string[]): void {
  const days = db.affectedDays(recordIds);
  const seen = new Set<string>();
  for (const day of days) {
    const key = `${day.sourceId}:${day.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const records = db.dayRecords(day.sourceId, day.day);
    const file = markdownFile(filesRoot, day.connection, day.sourceId, day.day);
    if (records.every((record) => record.deleted) || records.length === 0) {
      writeDayFile(file, null);
      continue;
    }
    const sample = records[0];
    writeDayFile(
      file,
      renderDay({
        title: sample?.source.title ?? day.sourceId,
        url: sample?.source.url ?? "",
        day: day.day,
        records,
      }),
    );
  }
}
