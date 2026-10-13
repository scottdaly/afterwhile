import { backfillRange, rangeDays, rangeLabel, readProgress, progressText, type BackfillProgress, type BackfillRange } from "../../connections/slack/backfill.ts";
import manifest from "../../connections/slack/connection.json";
import { applyVisible, channelPolicy, extractSlack, type KnownMessage, type SlackDraft, type SlackExtract } from "../../connections/slack/extract.ts";
import { decidePace, drawingStalled, IDLE_MS, scrollStepPx, USER_INPUT_EVENTS, type PaceSnapshot } from "../../connections/slack/pace.ts";
import selectors from "../../connections/slack/selectors.json";
import { endOfLocalDay, type CaptureRecord, type Coverage, type PageSnapshot } from "../../shared/src/index.ts";

interface Settings {
  slackEnabled: boolean;
  paused: boolean;
  slackBackfillEnabled: boolean;
  slackBackfillRange: BackfillRange;
  includeDms: boolean;
  includePrivate: boolean;
  slackBlockedUntil: number;
  slackHourBucket: string;
  slackHourLoads: number;
  slackPauseReason: string | null;
}

const defaults: Settings = {
  slackEnabled: false,
  paused: false,
  slackBackfillEnabled: false,
  slackBackfillRange: "30d",
  includeDms: false,
  includePrivate: false,
  slackBlockedUntil: 0,
  slackHourBucket: "",
  slackHourLoads: 0,
  slackPauseReason: null,
};

let settings: Settings = { ...defaults };
let known: KnownMessage[] = [];
let sourceId: string | null = null;
let progress: BackfillProgress = readProgress(null, "30d", Date.now());
let savedCount = 0;
let stalled = false;
let savedScroll: { container: HTMLElement; rowTs: string | null; offset: number; bottom: number; expectedTop: number } | null = null;
let restorePending = false;
let noProgressSteps = 0;
let nextScrollAt = 0;
let pendingLoad: { ids: Set<string>; oldest: number } | null = null;
let lastUserInputAt = Date.now();
let timer: number | null = null;
let timerAt = 0;
let running = false;
let rerun = false;
let windowLocked = false;
let stopped = false;
let observer: MutationObserver | null = null;

function contextInvalidated(error: unknown): boolean {
  return /extension context invalidated/i.test(error instanceof Error ? error.message : String(error));
}

function stop(): void {
  if (stopped) return;
  stopped = true;
  if (timer != null) window.clearTimeout(timer);
  timer = null;
  rerun = false;
  observer?.disconnect();
  observer = null;
  for (const eventName of USER_INPUT_EVENTS) window.removeEventListener(eventName, onUserInput, true);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  try { chrome.storage.onChanged.removeListener(onSettingsChanged); } catch { /* Context may already be gone. */ }
  window.__localMemorySlack = false;
  // Retiring a stale script must never move a person's current view.
  savedScroll = null;
}

function handleError(error: unknown): void {
  if (contextInvalidated(error)) stop();
  else console.error("Slack capture encountered an extension error.");
}

async function sendMessage(message: unknown): Promise<any> {
  if (stopped) return undefined;
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (contextInvalidated(error)) stop();
    throw error;
  }
}

function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  settings = { ...defaults, ...stored };
  settings.slackBackfillRange = backfillRange(settings.slackBackfillRange);
  const bucket = hourBucket(new Date());
  if (settings.slackHourBucket !== bucket) {
    settings.slackHourBucket = bucket;
    settings.slackHourLoads = 0;
  }
}

function toRecord(draft: SlackDraft, deleted = false): CaptureRecord {
  return {
    id: draft.id,
    connection: manifest.id,
    connectionVersion: manifest.version,
    kind: draft.kind,
    source: draft.source,
    position: null,
    occurredAt: draft.occurredAt,
    capturedAt: new Date().toISOString(),
    author: draft.author,
    text: deleted ? "" : draft.text,
    fields: { ...draft.fields, edited: draft.fields.edited || deleted },
    revision: 1,
    deleted,
  };
}

function publish(page: PageSnapshot): void {
  void sendMessage({ type: "page", page }).catch(handleError);
}

async function capture(extracted: SlackExtract): Promise<boolean> {
  const applied = applyVisible(known, extracted.messages, extracted.canInferDeletes);
  const records = [
    ...applied.upserts.map((draft) => toRecord(draft)),
    ...applied.deleted.map((message) => toRecord(message, true)),
  ];
  if (records.length > 0) {
    try {
      const response = await sendMessage({ type: "records", records });
      if (!response?.ok) return false;
    } catch {
      return false; // Keep the previous known list so the next tick retries delivery.
    }
    console.log(`captured ${records.length} ids=${records.map((record) => record.id).join(",")}`);
  }
  known = applied.known;
  const oldestAt = extracted.messages.filter((m) => m.kind === "message" && m.text)
    .map((m) => m.occurredAt).sort()[0];
  const response = await sendMessage({ type: "backfill-progress", sourceId: extracted.channel!.sourceId,
    range: settings.slackBackfillRange, oldestAt });
  if (!response?.ok) return false;
  progress = response.progress;
  savedCount = typeof response.count === "number" ? response.count : known.length;
  return true;
}

function scrollContainer(): HTMLElement | null {
  const list = Array.from(document.querySelectorAll<HTMLElement>(selectors.messageList))
    .find((el) => !el.closest(selectors.threadPane));
  if (!(list instanceof HTMLElement)) return null;
  const rows = Array.from(list.querySelectorAll<HTMLElement>(selectors.message));
  return [list, ...Array.from(list.querySelectorAll<HTMLElement>("*"))]
    .find((el) => rows.length > 0 && !el.closest(selectors.message) && rows.every((row) => el.contains(row)) && el.scrollHeight > el.clientHeight + 8) ?? list;
}

function schedule(delay: number): void {
  if (stopped) return;
  const due = Date.now() + delay;
  if (timer != null && timerAt <= due) return;
  if (timer != null) window.clearTimeout(timer);
  timerAt = due;
  timer = window.setTimeout(() => {
    timer = null;
    void tick();
  }, delay);
}

async function machineLocked(): Promise<boolean> {
  try {
    const response = await sendMessage({ type: "idle-state" });
    return response?.state === "locked";
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  if (stopped) return;
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    await step();
  } catch (error) {
    handleError(error);
    if (!stopped) schedule(3000);
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      schedule(0);
    }
  }
}

async function step(): Promise<void> {
  await loadSettings();
  if (!settings.slackEnabled) {
    restoreScroll();
    releaseLock();
    return;
  }
  const now = new Date();
  const rangeAtStart = settings.slackBackfillRange;
  const extracted = extractSlack(document, {
    url: location.href,
    now,
    oldestDays: rangeDays(backfillRange(settings.slackBackfillRange)),
  });

  if (extracted.pushback || now.getTime() < settings.slackBlockedUntil) {
    await stopForToday(extracted.pushback, now, extracted);
    return;
  }

  if (extracted.status === "stopped") {
    restoreScroll();
    releaseLock();
    publish({
      sourceId: extracted.channel?.sourceId ?? null,
      title: extracted.channel?.title ?? "Slack",
      url: location.href,
      count: known.length,
      coverage: "Capture stopped working",
      error: "capture stopped working",
      skipped: null,
    });
    schedule(3000);
    return;
  }

  if (!extracted.channel) {
    restoreScroll();
    releaseLock();
    publish({
      sourceId: null,
      title: "Slack",
      url: location.href,
      count: 0,
      coverage: "Nothing to capture on this page yet.",
      error: null,
      skipped: null,
    });
    schedule(2000);
    return;
  }

  if (extracted.channel.sourceId !== sourceId) {
    sourceId = extracted.channel.sourceId;
    known = [];
    progress = readProgress(null, backfillRange(settings.slackBackfillRange), Date.now());
    savedCount = 0;
    stalled = false;
    savedScroll = null;
    restorePending = false;
    noProgressSteps = 0;
    nextScrollAt = 0;
    pendingLoad = null;
    releaseLock();
  }

  const policy = channelPolicy(extracted.channel.kind, settings);
  if (!policy.capture) {
    restoreScroll();
    releaseLock();
    publish({
      sourceId: extracted.channel.sourceId,
      title: extracted.channel.title,
      url: extracted.channel.url,
      count: 0,
      coverage: policy.reason ?? "Off",
      error: null,
      skipped: policy.reason,
    });
    return;
  }

  if (settings.paused) {
    restoreScroll();
    releaseLock();
    publish({
      sourceId: extracted.channel.sourceId,
      title: extracted.channel.title,
      url: extracted.channel.url,
      count: savedCount,
      coverage: "All capture paused",
      error: null,
      skipped: null,
    });
    schedule(1000);
    return;
  }

  if (!await countHistoryLoad(extracted) || !await capture(extracted)) {
    releaseLock();
    schedule(1000);
    return;
  }

  if (!settings.slackBackfillEnabled) {
    restoreScroll();
    releaseLock();
    publish({ sourceId, title: extracted.channel.title, url: extracted.channel.url, count: savedCount,
      coverage: progressText(progress, "Saving visible messages · Automatic backfill off"), error: null, skipped: null });
    void sendMessage({ type: "coverage", coverage: { sourceId, expected: null, have: savedCount, gaps: [],
      complete: false, reason: "automatic backfill off", updatedAt: now.toISOString() } }).catch(handleError);
    schedule(2000);
    return;
  }

  if (settings.slackBackfillRange !== rangeAtStart) { schedule(0); return; }
  const visitBudget = manifest.pace.loadBudget;
  const hourlyBudget = manifest.pace.hourlyLoadBudget ?? 100;
  windowLocked = await machineLocked();
  if (stopped) return;
  const snapshot: PaceSnapshot = {
    now: Date.now(),
    lastUserInputAt,
    tabHidden: document.hidden,
    windowLocked,
    loadsThisVisit: progress.batchLoads,
    loadsThisHour: settings.slackHourLoads,
    visitBudget,
    hourlyBudget,
    reachedBeginning: extracted.reachedBeginning || (progress.reachedBoundary && progress.boundaryKind === "start"),
    reachedOldest: extracted.reachedOldest || progress.reachedBoundary,
    pushback: extracted.pushback,
    stalled,
    blockedUntil: settings.slackBlockedUntil || null,
  };
  const decision = decidePace(snapshot);

  if (decision.action === "stop" && decision.complete) {
    const response = await sendMessage({ type: "backfill-progress", sourceId, range: settings.slackBackfillRange, reachedBoundary: true, boundaryKind: decision.reason === "reached the start" ? "start" : "range" });
    if (response?.ok) progress = response.progress;
  }
  const rangeComplete = decision.action === "stop" && decision.complete && decision.reason === "reached the oldest point";
  const coverage: Coverage = {
    sourceId: extracted.channel.sourceId,
    expected: null,
    have: savedCount,
    gaps: [],
    // A history boundary proves neither contiguous coverage nor unopened thread replies.
    complete: false,
    reason: rangeComplete ? `selected range reached (${rangeLabel(settings.slackBackfillRange)})`
      : decision.action === "stop" && decision.complete ? "channel start reached; unopened threads may be missing"
      : decision.action === "stop" ? decision.reason : null,
    updatedAt: now.toISOString(),
  };
  const nextHour = (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000;
  const resumeAt = decision.action === "stop" && decision.reason === "hourly load budget reached" ? nextHour : progress.resumeAt;
  const resumeTime = resumeAt ? new Date(resumeAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "soon";
  const oldestVisible = extracted.messages.filter((m) => m.kind === "message").map((m) => m.occurredAt).sort()[0];
  const retracing = progress.oldestAt && oldestVisible && oldestVisible > progress.oldestAt;
  const status = decision.action === "wait"
    ? decision.reason === "person is using this tab" ? "Backfill waiting while you use this tab" : "Waiting for Slack to draw older messages"
    : decision.action === "scroll" ? retracing ? "Retracing saved history" : "Reading older messages"
    : rangeComplete ? `Selected range reached · ${rangeLabel(settings.slackBackfillRange)}`
    : decision.complete ? "Reached channel start · Open threads to save their replies"
    : decision.reason === "load budget reached" ? `Backfill resting · Resumes at ${resumeTime}`
    : decision.reason === "hourly load budget reached" ? `Hourly limit reached · Resumes at ${resumeTime}`
    : decision.reason;
  const coverageText = progressText(progress, status);

  publish({
    sourceId: extracted.channel.sourceId,
    title: extracted.channel.title,
    url: extracted.channel.url,
    count: savedCount,
    coverage: coverageText,
    error: null,
    skipped: null,
  });

  // AI clients need partial coverage while capture is active, too.
  void sendMessage({ type: "coverage", coverage }).catch(handleError);

  if (decision.action === "stop") {
    const budgetPause = decision.reason === "load budget reached" || decision.reason === "hourly load budget reached";
    // Retain the frontier while idle; returning/input still requests safe restoration.
    if (!budgetPause || restorePending) restoreScroll();
    releaseLock();
    schedule(decision.complete ? 5000 : resumeAt ? Math.max(1000, resumeAt - Date.now()) : 60_000);
    return;
  }

  if (decision.action === "wait") {
    if (decision.reason === "person is using this tab") restoreScroll();
    releaseLock();
    schedule(decision.retryMs);
    return;
  }

  if (restorePending) {
    restoreScroll();
    schedule(decision.pauseMs);
    return;
  }
  if (Date.now() < nextScrollAt) {
    schedule(nextScrollAt - Date.now());
    return;
  }

  const lock = await sendMessage({ type: "scroll-lock", op: "acquire", site: "slack" });
  if (!lock?.ok) {
    schedule(1500);
    return;
  }
  await loadSettings();
  if (settings.slackHourLoads >= hourlyBudget || settings.slackBlockedUntil > Date.now() || !settings.slackEnabled || settings.paused || !settings.slackBackfillEnabled || settings.slackBackfillRange !== rangeAtStart) {
    releaseLock();
    schedule(0);
    return;
  }

  const container = scrollContainer();
  if (!container) {
    releaseLock();
    schedule(decision.pauseMs);
    return;
  }
  // Input may have arrived while the lock request was in flight.
  if (userActive()) {
    restoreScroll();
    releaseLock();
    schedule(1000);
    return;
  }
  if (savedScroll == null) saveScroll(container);
  const channelMessages = extracted.messages.filter((message) => message.kind === "message");
  const beforeIds = channelMessages.map((message) => message.id);
  const beforeOldest = channelMessages.reduce((min, message) => Math.min(min, Date.parse(message.occurredAt)), Number.POSITIVE_INFINITY);
  const before = { scrollTop: container.scrollTop, rowIds: beforeIds };
  pendingLoad = { ids: new Set(beforeIds), oldest: beforeOldest };
  const stepPx = Math.min(scrollStepPx(container.clientHeight), Math.floor(container.clientHeight * decision.maxStepRatio));
  container.scrollTop = Math.max(0, container.scrollTop - stepPx);
  savedScroll!.expectedTop = container.scrollTop;
  // DOM notifications may capture promptly, but cannot shorten this reader pause.
  nextScrollAt = Date.now() + 350 + decision.pauseMs;
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  if (stopped) return;
  const afterExtract = extractSlack(document, { url: location.href, now: new Date(), oldestDays: rangeDays(backfillRange(settings.slackBackfillRange)) });
  if (afterExtract.pushback) {
    await stopForToday(afterExtract.pushback, new Date(), afterExtract);
    return;
  }
  if (afterExtract.status === "stopped") {
    restoreScroll();
    releaseLock();
    schedule(200);
    return;
  }
  if (afterExtract.channel?.sourceId !== sourceId) {
    savedScroll = null;
    releaseLock();
    schedule(200);
    return;
  }
  if (!settings.slackEnabled || settings.paused || !settings.slackBackfillEnabled || !channelPolicy(afterExtract.channel.kind, settings).capture) {
    restoreScroll();
    releaseLock();
    schedule(1000);
    return;
  }
  const afterMessages = afterExtract.messages.filter((message) => message.kind === "message");
  if (!userActive()) savedScroll!.expectedTop = container.scrollTop;
  const after = { scrollTop: container.scrollTop, rowIds: afterMessages.map((message) => message.id) };
  stalled = drawingStalled(before, after);
  const sameRows = before.rowIds.join("\n") === after.rowIds.join("\n");
  if (!sameRows || before.scrollTop !== after.scrollTop) noProgressSteps = 0;
  else noProgressSteps += 1;
  if (!await countHistoryLoad(afterExtract) || !await capture(afterExtract)) {
    releaseLock();
    schedule(1000);
    return;
  }
  if (noProgressSteps >= 3 && !afterExtract.reachedBeginning && !afterExtract.reachedOldest) {
    await stopForToday("content stopped loading", new Date(), afterExtract);
    return;
  }
  if (userActive()) {
    restoreScroll();
    releaseLock();
    schedule(1000);
  } else {
    schedule(Math.max(0, nextScrollAt - Date.now()));
  }
}

async function countHistoryLoad(extracted: SlackExtract): Promise<boolean> {
  const probe = pendingLoad;
  if (!probe || !extracted.messages.some((message) => message.kind === "message" && !probe.ids.has(message.id) && Date.parse(message.occurredAt) < probe.oldest)) return true;
  try {
    const response = await sendMessage({ type: "history-load", site: "slack", sourceId, range: settings.slackBackfillRange });
    if (!response?.ok) return false;
    pendingLoad = null;
    if (response.progress) progress = response.progress;
    settings.slackHourBucket = response.bucket;
    settings.slackHourLoads = response.loads;
    return true;
  } catch {
    return false;
  }
}

function userActive(): boolean {
  return !document.hidden && !windowLocked && Date.now() - lastUserInputAt < IDLE_MS;
}

function releaseLock(): void {
  void sendMessage({ type: "scroll-lock", op: "release", site: "slack" }).catch(handleError);
}

function saveScroll(container: HTMLElement): void {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(selectors.message));
  const rect = container.getBoundingClientRect();
  const row = rows.find((el) => el.getBoundingClientRect().bottom > rect.top && el.getBoundingClientRect().top < rect.bottom);
  savedScroll = {
    container,
    rowTs: row?.getAttribute(selectors.timestampAttr) ?? row?.querySelector(selectors.timestamp)?.getAttribute(selectors.timestampAttr) ?? null,
    offset: row ? row.getBoundingClientRect().top - container.getBoundingClientRect().top : 0,
    bottom: container.scrollHeight - container.clientHeight - container.scrollTop,
    expectedTop: container.scrollTop,
  };
}

function restoreScroll(): void {
  if (savedScroll == null) return;
  if (userActive()) {
    restorePending = true;
    // A person's own scroll supersedes the automation's saved position.
    if (savedScroll.container.isConnected && savedScroll.container.scrollTop === savedScroll.expectedTop) {
      schedule(Math.max(0, lastUserInputAt + IDLE_MS - Date.now()));
      return;
    }
  } else if (savedScroll.container.isConnected) {
    const { container, rowTs, offset, bottom } = savedScroll;
    const row = Array.from(container.querySelectorAll<HTMLElement>(selectors.message)).find((el) =>
      (el.getAttribute(selectors.timestampAttr) ?? el.querySelector(selectors.timestamp)?.getAttribute(selectors.timestampAttr)) === rowTs,
    );
    container.scrollTop = row
      ? container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - offset
      : container.scrollHeight - container.clientHeight - bottom;
  }
  savedScroll = null;
  restorePending = false;
}

function onUserInput(event: Event): void {
  if (stopped || !event.isTrusted) return;
  lastUserInputAt = Date.now();
  schedule(0);
}

function onVisibilityChange(): void {
  // Returning to a tab gets the same grace period as input, even before the pointer moves.
  if (!document.hidden) lastUserInputAt = Date.now();
  schedule(0);
}

function onSettingsChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (stopped || area !== "local") return;
  const controls = ["slackEnabled", "paused", "slackBackfillEnabled", "slackBackfillRange", "includeDms", "includePrivate", "slackBlockedUntil"] as const;
  if (controls.some((key) => key in changes && changes[key].newValue !== settings[key])) {
    for (const key of controls) if (key in changes) Object.assign(settings, { [key]: changes[key].newValue });
    schedule(0);
  }
}

declare global {
  interface Window { __localMemorySlack?: boolean; }
}

// Enabling Slack injects into open tabs, which may already have this script.
function start(): void {
  if (window.__localMemorySlack) return;
  window.__localMemorySlack = true;
  for (const eventName of USER_INPUT_EVENTS) {
    window.addEventListener(eventName, onUserInput, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  chrome.storage.onChanged.addListener(onSettingsChanged);

  const root = document.body ?? document.documentElement;
  if (root) {
    observer = new MutationObserver(() => {
      if (!running) schedule(200);
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  void tick();
}
start();

async function stopForToday(reason: string | null, now: Date, extracted: SlackExtract): Promise<void> {
  if (reason) {
    settings.slackBlockedUntil = endOfLocalDay(now);
    settings.slackPauseReason = reason;
    await chrome.storage.local.set({ slackBlockedUntil: settings.slackBlockedUntil, slackPauseReason: reason });
  }
  const channel = extracted.channel;
  const id = channel?.sourceId ?? sourceId;
  const pauseReason = reason ?? settings.slackPauseReason ?? "paused for the rest of the day";
  if (id) void sendMessage({ type: "coverage", coverage: {
    sourceId: id, expected: null, have: known.length, gaps: [], complete: false,
    reason: pauseReason, updatedAt: now.toISOString(),
  } satisfies Coverage }).catch(handleError);
  publish({ sourceId: id, title: channel?.title ?? "Slack", url: location.href, count: known.length,
    coverage: "Paused for the rest of the day.", error: `Slack paused for today: ${pauseReason}`, skipped: null });
  restoreScroll();
  releaseLock();
  schedule(60_000);
}
