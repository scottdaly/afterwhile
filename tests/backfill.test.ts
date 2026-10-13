import { afterEach, describe, expect, test } from "bun:test";
import { progressKey, readProgress, BACKFILL_PAUSE_MS } from "../connections/slack/backfill.ts";
import { ExtensionFixture, SOURCE_ID, page, row } from "./extension-fixture.ts";
const active: ExtensionFixture[] = [];
function make(...args: ConstructorParameters<typeof ExtensionFixture>) { const h = new ExtensionFixture(...args); active.push(h); return h; }
afterEach(async () => { for (const h of active.splice(0)) await h.close(); });

describe("resumable bounded Slack backfill", () => {
  test("backfill off keeps capturing and revising without scrolling", async () => {
    const h = make(undefined, { hidden: true, settings: { slackBackfillEnabled: false } });
    await h.start(); await h.clock.advance(90_000);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(2);
    expect(h.scrolls).toHaveLength(0);
    h.mutate(() => { h.list.querySelector('.p-rich_text_section')!.textContent = 'Synthetic edit'; });
    await h.clock.advance(200);
    expect(h.db.revisions(h.db.getSource(SOURCE_ID)[0]!.id)).toHaveLength(2);
    expect(h.storage.lastPage.coverage).toContain('Automatic backfill off');
    expect(h.scrolls).toHaveLength(0);
  });

  test("switching backfill off during lock acquisition prevents the step", async () => {
    const h = make(undefined, { hidden: true });
    h.onSend = (m) => { if (m.type === 'scroll-lock' && m.op === 'acquire') { void h.setStorage({ slackBackfillEnabled: false }); h.onSend = null; } };
    await h.start(); await h.clock.advance(2000);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(2);
    expect(h.scrolls).toHaveLength(0);
  });

  test("a 20-load batch pauses and resumes at its frontier without a new visit", async () => {
    const h = make(undefined, { hidden: true }); h.top = 100_000; h.height = 110_000;
    let ts = 90;
    h.onScroll = () => h.mutate(() => { h.list.insertAdjacentHTML("afterbegin", row(ts--)); });
    await h.start(); await h.clock.advance(37_200);
    const checkpoint = h.storage[progressKey(SOURCE_ID)];
    expect(checkpoint.batchLoads).toBe(20);
    expect(checkpoint.resumeAt).toBeGreaterThan(h.clock.now);
    expect(checkpoint.oldestAt).toBeTruthy();
    expect(h.db.coverage(SOURCE_ID)).toMatchObject({ complete: false, reason: 'load budget reached' });
    expect(h.storage.lastPage.coverage).toContain('Resumes at');
    const pausedTop = h.top; const steps = h.scrolls.length;
    await h.clock.advance(checkpoint.resumeAt - h.clock.now - 1);
    expect(h.scrolls).toHaveLength(steps);
    expect(h.top).toBe(pausedTop);
    await h.clock.advance(351);
    expect(h.scrolls.length).toBeGreaterThan(steps);
    expect(h.top).toBeLessThan(pausedTop);
    expect(h.storage.slackHourLoads).toBe(21);
  });

  test("hourly allowance pauses and resumes automatically at the next hour", async () => {
    const h = make(undefined, { hidden: true, settings: { slackHourBucket: '2026-10-12T17', slackHourLoads: 99 } });
    h.top = 10_000; h.height = 12_000;
    let ts = 90; h.onScroll = () => h.mutate(() => { h.list.insertAdjacentHTML("afterbegin", row(ts--)); });
    await h.start(); await h.clock.advance(2000);
    expect(h.storage.slackHourLoads).toBe(100);
    expect(h.storage.lastPage.coverage).toContain('Hourly limit reached');
    const steps = h.scrolls.length;
    await h.clock.advance(3_598_000 - 1);
    expect(h.scrolls).toHaveLength(steps);
    await h.clock.advance(351);
    expect(h.storage.slackHourLoads).toBe(1);
    expect(h.scrolls.length).toBeGreaterThan(steps);
  });

  test("automatic continuation never exceeds the 100-load hourly allowance", async () => {
    const h = make(page(row(500) + row(700)), { hidden: true }); h.top = 30_000; h.height = 40_000;
    let ts = 499; h.onScroll = () => h.mutate(() => h.list.insertAdjacentHTML('afterbegin', row(ts--)));
    await h.start(); await h.clock.advance(1_000_000);
    expect(h.storage.slackHourLoads).toBe(100);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(102);
    expect(h.storage.lastPage.coverage).toContain('Hourly limit reached');
    const steps = h.scrolls.length;
    await h.clock.advance(300_000);
    expect(h.scrolls).toHaveLength(steps);
    expect(h.storage.slackHourLoads).toBe(100);
  });

  test("a persisted batch pause survives a fresh content instance and resumes paced retracing", async () => {
    const h = make(undefined, { hidden: true });
    h.storage[progressKey(SOURCE_ID)] = { oldestAt: '2026-09-15T00:00:00Z', range: '30d', reachedBoundary: false,
      batchLoads: 20, resumeAt: h.clock.now + 60_000 };
    await h.start();
    expect(h.scrolls).toHaveLength(0);
    expect(h.storage.lastPage.coverage).toContain('Resumes at');
    h.contentContextError = 'storage';
    h.mutate(() => h.dom.document.body.appendChild(h.dom.document.createElement('span')));
    await h.clock.advance(200); h.contentContextError = null;
    await h.startContent();
    expect(h.scrolls).toHaveLength(0);
    expect(h.storage[progressKey(SOURCE_ID)].batchLoads).toBe(20);
    await h.clock.advance(59_800);
    expect(h.scrolls).toHaveLength(1);
    expect(h.storage.lastPage.coverage).toContain('Retracing saved history');
    expect(h.scrolls[0]!.top).toBe(800);
  });

  test("progress survives a worker restart and a fresh page visit; helper count is cumulative", async () => {
    const h = make(undefined, { settings: { slackBackfillEnabled: false } });
    await h.start();
    const first = h.storage[progressKey(SOURCE_ID)];
    h.mutate(() => { h.list.innerHTML = row(400); }); await h.clock.advance(200);
    expect(h.storage.lastPage.count).toBe(3);
    const progress = await h.send({ type: 'backfill-progress', sourceId: SOURCE_ID, range: '30d' });
    expect(progress.count).toBe(3);
    expect(progress.progress.oldestAt).toBe(first.oldestAt);
    h.contentContextError = "storage";
    h.mutate(() => h.dom.document.body.appendChild(h.dom.document.createElement("span")));
    await h.clock.advance(200);
    h.contentContextError = null;
    await h.startWorker();
    await h.startContent();
    expect(h.storage.lastPage.count).toBe(3);
    expect(h.db.revisions(h.db.getSource(SOURCE_ID)[0]!.id)).toHaveLength(1);
    const resumed = await h.send({ type: 'backfill-progress', sourceId: SOURCE_ID, range: '30d' });
    expect(resumed.progress.oldestAt).toBe(first.oldestAt);
    expect(resumed.count).toBe(3);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(3);
    const other = await h.send({ type: 'backfill-progress', sourceId: 'slack:TTEST:COTHER', range: '30d' });
    expect(other.progress.oldestAt).toBeNull();
  });

  test("a recent-range boundary stays partial over MCP and all-history selection reopens it", async () => {
    const h = make(page(row(100).replace('1791822100.000100', '1789000000.000100')), { hidden: true, settings: { slackBackfillRange: 'recent' } });
    await h.start();
    expect(h.scrolls).toHaveLength(0);
    expect(h.db.coverage(SOURCE_ID)).toMatchObject({ complete: false, reason: 'selected range reached (past 7 days)' });
    expect(h.storage.lastPage.coverage).toContain('Selected range reached');
    await h.setStorage({ slackBackfillRange: 'all' }); await h.clock.advance(0);
    expect(h.scrolls).toHaveLength(1);
    expect(h.storage[progressKey(SOURCE_ID)].reachedBoundary).toBe(false);
    expect(h.db.coverage(SOURCE_ID)?.complete).toBe(false);
  });

  test("reaching channel start is remembered without claiming all thread coverage", async () => {
    const h = make(page(row(100)) + '<div data-qa="beginning-banner">This is the very beginning</div>', { hidden: true });
    await h.start();
    expect(h.db.coverage(SOURCE_ID)).toMatchObject({ complete: false, reason: 'channel start reached; unopened threads may be missing' });
    expect(h.storage[progressKey(SOURCE_ID)].boundaryKind).toBe('start');
    h.mutate(() => h.dom.document.querySelector('[data-qa="beginning-banner"]')!.remove());
    await h.clock.advance(200);
    expect(h.storage.lastPage.coverage).toContain('Reached channel start');
    expect(h.scrolls).toHaveLength(0);
  });

  test("returning to a budget-paused tab cannot move the view before input or idle", async () => {
    const h = make(undefined, { hidden: true, settings: { slackHourBucket: '2026-10-12T17', slackHourLoads: 99 } });
    h.onScroll = () => { h.onScroll = null; h.mutate(() => h.list.insertAdjacentHTML('afterbegin', row(90))); };
    await h.start(); await h.clock.advance(2000);
    const steps = h.scrolls.length;
    Object.defineProperty(h.dom.document, 'hidden', { value: false, writable: true });
    h.dom.document.dispatchEvent(new h.dom.window.Event('visibilitychange'));
    await h.clock.advance(29_999);
    expect(h.scrolls).toHaveLength(steps);
    await h.clock.advance(201);
    expect(h.top).toBe(1000);
  });

  test("forget clears persisted progress and source totals", async () => {
    const h = make(undefined, { settings: { slackBackfillEnabled: false } });
    await h.start();
    expect(h.storage[progressKey(SOURCE_ID)].oldestAt).toBeTruthy();
    await h.send({ type: 'forget', scope: 'source', id: SOURCE_ID });
    expect(h.storage[progressKey(SOURCE_ID)]).toBeNull();
    expect(h.storage[`slackSourceStats:${SOURCE_ID}`]).toBeNull();
  });

  test("range changes reset completion, but cannot erase the oldest saved point", () => {
    const progress = { oldestAt: '2026-09-01T00:00:00Z', range: 'recent' as const, reachedBoundary: true, batchLoads: 20, resumeAt: 9000 };
    expect(readProgress(progress, 'all', 1000)).toMatchObject({ oldestAt: progress.oldestAt, reachedBoundary: false, batchLoads: 0 });
    expect(readProgress(progress, 'recent', 9000)).toMatchObject({ batchLoads: 0, resumeAt: null });
    expect(BACKFILL_PAUSE_MS).toBe(60_000);
  });
});
