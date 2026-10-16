import teamsManifest from "../../connections/teams/connection.json";
import { backfillRange, statsKey, type BackfillRange } from "../../connections/slack/backfill.ts";
import manifest from "../../connections/slack/connection.json";
import { APP_NAME, type PageSnapshot } from "../../shared/src/index.ts";

interface State {
  slackEnabled: boolean;
  paused: boolean;
  slackBackfillEnabled: boolean;
  slackBackfillRange: BackfillRange;
  includeDms: boolean;
  includePrivate: boolean;
  todayCount: number;
  helperConnected: boolean;
  slackPauseReason: string | null;
  lastPage: PageSnapshot | null;
}

const empty: State = {
  slackEnabled: false,
  paused: false,
  slackBackfillEnabled: false,
  slackBackfillRange: "30d",
  includeDms: false,
  includePrivate: false,
  todayCount: 0,
  helperConnected: false,
  slackPauseReason: null,
  lastPage: null,
};

const wordmark = document.querySelector("#wordmark");
const tagline = document.querySelector("#tagline");
if (wordmark) wordmark.textContent = APP_NAME;
if (tagline) tagline.textContent = "Saves what you read, on this computer, for your AI.";
document.title = APP_NAME;

const risks = document.querySelector("#risks");
if (risks) {
  for (const risk of manifest.risks) {
    const item = document.createElement("li");
    item.textContent = risk;
    risks.append(item);
  }
}

async function readState(): Promise<State> {
  const stored = await chrome.storage.local.get(Object.keys(empty));
  const state = { ...empty, ...stored };
  if (state.lastPage?.sourceId) {
    const key = statsKey(state.lastPage.sourceId);
    const stats = await chrome.storage.local.get(key);
    if (typeof stats[key]?.count === "number") state.lastPage = { ...state.lastPage, count: stats[key].count };
  }
  return state;
}

function render(state: State): void {
  const page = state.lastPage;
  const title = document.querySelector("#pageTitle");
  const url = document.querySelector("#pageUrl");
  const count = document.querySelector("#pageCount");
  const coverage = document.querySelector("#pageCoverage");
  const error = document.querySelector<HTMLElement>("#pageError");
  if (title) title.textContent = page?.title || "Open a Slack channel to capture it.";
  if (url) url.textContent = page?.url || "";
  if (count) count.textContent = page ? `${page.count} saved from this channel` : "";
  if (coverage) coverage.textContent = page?.skipped || page?.coverage || "Nothing saved from this page yet.";
  if (error) {
    const message = page?.error || (state.slackPauseReason ? `Slack paused for today: ${state.slackPauseReason}` : "");
    error.hidden = !message;
    error.textContent = message;
  }
  const today = document.querySelector("#today");
  if (today) today.textContent = `${state.todayCount} saved`;

  const toggle = document.querySelector("#slackToggle");
  if (toggle instanceof HTMLButtonElement) {
    toggle.textContent = state.slackEnabled ? "On" : "Turn on";
    toggle.setAttribute("aria-pressed", state.slackEnabled ? "true" : "false");
  }
  const dms = document.querySelector("#includeDms");
  const priv = document.querySelector("#includePrivate");
  if (dms instanceof HTMLInputElement) dms.checked = state.includeDms;
  if (priv instanceof HTMLInputElement) priv.checked = state.includePrivate;
  const pause = document.querySelector("#pause");
  if (pause) pause.textContent = state.paused ? "Resume capture" : "Pause all capture";
  const backfill = document.querySelector("#backfillToggle");
  if (backfill instanceof HTMLButtonElement) {
    backfill.textContent = state.slackBackfillEnabled ? "On" : "Off";
    backfill.setAttribute("aria-pressed", String(state.slackBackfillEnabled));
    backfill.disabled = !state.slackEnabled || state.paused;
  }
  const range = document.querySelector("#backfillRange");
  if (range instanceof HTMLSelectElement) range.value = backfillRange(state.slackBackfillRange);
  const helper = document.querySelector("#helper");
  if (helper) {
    helper.textContent = state.helperConnected
      ? "Helper is connected."
      : "Helper is not connected. Run install, then reload the extension.";
  }
}

async function refresh(): Promise<void> {
  render(await readState());
  await renderTeams();
}

document.querySelector("#slackToggle")?.addEventListener("click", async () => {
  const state = await readState();
  if (state.slackEnabled) {
    await chrome.storage.local.set({ slackEnabled: false });
    chrome.runtime.sendMessage({ type: "slack-enabled", enabled: false });
  } else {
    const granted = await chrome.permissions.request({ origins: ["https://app.slack.com/*"] });
    if (!granted) return;
    await chrome.storage.local.set({ slackEnabled: true });
    chrome.runtime.sendMessage({ type: "slack-enabled", enabled: true });
  }
  await refresh();
});

document.querySelector("#includeDms")?.addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  await chrome.storage.local.set({ includeDms: target.checked });
});

document.querySelector("#includePrivate")?.addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  await chrome.storage.local.set({ includePrivate: target.checked });
});

document.querySelector("#pause")?.addEventListener("click", async () => {
  const state = await readState();
  await chrome.storage.local.set({ paused: !state.paused });
  await refresh();
});

document.querySelector("#backfillToggle")?.addEventListener("click", async () => {
  const state = await readState();
  await chrome.storage.local.set({ slackBackfillEnabled: !state.slackBackfillEnabled });
  await refresh();
});
document.querySelector("#backfillRange")?.addEventListener("change", async (event) => {
  if (event.target instanceof HTMLSelectElement) await chrome.storage.local.set({ slackBackfillRange: backfillRange(event.target.value) });
});

async function forget(scope: "source" | "connection"): Promise<void> {
  const state = await readState();
  const id = scope === "source" ? state.lastPage?.sourceId : manifest.id;
  if (!id) return;
  const label = scope === "source" ? "this page" : "Slack";
  if (!confirm(`Forget saved records for ${label}? This cannot be undone.`)) return;
  const response = await chrome.runtime.sendMessage({ type: "forget", scope, id });
  if (!response?.ok) {
    const error = document.querySelector<HTMLElement>("#pageError");
    if (error) { error.hidden = false; error.textContent = response?.message ?? "Could not forget saved records. Try again."; }
    return;
  }
  if (scope === "source") {
    await chrome.storage.local.set({
      lastPage: {
        sourceId: id,
        title: state.lastPage?.title ?? "Slack",
        url: state.lastPage?.url ?? "",
        count: 0,
        coverage: "Forgotten on this computer.",
        error: null,
        skipped: null,
      } satisfies PageSnapshot,
    });
  }
  await refresh();
}

document.querySelector("#forgetPage")?.addEventListener("click", () => void forget("source"));
document.querySelector("#forgetSite")?.addEventListener("click", () => void forget("connection"));

chrome.storage.onChanged.addListener(() => {
  void refresh();
});

void refresh();

for (const risk of teamsManifest.risks) {
  const li = document.createElement("li"); li.textContent = risk; document.querySelector("#teamsRisks")?.append(li);
}
async function teamsState(): Promise<Record<string, any>> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const key = `teamsTab:${tab?.id}`;
  const stored = await chrome.storage.local.get(["teamsEnabled", "teamsPauseReason", "teamsBlockedUntil", "paused", key]);
  const page = stored[key];
  return { ...stored, page: page && tab?.url && page.topUrl === tab.url ? page : null };
}
async function renderTeams() {
  const state = await teamsState();
  const toggle = document.querySelector<HTMLButtonElement>("#teamsToggle")!;
  toggle.textContent = state.teamsEnabled ? "On" : "Turn on";
  toggle.setAttribute("aria-pressed", String(Boolean(state.teamsEnabled)));
  const status = document.querySelector("#teamsStatus")!;
  status.textContent = !state.teamsEnabled ? "Teams capture off" : state.paused ? "All capture paused" : state.page?.reason ?? "Open a meeting transcript in Recap or Stream.";
  const error = document.querySelector<HTMLElement>("#teamsError")!;
  error.textContent = state.page?.error || (state.teamsBlockedUntil > Date.now() ? state.teamsPauseReason : "") || "";
  error.hidden = !error.textContent;
  const list = document.querySelector("#teamsParts")!;
  list.replaceChildren();
  for (const part of state.page?.parts ?? []) {
    const li = document.createElement("li");
    const c = part.savedCoverage;
    const gaps = c?.gaps?.map(([a, b]: [number, number]) => a === b ? a : `${a}–${b}`).join(", ");
    li.textContent = `${part.source.title}: ${part.count ?? 0} lines saved · ${c?.complete ? "Complete" : c ? `${c.have} of ${c.expected}; gaps ${gaps || "not established"}` : "Waiting for helper coverage"}`;
    list.append(li);
  }
}
document.querySelector("#teamsToggle")?.addEventListener("click", async () => {
  const state = await teamsState();
  const enabled = !state.teamsEnabled;
  // Keep the permission request on the user's click, as with Slack.
  if (enabled && !await chrome.permissions.request({ origins: teamsManifest.sites.map((site) => site.match) })) return;
  await chrome.storage.local.set({ teamsEnabled: enabled });
  const response = await chrome.runtime.sendMessage({ type: "teams-enabled", enabled });
  if (!response?.ok) {
    await chrome.storage.local.set({ teamsEnabled: false });
    const error = document.querySelector<HTMLElement>("#teamsError")!; error.hidden = false; error.textContent = "Could not enable Teams capture. Reload the extension and try again.";
    return;
  }
  await refresh();
});
async function forgetTeams(scope: "source" | "connection") {
  const state = await teamsState();
  const id = scope === "source" ? state.page?.sourceId : "teams";
  if (!id || !confirm(`Forget saved ${scope === "source" ? "transcript part" : "Teams transcripts"}? This cannot be undone.`)) return;
  const response = await chrome.runtime.sendMessage({ type: "forget", scope, id });
  if (!response?.ok) {
    const error = document.querySelector<HTMLElement>("#teamsError")!; error.hidden = false; error.textContent = response?.message ?? "Could not forget saved records.";
  } else await refresh();
}
document.querySelector("#forgetTeamsPart")?.addEventListener("click", () => void forgetTeams("source"));
document.querySelector("#forgetTeams")?.addEventListener("click", () => void forgetTeams("connection"));
