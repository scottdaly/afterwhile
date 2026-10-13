import manifest from "../../connections/slack/connection.json";
import { applyVisible, channelPolicy, extractSlack, type KnownMessage, type SlackDraft, type SlackExtract } from "../../connections/slack/extract.ts";
import { decidePace, drawingStalled, IDLE_MS, scrollStepPx, USER_INPUT_EVENTS, type PaceSnapshot } from "../../connections/slack/pace.ts";
import selectors from "../../connections/slack/selectors.json";
import { coverageHint, endOfLocalDay, type CaptureRecord, type Coverage, type PageSnapshot } from "../../shared/src/index.ts";

interface Settings {
  slackEnabled: boolean;
  paused: boolean;
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
let loadsThisVisit = 0;
let stalled = false;
let savedScroll: { container: HTMLElement; rowTs: string | null; offset: number; bottom: number; expectedTop: number } | null = null;
let restorePending = false;
let noProgressSteps = 0;
let nextScrollAt = 0;
let lastUserInputAt = Date.now();
let timer: number | null = null;
let timerAt = 0;
let running = false;
let rerun = false;
let windowLocked = false;

function hourBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

async function loadSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  settings = { ...defaults, ...stored };
  const bucket = hourBucket(new Date());
  if (settings.slackHourBucket !== bucket) {
    settings.slackHourBucket = bucket;
    settings.slackHourLoads = 0;
    await chrome.storage.local.set({ slackHourBucket: bucket, slackHourLoads: 0 });
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
  chrome.runtime.sendMessage({ type: "page", page });
}

async function capture(extracted: SlackExtract): Promise<boolean> {
  const applied = applyVisible(known, extracted.messages);
  const records = [
    ...applied.upserts.map((draft) => toRecord(draft)),
    ...applied.deleted.map((message) => toRecord(message, true)),
  ];
  if (records.length > 0) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "records", records });
      if (!response?.ok) return false;
    } catch {
      return false; // Keep the previous known list so the next tick retries delivery.
    }
    console.log(`captured ${records.length} ids=${records.map((record) => record.id).join(",")}`);
  }
  known = applied.known;
  return true;
}

function scrollContainer(): HTMLElement | null {
  const list = Array.from(document.querySelectorAll<HTMLElement>(selectors.messageList))
    .find((el) => !el.closest(selectors.threadPane));
  if (!(list instanceof HTMLElement)) return null;
  return [list, ...Array.from(list.querySelectorAll<HTMLElement>("*"))]
    .find((el) => el.scrollHeight > el.clientHeight + 8) ?? list;
}

function schedule(delay: number): void {
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
    const response = await chrome.runtime.sendMessage({ type: "idle-state" });
    return response?.state === "locked";
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    await step();
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
  const extracted = extractSlack(document, {
    url: location.href,
    now,
    oldestDays: manifest.pace.oldestDays ?? 30,
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
    loadsThisVisit = 0;
    stalled = false;
    savedScroll = null;
    restorePending = false;
    noProgressSteps = 0;
    nextScrollAt = 0;
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
      count: known.length,
      coverage: "Paused",
      error: null,
      skipped: null,
    });
    schedule(1000);
    return;
  }

  if (!await capture(extracted)) {
    releaseLock();
    schedule(1000);
    return;
  }

  const visitBudget = manifest.pace.loadBudget;
  const hourlyBudget = manifest.pace.hourlyLoadBudget ?? 100;
  windowLocked = await machineLocked();
  const snapshot: PaceSnapshot = {
    now: Date.now(),
    lastUserInputAt,
    tabHidden: document.hidden,
    windowLocked,
    loadsThisVisit,
    loadsThisHour: settings.slackHourLoads,
    visitBudget,
    hourlyBudget,
    reachedBeginning: extracted.reachedBeginning,
    reachedOldest: extracted.reachedOldest,
    pushback: extracted.pushback,
    stalled,
    blockedUntil: settings.slackBlockedUntil || null,
  };
  const decision = decidePace(snapshot);

  const coverage: Coverage = {
    sourceId: extracted.channel.sourceId,
    expected: null,
    have: known.length,
    gaps: [],
    complete: decision.action === "stop" && decision.complete,
    reason: decision.action === "stop" && !decision.complete ? decision.reason : null,
    updatedAt: now.toISOString(),
  };
  const coverageText =
    decision.action === "scroll" || decision.action === "wait"
      ? known.length > 0
        ? "Reading this channel."
        : "Nothing saved from this page yet."
      : coverageHint(coverage, extracted.channel.title);

  publish({
    sourceId: extracted.channel.sourceId,
    title: extracted.channel.title,
    url: extracted.channel.url,
    count: known.length,
    coverage: coverageText,
    error: null,
    skipped: null,
  });

  if (decision.action === "stop") {
    chrome.runtime.sendMessage({ type: "coverage", coverage });
    restoreScroll();
    releaseLock();
    schedule(decision.complete ? 5000 : 60_000);
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

  const lock = await chrome.runtime.sendMessage({ type: "scroll-lock", op: "acquire", site: "slack" });
  if (!lock?.ok) {
    schedule(1500);
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
  const stepPx = Math.min(scrollStepPx(container.clientHeight), Math.floor(container.clientHeight * decision.maxStepRatio));
  container.scrollTop = Math.max(0, container.scrollTop - stepPx);
  savedScroll!.expectedTop = container.scrollTop;
  // DOM notifications may capture promptly, but cannot shorten this reader pause.
  nextScrollAt = Date.now() + 350 + decision.pauseMs;
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  const afterExtract = extractSlack(document, { url: location.href, now: new Date(), oldestDays: manifest.pace.oldestDays ?? 30 });
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
  if (!settings.slackEnabled || settings.paused || !channelPolicy(afterExtract.channel.kind, settings).capture) {
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
  if (!sameRows) noProgressSteps = 0;
  else if (!document.hidden || before.scrollTop === after.scrollTop) noProgressSteps += 1;
  if (!await capture(afterExtract)) {
    releaseLock();
    schedule(1000);
    return;
  }
  if (noProgressSteps >= 3 && !afterExtract.reachedBeginning && !afterExtract.reachedOldest) {
    await stopForToday("content stopped loading", new Date(), afterExtract);
    return;
  }
  const newOlder = afterMessages.some(
    (message) => !beforeIds.includes(message.id) && Date.parse(message.occurredAt) < beforeOldest,
  );
  if (newOlder) {
    loadsThisVisit += 1;
    settings.slackHourLoads += 1;
    await chrome.storage.local.set({
      slackHourBucket: settings.slackHourBucket,
      slackHourLoads: settings.slackHourLoads,
    });
  }
  if (userActive()) {
    restoreScroll();
    releaseLock();
    schedule(1000);
  } else {
    schedule(Math.max(0, nextScrollAt - Date.now()));
  }
}

function userActive(): boolean {
  return !document.hidden && !windowLocked && Date.now() - lastUserInputAt < IDLE_MS;
}

function releaseLock(): void {
  chrome.runtime.sendMessage({ type: "scroll-lock", op: "release", site: "slack" });
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
    if (savedScroll.container.scrollTop === savedScroll.expectedTop) return;
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

function onUserInput(): void {
  lastUserInputAt = Date.now();
  schedule(0);
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
  document.addEventListener("visibilitychange", () => schedule(0));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const controls = ["slackEnabled", "paused", "includeDms", "includePrivate", "slackBlockedUntil"] as const;
    if (controls.some((key) => key in changes && changes[key].newValue !== settings[key])) {
      for (const key of controls) if (key in changes) Object.assign(settings, { [key]: changes[key].newValue });
      schedule(0);
    }
  });

  const root = document.body ?? document.documentElement;
  if (root) {
    new MutationObserver(() => {
      if (!running) schedule(200);
    }).observe(root, { childList: true, subtree: true });
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
  if (id) chrome.runtime.sendMessage({ type: "coverage", coverage: {
    sourceId: id, expected: null, have: known.length, gaps: [], complete: false,
    reason: pauseReason, updatedAt: now.toISOString(),
  } satisfies Coverage });
  publish({ sourceId: id, title: channel?.title ?? "Slack", url: location.href, count: known.length,
    coverage: "Paused for the rest of the day.", error: `Slack paused for today: ${pauseReason}`, skipped: null });
  restoreScroll();
  releaseLock();
  schedule(60_000);
}
