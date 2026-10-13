import { SiteScrollLock } from "../../connections/slack/pace.ts";
import {
  chunkRecords,
  NATIVE_HOST_ID,
  type CaptureRecord,
  type Coverage,
  type PageSnapshot,
} from "../../shared/src/index.ts";

const slackLock = new SiteScrollLock();
let port: chrome.runtime.Port | null = null;
let reconnectTimer: number | null = null;
const queue: CaptureRecord[] = [];

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
  if (has) return;
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: ["https://app.slack.com/*"],
      js: ["content-slack.js"],
      runAt: "document_idle",
      persistAcrossSessions: true,
    },
  ]);
}

function rememberHelper(connected: boolean): void {
  chrome.storage.local.set({ helperConnected: connected });
}

function flush(): void {
  if (!port || queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  for (const chunk of chunkRecords(batch)) {
    port.postMessage({ type: "records", records: chunk });
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
  port.onMessage.addListener((message: { type?: string; todayCount?: number; message?: string }) => {
    if (typeof message.todayCount === "number") {
      chrome.storage.local.set({ todayCount: message.todayCount, helperConnected: true });
    }
    if (message.type === "error") {
      console.error(`helper ${message.message ?? "error"}`);
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    rememberHelper(false);
    if (chrome.runtime.lastError) {
      console.error(`helper disconnected ${chrome.runtime.lastError.message ?? ""}`);
    }
    scheduleReconnect();
  });
  rememberHelper(true);
  port.postMessage({ type: "stats" });
  flush();
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
  if (message?.type === "records" && Array.isArray(message.records)) {
    queue.push(...(message.records as CaptureRecord[]));
    flush();
    sendResponse({ ok: true });
    return false;
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
    if (message.op === "release") {
      slackLock.release(tabId);
      sendResponse({ ok: true });
      return false;
    }
    sendResponse({ ok: slackLock.tryAcquire(tabId) });
    return false;
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
    port?.postMessage({ type: "forget", scope: message.scope, id: message.id });
    sendResponse({ ok: Boolean(port) });
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  slackLock.release(tabId);
});

chrome.storage.onChanged.addListener(() => {
  refreshBadge().catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    slackEnabled: false,
    paused: false,
    includeDms: false,
    includePrivate: false,
    todayCount: 0,
    helperConnected: false,
  });
  chrome.idle.setDetectionInterval(30);
  connectNative();
  refreshBadge().catch(() => undefined);
});

chrome.idle.setDetectionInterval(30);
connectNative();
refreshBadge().catch(() => undefined);
