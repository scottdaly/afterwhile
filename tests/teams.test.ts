import { expect, test } from "bun:test";
import { ExtensionFixture } from "./extension-fixture.ts";
import { fixture, page, row, STREAM, FRAME } from "../connections/teams/fixtures/helpers.ts";
import { acceptCoverage } from "../helper/src/ingest.ts";
import { renderDay } from "../helper/src/markdown.ts";

function setup(html = fixture(), options: { hidden?: boolean; settings?: Record<string, unknown>; url?: string } = {}) {
  return new ExtensionFixture(html, { connection: "teams", hidden: true, url: STREAM, ...options, settings: { slackEnabled: false, teamsEnabled: true, ...options.settings } });
}
test("Stream captures, helper computes coverage and reload makes no revisions", async () => {
  const f = setup();
  try {
    await f.start(); await f.clock.advance(2000);
    const source = f.db.sources("teams")[0]!;
    expect(source.recordCount).toBe(3); expect(source.coverage?.complete).toBe(true);
    expect(f.storage['teamsTab:1'].parts[0].count).toBe(3);
    expect(f.storage['teamsTab:1'].parts[0].savedCoverage.complete).toBe(true);
    await f.startContent(); await f.clock.advance(2000);
    expect(f.db.sources("teams")[0]?.recordCount).toBe(3);
    expect(f.db.getSource(source.sourceId).every((r) => r.revision === 1)).toBe(true);
    expect(f.db.search("ribbon", { connection: "teams" })).toHaveLength(1);
    expect(f.db.recent({ connection: "teams", checkpoint: true, client: "synthetic" })).toHaveLength(3);
    expect(f.db.recent({ connection: "teams", checkpoint: true, client: "synthetic" })).toHaveLength(0);
    expect(f.db.coverageText(source.sourceId)).toContain("fully captured");
    const md = renderDay({ title: "Synthetic meeting", url: STREAM, day: "2026-10-12", records: f.db.getSource(source.sourceId) });
    expect(md).toContain("00:02 · Event"); expect(md).toContain("01:03 · Robin Vale"); expect(md).toContain("Meeting date unknown");
  } finally { await f.close(); }
});

test("virtualized list reveals every line with steps at most half-height and restores", async () => {
  const f = setup(page(row(5) + row(6) + row(7) + row(8)));
  f.height = 1200; f.visibleHeight = 400; f.top = 400;
  f.configureList();
  f.onScroll = () => {
    const start = Math.floor(f.top / 100) + 1;
    f.list.innerHTML = Array.from({ length: 4 }, (_, i) => row(start + i)).join("");
  };
  try {
    await f.start(); await f.clock.advance(40_000);
    const source = f.db.sources("teams")[0]!;
    expect(source.recordCount).toBe(12);
    expect(source.coverage).toMatchObject({ have: 12, expected: 12, complete: true, gaps: [] });
    expect(f.top).toBe(400);
    const moves = [400, ...f.scrolls.map((s) => s.top)];
    // Last move restores the original reading position.
    expect(moves.slice(1, -1).every((n, i) => Math.abs(n - moves[i]!) <= 200)).toBe(true);
  } finally { await f.close(); }
});

test("background stall retains partial coverage until visible and idle", async () => {
  const f = setup(page(row(5) + row(6)));
  try {
    await f.start(); await f.clock.advance(20_000);
    expect(f.scrolls.length).toBe(1);
    expect(f.db.sources("teams")[0]?.coverage?.complete).toBe(false);
    expect(f.storage['teamsTab:1'].reason).toContain("Waiting for visible");
    Object.defineProperty(f.dom.document, "hidden", { value: false });
    f.dom.document.dispatchEvent(new f.dom.window.Event("visibilitychange"));
    const moves = f.scrolls.length;
    await f.clock.advance(20_000); expect(f.scrolls.length).toBe(moves);
    await f.clock.advance(15_000); expect(f.scrolls.length).toBeGreaterThan(moves);
  } finally { await f.close(); }
});

test("two parts remain separate in database and popup", async () => {
  const f = setup(page(row(1, 1), "one"), { url: FRAME });
  try {
    await f.start(); await f.clock.advance(1000);
    f.mutate(() => {
      const option = f.dom.document.querySelector("option")!;
      option.setAttribute("value", "two"); option.textContent = "Part two";
    });
    await f.clock.advance(3000);
    expect(f.db.sources("teams")).toHaveLength(2);
    expect(f.storage['teamsTab:1'].parts).toHaveLength(2);
    expect(f.db.sources("teams").every((s) => s.coverage?.complete && s.recordCount === 1)).toBe(true);
  } finally { await f.close(); }
});

test("off and paused capture nothing; visible tab waits; changed markup reports error", async () => {
  for (const settings of [{ teamsEnabled: false }, { paused: true }]) {
    const f = setup(fixture(), { settings });
    try { await f.start(); await f.clock.advance(10_000); expect(f.db.sources("teams")).toHaveLength(0); expect(f.scrolls).toHaveLength(0); }
    finally { await f.close(); }
  }
  const f = setup(page(row(5) + row(6)), { hidden: false });
  try {
    await f.start(); await f.clock.advance(29_000); expect(f.scrolls).toHaveLength(0);
    f.input("wheel"); await f.clock.advance(29_000); expect(f.scrolls).toHaveLength(0);
    f.mutate(() => { f.list.innerHTML = '<div role="listitem">Synthetic changed markup.</div>'; });
    await f.clock.advance(2000); expect(f.storage['teamsTab:1'].error).toBe("capture stopped working");
    expect(f.db.sources("teams")[0]?.recordCount).toBe(2);
  } finally { await f.close(); }
});

test("helper does not accept claimed completeness before records reach disk", async () => {
  const f = setup();
  try {
    acceptCoverage(f.db, { sourceId: "teams:synthetic", expected: 3, have: 3, complete: true, gaps: [], reason: null, updatedAt: new Date().toISOString() });
    expect(f.db.coverage("teams:synthetic")).toMatchObject({ have: 0, complete: false, gaps: [[1, 3]] });
  } finally { await f.close(); }
});

test("runtime registration requests all frames; scroll lock distinguishes frames", async () => {
  const f = setup();
  try {
    await f.startWorker();
    const enabled = f.send({ type: "teams-enabled", enabled: true }); await f.clock.advance(0); await enabled;
    const script = f.registered.find((s) => s.id === "teams");
    expect(script.allFrames).toBe(true);
    expect(script.matches).toContain("https://*.sharepoint.com/*");
    expect(f.injections.every((s) => s.target.allFrames && s.target.tabId !== 2)).toBe(true);
    const lock = (frameId: number, op = "acquire") => f.send({ type: "scroll-lock", site: "teams", op }, { tab: { id: 1, incognito: false }, frameId });
    const a = lock(1); await f.clock.advance(0); expect((await a).ok).toBe(true);
    const b = lock(2); await f.clock.advance(0); expect((await b).ok).toBe(false);
    const c = lock(2, "release"); await f.clock.advance(0); await c;
    const d = lock(2); await f.clock.advance(0); expect((await d).ok).toBe(false);
  } finally { await f.close(); }
});

test("part Markdown paths differ, edits preserve first capture time and metadata revisions", async () => {
  const f = setup(page(row(1, 1), "one"));
  try {
    await f.start(); await f.clock.advance(1000);
    const original = f.db.getSource(f.db.sources("teams")[0]!.sourceId)[0]!;
    f.mutate(() => { f.dom.document.querySelector("[role='group']")!.setAttribute("aria-label", "Robin Vale, 00:05"); });
    await f.clock.advance(2000);
    const revised = f.db.getSource(original.source.id)[0]!;
    expect(revised.revision).toBe(2); expect(revised.author?.name).toBe("Robin Vale");
    expect(revised.fields.offsetSeconds).toBe(5); expect(revised.occurredAt).toBe(original.occurredAt);
    f.mutate(() => { f.dom.document.querySelector("option")!.setAttribute("value", "two"); });
    await f.clock.advance(2000);
    const ids = f.db.sources("teams").map((s) => s.sourceId);
    const { sourceSlug } = await import("../shared/src/index.ts");
    expect(new Set(ids.map(sourceSlug)).size).toBe(2);
  } finally { await f.close(); }
});

test("helper outage keeps counts unconfirmed and replays records plus coverage after restart", async () => {
  const f = setup(); f.hostMode = "missing";
  try {
    await f.start(); await f.clock.advance(3000);
    expect(f.db.sources("teams")).toHaveLength(0);
    expect(f.storage['teamsTab:1'].parts[0].count).toBe(0);
    expect(f.storage['teamsTab:1'].parts[0].savedCoverage).toBeNull();
    expect(f.storage.pendingCoverage.length).toBeGreaterThan(0);
    f.hostMode = "healthy"; await f.startWorker(); await f.clock.advance(3000);
    expect(f.db.sources("teams")[0]?.coverage?.complete).toBe(true);
    expect(f.storage['teamsTab:1'].parts[0].count).toBe(3);
  } finally { await f.close(); }
});

test("input in the outer Teams frame protects an idle transcript iframe", async () => {
  const f = setup(page(row(5) + row(6)), { hidden: false });
  try {
    await f.start(); await f.clock.advance(29_000);
    const activity = f.send({ type: "teams-activity", input: true }, { tab: { id: 1, incognito: false }, frameId: 0 });
    await f.clock.advance(0); await activity;
    await f.clock.advance(29_000); expect(f.scrolls).toHaveLength(0);
    await f.clock.advance(2000); expect(f.scrolls.length).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test("official MCP client reads Teams sources/search/recent/get/coverage", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createMcpServer } = await import("../helper/src/mcp.ts");
  const f = setup();
  const client = new Client({ name: "synthetic-teams-client", version: "1" });
  const server = createMcpServer(f.db);
  try {
    await f.start(); await f.clock.advance(2000);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const text = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return (result.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    };
    const source = f.db.sources("teams")[0]!;
    expect(await text("sources", { connection: "teams" })).toContain("coverage complete");
    expect(await text("search", { connection: "teams", query: "ribbon" })).toContain("01:03 into part");
    expect(await text("recent", { connection: "teams", checkpoint: true })).toContain("Recording started.");
    expect(await text("recent", { connection: "teams", checkpoint: true })).toBe("No matching records.");
    const got = await text("get", { sourceId: source.sourceId });
    expect(got.indexOf("position 1")).toBeLessThan(got.indexOf("position 3"));
    expect(got).toContain("meeting date unknown");
    expect(await text("coverage", { sourceId: source.sourceId })).toContain("fully captured");
  } finally { await client.close(); await server.close(); await f.close(); }
});

test("parent restriction arriving at queue storage prevents a helper write", async () => {
  const f = setup(page(row(1, 1)));
  let injected = false;
  f.beforeStorageSet = async (values) => {
    if (!injected && Array.isArray(values.pendingRecords) && values.pendingRecords.length > 0) {
      injected = true;
      await f.setStorage({ teamsBlockedUntil: f.clock.now + 86_400_000, teamsPauseReason: "copy restriction" });
    }
  };
  try {
    await f.start(); await f.clock.advance(3000);
    expect(injected).toBe(true); expect(f.db.sources("teams")).toHaveLength(0);
    expect(f.storage.pendingRecords).toHaveLength(0);
  } finally { await f.close(); }
});

test("persistent extent mismatch survives reader reload and never claims complete", async () => {
  const f = setup();
  try {
    await f.start(); await f.clock.advance(2000);
    const source = f.db.sources("teams")[0]!;
    // Emulate a full document/extension reload while retaining extension storage/database.
    f.contentContextError = "storage"; await f.clock.advance(1100); f.contentContextError = null;
    f.mutate(() => { f.list.innerHTML = row(1, 1); });
    await f.startWorker(); await f.startContent(); await f.clock.advance(2000);
    expect(f.storage['teamsTab:1'].error).toBe("capture stopped working");
    expect(f.db.coverage(source.sourceId)).toMatchObject({ complete: false, reason: "transcript extent changed" });
    acceptCoverage(f.db, { sourceId: source.sourceId, expected: 1, have: 1, complete: true, gaps: [], reason: null, updatedAt: new Date(f.clock.now).toISOString() });
    expect(f.db.coverage(source.sourceId)).toMatchObject({ have: 3, complete: false, reason: "transcript extent changed" });
    expect(f.db.getSource(source.sourceId)).toHaveLength(3);
  } finally { await f.close(); }
});

test("pause restoration waits for activity in the outer frame", async () => {
  const f = setup(page(row(5) + row(6)), { hidden: false });
  try {
    await f.start(); await f.clock.advance(30_500);
    expect(f.scrolls.length).toBeGreaterThan(0);
    const before = f.top;
    const parentInput = f.send({ type: "teams-activity", input: true }, { tab: { id: 1, incognito: false }, frameId: 0 });
    await f.clock.advance(0); await parentInput;
    await f.setStorage({ paused: true }); await f.clock.advance(1100);
    expect(f.top).toBe(before);
    await f.clock.advance(30_000); expect(f.top).toBe(1000);
  } finally { await f.close(); }
});

test("forget resets caches, stops capture and can be enabled for a fresh capture", async () => {
  const f = setup();
  try {
    await f.start(); await f.clock.advance(2000);
    const source = f.db.sources("teams")[0]!;
    const forget = f.send({ type: "forget", scope: "source", id: source.sourceId });
    await f.clock.advance(1000); expect((await forget).ok).toBe(true);
    expect(f.db.sources("teams")).toHaveLength(0);
    expect(f.storage.teamsEnabled).toBe(false);
    expect(f.storage['teamsTab:1'].reason).not.toBe("Complete");
    await f.setStorage({ teamsEnabled: true }); await f.clock.advance(3000);
    expect(f.db.sources("teams")[0]?.recordCount).toBe(3);
    expect(f.storage['teamsTab:1'].parts[0].savedCoverage.complete).toBe(true);
  } finally { await f.close(); }
});

test("navigation and removal invalidate popup state and reject stale epochs", async () => {
  const f = setup();
  try {
    await f.start(); await f.clock.advance(2000);
    f.tabUpdates.emit(1, { url: "https://teams.cloud.microsoft/new-page" });
    await f.clock.advance(0); expect(f.storage['teamsTab:1']).toBeNull();
    const stale = f.send({ type: "teams-page", reason: "stale page", generation: 0, navigationEpoch: 0 });
    await f.clock.advance(0); expect((await stale).ok).toBe(false);
    expect(f.storage['teamsTab:1']).toBeNull();
    f.tabRemovals.emit(1); await f.clock.advance(0);
    expect(f.storage['teamsTab:1']).toBeNull();
  } finally { await f.close(); }
});

test("iframe records wait until the outer page has passed the protection check", async () => {
  const f = setup();
  try {
    await f.startWorker();
    const { parseHTML } = await import("linkedom");
    const { extractTeams } = await import("../connections/teams/extract.ts");
    const records = (await extractTeams(parseHTML(fixture()).document, { url: FRAME })).parts[0]!.records;
    const sender = { tab: { id: 1, incognito: false }, frameId: 4 };
    const denied = f.send({ type: "records", records }, sender); await f.clock.advance(0); expect((await denied).ok).toBe(false);
    const check = f.send({ type: "teams-frame-check", blocked: null }); await f.clock.advance(0); await check;
    const accepted = f.send({ type: "records", records }, sender); await f.clock.advance(0); expect((await accepted).ok).toBe(true);
    const block = f.send({ type: "teams-frame-check", blocked: "copy restriction" }); await f.clock.advance(0); await block;
    const later = f.send({ type: "records", records }, sender); await f.clock.advance(0); expect((await later).ok).toBe(false);
  } finally { await f.close(); }
});

test("popup renders saved gaps/completeness and refuses a stale document cache", async () => {
  const { readFileSync } = await import("fs");
  const { runInNewContext } = await import("vm");
  const { parseHTML } = await import("linkedom");
  const path = await import("path");
  const dom = parseHTML(readFileSync(path.resolve(import.meta.dir, "../extension/src/popup.html"), "utf8"));
  const bundle = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../extension/src/popup.ts")], target: "browser", format: "iife" });
  const listeners: Array<() => void> = [];
  let url = STREAM;
  const storage: Record<string, any> = { teamsEnabled: true, 'teamsTab:4': { topUrl: STREAM, sourceId: "teams:synthetic", reason: "Reading transcript", parts: [{
    source: { id: "teams:synthetic", title: "Meeting transcript · Part one", url: STREAM }, count: 2,
    savedCoverage: { have: 2, expected: 3, complete: false, gaps: [[2, 2]] },
  }] } };
  runInNewContext(await bundle.outputs[0]!.text(), {
    document: dom.document, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement,
    chrome: { storage: { local: { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, storage[k]]).filter(([, v]) => v !== undefined)) }, onChanged: { addListener: (fn: () => void) => listeners.push(fn) } },
      tabs: { query: async () => [{ id: 4, url }] } },
  });
  const settle = async () => { for (let n = 0; n < 60; n++) await Promise.resolve(); };
  await settle();
  expect(dom.document.querySelector('#teamsParts')!.textContent).toContain('2 lines saved · 2 of 3; gaps 2');
  storage['teamsTab:4'].parts[0].count = 3;
  storage['teamsTab:4'].parts[0].savedCoverage = { have: 3, expected: 3, complete: true, gaps: [] };
  listeners.forEach((fn) => fn()); await settle();
  expect(dom.document.querySelector('#teamsParts')!.textContent).toContain('3 lines saved · Complete');
  url = "https://teams.cloud.microsoft/another-meeting";
  listeners.forEach((fn) => fn()); await settle();
  expect(dom.document.querySelector('#teamsParts')!.textContent).toBe('');
});

test("an actual parent restriction message interrupts serialized record acceptance", async () => {
  const f = setup();
  let injected = false;
  let parentBlock: Promise<any> | null = null;
  f.beforeStorageSet = async (values) => {
    if (!injected && Array.isArray(values.pendingRecords) && values.pendingRecords.length > 0) {
      injected = true;
      // Do not await the response: it is deliberately queued behind this write.
      parentBlock = f.send({ type: "teams-frame-check", blocked: "copy restriction" }, { tab: { id: 1, incognito: false }, frameId: 0 });
    }
  };
  try {
    await f.start(); await f.clock.advance(3000);
    expect(injected).toBe(true);
    expect(f.db.sources("teams")).toHaveLength(0);
    expect(f.storage.pendingRecords).toHaveLength(0);
    expect(f.storage.teamsBlockedUntil).toBeGreaterThan(f.clock.now);
    await parentBlock;
  } finally { await f.close(); }
});

test("manual jump after seeing row one retraces upward to fill the middle gap", async () => {
  const f = setup(page([1, 2, 3, 4].map((n) => row(n)).join('')), { hidden: false });
  f.height = 1200; f.visibleHeight = 400; f.top = 0; f.configureList();
  f.onScroll = () => {
    const start = Math.floor(f.top / 100) + 1;
    f.list.innerHTML = Array.from({ length: 4 }, (_, i) => row(start + i)).join('');
  };
  try {
    await f.start(); await f.clock.advance(1000);
    f.input("wheel");
    f.top = 600;
    f.mutate(() => { f.list.innerHTML = [7, 8, 9, 10].map((n) => row(n)).join(''); });
    await f.clock.advance(60_000);
    expect(f.db.sources("teams")[0]?.coverage).toMatchObject({ complete: true, expected: 12, have: 12, gaps: [] });
    expect(f.storage.teamsBlockedUntil ?? 0).toBeLessThan(f.clock.now);
  } finally { await f.close(); }
});

test("an interrupted restriction cleanup never replays discarded records after expiry", async () => {
  const { parseHTML } = await import("linkedom");
  const { extractTeams } = await import("../connections/teams/extract.ts");
  for (const expired of [false, true]) {
    const f = setup();
    try {
      const part = (await extractTeams(parseHTML(fixture()).document, { url: STREAM, now: new Date(f.clock.now - 10_000) })).parts[0]!;
      // Interrupted older cleanup: restriction persisted, queued records not purged.
      f.storage.pendingRecords = part.records;
      f.storage.teamsBlockedUntil = f.clock.now + (expired ? -1000 : 1000);
      f.storage.teamsEnabled = false;
      await f.startWorker(); await f.clock.advance(5000);
      expect(f.db.sources("teams")).toHaveLength(0);
      expect(f.storage.pendingRecords).toHaveLength(0);
      await f.startWorker(); await f.clock.advance(5000);
      expect(f.db.sources("teams")).toHaveLength(0);
      if (expired) {
        f.storage.pendingRecords = part.records.map((r) => ({ ...r, capturedAt: new Date(f.clock.now).toISOString() }));
        f.storage.teamsEnabled = true;
        await f.startWorker(); await f.clock.advance(1000);
        expect(f.db.sources("teams")[0]?.recordCount).toBe(3);
      }
    } finally { await f.close(); }
  }
});
