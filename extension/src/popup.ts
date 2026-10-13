import manifest from "../../connections/slack/connection.json";
import { APP_NAME, type PageSnapshot } from "../../shared/src/index.ts";

interface State {
  slackEnabled: boolean;
  paused: boolean;
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
  return { ...empty, ...stored };
}

function render(state: State): void {
  const page = state.lastPage;
  const title = document.querySelector("#pageTitle");
  const url = document.querySelector("#pageUrl");
  const count = document.querySelector("#pageCount");
  const coverage = document.querySelector("#pageCoverage");
  const error = document.querySelector("#pageError");
  if (title) title.textContent = page?.title || "Open a Slack channel to capture it.";
  if (url) url.textContent = page?.url || "";
  if (count) count.textContent = page ? `${page.count} on this page` : "";
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
  if (pause) pause.textContent = state.paused ? "Resume" : "Pause";
  const helper = document.querySelector("#helper");
  if (helper) {
    helper.textContent = state.helperConnected
      ? "Helper is connected."
      : "Helper is not connected. Run install, then reload the extension.";
  }
}

async function refresh(): Promise<void> {
  render(await readState());
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

async function forget(scope: "source" | "connection"): Promise<void> {
  const state = await readState();
  const id = scope === "source" ? state.lastPage?.sourceId : manifest.id;
  if (!id) return;
  const label = scope === "source" ? "this page" : "Slack";
  if (!confirm(`Forget saved records for ${label}? This cannot be undone.`)) return;
  chrome.runtime.sendMessage({ type: "forget", scope, id });
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
