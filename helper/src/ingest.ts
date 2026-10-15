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
  const valid = records.filter(isCaptureRecord);
  const summary = db.insertRecords(valid);
  // A retry may follow a crash after SQLite committed but before Markdown was written.
  refreshRecords(db, filesRoot, valid.map((record) => record.id));
  // Coverage can arrive before the queued batch reaches the helper.
  for (const sourceId of new Set(valid.filter((record) => record.connection === "slack").map((record) => record.source.id))) {
    const coverage = db.coverage(sourceId);
    if (coverage && coverage.expected == null) acceptCoverage(db, coverage);
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
  db.updateCoverage(current);
  log(`coverage source=${current.sourceId} have=${current.have} complete=${current.complete} reason=${current.reason ?? ""}`);
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
