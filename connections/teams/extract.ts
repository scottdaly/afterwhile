export { exactCoverage } from "../../shared/src/coverage.ts";
import type { CaptureRecord } from "../../shared/src/index.ts";
import manifest from "./connection.json";
import selectors from "./selectors.json";

export interface TeamsPart {
  source: CaptureRecord["source"];
  part: string;
  expected: number;
  records: CaptureRecord[];
}
export interface TeamsExtract {
  status: "ok" | "waiting" | "stopped" | "blocked";
  reason: string | null;
  parts: TeamsPart[];
}
const empty = (status: TeamsExtract["status"], reason: string | null = null): TeamsExtract => ({ status, reason, parts: [] });

export function transcriptPage(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "teams.cloud.microsoft" ||
      (u.hostname.endsWith(".sharepoint.com") && /\/(stream|xplatplugins)\.aspx$/i.test(u.pathname)));
  } catch { return false; }
}

/** Only the displayed page address or rendered links/selected controls. No hidden app state. */
export function documentIdentity(url: string): { key: string; url: string } | null {
  try {
    const u = new URL(url);
    if (!transcriptPage(url) || !u.hostname.endsWith(".sharepoint.com")) return null;
    const params = new Map<string, string>();
    u.searchParams.forEach((v, k) => params.set(k.toLowerCase(), v));
    const fileParam = ["sourcedoc", "docid", "id"].find((name) => params.has(name));
    const file = fileParam ? params.get(fileParam) : undefined;
    const item = params.get("itemid");
    const drive = params.get("driveid");
    if (!file && !(item && drive)) return null;
    const key = file ? `${u.hostname}:${file.replace(/[{}]/g, "").toLowerCase()}` : `${u.hostname}:${drive}:${item}`;
    // Keep a small allowlist; remove auth/session parameters from provenance.
    u.search = ""; u.hash = "";
    if (file) u.searchParams.set(fileParam!, file);
    else { u.searchParams.set("driveId", drive!); u.searchParams.set("itemId", item!); }
    return { key, url: u.toString() };
  } catch { return null; }
}

// Opaque ids keep organizer/file locators out of routine id-only diagnostics.
export async function sourceId(key: string, part: string): Promise<string> {
  const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `teams:${(await hash(key)).slice(0, 32)}:part:${(await hash(part)).slice(0, 32)}`;
}

export function parseSpeakerTime(label: string): { name: string; offset: string; seconds: number } | null {
  const match = label.match(/(?:^|[\s,])((?:\d{1,3}:)?\d{1,2}:\d{2})(?=$|[\s,.])/);
  if (!match || match.index == null) return null;
  const offset = match[1]!;
  const chunks = offset.split(":").map(Number);
  if (chunks.at(-1)! > 59 || (chunks.length === 3 && chunks[1]! > 59)) return null;
  const seconds = chunks.reduce((total, value) => total * 60 + value, 0);
  const name = `${label.slice(0, match.index)} ${label.slice(match.index + match[0].length)}`
    .replace(/^[\s,.:–-]+|[\s,.:–-]+$/g, "").trim();
  return { name, offset, seconds };
}

/** Rendered DOM only. Offscreen drawn rows are allowed; hidden retained DOM is not. */
export function isRendered(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return false;
    const view = node.ownerDocument.defaultView;
    const style = view?.getComputedStyle ? view.getComputedStyle(node) : (node as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0" || style.contentVisibility === "hidden")) return false;
  }
  // Real browser DOM exposes geometry. Synthetic DOM tests have no layout engine.
  const rects = (el as HTMLElement).getClientRects;
  return typeof rects !== "function" || rects.call(el).length > 0;
}
export function renderedText(el: Element): string {
  if (!isRendered(el)) return "";
  return Array.from(el.childNodes).map((node) => node.nodeType === 3 ? node.textContent ?? ""
    : node.nodeType === 1 ? renderedText(node as Element) : "").join("");
}
function displayed(document: Document, selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector)).filter(isRendered);
}
export function protectionReason(document: Document): string | null {
  if (displayed(document, selectors.protection).length) return "copy restriction or sensitivity label";
  if (displayed(document, selectors.login).length) return "sign-in prompt";
  if (displayed(document, selectors.captcha).length) return "CAPTCHA";
  // Any unrecognized visible page notice is a stop. Do not guess that a new
  // warning (including localized restrictions) is harmless. Never scan speech.
  for (const el of displayed(document, selectors.alert)) {
    if (!el.closest(`${selectors.text}, ${selectors.event}`) && renderedText(el).trim()) return "unrecognized page notice";
  }
  for (const el of displayed(document, "p, [role='note']")) {
    if (el.closest(`${selectors.text}, ${selectors.event}`)) continue;
    if (/copy|copi|sensitivity|confidential|restricted|\bDLP\b/i.test(renderedText(el))) return "copy restriction or sensitivity notice";
  }
  return null;
}

export async function extractTeams(document: Document, options: { url: string; now?: Date }): Promise<TeamsExtract> {
  if (!transcriptPage(options.url)) return empty("waiting");
  const blocked = protectionReason(document);
  if (blocked) return empty("blocked", blocked);
  const roots = displayed(document, selectors.root);
  if (roots.length === 0) return empty("waiting"); // Teams shell / Recap parent: frame captures itself.
  const fail = () => empty("stopped", "capture stopped working");
  // There is no verified multi-root contract; avoid silently mixing two components.
  if (roots.length !== 1) return fail();
  const root = roots[0]!;
  const container = root.querySelector(selectors.container) ?? (root.matches(selectors.container) ? root : null);
  if (!container || !isRendered(container)) return fail();
  const selected = Array.from(document.querySelectorAll(selectors.selectedPart)).filter((el) =>
    el.tagName === "OPTION" ? el.parentElement && isRendered(el.parentElement) : isRendered(el));
  if (selected.length > 1) return fail();
  const control = selected[0];
  const selectedKey = control?.getAttribute("data-transcript-id") ?? control?.getAttribute("value");
  // A selected part with no stable key is unsafe, as numbering restarts.
  if (control && !selectedKey?.trim()) return fail();
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(selectors.documentLink))
    .filter(isRendered).map((link) => {
      try { return documentIdentity(new URL(link.getAttribute("href") ?? "", options.url).href); } catch { return null; }
    }).filter((x) => x != null);
  const direct = documentIdentity(options.url);
  const locators = new Map(links.map((x) => [x.key, x]));
  const identity = direct ?? (locators.size === 1 ? [...locators.values()][0] : null);
  if (!identity) return fail();
  const u = new URL(options.url);
  const explicitPart = u.searchParams.get("transcriptId") ?? u.searchParams.get("transcriptid");
  const part = selectedKey?.trim() ?? explicitPart;
  // No implicit single-part fallback: Recap/Stream equivalence must be exposed.
  if (!part) return fail();
  const id = "pending"; // Hash only after the DOM snapshot is fully copied.
  const sourceUrl = new URL(identity.url); sourceUrl.searchParams.set("transcriptId", part);
  const source = { id, title: `Meeting transcript · ${control?.textContent?.trim() || (part === "document" ? "document part" : "selected part")}`, url: sourceUrl.toString() };
  const rows = Array.from(container.querySelectorAll(selectors.line)).filter(isRendered);
  if (!rows.length) return renderedText(container).trim() ? fail() : empty("waiting");
  const now = (options.now ?? new Date()).toISOString();
  const seen = new Set<number>();
  let expected = 0;
  const records: CaptureRecord[] = [];
  for (const row of rows) {
    const pos = row.getAttribute("aria-posinset") ?? "";
    const size = row.getAttribute("aria-setsize") ?? "";
    if (!/^[1-9]\d*$/.test(pos) || !/^[1-9]\d*$/.test(size)) return fail();
    const position = Number(pos), total = Number(size);
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(total) || total > 1_000_000 || position > total || seen.has(position) || (expected && expected !== total)) return fail();
    expected = total; seen.add(position);
    const speech = row.querySelector(selectors.text), event = row.querySelector(selectors.event);
    if (Boolean(speech) === Boolean(event)) return fail();
    const text = (speech ?? event) ? renderedText((speech ?? event)!).trim() : "";
    const group = row.closest(selectors.group);
    const stamp = parseSpeakerTime(group?.getAttribute("aria-label") ?? "");
    if (!text || !stamp || (speech && !stamp.name)) return fail();
    records.push({ id: `${id}:line:${position}`, connection: manifest.id, connectionVersion: manifest.version,
      kind: speech ? "transcript-line" : "transcript-event", source, position,
      // No meeting date is established by this DOM. Offset is authoritative;
      // occurredAt is first-capture time, explicitly identified in fields.
      occurredAt: now, capturedAt: now, author: speech ? { name: stamp.name, id: "" } : null,
      text, fields: { offsetSeconds: stamp.seconds, offset: stamp.offset, part, expected: total, timeBasis: "capture (meeting date unknown)" }, revision: 1, deleted: false });
  }
  // All labels, text and identities above were copied before this first await.
  const stableId = await sourceId(identity.key, part);
  const stableSource = { ...source, id: stableId };
  return { status: "ok", reason: null, parts: [{ source: stableSource, part, expected,
    records: records.map((record) => ({ ...record, id: `${stableId}:line:${record.position}`, source: stableSource })) }] };
}
