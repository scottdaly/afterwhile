import teamsManifest from "../../connections/teams/connection.json";
import slackManifest from "../../connections/slack/connection.json";
import { backfillRange, readProgress, progressKey, statsKey, BACKFILL_PAUSE_MS } from "../../connections/slack/backfill.ts";
import {
  chunkRecords,
  endOfLocalDay,
  NATIVE_HOST_ID,
  RECORD_BATCH_MAX_COUNT,
  type CaptureRecord,
  type Coverage,
  type PageSnapshot,
} from "../../shared/src/index.ts";

let port: chrome.runtime.Port | null = null;
let reconnectTimer: number | null = null;
const queue: CaptureRecord[] = [];
const coverages = new Map<string, Coverage>();
const PENDING_MAX_BYTES = 8 * 1024 * 1024;
let helperReady = false;
// Set synchronously when a restriction message arrives, before serialized work.
let teamsBlockedThrough = 0;
let inFlight: { batchId: string; records: CaptureRecord[] } | null = null;
// Serialise storage updates so an ack cannot overwrite a newly queued batch.
let pendingWork = Promise.resolve();
let queueLoaded = false;

function updateQueue(work: () => Promise<void>): Promise<void> {
  const result = pendingWork.then(async () => {
    if (!queueLoaded) {
      const stored = await chrome.storage.local.get(["pendingRecords", "pendingCoverage", "teamsBlockedUntil", "teamsDiscardThrough"]);
      teamsBlockedThrough = Math.max(teamsBlockedThrough, stored.teamsBlockedUntil ?? 0);
      // Heal an interrupted restriction cleanup, even after its daily pause ends.
      // New captures after the cutoff remain eligible on later days.
      const cutoff = stored.teamsDiscardThrough ?? stored.teamsBlockedUntil ?? 0;
      const records = Array.isArray(stored.pendingRecords) ? stored.pendingRecords : [];
      const safe = records.filter((record: CaptureRecord) => record.connection !== "teams" || Date.parse(record.capturedAt) > cutoff);
      const safeCoverage = (stored.pendingCoverage ?? []).filter((c: Coverage) => !c.sourceId.startsWith("teams:") || Date.parse(c.updatedAt) > cutoff);
      if (safe.length !== records.length || safeCoverage.length !== (stored.pendingCoverage?.length ?? 0)) {
        await chrome.storage.local.set({ pendingRecords: safe, pendingCoverage: safeCoverage });
      }
      queue.push(...safe);
      for (const c of safeCoverage) coverages.set(c.sourceId, c);
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
  const teams = await chrome.storage.session.get("teamsScrollOwner");
  if (String(teams.teamsScrollOwner).startsWith(`${tabId}:`)) await chrome.storage.session.set({ teamsScrollOwner: null });
}

function badge(on: boolean): void {
  chrome.action.setBadgeText({ text: on ? "ON" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#1f6b4a" });
}

async function refreshBadge(): Promise<void> {
  const stored = await chrome.storage.local.get(["slackEnabled", "teamsEnabled", "paused"]);
  badge(Boolean(stored.slackEnabled || stored.teamsEnabled) && !stored.paused);
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

async function ensureTeamsScript(enabled: boolean): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const has = existing.some((script) => script.id === "teams");
  if (!enabled) {
    if (has) await chrome.scripting.unregisterContentScripts({ ids: ["teams"] });
    return;
  }
  const matches = teamsManifest.sites.map((site) => site.match);
  if (!has) await chrome.scripting.registerContentScripts([{
    id: "teams", matches, allFrames: true, js: ["content-teams.js"], runAt: "document_idle", persistAcrossSessions: true,
  }]);
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(tabs.filter((tab) => !tab.incognito && tab.id != null).map((tab) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, files: ["content-teams.js"] }).catch(() => undefined)));
}

async function updateTeamsSaved(sources: Array<{ sourceId: string; count: number; coverage?: Coverage | null }>) {
  const all = await chrome.storage.local.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("teamsTab:") || !value?.parts) continue;
    const parts = value.parts.map((part: any) => {
      const ack = sources.find((s) => s.sourceId === part.source.id);
      return ack ? { ...part, count: ack.count, savedCoverage: ack.coverage } : part;
    });
    const selected = parts.find((part: any) => part.source.id === value.sourceId);
    await chrome.storage.local.set({ [key]: { ...value, parts,
      reason: selected?.savedCoverage?.complete ? "Complete" : selected?.savedCoverage?.reason ?? value.reason } });
  }
}

async function teamsAllowed(message: any, sender: chrome.runtime.MessageSender): Promise<boolean> {
  const state = await chrome.storage.local.get(["teamsEnabled", "paused", "teamsBlockedUntil", "teamsResetGeneration"]);
  const session = await chrome.storage.session.get([`teamsNavigation:${sender.tab?.id}`, `teamsParentGuard:${sender.tab?.id}`]);
  return Date.now() >= teamsBlockedThrough && Boolean(state.teamsEnabled) && !state.paused && !(state.teamsBlockedUntil > Date.now())
    && (message.generation ?? 0) === (state.teamsResetGeneration ?? 0)
    && (message.navigationEpoch ?? 0) === (session[`teamsNavigation:${sender.tab?.id}`] ?? 0)
    && (!sender.frameId || session[`teamsParentGuard:${sender.tab?.id}`]?.ready === true)
    && (!sender.documentLifecycle || sender.documentLifecycle === "active");
}
async function blockTeams(reason: string) {
  const cutoff = endOfLocalDay(new Date());
  const remaining = queue.filter((r) => r.connection !== "teams");
  const survivingCoverage = [...coverages.values()].filter((c) => !c.sourceId.startsWith("teams:"));
  // Persist the restriction, discard cutoff and queue purge in one storage write.
  await chrome.storage.local.set({ teamsBlockedUntil: cutoff, teamsPauseReason: reason, teamsDiscardThrough: cutoff,
    pendingRecords: remaining, pendingCoverage: survivingCoverage });
  queue.splice(0, queue.length, ...remaining);
  // Outstanding native writes precede this detected block; don't resend them.
  if (inFlight?.records.some((r) => r.connection === "teams")) inFlight = null;
  for (const [id] of coverages) if (id.startsWith("teams:")) coverages.delete(id);
}

async function invalidateTeamsTab(tabId: number) {
  await releaseScrollLock(tabId);
  const key = `teamsNavigation:${tabId}`;
  const state = await chrome.storage.session.get(key);
  await chrome.storage.session.set({ [key]: (state[key] ?? 0) + 1, [`teamsParentGuard:${tabId}`]: null, [`teamsInput:${tabId}`]: null });
  await chrome.storage.local.set({ [`teamsTab:${tabId}`]: null });
}

function rememberHelper(connected: boolean): void {
  chrome.storage.local.set({ helperConnected: connected });
}

function flush(): void {
  if (!port || !helperReady || inFlight) return;
  if (Date.now() < teamsBlockedThrough && queue.some((r) => r.connection === "teams")) return;
  if (queue.length === 0) {
    for (const coverage of coverages.values()) port.postMessage({ type: "coverage", coverage });
    return;
  }
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
  port.onMessage.addListener((message: { type?: string; batchId?: string; todayCount?: number; message?: string; sources?: Array<{ sourceId: string; count: number; coverage?: Coverage | null }> }) => {
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
      if (message.sources?.some((s) => s.sourceId.startsWith("teams:"))) await updateTeamsSaved(message.sources);
      // Coverage is replayable until the helper acknowledges this exact snapshot.
      if (message.type === "ack" && !message.batchId && message.sources) {
        for (const source of message.sources) {
          if (source.coverage?.updatedAt === coverages.get(source.sourceId)?.updatedAt) coverages.delete(source.sourceId);
        }
        await chrome.storage.local.set({ pendingCoverage: [...coverages.values()] });
      }
      if (message.type === "ack" && inFlight && message.batchId === inFlight.batchId) {
        for (const source of message.sources ?? []) {
          if (source.sourceId.startsWith("slack:")) {
            const state = await chrome.storage.local.get("lastPage");
            await chrome.storage.local.set({ [statsKey(source.sourceId)]: { count: source.count },
              ...(state.lastPage?.sourceId === source.sourceId ? { lastPage: { ...state.lastPage, count: source.count } } : {}) });
          }
        }
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
      if (typeof message.sourceId === "string" && message.sourceId.startsWith("slack:")) {
        const key = progressKey(message.sourceId);
        const state = await chrome.storage.local.get(key);
        const progress = readProgress(state[key], backfillRange(message.range), Date.now());
        progress.batchLoads += 1;
        if (slackManifest.pace.loadBudget != null && progress.batchLoads >= slackManifest.pace.loadBudget) progress.resumeAt = Date.now() + BACKFILL_PAUSE_MS;
        await chrome.storage.local.set({ [key]: progress });
        sendResponse({ ok: true, bucket, loads, progress });
      } else sendResponse({ ok: true, bucket, loads });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "backfill-progress" && typeof message.sourceId === "string" && message.sourceId.startsWith("slack:")) {
    updateQueue(async () => {
      const key = progressKey(message.sourceId);
      const state = await chrome.storage.local.get([key, statsKey(message.sourceId)]);
      const progress = readProgress(state[key], backfillRange(message.range), Date.now());
      if (typeof message.oldestAt === "string" && Number.isFinite(Date.parse(message.oldestAt))) {
        if (!progress.oldestAt || Date.parse(message.oldestAt) < Date.parse(progress.oldestAt)) progress.oldestAt = message.oldestAt;
      }
      if (message.reachedBoundary === true) {
        progress.reachedBoundary = true;
        progress.boundaryKind = message.boundaryKind === "start" ? "start" : "range";
      }
      await chrome.storage.local.set({ [key]: progress });
      sendResponse({ ok: true, progress, count: state[statsKey(message.sourceId)]?.count });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "records" && Array.isArray(message.records)) {
    updateQueue(async () => {
      const pending = [...queue, ...(message.records as CaptureRecord[])];
      if (new TextEncoder().encode(JSON.stringify(pending)).byteLength > PENDING_MAX_BYTES) {
        throw new Error("pending records storage is full");
      }
      const teams = message.records.some((r: CaptureRecord) => r.connection === "teams");
      if (teams && !await teamsAllowed(message, sender)) throw new Error("Teams capture is stopped");
      await chrome.storage.local.set({ pendingRecords: pending });
      // Storage can yield to a parent-frame restriction, pause, forget or navigation.
      // No helper write is sent until the authoritative gate has been checked again.
      if (teams && !await teamsAllowed(message, sender)) {
        await chrome.storage.local.set({ pendingRecords: [...queue] });
        throw new Error("Teams capture is stopped");
      }
      queue.push(...(message.records as CaptureRecord[]));
      flush();
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "coverage") {
    updateQueue(async () => {
      coverages.set(message.coverage.sourceId, message.coverage as Coverage);
      await chrome.storage.local.set({ pendingCoverage: [...coverages.values()] });
      flush();
    }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "page") {
    chrome.storage.local.set({ lastPage: message.page as PageSnapshot });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "scroll-lock") {
    const tabId = sender.tab?.id ?? -1;
    const site = String(message.site ?? "slack");
    if (site === "teams") {
      updateQueue(async () => {
        const owner = `${tabId}:${sender.frameId ?? 0}`;
        const stored = await chrome.storage.session.get(["teamsScrollOwner", "teamsScrollUntil"]);
        const ok = stored.teamsScrollOwner == null || stored.teamsScrollOwner === owner || stored.teamsScrollUntil < Date.now();
        if (message.op === "release") {
          if (stored.teamsScrollOwner === owner) await chrome.storage.session.set({ teamsScrollOwner: null });
        } else if (ok) await chrome.storage.session.set({ teamsScrollOwner: owner, teamsScrollUntil: Date.now() + 10_000 });
        sendResponse({ ok });
      }).catch(() => sendResponse({ ok: false }));
      return true;
    }
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
  if ((message?.type === "teams-frame-check" || message?.type === "teams-blocked") && sender.tab?.id != null) {
    if (message.blocked || message.type === "teams-blocked") teamsBlockedThrough = endOfLocalDay(new Date());
    updateQueue(async () => {
      if (message.blocked || message.type === "teams-blocked") await blockTeams(String(message.blocked ?? message.reason ?? "capture stopped"));
      const key = `teamsParentGuard:${sender.tab!.id}`;
      const navKey = `teamsNavigation:${sender.tab!.id}`;
      if (!sender.frameId && message.type === "teams-frame-check") await chrome.storage.session.set({ [key]: { ready: !message.blocked } });
      const session = await chrome.storage.session.get([key, navKey]);
      const state = await chrome.storage.local.get("teamsBlockedUntil");
      sendResponse({ ok: !(state.teamsBlockedUntil > Date.now()) && (!sender.frameId || session[key]?.ready), navigationEpoch: session[navKey] ?? 0 });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "teams-extent" && typeof message.sourceId === "string" && message.sourceId.startsWith("teams:")) {
    updateQueue(async () => {
      if (!await teamsAllowed(message, sender)) { sendResponse({ ok: false }); return; }
      const key = `teamsExtent:${message.sourceId}`;
      const state = await chrome.storage.local.get(key);
      const previous = state[key];
      const invalid = previous?.invalid || (previous && previous.expected !== message.expected);
      await chrome.storage.local.set({ [key]: { expected: previous?.expected ?? message.expected, invalid: Boolean(invalid) } });
      if (invalid) {
        coverages.set(message.sourceId, { sourceId: message.sourceId, expected: message.expected, have: 0, gaps: [], complete: false, reason: "transcript extent changed", updatedAt: new Date().toISOString() });
        await chrome.storage.local.set({ pendingCoverage: [...coverages.values()] }); flush();
      }
      sendResponse({ ok: !invalid });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "teams-activity" && sender.tab?.id != null) {
    updateQueue(async () => {
      const key = `teamsInput:${sender.tab!.id}`;
      if (message.input) await chrome.storage.session.set({ [key]: Date.now() });
      const state = await chrome.storage.session.get(key);
      sendResponse({ lastInput: state[key] ?? 0 });
    }).catch(() => sendResponse({ lastInput: Date.now() }));
    return true;
  }
  if (message?.type === "teams-enabled") {
    ensureTeamsScript(Boolean(message.enabled)).then(() => refreshBadge()).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, message: "Could not enable Teams capture." }));
    return true;
  }
  if ((message?.type === "teams-part" || message?.type === "teams-page") && sender.tab?.id != null) {
    updateQueue(async () => {
      const key = `teamsTab:${sender.tab!.id}`;
      const state = await chrome.storage.local.get(key);
      const previous = state[key] ?? { parts: [] };
      if (!await teamsAllowed(message, sender)) { sendResponse({ ok: false }); return; }
      if (message.type === "teams-part") {
        const part = message.part;
        const doc = String(part.source.id).split(":part:")[0];
        const parts = previous.parts.filter((p: any) => p.source.id.startsWith(`${doc}:part:`));
        const old = parts.find((p: any) => p.source.id === part.source.id);
        const next = { ...part, count: old?.count ?? 0, savedCoverage: old?.savedCoverage ?? null };
        await chrome.storage.local.set({ [key]: { sourceId: part.source.id, parts: [...parts.filter((p: any) => p.source.id !== part.source.id), next], error: null, reason: old?.savedCoverage?.complete ? "Complete" : message.reason, topUrl: sender.tab?.url } });
        coverages.set(part.source.id, part.coverage);
        await chrome.storage.local.set({ pendingCoverage: [...coverages.values()] });
        flush();
      } else await chrome.storage.local.set({ [key]: { ...previous, error: message.error, reason: message.reason } });
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "forget") {
    if (!port || !helperReady || !["source", "connection"].includes(message.scope) || typeof message.id !== "string") {
      sendResponse({ ok: false, message: "Connect the helper and try again." });
      return false;
    }
    updateQueue(async () => {
      if (message.id === "teams" || message.id.startsWith("teams:")) {
        const state = await chrome.storage.local.get("teamsResetGeneration");
        await chrome.storage.local.set({ teamsResetGeneration: (state.teamsResetGeneration ?? 0) + 1, teamsEnabled: false });
      }
      for (const [id] of coverages) if (message.scope === "source" ? id === message.id : id.startsWith(`${message.id}:`)) coverages.delete(id);
      await chrome.storage.local.set({ pendingCoverage: [...coverages.values()] });
      const remaining = queue.filter((record) => (message.scope === "source" ? record.source.id : record.connection) !== message.id);
      await chrome.storage.local.set({ pendingRecords: remaining });
      queue.splice(0, queue.length, ...remaining);
      // Native messages are ordered: forget follows the outstanding record batch.
      inFlight = null;
      if (!port || !helperReady) throw new Error("helper disconnected");
      port.postMessage({ type: "forget", scope: message.scope, id: message.id });
      const state = await chrome.storage.local.get(null);
      for (const [key, value] of Object.entries(state)) {
        if (key.startsWith("teamsTab:") && value?.parts) await chrome.storage.local.set({ [key]: { ...value,
          parts: value.parts.filter((p: any) => message.scope === "source" ? p.source.id !== message.id : message.id !== "teams"), sourceId: null, reason: "Forgotten on this computer. Teams capture off." } });
      }
      const keys = Object.keys(state).filter((key) => message.scope === "source"
        ? key === progressKey(message.id) || key === statsKey(message.id) || key === `teamsExtent:${message.id}`
        : (message.id === "slack" && (key.startsWith("slackBackfill:") || key.startsWith("slackSourceStats:"))) || (message.id === "teams" && key.startsWith("teamsExtent:")));
      await chrome.storage.local.set(Object.fromEntries(keys.map((key) => [key, null])));
      flush();
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, message: "Could not forget saved records. Try again." }));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void updateQueue(() => invalidateTeamsTab(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === "loading" || changes.url) void updateQueue(() => invalidateTeamsTab(tabId));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.teamsBlockedUntil) teamsBlockedThrough = Math.max(teamsBlockedThrough, changes.teamsBlockedUntil.newValue ?? 0);
  refreshBadge().catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    slackEnabled: false,
    teamsEnabled: false,
    paused: false,
    slackBackfillEnabled: false,
    slackBackfillRange: "30d",
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
  await ensureTeamsScript(Boolean(stored.teamsEnabled));
  chrome.idle.setDetectionInterval(30);
  connectNative();
  refreshBadge().catch(() => undefined);
});

chrome.idle.setDetectionInterval(30);
connectNative();
refreshBadge().catch(() => undefined);
