import manifest from "../../connections/teams/connection.json";
import selectors from "../../connections/teams/selectors.json";
import { extractTeams, exactCoverage, transcriptPage, protectionReason } from "../../connections/teams/extract.ts";
import { IDLE_MS, nextPauseMs, USER_INPUT_EVENTS } from "../../shared/src/reader.ts";
import { type CaptureRecord } from "../../shared/src/index.ts";

let stopped = false, running = false;
let domGeneration = 0;
let navigationEpoch = 0;
let timer: number | null = null;
let lastInput = Date.now(), nextScroll = 0;
let current: string | null = null;
let saved: { el: HTMLElement; top: number; expectedTop: number } | null = null;
let direction: -1 | 1 = -1;
let stalled = false, unchanged = 0;
let probe: { ids: string; top: number } | null = null;
const known = new Map<string, string>();
const positions = new Map<string, Set<number>>();
let observer: MutationObserver | null = null;
let settings = { teamsEnabled: false, paused: false, teamsBlockedUntil: 0, teamsPauseReason: "", teamsResetGeneration: 0 };

function stop() {
  stopped = true;
  if (timer != null) window.clearTimeout(timer);
  observer?.disconnect();
  for (const name of USER_INPUT_EVENTS) window.removeEventListener(name, input, true);
  document.removeEventListener("visibilitychange", visibility);
  try { chrome.storage.onChanged.removeListener(changed); } catch { /* Context may be gone. */ }
  window.__localMemoryTeams = false;
  saved = null; // Invalidated scripts never restore/move the view.
}
async function send(message: unknown): Promise<any> {
  if (stopped) return;
  try { return await chrome.runtime.sendMessage(message); }
  catch (error) { if (/extension context invalidated/i.test(String(error))) stop(); throw error; }
}
function schedule(ms = 1000) {
  if (stopped || timer != null) return;
  timer = window.setTimeout(() => { timer = null; void tick(); }, ms);
}
function active() { return !document.hidden && Date.now() - lastInput < IDLE_MS; }
async function release() { await send({ type: "scroll-lock", site: "teams", op: "release" }); }
async function restore() {
  if (!saved) return;
  // Parent-frame activity matters on every exit path, including pause/off/errors.
  const activity = await send({ type: "teams-activity" });
  lastInput = Math.max(lastInput, activity?.lastInput ?? Date.now());
  if (!saved) return;
  if (!saved.el.isConnected || saved.el.scrollTop !== saved.expectedTop) { saved = null; return; }
  if (active()) return;
  saved.el.scrollTop = saved.top;
  saved = null;
}
function input(event: Event) {
  if (!event.isTrusted) return;
  lastInput = Date.now();
  // A real wheel/key gesture supersedes restoration; avoid jumping later.
  if (event.type === "wheel" || event.type === "keydown" || event.type === "touchstart") {
    saved = null; direction = -1; probe = null; stalled = false; unchanged = 0;
  }
  void send({ type: "teams-activity", input: true }).catch(() => {});
  schedule(0);
}
function visibility() { if (!document.hidden) { lastInput = Date.now(); void send({ type: "teams-activity", input: true }).catch(() => {}); } schedule(0); }
function changed(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== "local") return;
  if ("teamsResetGeneration" in changes) {
    known.clear(); positions.clear(); current = null; saved = null;
    probe = null; stalled = false; unchanged = 0; direction = -1; nextScroll = 0;
    void release().catch(() => {});
  }
  if (["teamsEnabled", "paused", "teamsBlockedUntil", "teamsResetGeneration"].some((key) => key in changes)) {
    for (const key of Object.keys(settings)) if (key in changes) Object.assign(settings, { [key]: changes[key]!.newValue });
    schedule(0);
  }
}
async function publish(error: string | null, reason: string) {
  await send({ type: "teams-page", sourceId: current, error, reason, generation: settings.teamsResetGeneration, navigationEpoch });
}
async function tick() {
  if (stopped || running) return;
  running = true;
  try { await step(); }
  catch (error) {
    if (/extension context invalidated/i.test(String(error))) stop();
    else { await release().catch(() => {}); await publish("Teams capture encountered an extension error.", "Will retry").catch(() => {}); }
  } finally { running = false; schedule(); }
}
async function step() {
  settings = { ...settings, ...await chrome.storage.local.get(Object.keys(settings)) };
  if (stopped) return;
  const epoch = settings.teamsResetGeneration;
  const generation = domGeneration;
  const pageUrl = location.href;
  if (!settings.teamsEnabled || settings.paused) { await restore(); await release(); return; }
  if (settings.teamsBlockedUntil > Date.now()) {
    await restore(); await release(); await publish(settings.teamsPauseReason, "Paused for the rest of the day"); return;
  }
  const guard = await send({ type: "teams-frame-check", blocked: protectionReason(document) });
  navigationEpoch = guard?.navigationEpoch ?? 0;
  if (!guard?.ok) { await restore(); await release(); return; }
  const activity = await send({ type: "teams-activity" });
  lastInput = Math.max(lastInput, activity?.lastInput ?? 0);
  const result = await extractTeams(document, { url: location.href });
  if (stopped || epoch !== settings.teamsResetGeneration || generation !== domGeneration || pageUrl !== location.href) return;
  const controlsAfterRead = await chrome.storage.local.get(["teamsEnabled", "paused", "teamsBlockedUntil", "teamsResetGeneration"]);
  if (!controlsAfterRead.teamsEnabled || controlsAfterRead.paused || controlsAfterRead.teamsBlockedUntil > Date.now() || (controlsAfterRead.teamsResetGeneration ?? 0) !== epoch || generation !== domGeneration || protectionReason(document)) { await release(); return; }
  if (result.status === "blocked") {
    await send({ type: "teams-blocked", reason: result.reason });
    await restore(); await release(); await publish(result.reason, "Paused for the rest of the day"); return;
  }
  if (result.status !== "ok") {
    await restore(); await release();
    // A parent Teams page has no transcript; never overwrite the frame's status.
    if (result.status === "stopped" || current) await publish(result.reason, result.reason ?? "Waiting for transcript");
    return;
  }
  const part = result.parts[0]!;
  const container = document.querySelector<HTMLElement>(`${selectors.root} ${selectors.container}`);
  if (!container) { await publish("capture stopped working", "capture stopped working"); await release(); return; }
  if (current !== part.source.id) {
    await restore(); await release(); current = part.source.id; saved = null;
    direction = -1; probe = null; stalled = false; unchanged = 0;
  }
  if (saved && container.scrollTop !== saved.expectedTop) {
    saved = null; direction = -1; probe = null; stalled = false; unchanged = 0;
  }
  const rowIds = part.records.map((r) => r.id).join("\n");
  if (probe) {
    const same = probe.ids === rowIds;
    stalled = same && container.scrollTop !== probe.top;
    unchanged = same ? unchanged + 1 : 0;
    probe = null;
  }
  const extent = await send({ type: "teams-extent", sourceId: current, expected: part.expected, generation: epoch, navigationEpoch });
  if (!extent?.ok) { await restore(); await release(); await publish("capture stopped working", "Transcript extent changed; forget and recapture only after checking part identity"); return; }
  const prior = positions.get(current) ?? new Set<number>();
  const records = part.records.filter((record) => known.get(record.id) !== fingerprint(record));
  if (records.length) {
    if (generation !== domGeneration || epoch !== settings.teamsResetGeneration || protectionReason(document)) return;
    const response = await send({ type: "records", records, generation: epoch, navigationEpoch });
    if (!response?.ok) { await release(); return; }
    for (const record of records) known.set(record.id, fingerprint(record));
  }
  if (epoch !== settings.teamsResetGeneration) return;
  for (const record of part.records) prior.add(record.position!);
  positions.set(current, prior);
  const coverage = exactCoverage(current, part.expected, prior);
  const status = coverage.complete ? "All positions queued; waiting for helper" : stalled && document.hidden ? "Waiting for visible, idle tab to draw lines"
    : active() ? "Waiting while you use this tab" : "Reading transcript";
  await send({ type: "teams-part", part: { source: part.source, part: part.part, coverage }, reason: status, generation: epoch, navigationEpoch });
  if (coverage.complete) { await restore(); await release(); return; }
  if (active() || (stalled && document.hidden)) { await release(); return; }
  // Three unchanged paints in a visible tab are a stop, never completeness.
  if (unchanged >= 3) {
    await send({ type: "teams-blocked", reason: "content stopped drawing" });
    await restore(); await release(); await publish("content stopped drawing", "Partial capture"); return;
  }
  if (Date.now() < nextScroll) return;
  const lock = await send({ type: "scroll-lock", site: "teams", op: "acquire" });
  if (!lock?.ok) return;
  // Recheck after awaits: a switch or person input can arrive in flight.
  const controls = await chrome.storage.local.get(["teamsEnabled", "paused", "teamsBlockedUntil"]);
  const latestActivity = await send({ type: "teams-activity" });
  lastInput = Math.max(lastInput, latestActivity?.lastInput ?? 0);
  if (stopped || !controls.teamsEnabled || controls.paused || controls.teamsBlockedUntil > Date.now() || active() || epoch !== settings.teamsResetGeneration || generation !== domGeneration || current !== part.source.id || !container.isConnected || protectionReason(document)) { await release(); return; }
  if (container.clientHeight <= 1) { await release(); return; }
  saved ??= { el: container, top: container.scrollTop, expectedTop: container.scrollTop };
  if (direction === -1 && (container.scrollTop <= 0 || part.records.some((record) => record.position === 1))) direction = 1;
  probe = { ids: rowIds, top: container.scrollTop };
  const step = Math.floor(container.clientHeight / 2);
  container.scrollTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + direction * step));
  saved.expectedTop = container.scrollTop;
  nextScroll = Date.now() + nextPauseMs();
}
function fingerprint(record: CaptureRecord) {
  return JSON.stringify([record.text, record.kind, record.author, record.fields]);
}
declare global { interface Window { __localMemoryTeams?: boolean; } }
if (transcriptPage(location.href) && !window.__localMemoryTeams) {
  window.__localMemoryTeams = true;
  for (const event of USER_INPUT_EVENTS) window.addEventListener(event, input, { capture: true, passive: true });
  document.addEventListener("visibilitychange", visibility);
  chrome.storage.onChanged.addListener(changed);
  observer = new MutationObserver(() => { domGeneration += 1; schedule(200); });
  observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  if (!document.hidden) void send({ type: "teams-activity", input: true }).catch(() => {});
  void tick();
}
