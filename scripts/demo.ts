import { mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { parseHTML } from "linkedom";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractSlack } from "../connections/slack/extract.ts";
import manifest from "../connections/slack/connection.json";
import { APP_NAME, type CaptureRecord } from "../shared/src/index.ts";
import { RecordDatabase } from "../helper/src/database.ts";
import { acceptCoverage, acceptRecords } from "../helper/src/ingest.ts";
import { envName } from "../helper/src/paths.ts";

const root = path.resolve(import.meta.dir, "..");
const channelUrl = "https://app.slack.com/client/T024BE7LD/C01ABCD2EFG";
const sourceId = "slack:T024BE7LD:C01ABCD2EFG";

function load(name: string) {
  const html = readFileSync(path.join(root, "connections/slack/fixtures", name), "utf8");
  return parseHTML(html).document;
}

function toRecord(draft: ReturnType<typeof extractSlack>["messages"][number], capturedAt: string): CaptureRecord {
  return {
    id: draft.id,
    connection: manifest.id,
    connectionVersion: manifest.version,
    kind: draft.kind,
    source: draft.source,
    position: null,
    occurredAt: draft.occurredAt,
    capturedAt,
    author: draft.author,
    text: draft.text,
    fields: draft.fields,
    revision: 1,
    deleted: false,
  };
}

const home = path.join(root, ".demo");
const data = path.join(home, "data");
const files = path.join(home, "files");
mkdirSync(data, { recursive: true });

const db = new RecordDatabase(path.join(data, "records.db"));
const visible = extractSlack(load("channel.html"), { url: channelUrl, now: new Date("2026-10-12T17:00:00Z") });
const older = extractSlack(load("channel-older.html"), { url: channelUrl, now: new Date("2026-10-12T17:00:00Z") });
const edited = extractSlack(load("channel-edited.html"), { url: channelUrl, now: new Date("2026-10-12T18:00:00Z") });
if (visible.status !== "ok" || !visible.messages.length) throw new Error("fixture extract failed");

acceptRecords(db, files, [
  ...older.messages.map((message) => toRecord(message, "2026-10-12T16:31:12.000Z")),
  ...visible.messages.map((message) => toRecord(message, "2026-10-12T16:31:12.000Z")),
]);
const changed = edited.messages.find((message) => message.fields.edited);
if (!changed) throw new Error("edited fixture did not mark the message");
acceptRecords(db, files, [toRecord(changed, "2026-10-12T18:04:00.000Z")]);
acceptCoverage(db, {
  sourceId,
  expected: null,
  have: 3,
  gaps: [],
  complete: false,
  reason: "load budget reached",
  updatedAt: "2026-10-12T18:05:00.000Z",
});
db.close();

const dayFile = path.join(files, "slack", "slack-T024BE7LD-C01ABCD2EFG", "2026-10-12.md");
const sampleDir = path.join(root, "docs", "samples");
mkdirSync(sampleDir, { recursive: true });
const sample = readFileSync(dayFile, "utf8");
writeFileSync(path.join(sampleDir, "2026-10-12.md"), sample);

const lines: string[] = [];
function log(line: string) {
  lines.push(line);
  console.log(line);
}

log(`MCP transcript`);
log(`client: transcript-client via @modelcontextprotocol/sdk StdioClientTransport`);
log(`server: ${APP_NAME} mcp`);
log(`database: synthetic Slack fixtures (channel, older history, one edit)`);
log("");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["helper/src/index.ts", "mcp"],
  cwd: root,
  stderr: "pipe",
  env: {
    ...getDefaultEnvironment(),
    PATH: process.env.PATH ?? "",
    TZ: "UTC",
    [envName("DATA_DIR")]: data,
    [envName("FILES_DIR")]: files,
    [envName("HOME")]: home,
  },
});
const client = new Client({ name: "transcript-client", version: "0.0.0" });
await client.connect(transport);

async function call(name: string, args: Record<string, unknown>) {
  log(`-> tools/call ${name} ${JSON.stringify(args)}`);
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => ("text" in item ? String(item.text) : ""))
    .join("\n");
  log("<-");
  log(text);
  log("");
  return text;
}

const search = await call("search", {
  query: "focus states",
  connection: "slack",
  sourceId,
  since: "2026-10-12T00:00:00.000Z",
  until: "2026-10-12T23:59:59.000Z",
  limit: 20,
});
if (!search.includes("https://app.slack.com/client/T024BE7LD/C01ABCD2EFG")) {
  throw new Error("search did not cite the channel URL");
}
if (!search.includes("Thursday")) throw new Error("search did not return the edited text");

await call("search", {
  query: "focus ring",
  connection: "slack",
  since: "2026-10-11T00:00:00.000Z",
  until: "2026-10-11T23:59:59.000Z",
});
const recent = await call("recent", { connection: "slack", checkpoint: true });
const recentAgain = await call("recent", { connection: "slack", checkpoint: true });
if (recentAgain !== "No matching records.") throw new Error("checkpoint did not advance");
if (!recent.includes("app.slack.com")) throw new Error("recent omitted the source URL");
await call("get", { sourceId });
await call("sources", { connection: "slack" });
const coverage = await call("coverage", { sourceId });
if (!coverage.includes("load budget reached")) throw new Error("coverage missing the reason");

await client.close();
const transcript = `${lines.join("\n")}\n`;
writeFileSync(path.join(sampleDir, "mcp-transcript.txt"), transcript);
console.log(`sample ${path.join(sampleDir, "2026-10-12.md")}`);
