import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";
import {
  coverageHint,
  localDay,
  type CaptureRecord,
  type Coverage,
} from "../../shared/src/index.ts";
import { databasePath } from "./paths.ts";

export interface InsertSummary {
  inserted: number;
  revisions: number;
  unchanged: number;
  deleted: number;
  ids: string[];
}

export interface SearchOptions {
  connection?: string;
  sourceId?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface RecentOptions {
  sourceId?: string;
  connection?: string;
  since?: string;
  client?: string;
  checkpoint?: boolean;
  limit?: number;
}

export interface StoredRecord extends CaptureRecord {
  occurredDay: string;
  capturedDay: string;
}

const BUSY_TIMEOUT_MS = 5000;

export class RecordDatabase {
  readonly db: Database;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.assertFts5();
    this.migrate();
  }

  static openDefault(): RecordDatabase {
    return new RecordDatabase(databasePath());
  }

  private assertFts5(): void {
    this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x)");
    this.db.run("DROP TABLE IF EXISTS _fts5_probe");
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS records (
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        connection TEXT NOT NULL,
        connection_version TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        position INTEGER,
        occurred_at TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        occurred_day TEXT NOT NULL,
        captured_day TEXT NOT NULL,
        author_name TEXT,
        author_id TEXT,
        text TEXT NOT NULL,
        fields TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (record_id, revision)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_records_source ON records(source_id, occurred_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_records_connection ON records(connection, occurred_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_records_captured_day ON records(captured_day)`);
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        record_id UNINDEXED,
        text,
        source_title,
        author_name,
        tokenize = 'unicode61'
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS coverage (
        source_id TEXT PRIMARY KEY,
        expected INTEGER,
        have INTEGER NOT NULL,
        gaps TEXT NOT NULL,
        complete INTEGER NOT NULL,
        reason TEXT,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        client TEXT PRIMARY KEY,
        cursor_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  busyTimeoutMs(): number {
    const row = this.db.prepare("PRAGMA busy_timeout").get() as { timeout?: number; busy_timeout?: number };
    return Number(row.timeout ?? row.busy_timeout ?? 0);
  }

  insertRecords(records: CaptureRecord[]): InsertSummary {
    const summary: InsertSummary = { inserted: 0, revisions: 0, unchanged: 0, deleted: 0, ids: [] };
    const trx = this.db.transaction((batch: CaptureRecord[]) => {
      for (const record of batch) {
        const outcome = this.insertOne(record);
        if (outcome === "new") summary.inserted += 1;
        else if (outcome === "revision") summary.revisions += 1;
        else if (outcome === "deleted") summary.deleted += 1;
        else summary.unchanged += 1;
        if (outcome !== "unchanged") summary.ids.push(record.id);
      }
    });
    trx(records);
    return summary;
  }

  private insertOne(record: CaptureRecord): "new" | "revision" | "deleted" | "unchanged" {
    if (!isSafeConnection(record.connection) || !record.id || !record.source?.id) return "unchanged";
    const latest = this.latestRow(record.id);
    if (record.deleted && !latest) return "unchanged";
    if (
      latest &&
      latest.text === record.text &&
      Boolean(latest.deleted) === record.deleted &&
      latest.source_title === record.source.title
    ) {
      return "unchanged";
    }
    if (latest && latest.text === record.text && Boolean(latest.deleted) === record.deleted) {
      this.db
        .prepare(`UPDATE records SET source_title = ?, source_url = ? WHERE record_id = ? AND revision = ?`)
        .run(record.source.title, record.source.url, record.id, latest.revision);
      this.syncFts(record.id, record.deleted ? null : record);
      return "unchanged";
    }

    const revision = latest ? Number(latest.revision) + 1 : 1;
    const occurredDay = localDay(record.occurredAt);
    const capturedDay = localDay(record.capturedAt);
    this.db
      .prepare(
        `INSERT INTO records (
          record_id, revision, connection, connection_version, kind, source_id, source_title,
          source_url, position, occurred_at, captured_at, occurred_day, captured_day,
          author_name, author_id, text, fields, deleted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        revision,
        record.connection,
        record.connectionVersion,
        record.kind,
        record.source.id,
        record.source.title,
        record.source.url,
        record.position,
        record.occurredAt,
        record.capturedAt,
        occurredDay,
        capturedDay,
        record.author?.name ?? null,
        record.author?.id ?? null,
        record.deleted ? "" : record.text,
        JSON.stringify(record.fields ?? {}),
        record.deleted ? 1 : 0,
      );
    this.syncFts(record.id, record.deleted ? null : { ...record, text: record.text });
    if (!latest) return "new";
    return record.deleted ? "deleted" : "revision";
  }

  private syncFts(recordId: string, current: CaptureRecord | null): void {
    this.db.prepare(`DELETE FROM records_fts WHERE record_id = ?`).run(recordId);
    if (!current || current.deleted) return;
    this.db
      .prepare(`INSERT INTO records_fts (record_id, text, source_title, author_name) VALUES (?, ?, ?, ?)`)
      .run(recordId, current.text, current.source.title, current.author?.name ?? "");
  }

  private latestRow(recordId: string): Row | undefined {
    return this.db
      .prepare(`SELECT * FROM records WHERE record_id = ? ORDER BY revision DESC LIMIT 1`)
      .get(recordId) as Row | undefined;
  }

  updateCoverage(coverage: Coverage): void {
    this.db
      .prepare(
        `INSERT INTO coverage (source_id, expected, have, gaps, complete, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET
           expected = excluded.expected,
           have = excluded.have,
           gaps = excluded.gaps,
           complete = excluded.complete,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        coverage.sourceId,
        coverage.expected,
        coverage.have,
        JSON.stringify(coverage.gaps),
        coverage.complete ? 1 : 0,
        coverage.reason,
        coverage.updatedAt,
      );
  }

  search(query: string, options: SearchOptions = {}): StoredRecord[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const limit = clampLimit(options.limit, 20);
    const where = ["records_fts MATCH ?", "r.deleted = 0", "r.revision = (SELECT MAX(revision) FROM records WHERE record_id = r.record_id)"];
    const params: Array<string | number> = [match];
    if (options.connection) {
      where.push("r.connection = ?");
      params.push(options.connection);
    }
    if (options.sourceId) {
      where.push("r.source_id = ?");
      params.push(options.sourceId);
    }
    if (options.since) {
      where.push("r.occurred_at >= ?");
      params.push(options.since);
    }
    if (options.until) {
      where.push("r.occurred_at <= ?");
      params.push(options.until);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT r.* FROM records_fts
         JOIN records r ON r.record_id = records_fts.record_id
         WHERE ${where.join(" AND ")}
         ORDER BY r.occurred_at DESC
         LIMIT ?`,
      )
      .all(...params) as Row[];
    return rows.map(rowToRecord);
  }

  recent(options: RecentOptions = {}): StoredRecord[] {
    const limit = clampLimit(options.limit, 50);
    let cursor: string | null = null;
    const until = new Date().toISOString();
    if (options.checkpoint && options.client) {
      const row = this.db.prepare(`SELECT cursor_at FROM checkpoints WHERE client = ?`).get(options.client) as
        | { cursor_at: string }
        | undefined;
      cursor = row?.cursor_at ?? null;
    }
    const where = ["r.deleted = 0", "r.revision = (SELECT MAX(revision) FROM records WHERE record_id = r.record_id)"];
    const params: Array<string | number> = [];
    if (options.sourceId) {
      where.push("r.source_id = ?");
      params.push(options.sourceId);
    }
    if (options.connection) {
      where.push("r.connection = ?");
      params.push(options.connection);
    }
    if (options.since) {
      where.push("r.occurred_at >= ?");
      params.push(options.since);
    }
    if (options.checkpoint && options.client) {
      if (cursor) {
        where.push("r.captured_at > ?");
        params.push(cursor);
      }
      where.push("r.captured_at <= ?");
      params.push(until);
    }
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT r.* FROM records r WHERE ${where.join(" AND ")} ORDER BY r.occurred_at DESC LIMIT ?`)
      .all(...params) as Row[];
    if (options.checkpoint && options.client) {
      this.db
        .prepare(
          `INSERT INTO checkpoints (client, cursor_at, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(client) DO UPDATE SET cursor_at = excluded.cursor_at, updated_at = excluded.updated_at`,
        )
        .run(options.client, until, until);
    }
    return rows.map(rowToRecord);
  }

  getSource(
    sourceId: string,
    options: { fromPosition?: number; toPosition?: number; since?: string; until?: string } = {},
  ): StoredRecord[] {
    const where = [
      "source_id = ?",
      "deleted = 0",
      "revision = (SELECT MAX(revision) FROM records r2 WHERE r2.record_id = records.record_id)",
    ];
    const params: Array<string | number> = [sourceId];
    if (options.fromPosition != null) {
      where.push("position >= ?");
      params.push(options.fromPosition);
    }
    if (options.toPosition != null) {
      where.push("position <= ?");
      params.push(options.toPosition);
    }
    if (options.since) {
      where.push("occurred_at >= ?");
      params.push(options.since);
    }
    if (options.until) {
      where.push("occurred_at <= ?");
      params.push(options.until);
    }
    const rows = this.db
      .prepare(`SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY COALESCE(position, 0), occurred_at ASC`)
      .all(...params) as Row[];
    return rows.map(rowToRecord);
  }

  sources(connection?: string): Array<{
    sourceId: string;
    title: string;
    url: string;
    recordCount: number;
    lastCaptured: string;
    coverage: Coverage | null;
  }> {
    const params: Array<string | number> = [];
    let sql = `
      SELECT source_id, source_title, source_url, COUNT(*) AS record_count, MAX(captured_at) AS last_captured
      FROM records
      WHERE deleted = 0
        AND revision = (SELECT MAX(revision) FROM records r2 WHERE r2.record_id = records.record_id)
    `;
    if (connection) {
      sql += ` AND connection = ?`;
      params.push(connection);
    }
    sql += ` GROUP BY source_id ORDER BY last_captured DESC`;
    const rows = this.db.prepare(sql).all(...params) as Array<{
      source_id: string;
      source_title: string;
      source_url: string;
      record_count: number;
      last_captured: string;
    }>;
    return rows.map((row) => ({
      sourceId: row.source_id,
      title: row.source_title,
      url: row.source_url,
      recordCount: Number(row.record_count),
      lastCaptured: row.last_captured,
      coverage: this.coverage(row.source_id),
    }));
  }

  coverage(sourceId: string): Coverage | null {
    const row = this.db.prepare(`SELECT * FROM coverage WHERE source_id = ?`).get(sourceId) as
      | {
          source_id: string;
          expected: number | null;
          have: number;
          gaps: string;
          complete: number;
          reason: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      sourceId: row.source_id,
      expected: row.expected,
      have: row.have,
      gaps: JSON.parse(row.gaps) as Array<[number, number]>,
      complete: row.complete === 1,
      reason: row.reason,
      updatedAt: row.updated_at,
    };
  }

  coverageText(sourceId: string): string {
    const coverage = this.coverage(sourceId);
    const source = this.sources().find((item) => item.sourceId === sourceId);
    const title = source?.title ?? sourceId;
    if (!coverage) {
      return `Nothing saved for ${title} yet. Open it in the browser so it can be captured.\n${source?.url ?? ""}`.trim();
    }
    const hint = coverageHint(coverage, title);
    const expected = coverage.expected == null ? "unknown" : String(coverage.expected);
    return [
      hint,
      source?.url ?? "",
      `have ${coverage.have}`,
      `expected ${expected}`,
      `complete ${coverage.complete}`,
      coverage.reason ? `reason ${coverage.reason}` : "",
      coverage.gaps.length ? `gaps ${JSON.stringify(coverage.gaps)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  todayCount(now = new Date()): number {
    const day = localDay(now.toISOString());
    const row = this.db
      .prepare(`SELECT COUNT(DISTINCT record_id) AS n FROM records WHERE captured_day = ?`)
      .get(day) as { n: number };
    return Number(row?.n ?? 0);
  }

  revisions(recordId: string): StoredRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM records WHERE record_id = ? ORDER BY revision ASC`)
      .all(recordId) as Row[];
    return rows.map(rowToRecord);
  }

  forget(scope: "source" | "connection", id: string): {
    removed: number;
    sources: Array<{ sourceId: string; connection: string }>;
  } {
    const rows =
      scope === "source"
        ? (this.db.prepare(`SELECT DISTINCT source_id, connection FROM records WHERE source_id = ?`).all(id) as Array<{
            source_id: string;
            connection: string;
          }>)
        : (this.db.prepare(`SELECT DISTINCT source_id, connection FROM records WHERE connection = ?`).all(id) as Array<{
            source_id: string;
            connection: string;
          }>);
    const result =
      scope === "source"
        ? this.db.prepare(`DELETE FROM records WHERE source_id = ?`).run(id)
        : this.db.prepare(`DELETE FROM records WHERE connection = ?`).run(id);
    if (scope === "source") this.db.prepare(`DELETE FROM coverage WHERE source_id = ?`).run(id);
    else {
      const coverageIds = rows.map((row) => row.source_id);
      for (const sourceId of coverageIds) this.db.prepare(`DELETE FROM coverage WHERE source_id = ?`).run(sourceId);
    }
    this.db.run(`DELETE FROM records_fts`);
    const remaining = this.db
      .prepare(
        `SELECT * FROM records r WHERE r.deleted = 0 AND r.revision = (SELECT MAX(revision) FROM records WHERE record_id = r.record_id)`,
      )
      .all() as Row[];
    const insert = this.db.prepare(
      `INSERT INTO records_fts (record_id, text, source_title, author_name) VALUES (?, ?, ?, ?)`,
    );
    for (const row of remaining) insert.run(row.record_id, row.text, row.source_title, row.author_name ?? "");
    return {
      removed: Number(result.changes ?? 0),
      sources: rows.map((row) => ({ sourceId: row.source_id, connection: row.connection })),
    };
  }

  affectedDays(recordIds: string[]): Array<{ connection: string; sourceId: string; day: string }> {
    if (recordIds.length === 0) return [];
    const unique = [...new Set(recordIds)];
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT connection, source_id, occurred_day FROM records WHERE record_id IN (${placeholders})`,
      )
      .all(...unique) as Array<{ connection: string; source_id: string; occurred_day: string }>;
    return rows.map((row) => ({ connection: row.connection, sourceId: row.source_id, day: row.occurred_day }));
  }

  dayRecords(sourceId: string, day: string): StoredRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM records WHERE source_id = ? AND occurred_day = ?
         AND revision = (SELECT MAX(revision) FROM records r2 WHERE r2.record_id = records.record_id)
         ORDER BY occurred_at ASC`,
      )
      .all(sourceId, day) as Row[];
    return rows.map(rowToRecord);
  }

  close(): void {
    this.db.close(true);
  }
}

interface Row {
  record_id: string;
  revision: number;
  connection: string;
  connection_version: string;
  kind: string;
  source_id: string;
  source_title: string;
  source_url: string;
  position: number | null;
  occurred_at: string;
  captured_at: string;
  occurred_day: string;
  captured_day: string;
  author_name: string | null;
  author_id: string | null;
  text: string;
  fields: string;
  deleted: number;
}

function rowToRecord(row: Row): StoredRecord {
  return {
    id: row.record_id,
    revision: Number(row.revision),
    connection: row.connection,
    connectionVersion: row.connection_version,
    kind: row.kind,
    source: { id: row.source_id, title: row.source_title, url: row.source_url },
    position: row.position == null ? null : Number(row.position),
    occurredAt: row.occurred_at,
    capturedAt: row.captured_at,
    occurredDay: row.occurred_day,
    capturedDay: row.captured_day,
    author: row.author_name ? { name: row.author_name, id: row.author_id ?? "" } : null,
    text: row.text,
    fields: JSON.parse(row.fields) as { [key: string]: unknown },
    deleted: row.deleted === 1,
  };
}

export function toFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (terms.length === 0) return "";
  return terms.map((term) => `"${term.replaceAll('"', "")}"`).join(" ");
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function isSafeConnection(connection: string): boolean {
  return /^[a-z0-9_-]+$/i.test(connection);
}

export function isCaptureRecord(value: unknown): value is CaptureRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as CaptureRecord;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.connection === "string" &&
    typeof record.text === "string" &&
    typeof record.occurredAt === "string" &&
    typeof record.capturedAt === "string" &&
    typeof record.source?.id === "string" &&
    typeof record.source.title === "string" &&
    typeof record.source.url === "string"
  );
}
