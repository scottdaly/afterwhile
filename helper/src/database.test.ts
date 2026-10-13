import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { APP_NAME, type CaptureRecord } from "../../shared/src/index.ts";
import { RecordDatabase } from "./database.ts";

const open: Array<{ root: string; db: RecordDatabase }> = [];
function database() {
  const root = mkdtempSync(path.join(tmpdir(), `${APP_NAME}-cursor-`));
  const db = new RecordDatabase(path.join(root, "records.db"));
  open.push({ root, db }); return db;
}
afterEach(() => {
  for (const { root, db } of open.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); }
});

function record(index = 0, overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: `slack:TTEST:CTEST:${index}`, connection: "slack", connectionVersion: "0.1.0", kind: "message",
    source: { id: "slack:TTEST:CTEST", title: "#synthetic", url: "https://app.slack.com/client/TTEST/CTEST" },
    position: null, occurredAt: `2026-10-12T16:2${5 - index}:00Z`, capturedAt: "1999-01-01T00:00:00Z",
    author: null, text: `Synthetic cursor message ${index}`, fields: {}, revision: 1, deleted: false,
    ...overrides,
  };
}

test("limited checkpoint pages use insert order despite reversed times and browser clock skew", () => {
  const db = database();
  db.insertRecords([record(0), record(1), record(2, { capturedAt: "2099-01-01T00:00:00Z" }), record(3), record(4)]);
  const options = { connection: "slack", client: "synthetic-client", checkpoint: true, limit: 2 };
  const pages = [db.recent(options), db.recent(options), db.recent(options), db.recent(options)];
  expect(pages.map((page) => page.length)).toEqual([2, 2, 1, 0]);
  expect(pages.flat().map((item) => item.id)).toEqual([0, 1, 2, 3, 4].map((index) => record(index).id));
  db.insertRecords([record(0, { text: "An edit inserted later", capturedAt: "1998-01-01T00:00:00Z" })]);
  expect(db.recent(options).map((item) => item.text)).toEqual(["An edit inserted later"]);
  db.insertRecords([record(0, { text: "An edit inserted later" })]);
  expect(db.recent(options)).toHaveLength(0);
  expect(db.recent({ ...options, client: "another-client" })).toHaveLength(2);
});

test("insert cursor keeps increasing after forget removes every record", () => {
  const db = database(); db.insertRecords([record()]);
  const options = { client: "client", checkpoint: true };
  expect(db.recent(options)).toHaveLength(1);
  db.forget("connection", "slack");
  db.insertRecords([record(1)]);
  expect(db.recent(options).map((item) => item.id)).toEqual([record(1).id]);
});

test("legacy records and time checkpoints migrate without skipping history", () => {
  const db = database(); db.insertRecords([record(0), record(1)]);
  db.recent({ client: "legacy", checkpoint: true });
  const columns = (db.db.query("PRAGMA table_info(records)").all() as Array<{ name: string }>).map((column) => column.name).filter((name) => name !== "ingest_seq");
  db.db.run(`CREATE TABLE legacy_records AS SELECT ${columns.join(", ")} FROM records ORDER BY ingest_seq`);
  db.db.run("DROP TABLE records");
  db.db.run("ALTER TABLE legacy_records RENAME TO records");
  db.db.run("ALTER TABLE checkpoints DROP COLUMN cursor_seq");
  const filename = path.join(open[0]!.root, "records.db");
  db.close();
  const migrated = new RecordDatabase(filename); open[0]!.db = migrated;
  expect(migrated.recent({ client: "legacy", checkpoint: true, limit: 1 }).map((item) => item.id)).toEqual([record(0).id]);
  expect(migrated.recent({ client: "legacy", checkpoint: true, limit: 1 }).map((item) => item.id)).toEqual([record(1).id]);
  expect(migrated.recent({ client: "legacy", checkpoint: true })).toEqual([]);
  migrated.insertRecords([record(0, { text: "Edit after migration" })]);
  expect(migrated.revisions(record().id).map((item) => item.revision)).toEqual([1, 2]);
});

test("search, recent and get compare ISO offsets as instants, including stored offsets", () => {
  const db = database();
  db.insertRecords([record(0, { occurredAt: "2026-10-12T16:20:00Z" }), record(1, { occurredAt: "2026-10-12T18:20:00+02:00" })]);
  const since = "2026-10-12T18:00:00+02:00"; // 16:00Z
  const until = "2026-10-12T10:00:00-07:00"; // 17:00Z
  expect(db.search("Synthetic", { since, until })).toHaveLength(2);
  expect(db.recent({ since })).toHaveLength(2);
  expect(db.getSource(record().source.id, { since, until })).toHaveLength(2);
  expect(db.search("Synthetic", { since: until })).toHaveLength(0);
  expect(db.recent({ since: until })).toHaveLength(0);
  expect(db.getSource(record().source.id, { until: since })).toHaveLength(0);
});
