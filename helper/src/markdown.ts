import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { localTime, sourceSlug, type CaptureRecord } from "../../shared/src/index.ts";

export function markdownFile(
  filesRoot: string,
  connection: string,
  sourceId: string,
  day: string,
): string {
  return path.join(filesRoot, connection, sourceSlug(sourceId), `${day}.md`);
}

export function renderDay(options: {
  title: string;
  url: string;
  day: string;
  records: CaptureRecord[];
}): string {
  const lines: string[] = [`# ${options.title}`, "", options.url, "", options.day, ""];
  if (options.records.some((r) => r.connection === "teams")) lines.push("Offsets are relative to this transcript part. Meeting date unknown; file date is the first capture date.", "");
  const visible = options.records
    .filter((record) => !record.deleted)
    .sort((a, b) => a.connection === "teams" && b.connection === "teams" ? (a.position ?? 0) - (b.position ?? 0) : (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  for (const record of visible) {
    const who = record.author?.name ?? "Unknown";
    const edited = record.revision > 1 || record.fields.edited === true ? " (edited)" : "";
    if (record.connection === "teams") {
      lines.push(`## ${record.fields.offset} · ${record.kind === "transcript-event" ? "Event" : who}${edited}`, "");
    } else lines.push(`## ${localTime(record.occurredAt)} ${who}${edited}`, "");
    lines.push(record.text, "");
    if (record.fields.replyCount) lines.push(`Replies: ${record.fields.replyCount}`, "");
    if (typeof record.fields.threadTs === "string" && record.fields.threadTs) {
      lines.push(`Thread: ${record.fields.threadTs}`, "");
    }
    lines.push(`id: ${record.id}`, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

export function writeDayFile(file: string, body: string | null): void {
  if (body == null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
