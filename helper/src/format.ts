import type { StoredRecord } from "./database.ts";

export function snippet(text: string, query: string): string {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    index = lower.indexOf(term.toLowerCase());
    if (index >= 0) break;
  }
  if (index < 0) return text.length > 180 ? `${text.slice(0, 180)}…` : text;
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + 110);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export function formatRecord(record: StoredRecord, query?: string): string {
  const who = record.author?.name ?? "unknown";
  const body = query ? snippet(record.text, query) : record.text;
  return [
    record.source.title,
    record.source.url,
    record.connection === "teams" ? `${record.fields.offset} into part · ${record.kind === "transcript-event" ? "Event" : who} · position ${record.position} · meeting date unknown (captured ${record.occurredAt})` : `${record.occurredAt} · ${who}`,
    body,
    `id ${record.id}`,
  ].join("\n");
}

export function formatRecords(records: StoredRecord[], query?: string): string {
  if (records.length === 0) return "No matching records.";
  return records.map((record) => formatRecord(record, query)).join("\n\n");
}
