import manifest from "../../connections/slack/connection.json";
import { applyVisible, channelPolicy, extractSlack, type KnownMessage, type SlackDraft } from "../../connections/slack/extract.ts";
import { decidePace, drawingStalled, scrollStepPx, USER_INPUT_EVENTS, type PaceSnapshot } from "../../connections/slack/pace.ts";
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
}

const defaults: Settings = {
  slackEnabled: false,
  paused: false,
  includeDms: false,
  includePrivate: false,
  slackBlockedUntil: 0,
  slackHourBucket: "",
  slackHourLoads: 0,
};

let settings: Settings = { ...defaults };
let known: KnownMessage[] = [];
let sourceId: string | null = null;
let loadsThisVisit = 0;
let stalled = false;
let savedScroll: number | null = null;
let lastUserInputAt = Date.now();
let timer: number | null = null;
let running = false;

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

function sendRecords(records: CaptureRecord[]): void {
  if (records.length === 0) return;
  console.log(`captured ${records.length} ids=${records.map((record) => record.id).join(",")}`);
  chrome.runtime.sendMessage({ type: "records", records });
}

function scrollContainer(): HTMLElement | null {
  const list = document.querySelector(selectors.messageList);
  if (!(list instanceof HTMLElement)) return null;
  let el: HTMLElement | null = list;
  while (el) {
    if (el.scrollHeight > el.clientHeight + 8) return el;
    el = el.parentElement;
  }
  return list;
}

function schedule(delay: number): void {
  if (timer != null) window.clearTimeout(timer);
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
  if (running) return;
  running = true;
  try {
    await step();
  } finally {
    running = false;
  }
}

async function step(): Promise<void> {
  await loadSettings();
  if (!settings.slackEnabled) return;
  const now = new Date();
  const extracted = extractSlack(document, {
    url: location.href,
    now,
    oldestDays: manifest.pace.oldestDays ?? 30,
  });

  if (extracted.status === "stopped") {
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
  }

  const policy = channelPolicy(extracted.channel, settings);
  if (!policy.capture) {
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

  if (!extracted.pushback) {
    const applied = applyVisible(known, extracted.messages);
    known = applied.known;
    const records = [
      ...applied.upserts.map((draft) => toRecord(draft)),
      ...applied.deleted.map((message) =>
        toRecord(
          {
            id: message.id,
            kind: "message",
            source: {
              id: extracted.channel!.sourceId,
              title: extracted.channel!.title,
              url: extracted.channel!.url,
            },
            occurredAt: message.occurredAt,
            author: null,
            text: message.text,
            fields: { threadTs: null, replyCount: 0, edited: false },
          },
          true,
        ),
      ),
    ];
    sendRecords(records);
  }

  const visitBudget = manifest.pace.loadBudget;
  const hourlyBudget = manifest.pace.hourlyLoadBudget ?? 100;
  const snapshot: PaceSnapshot = {
    now: now.getTime(),
    lastUserInputAt,
    tabHidden: document.hidden,
    windowLocked: await machineLocked(),
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
    error: extracted.pushback ? `Slack paused for today: ${extracted.pushback}` : decision.action === "stop" && decision.reason === "paused" ? "Paused" : null,
    skipped: null,
  });

  if (decision.action === "stop") {
    chrome.runtime.sendMessage({ type: "coverage", coverage });
    if (extracted.pushback) {
      const until = endOfLocalDay(now);
      settings.slackBlockedUntil = until;
      await chrome.storage.local.set({ slackBlockedUntil: until, slackPauseReason: extracted.pushback });
    }
    restoreScroll();
    chrome.runtime.sendMessage({ type: "scroll-lock", op: "release", site: "slack" });
    schedule(decision.complete ? 5000 : 60_000);
    return;
  }

  if (decision.action === "wait") {
    chrome.runtime.sendMessage({ type: "scroll-lock", op: "release", site: "slack" });
    schedule(decision.retryMs);
    return;
  }

  const lock = await chrome.runtime.sendMessage({ type: "scroll-lock", op: "acquire", site: "slack" });
  if (!lock?.ok) {
    schedule(1500);
    return;
  }

  const container = scrollContainer();
  if (!container) {
    schedule(decision.pauseMs);
    return;
  }
  if (savedScroll == null) savedScroll = container.scrollTop;
  const beforeIds = extracted.messages.map((message) => message.id);
  const beforeOldest = extracted.messages.reduce((min, message) => Math.min(min, Date.parse(message.occurredAt)), Number.POSITIVE_INFINITY);
  const before = { scrollTop: container.scrollTop, rowIds: beforeIds };
  const stepPx = Math.min(scrollStepPx(container.clientHeight), Math.floor(container.clientHeight * decision.maxStepRatio));
  container.scrollTop = Math.max(0, container.scrollTop - stepPx);
  await new Promise((resolve) => window.setTimeout(resolve, 350));
  const afterExtract = extractSlack(document, { url: location.href, now: new Date(), oldestDays: manifest.pace.oldestDays ?? 30 });
  const after = { scrollTop: container.scrollTop, rowIds: afterExtract.messages.map((message) => message.id) };
  stalled = drawingStalled(before, after);
  const newOlder = afterExtract.messages.some(
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
  schedule(decision.pauseMs);
}

function restoreScroll(): void {
  if (savedScroll == null) return;
  const container = scrollContainer();
  if (container) container.scrollTop = savedScroll;
  savedScroll = null;
}

function onUserInput(): void {
  lastUserInputAt = Date.now();
}

for (const eventName of USER_INPUT_EVENTS) {
  window.addEventListener(eventName, onUserInput, { passive: true, capture: true });
}
document.addEventListener("visibilitychange", () => schedule(0));
chrome.storage.onChanged.addListener(() => schedule(0));

const root = document.body ?? document.documentElement;
if (root) {
  new MutationObserver(() => {
    if (!running) schedule(200);
  }).observe(root, { childList: true, subtree: true });
}

void tick();
