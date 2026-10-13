import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import path from "path";
import { localDay, sourceSlug } from "../shared/src/index.ts";
import { handleHostMessage } from "../helper/src/host.ts";
import { ExtensionFixture, SOURCE_ID } from "./extension-fixture.ts";

const active: ExtensionFixture[] = [];
function make(...args: ConstructorParameters<typeof ExtensionFixture>) {
  const h = new ExtensionFixture(...args); active.push(h); return h;
}
afterEach(async () => { for (const h of active.splice(0)) await h.close(); });

test("a missing helper is disconnected until its first reply; queued records survive reconnect", async () => {
  const h = make(undefined, { hostMode: "missing" });
  await h.start();
  expect(h.storage.helperConnected).toBe(false);
  expect(h.storage.pendingRecords).toHaveLength(2);
  expect(h.sent.filter((message) => message.type === "records")).toHaveLength(0);
  h.ports.at(-1).disconnect(); h.hostMode = "healthy";
  await h.clock.advance(5000);
  expect(h.storage.helperConnected).toBe(true);
  expect(h.storage.pendingRecords).toEqual([]);
  expect(h.db.getSource(SOURCE_ID)).toHaveLength(2);
});

test("a crash before ingest replays the batch instead of losing it to the content known list", async () => {
  const h = make(undefined, { hostMode: "before-ingest" });
  await h.start();
  expect(h.storage.pendingRecords).toHaveLength(2);
  expect(h.db.getSource(SOURCE_ID)).toHaveLength(0);
  h.ports.at(-1).onMessage.emit({ type: "ack", batchId: "wrong-batch" });
  h.ports.at(-1).onMessage.emit({ type: "ack", todayCount: 0 }); // Coverage ack is not a record ack.
  await h.clock.advance(0);
  expect(h.storage.pendingRecords).toHaveLength(2);
  h.ports.at(-1).disconnect(); h.hostMode = "healthy";
  await h.clock.advance(5000);
  expect(h.db.getSource(SOURCE_ID)).toHaveLength(2);
  expect(h.storage.pendingRecords).toEqual([]);
});

test("a lost ack followed by worker restart replays idempotently from storage", async () => {
  const h = make(undefined, { hostMode: "drop-ack" });
  await h.start();
  expect(h.db.getSource(SOURCE_ID)).toHaveLength(2);
  expect(h.storage.pendingRecords).toHaveLength(2);
  const record = h.db.getSource(SOURCE_ID)[0]!;
  const markdown = path.join(h.root, "files", "slack", sourceSlug(SOURCE_ID), `${localDay(record.occurredAt)}.md`);
  rmSync(markdown); // Simulate a crash after commit but before Markdown finished.
  h.hostMode = "healthy";
  await h.startWorker(); await h.clock.advance(0);
  expect(h.storage.pendingRecords).toEqual([]);
  for (const record of h.db.getSource(SOURCE_ID)) expect(h.db.revisions(record.id)).toHaveLength(1);
  expect(h.sent.filter((message) => message.type === "records")).toHaveLength(2);
  expect(readFileSync(markdown, "utf8")).toContain(record.text);
});

test("an ack removes only its batch while a later edit is queued", async () => {
  const h = make(undefined, { hostMode: "before-ingest" }); await h.start();
  const batch = h.sent.find((message) => message.type === "records");
  const edited = { ...batch.records[0], text: "Synthetic queued edit" };
  await h.send({ type: "records", records: [edited] });
  expect(h.storage.pendingRecords).toHaveLength(3);
  const ack = handleHostMessage(h.db, path.join(h.root, "files"), batch);
  h.hostMode = "healthy"; h.ports.at(-1).onMessage.emit(ack);
  await h.clock.advance(0);
  expect(h.storage.pendingRecords).toEqual([]);
  expect(h.db.revisions(edited.id).map((record) => record.text)).toEqual([batch.records[0].text, edited.text]);
});

test("updates preserve settings and enabling Slack injects into existing non-incognito tabs", async () => {
  const h = make(undefined, { hostMode: "missing", settings: { paused: true, includeDms: true, includePrivate: true, todayCount: 42 } });
  await h.startWorker();
  await Promise.all(h.installed.emit({ reason: "update" }));
  expect(h.storage).toMatchObject({ slackEnabled: true, paused: true, includeDms: true, includePrivate: true, todayCount: 42 });
  h.injections.length = 0;
  expect(await h.send({ type: "slack-enabled", enabled: true })).toEqual({ ok: true });
  expect(h.injections).toEqual([{ target: { tabId: 1 }, files: ["content-slack.js"] }]);
  expect(h.registered).toHaveLength(1);
  await h.send({ type: "slack-enabled", enabled: true });
  expect(h.registered).toHaveLength(1);
});

test("incognito messages are rejected before queuing", async () => {
  const h = make(); await h.startWorker();
  expect(await h.send({ type: "records", records: [{}] }, { tab: { id: 2, incognito: true } })).toMatchObject({ ok: false, reason: "incognito" });
  expect(h.storage.pendingRecords).toBeUndefined();
});
