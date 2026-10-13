import type { SourceRef } from "../../shared/src/index.ts";
import selectors from "./selectors.json";

export interface QueryEl {
  querySelector(selector: string): QueryEl | null;
  querySelectorAll(selector: string): ArrayLike<QueryEl>;
  getAttribute(name: string): string | null;
  textContent: string | null;
  closest(selector: string): QueryEl | null;
  parentElement?: QueryEl | null;
  innerText?: string;
}

export interface QueryRoot {
  querySelector(selector: string): QueryEl | null;
  querySelectorAll(selector: string): ArrayLike<QueryEl>;
  body?: { textContent: string | null } | null;
}

export interface SlackChannel {
  teamId: string;
  channelId: string;
  title: string;
  url: string;
  kind: "public" | "dm" | "private";
  sourceId: string;
}

export interface SlackDraft {
  id: string;
  kind: "message" | "thread_reply";
  source: SourceRef;
  occurredAt: string;
  author: { name: string; id: string } | null;
  text: string;
  fields: { threadTs: string | null; replyCount: number; edited: boolean };
  paneId?: string;
}

export interface SlackExtract {
  canInferDeletes: boolean;
  status: "ok" | "stopped";
  reason: string | null;
  pushback: string | null;
  reachedBeginning: boolean;
  reachedOldest: boolean;
  channel: SlackChannel | null;
  messages: SlackDraft[];
}

export interface ExtractOptions {
  url: string;
  now?: Date;
  oldestDays?: number;
}

export interface KnownMessage extends SlackDraft {
  position: number | null;
}

const STOPPED = "capture stopped working";

export function parseSlackUrl(url: string): { teamId: string; channelId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "app.slack.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const client = parts.indexOf("client");
  if (client < 0 || parts.length < client + 3) return null;
  const teamId = parts[client + 1] ?? "";
  const channelId = parts[client + 2] ?? "";
  if (!/^T[A-Z0-9]+$/.test(teamId) || !/^[CDG][A-Z0-9]+$/.test(channelId)) return null;
  return { teamId, channelId };
}

export function channelPolicy(
  kind: SlackChannel["kind"],
  settings: { includeDms: boolean; includePrivate: boolean },
): { capture: boolean; reason: string | null } {
  if (kind === "dm" && !settings.includeDms) {
    return { capture: false, reason: "DMs are off" };
  }
  if (kind === "private" && !settings.includePrivate) {
    return { capture: false, reason: "Private channels are off" };
  }
  return { capture: true, reason: null };
}

export function extractSlack(document: QueryRoot, options: ExtractOptions): SlackExtract {
  const now = options.now ?? new Date();
  const oldestDays = options.oldestDays ?? 30;
  const empty: SlackExtract = {
    canInferDeletes: false,
    status: "ok",
    reason: null,
    pushback: null,
    reachedBeginning: false,
    reachedOldest: false,
    channel: null,
    messages: [],
  };

  const pushback = detectPushback(document);
  if (pushback) return { ...empty, reason: pushback, pushback };

  const ids = parseSlackUrl(options.url);
  const shell = document.querySelector(selectors.shell);
  if (!ids || !shell) {
    const bodyText = (document.body?.textContent ?? "").trim();
    if (bodyText.length > 80) {
      return { ...empty, status: "stopped", reason: STOPPED };
    }
    return empty;
  }

  const channel = readChannel(document, ids, options.url);
  const list = sliceNodes(document.querySelectorAll(selectors.messageList)).find((node) => !node.closest(selectors.threadPane));
  const messages = list ? readMessages(list, channel) : [];
  const roots: QueryRoot[] = list ? [list] : [];
  const channelIds = new Set(messages.map((message) => message.id));
  for (const pane of sliceNodes(document.querySelectorAll(selectors.threadPane))) {
    const parent = pane.getAttribute(selectors.threadTsAttr);
    // A thread can remain open from another channel; its own source is unverified.
    if (parent && channelIds.has(`${channel.sourceId}:${parent}`)) {
      roots.push(pane);
      messages.push(...readMessages(pane, channel));
    }
  }
  const listText = (list?.textContent ?? "").replace(/\s+/g, " ").trim();
  const hasTimestamp = list?.querySelector(selectors.timestamp) != null;
  const beginning = reachedBeginning(document);
  if (list && messages.length === 0 && !hasTimestamp && !beginning && listText.length > 40) {
    return { ...empty, status: "stopped", reason: STOPPED, channel };
  }

  const cutoff = now.getTime() - oldestDays * 24 * 60 * 60 * 1000;
  let oldest = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    if (message.kind !== "message") continue;
    const time = Date.parse(message.occurredAt);
    if (time < oldest) oldest = time;
  }
  const reachedOldest = messages.length > 0 && oldest <= cutoff;

  return {
    canInferDeletes: roots.every((root) => sliceNodes(root.querySelectorAll(selectors.message)).every((node) => messageTimestamp(node) != null)),
    status: "ok",
    reason: null,
    pushback: null,
    reachedBeginning: beginning,
    reachedOldest,
    channel,
    messages,
  };
}

export function planUpdates(
  known: KnownMessage[],
  visible: SlackDraft[],
  canInferDeletes = true,
): { upserts: SlackDraft[]; deletedIds: string[] } {
  const key = (id: string, pane: string) => `${pane}:${id}`;
  const visibleIds = new Set(visible.map((message) => key(message.id, paneId(message))));
  const visibleRecordIds = new Set(visible.map((message) => message.id));
  const previous = new Map(known.map((message) => [key(message.id, message.paneId ?? "channel"), message]));
  const upserts = visible.filter((message) => message.text && previous.get(key(message.id, paneId(message)))?.text !== message.text);
  if (!canInferDeletes) return { upserts, deletedIds: [] };

  const ordered = [...known].sort((a, b) =>
    (a.paneId ?? "channel").localeCompare(b.paneId ?? "channel") || compareKnown(a, b),
  );
  const deletedIds: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i];
    if (!item || visibleRecordIds.has(item.id)) continue;
    const prev = i > 0 ? ordered[i - 1] : undefined;
    const next = i + 1 < ordered.length ? ordered[i + 1] : undefined;
    if (!prev || !next) continue;
    const pane = item.paneId ?? "channel";
    if (pane === "thread:unknown" || (prev.paneId ?? "channel") !== pane || (next.paneId ?? "channel") !== pane) continue;
    if (!visibleIds.has(key(prev.id, pane)) || !visibleIds.has(key(next.id, pane))) continue;
    deletedIds.push(item.id);
  }
  return { upserts, deletedIds };
}

export function applyVisible(
  known: KnownMessage[],
  visible: SlackDraft[],
  canInferDeletes = true,
): { known: KnownMessage[]; upserts: SlackDraft[]; deleted: KnownMessage[] } {
  const plan = planUpdates(known, visible, canInferDeletes);
  const deleted = known.filter((message) => plan.deletedIds.includes(message.id));
  const next = known.filter((message) => !plan.deletedIds.includes(message.id));
  for (const message of visible) {
    // A timestamped row can be present before its text draws. Keep its old value.
    if (!message.text) continue;
    const entry: KnownMessage = {
      ...message,
      position: null,
      paneId: paneId(message),
    };
    const index = next.findIndex((item) => item.id === message.id && (item.paneId ?? "channel") === paneId(message));
    if (index >= 0) next[index] = entry;
    else next.push(entry);
  }
  return { known: next, upserts: plan.upserts, deleted };
}

function paneId(message: SlackDraft): string {
  return message.paneId ?? (message.kind === "thread_reply" ? `thread:${message.fields.threadTs ?? "unknown"}` : "channel");
}

function compareKnown(a: KnownMessage, b: KnownMessage): number {
  if (a.position != null && b.position != null && a.position !== b.position) {
    return a.position - b.position;
  }
  if (a.occurredAt < b.occurredAt) return -1;
  if (a.occurredAt > b.occurredAt) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function detectPushback(document: QueryRoot): string | null {
  if (document.querySelector(selectors.captcha)) return "CAPTCHA";
  if (document.querySelector(selectors.login)) return "sign-in prompt";
  const banner = document.querySelector(selectors.errorBanner);
  const bannerText = (banner?.textContent ?? "").toLowerCase();
  if (bannerText.includes("slow down")) return "slow down";
  if (bannerText.includes("something went wrong")) return "something went wrong";
  if (banner) return "something went wrong";
  return null;
}

function reachedBeginning(document: QueryRoot): boolean {
  const banner = sliceNodes(document.querySelectorAll(selectors.beginning)).find((node) => !node.closest(selectors.threadPane));
  const text = (banner?.textContent ?? "").toLowerCase();
  return text.includes("very beginning") || text.includes("this is the start");
}

function readChannel(
  document: QueryRoot,
  ids: { teamId: string; channelId: string },
  url: string,
): SlackChannel {
  const header = document.querySelector(selectors.channelHeader);
  const dm = header?.querySelector(selectors.dmIndicator) != null || ids.channelId.startsWith("D");
  const lock = header?.querySelector(selectors.privateChannelLock) != null;
  const publicId = ids.channelId.startsWith("C");
  let kind: SlackChannel["kind"];
  if (dm) kind = "dm";
  else if (lock || !publicId || !header?.querySelector(selectors.channelName)?.textContent?.trim()) kind = "private";
  else kind = "public";

  const nameEl =
    header?.querySelector(kind === "dm" ? selectors.dmIndicator : selectors.channelName) ??
    header?.querySelector(selectors.channelName) ??
    header?.querySelector(selectors.dmIndicator);
  const title = (nameEl?.textContent ?? "").replace(/\s+/g, " ").trim() || ids.channelId;
  let page = url;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    page = parsed.toString();
  } catch {
    page = url;
  }
  return {
    teamId: ids.teamId,
    channelId: ids.channelId,
    title,
    url: page,
    kind,
    sourceId: `slack:${ids.teamId}:${ids.channelId}`,
  };
}

function readMessages(root: QueryRoot, channel: SlackChannel): SlackDraft[] {
  const nodes = sliceNodes(root.querySelectorAll(selectors.message));
  const messages: SlackDraft[] = [];
  for (const node of nodes) {
    const ts = messageTimestamp(node);
    if (!ts) continue;
    const blocks = sliceNodes(node.querySelectorAll(selectors.messageText));
    const text = blocks
      .filter((block) => !blocks.includes(block.parentElement?.closest(selectors.messageText) as QueryEl))
      .map((block) => (block.closest(selectors.messageCode) === block
        ? block.textContent ?? ""
        : block.innerText ?? block.textContent ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
    const authorEl = node.querySelector(selectors.author);
    const authorName = (authorEl?.textContent ?? "").replace(/\s+/g, " ").trim();
    const authorId = authorEl?.getAttribute(selectors.authorIdAttr)?.trim() ?? "";
    const repliesText = node.querySelector(selectors.threadReplies)?.textContent ?? "";
    const replyMatch = repliesText.match(/(\d+)/);
    const pane = node.closest(selectors.threadPane);
    const threadTs = pane?.getAttribute(selectors.threadTsAttr) ?? null;
    const occurredMs = Number(ts) * 1000;
    if (!Number.isFinite(occurredMs)) continue;
    messages.push({
      id: `${channel.sourceId}:${ts}`,
      kind: pane ? "thread_reply" : "message",
      source: { id: channel.sourceId, title: channel.title, url: channel.url },
      occurredAt: new Date(occurredMs).toISOString(),
      author: authorName ? { name: authorName, id: authorId } : null,
      text,
      fields: {
        threadTs,
        replyCount: replyMatch ? Number(replyMatch[1]) : 0,
        edited: node.querySelector(selectors.edited) != null,
      },
      paneId: pane ? `thread:${threadTs ?? "unknown"}` : "channel",
    });
  }
  return messages;
}

function messageTimestamp(node: QueryEl): string | null {
  const ts = node.getAttribute(selectors.timestampAttr) ?? node.querySelector(selectors.timestamp)?.getAttribute(selectors.timestampAttr);
  return ts && /^\d+\.\d+$/.test(ts) ? ts : null;
}

function sliceNodes(list: ArrayLike<QueryEl>): QueryEl[] {
  return Array.prototype.slice.call(list) as QueryEl[];
}
