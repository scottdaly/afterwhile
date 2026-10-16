import { readFileSync } from "fs";
export const STREAM = "https://synthetic-my.sharepoint.com/personal/fictional/_layouts/15/stream.aspx?docId=fixture-recording&transcriptId=part-one";
export const FRAME = STREAM.replace("stream.aspx", "xplatplugins.aspx");
export function fixture(name = "complete") { return readFileSync(new URL(`./${name}.html`, import.meta.url), "utf8"); }
export function row(n: number, total = 12) {
  return `<div id="entry-${n}" role="group" aria-label="Avery Finch, 00:${String(n).padStart(2, "0")}"><div id="sub-entry-${n}" role="listitem" aria-posinset="${n}" aria-setsize="${total}"><span class="entryText-test">Invented ribbon line ${n}.</span></div></div>`;
}
export function page(rows: string, part = "") {
  return `<html><body>${part ? `<select aria-label="Transcript parts"><option value="${part}" selected>Part ${part}</option></select>` : ""}<div id="OneTranscript"><div id="scrollToTargetTargetedFocusZone">${rows}</div></div></body></html>`;
}

