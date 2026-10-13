import {
  chunkRecords,
  NATIVE_HOST_ID,
  RECORD_BATCH_MAX_COUNT,
  type CaptureRecord,
  type Coverage,
  type PageSnapshot,
} from "../../shared/src/index.ts";

let port: chrome.runtime.Port | null = null;
let reconnectTimer: number | null = null;
const queue: CaptureRecord[] = [];
const PENDING_MAX_BYTES = 8 * 1024 * 1024;
let helperReady = false;
let inFlight: { batchId: string; records: CaptureRecord[] } | null = null;
// Serialise storage updates so an ack cannot overwrite a newly queued batch.
let pendingWork = Promise.resolve();
let queueLoaded = false;

function updateQueue(work: () => Promise<void>): Promise<void> {
  const result = pendingWork.then(async () => {
    if (!queueLoaded) {
      const stored = await chrome.storage.local.get("pendingRecords");
      if (Array.isArray(stored.pendingRecords)) queue.push(...stored.pendingRecords);
      queueLoaded = true;
    }
    await work();
  });
  pendingWork = result.catch((error) => console.error(`queue ${String(error)}`));
  return result;
}

async function releaseScrollLock(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get("slackScrollTab");
  if (stored.slackScrollTab === tabId) await chrome.storage.session.set({ slackScrollTab: null });
}

function badge(on: boolean): void {
  chrome.action.setBadgeText({ text: on ? "ON" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#1f6b4a" });
}

async function refreshBadge(): Promise<void> {
  const stored = await chrome.storage.local.get(["slackEnabled", "paused"]);
  badge(Boolean(stored.slackEnabled) && !stored.paused);
}

async function ensureSlackScript(enabled: boolean): Promise<void> {
  const id = "slack";
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const has = existing.some((script) => script.id === id);
  if (!enabled) {
    if (has) await chrome.scripting.unregisterContentScripts({ ids: [id] });
    return;
  }
  if (!has) await chrome.scripting.registerContentScripts([
    {
      id,
      matches: ["https://app.slack.com/*"],
      js: ["content-slack.js"],
      runAt: "document_idle",
      persistAcrossSessions: true,
    },
  ]);
  const tabs = await chrome.tabs.query({ url: "https://app.slack.com/*" });
  await Promise.all(tabs.filter((tab) => !tab.incognito && tab.id != null).map((tab) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["content-slack.js"] })
      .catch(() => undefined), // A tab can navigate or close between query and injection.
  ));
}

function rememberHelper(connected: boolean): void {
  chrome.storage.local.set({ helperConnected: connected });
}

function flush(): void {
  if (!port || !helperReady || inFlight || queue.length === 0) return;
  const records: CaptureRecord[] = [];
  const ids = new Set<string>();
  for (const record of chunkRecords(queue.slice(0, RECORD_BATCH_MAX_COUNT))[0]!) {
    // Replaying a batch with two versions of one id would create extra revisions.
    if (ids.has(record.id)) break;
    ids.add(record.id);
    records.push(record);
  }
  inFlight = { batchId: crypto.randomUUID(), records };
  try {
    port.postMessage({ type: "records", ...inFlight });
  } catch {
    port.disconnect();
  }
}

function connectNative(): void {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_ID);
  } catch {
    rememberHelper(false);
    scheduleReconnect();
    return;
  }
  const currentPort = port;
  rememberHelper(false);
  port.onMessage.addListener((message: { type?: string; batchId?: string; todayCount?: number; message?: string }) => {
    if (port !== currentPort) return;
    helperReady = true;
    rememberHelper(true);
    if (typeof message.todayCount === "number") {
      chrome.storage.local.set({ todayCount: message.todayCount, helperConnected: true });
    }
    if (message.type === "error") {
      console.error(`helper ${message.message ?? "error"}`);
      currentPort.disconnect();
      return;
    }
    void updateQueue(async () => {
      if (message.type === "ack" && inFlight && message.batchId === inFlight.batchId) {
        const remaining = queue.slice(inFlight.records.length);
        await chrome.storage.local.set({ pendingRecords: remaining });
        queue.splice(0, queue.length, ...remaining);
        inFlight = null;
      }
      flush();
    }).catch(() => {
      if (port === currentPort) currentPort.disconnect();
    });
  });
  port.onDisconnect.addListener(() => {
    if (port !== currentPort) return;
    port = null;
    helperReady = false;
    inFlight = null;
    rememberHelper(false);
    if (chrome.runtime.lastError) {
      console.error(`helper disconnected ${chrome.runtime.lastError.message ?? ""}`);
    }
    scheduleReconnect();
  });
  port.postMessage({ type: "stats" });
}

function scheduleReconnect(): void {
  if (reconnectTimer != null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, 5000) as unknown as number;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab?.incognito) {
    sendResponse({ ok: false, reason: "incognito" });
    return false;
  }
  connectNative();
  if (message?.type === "history-load" && message.site === "slack") {
    updateQueue(async () => {
      const bucket = new Date().toISOString().slice(0, 13);
      const stored = await chrome.storage.local.get(["slackHourBucket", "slackHourLoads"]);
      const loads = (stored.slackHourBucket === bucket ? Number(stored.slackHourLoads) || 0 : 0) + 1;
      await chrome.storage.local.set({ slackHourBucket: bucket, slackHourLoads: loads });
      sendResponse({ ok: true, bucket, loads });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "records" && Array.isArray(message.records)) {
    updateQueue(async () => {
      const pending = [...queue, ...(message.records as CaptureRecord[])];
      if (new TextEncoder().encode(JSON.stringify(pending)).byteLength > PENDING_MAX_BYTES) {
        throw new Error("pending records storage is full");
      }
      await chrome.storage.local.set({ pendingRecords: pending });
      queue.push(...(message.records as CaptureRecord[]));
      flush();
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "coverage") {
    port?.postMessage({ type: "coverage", coverage: message.coverage as Coverage });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "page") {
    chrome.storage.local.set({ lastPage: message.page as PageSnapshot });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "scroll-lock") {
    const tabId = sender.tab?.id ?? -1;
    const site = String(message.site ?? "slack");
    if (site !== "slack") {
      sendResponse({ ok: false });
      return false;
    }
    updateQueue(async () => {
      if (message.op === "release") {
        await releaseScrollLock(tabId);
        sendResponse({ ok: true });
        return;
      }
      const stored = await chrome.storage.session.get("slackScrollTab");
      const ok = stored.slackScrollTab == null || stored.slackScrollTab === tabId;
      if (ok && stored.slackScrollTab !== tabId) await chrome.storage.session.set({ slackScrollTab: tabId });
      sendResponse({ ok });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "idle-state") {
    chrome.idle.queryState(30, (state) => sendResponse({ state }));
    return true;
  }
  if (message?.type === "slack-enabled") {
    ensureSlackScript(Boolean(message.enabled))
      .then(() => refreshBadge())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: String(error) }));
    return true;
  }
  if (message?.type === "forget") {
    if (!port || !helperReady || !["source", "connection"].includes(message.scope) || typeof message.id !== "string") {
      sendResponse({ ok: false, message: "Connect the helper and try again." });
      return false;
    }
    updateQueue(async () => {
      const remaining = queue.filter((record) => (message.scope === "source" ? record.source.id : record.connection) !== message.id);
      await chrome.storage.local.set({ pendingRecords: remaining });
      queue.splice(0, queue.length, ...remaining);
      // Native messages are ordered: forget follows the outstanding record batch.
      inFlight = null;
      if (!port || !helperReady) throw new Error("helper disconnected");
      port.postMessage({ type: "forget", scope: message.scope, id: message.id });
      flush();
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, message: "Could not forget saved records. Try again." }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void updateQueue(() => releaseScrollLock(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === "loading") void updateQueue(() => releaseScrollLock(tabId));
});

chrome.storage.onChanged.addListener(() => {
  refreshBadge().catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    slackEnabled: false,
    paused: false,
    includeDms: false,
    includePrivate: false,
    todayCount: 0,
    helperConnected: false,
    slackHourBucket: "",
    slackHourLoads: 0,
  };
  const stored = await chrome.storage.local.get(Object.keys(defaults));
  await chrome.storage.local.set(Object.fromEntries(
    Object.entries(defaults).filter(([key]) => stored[key] === undefined),
  ));
  await ensureSlackScript(Boolean(stored.slackEnabled));
  chrome.idle.setDetectionInterval(30);
  connectNative();
  refreshBadge().catch(() => undefined);
});

chrome.idle.setDetectionInterval(30);
connectNative();
refreshBadge().catch(() => undefined);
