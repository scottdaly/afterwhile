import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  APP_NAME,
  coverageHint,
  localDay,
  NATIVE_HOST_ID,
  sourceSlug,
  UNPACKED_EXTENSION_ID,
  type CaptureRecord,
  type Coverage,
} from "../../shared/src/index.ts";
import { RecordDatabase } from "./database.ts";
import { formatRecords } from "./format.ts";
import { acceptCoverage, acceptRecords, forgetSaved } from "./ingest.ts";
import { handleHostMessage } from "./host.ts";
import { encodeNative, NativeDecoder } from "./native-frame.ts";
import { envName } from "./paths.ts";
import { dataDir, filesDir } from "./paths.ts";
import {
  applyInstall,
  applyUninstall,
  hostManifest,
  mcpSnippets,
  planInstall,
  prepareInvocation,
  windowsRegistryKeys,
} from "./install.ts";

function tempDirs(): { root: string; data: string; files: string } {
  const root = mkdtempSync(path.join(tmpdir(), `${APP_NAME}-`));
  return { root, data: path.join(root, "data"), files: path.join(root, "files") };
}

function record(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  return {
    id: "slack:T024BE7LD:C01ABCD2EFG:1791822000.000100",
    connection: "slack",
    connectionVersion: "0.1.0",
    kind: "message",
    position: null,
    occurredAt: "2026-10-12T16:20:00.100Z",
    capturedAt: "2026-10-12T16:31:12.000Z",
    author: { name: "Alex Kim", id: "U02XYZ" },
    text: "We should revisit the Input focus states before Friday.",
    fields: { threadTs: null, replyCount: 3, edited: false },
    revision: 1,
    deleted: false,
    ...overrides,
    source: { ...{
      id: "slack:T024BE7LD:C01ABCD2EFG",
      title: "#design-foundations",
      url: "https://app.slack.com/client/T024BE7LD/C01ABCD2EFG",
    }, ...overrides.source },
  };
}

describe("storage", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("paths follow the platform and slug source ids", () => {
    expect(dataDir({ platform: "darwin", home: "/Users/ada", env: {} })).toBe(
      `/Users/ada/Library/Application Support/${APP_NAME}`,
    );
    expect(filesDir({ platform: "darwin", home: "/Users/ada", env: {} })).toBe(`/Users/ada/${APP_NAME}`);
    expect(
      dataDir({ platform: "win32", home: "C:\\Users\\Ada", env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" } }),
    ).toBe(`C:\\Users\\Ada\\AppData\\Local\\${APP_NAME}`);
    expect(filesDir({ platform: "win32", home: "C:\\Users\\Ada", env: {} })).toBe(`C:\\Users\\Ada\\${APP_NAME}`);
    expect(dataDir({ platform: "linux", home: "/home/ada", env: {} })).toBe(`/home/ada/.local/share/${APP_NAME}`);
    const slug = sourceSlug("slack:T024BE7LD:C01ABCD2EFG");
    expect(slug).not.toContain(":");
    expect(slug).toBe("slack-T024BE7LD-C01ABCD2EFG");
  });

  test("dedupes, keeps revisions, and writes the day file", () => {
    const dirsForTest = tempDirs();
    dirs.push(dirsForTest.root);
    const db = new RecordDatabase(path.join(dirsForTest.data, "records.db"));
    expect(db.busyTimeoutMs()).toBeGreaterThanOrEqual(5000);
    const mode = db.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode.toLowerCase()).toBe("wal");

    const first = acceptRecords(db, dirsForTest.files, [record(), record()]);
    expect(first.inserted).toBe(1);
    expect(first.unchanged).toBe(1);
    const edited = acceptRecords(db, dirsForTest.files, [
      record({
        text: "We should revisit the Input focus states before Thursday.",
        capturedAt: "2026-10-12T18:00:00.000Z",
        fields: { threadTs: null, replyCount: 3, edited: true },
      }),
    ]);
    expect(edited.revisions).toBe(1);
    const revisions = db.revisions(record().id);
    expect(revisions.map((item) => item.revision)).toEqual([1, 2]);
    expect(revisions[0]?.text).toContain("Friday");
    expect(revisions[1]?.text).toContain("Thursday");

    const day = localDay("2026-10-12T16:20:00.100Z");
    const file = path.join(dirsForTest.files, "slack", sourceSlug(record().source.id), `${day}.md`);
    const markdown = readFileSync(file, "utf8");
    expect(markdown).toContain("# #design-foundations");
    expect(markdown).toContain("https://app.slack.com/client/T024BE7LD/C01ABCD2EFG");
    expect(markdown).toContain("Thursday");
    expect(markdown).toContain("(edited)");
    expect(markdown).not.toContain("Friday");

    const found = db.search("focus states", { connection: "slack" });
    expect(found[0]?.source.url).toContain("app.slack.com");
    expect(formatRecords(found, "focus")).toContain("app.slack.com");
    db.close();
  });

  test("deletion keeps the old row and drops it from search", () => {
    const dirsForTest = tempDirs();
    dirs.push(dirsForTest.root);
    const db = new RecordDatabase(path.join(dirsForTest.data, "records.db"));
    acceptRecords(db, dirsForTest.files, [record()]);
    acceptRecords(db, dirsForTest.files, [record({ deleted: true, text: "", capturedAt: "2026-10-12T19:00:00.000Z" })]);
    expect(db.revisions(record().id)).toHaveLength(2);
    expect(db.search("focus")).toHaveLength(0);
    expect(db.getSource(record().source.id)).toHaveLength(0);
    db.close();
  });

  test("checkpoints return only records saved since the last ask", async () => {
    const dirsForTest = tempDirs();
    dirs.push(dirsForTest.root);
    const db = new RecordDatabase(path.join(dirsForTest.data, "records.db"));
    acceptRecords(db, dirsForTest.files, [record()]);
    const first = db.recent({ connection: "slack", checkpoint: true, client: "codex" });
    expect(first).toHaveLength(1);
    const second = db.recent({ connection: "slack", checkpoint: true, client: "codex" });
    expect(second).toHaveLength(0);
    await Bun.sleep(20);
    acceptRecords(db, dirsForTest.files, [
      record({
        id: "slack:T024BE7LD:C01ABCD2EFG:1791822300.000200",
        occurredAt: "2026-10-12T16:25:00.200Z",
        capturedAt: new Date().toISOString(),
        text: "The ring is too faint on the secondary button.",
        author: { name: "Jordan Lee", id: "U03ABC" },
      }),
    ]);
    const third = db.recent({ connection: "slack", checkpoint: true, client: "codex" });
    expect(third.map((item) => item.author?.name)).toEqual(["Jordan Lee"]);
    db.close();
  });

  test("coverage hint names the gap", () => {
    const dirsForTest = tempDirs();
    dirs.push(dirsForTest.root);
    const db = new RecordDatabase(path.join(dirsForTest.data, "records.db"));
    acceptRecords(db, dirsForTest.files, [record()]);
    const coverage: Coverage = {
      sourceId: record().source.id,
      expected: 252,
      have: 240,
      gaps: [[118, 129]],
      complete: false,
      reason: "load budget reached",
      updatedAt: "2026-10-12T16:40:00.000Z",
    };
    acceptCoverage(db, coverage);
    const text = db.coverageText(record().source.id);
    expect(text).toContain(coverageHint(coverage, "#design-foundations"));
    expect(text).toContain("118–129");
    expect(text).toContain(record().source.url);
    expect(db.sources("slack")[0]?.recordCount).toBe(1);
    db.close();
  });

  test("a second connection can read what the host wrote", () => {
    const dirsForTest = tempDirs();
    dirs.push(dirsForTest.root);
    const file = path.join(dirsForTest.data, "records.db");
    const writer = new RecordDatabase(file);
    handleHostMessage(writer, dirsForTest.files, { type: "records", records: [record()] });
    const reader = new RecordDatabase(file);
    expect(reader.search("Friday")).toHaveLength(1);
    writer.close();
    reader.close();
  });

  test("forget removes the source and its markdown", () => {
    const dirsForTest = tempDirs();
    dirs.push(dirsForTest.root);
    const db = new RecordDatabase(path.join(dirsForTest.data, "records.db"));
    acceptRecords(db, dirsForTest.files, [record()]);
    const result = forgetSaved(db, dirsForTest.files, "source", record().source.id);
    expect(result.removed).toBeGreaterThan(0);
    expect(db.getSource(record().source.id)).toHaveLength(0);
    db.close();
  });
});

describe("native host", () => {
  test("stdio host writes a record and answers under 1MB", async () => {
    const dirsForTest = tempDirs();
    const env = {
      ...process.env,
      [envName("DATA_DIR")]: dirsForTest.data,
      [envName("FILES_DIR")]: dirsForTest.files,
      [envName("HOME")]: dirsForTest.root,
    };
    const proc = Bun.spawn([process.execPath, "helper/src/index.ts", "host"], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(encodeNative({ type: "records", records: [record()] }));
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    const messages = new NativeDecoder().push(Buffer.from(stdout));
    expect(messages[0]).toMatchObject({ type: "ack", inserted: 1 });
    expect(stderr).not.toContain("Input focus states");
    const day = localDay(record().occurredAt);
    const markdown = readFileSync(
      path.join(dirsForTest.files, "slack", sourceSlug(record().source.id), `${day}.md`),
      "utf8",
    );
    expect(markdown).toContain("Input focus states");
    rmSync(dirsForTest.root, { recursive: true, force: true });
  }, 20_000);

  test("oversized frames are rejected", () => {
    const decoder = new NativeDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(2 * 1024 * 1024, 0);
    expect(() => decoder.push(header)).toThrow("1MB");
  });
});

describe("install", () => {
  test("macOS and Windows plans register Chrome and Edge", () => {
    const hostPath = `/usr/local/bin/${APP_NAME}-host`;
    const darwin = planInstall({
      platform: "darwin",
      home: "/Users/ada",
      hostPath,
      extensionIds: [UNPACKED_EXTENSION_ID, "storeextensionidabcdefghijklmnop"],
    });
    const paths = darwin.files.map((file) => file.path);
    expect(paths.some((file) => file.includes("Google/Chrome/NativeMessagingHosts"))).toBe(true);
    expect(paths.some((file) => file.includes("Microsoft Edge/NativeMessagingHosts"))).toBe(true);
    const manifest = JSON.parse(darwin.files[0]?.contents ?? "{}") as { allowed_origins: string[]; path: string; name: string };
    expect(manifest.name).toBe(NATIVE_HOST_ID);
    expect(manifest.path).toBe(hostPath);
    expect(manifest.allowed_origins).toContain(`chrome-extension://${UNPACKED_EXTENSION_ID}/`);
    expect(manifest.allowed_origins).toHaveLength(2);

    const windows = planInstall({
      platform: "win32",
      home: "C:\\Users\\Ada",
      localAppData: "C:\\Users\\Ada\\AppData\\Local",
      hostPath: `C:\\Users\\Ada\\AppData\\Local\\${APP_NAME}\\${APP_NAME}.exe`,
      extensionIds: [UNPACKED_EXTENSION_ID],
    });
    expect(windows.registry.map((entry) => entry.key)).toEqual(windowsRegistryKeys());
    expect(windows.registry[0]?.data.endsWith(`${NATIVE_HOST_ID}.json`)).toBe(true);
    expect(windows.registry[1]?.key).toContain("Microsoft\\Edge");
    expect(hostManifest(hostPath, [UNPACKED_EXTENSION_ID])).toContain(NATIVE_HOST_ID);
  });

  test("linux install writes a host the browser can exec", () => {
    const root = mkdtempSync(path.join(tmpdir(), `${APP_NAME}-install-`));
    const previous = process.env[envName("DATA_DIR")];
    process.env[envName("DATA_DIR")] = path.join(root, "data");
    try {
      expect(() => prepareInvocation("win32", process.env)).toThrow(/exe/);
      const invocation = prepareInvocation("linux", process.env);
      expect(readFileSync(invocation.hostPath, "utf8")).toContain(" host");
      expect(readFileSync(invocation.cliPath, "utf8")).toContain('"$@"');
      const plan = planInstall({
        platform: "linux",
        home: root,
        hostPath: invocation.hostPath,
        extensionIds: [UNPACKED_EXTENSION_ID],
      });
      applyInstall(plan);
      expect(JSON.parse(readFileSync(plan.files[0]!.path, "utf8")).path).toBe(invocation.hostPath);
      applyUninstall(plan);
      expect(() => readFileSync(plan.files[0]!.path, "utf8")).toThrow();
      const snippets = mcpSnippets(invocation.mcpCommand, invocation.mcpArgs);
      expect(snippets).toContain("mcpServers");
      expect(snippets).toContain("mcp_servers");
      expect(snippets).toContain(APP_NAME);
    } finally {
      if (previous == null) delete process.env[envName("DATA_DIR")];
      else process.env[envName("DATA_DIR")] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mcp client", () => {
  test("official SDK search, recent, and coverage", async () => {
    const dirsForTest = tempDirs();
    const db = new RecordDatabase(path.join(dirsForTest.data, "records.db"));
    acceptRecords(db, dirsForTest.files, [
      record(),
      record({
        id: "slack:T024BE7LD:C01ABCD2EFG:1791741900.000300",
        occurredAt: "2026-10-11T18:05:00.300Z",
        capturedAt: "2026-10-11T18:06:00.000Z",
        text: "Yesterday we left the focus ring on the secondary button unresolved.",
        author: { name: "Sam Patel", id: "U04QWE" },
      }),
    ]);
    acceptCoverage(db, {
      sourceId: record().source.id,
      expected: null,
      have: 2,
      gaps: [],
      complete: false,
      reason: "load budget reached",
      updatedAt: "2026-10-12T17:00:00.000Z",
    });
    db.close();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["helper/src/index.ts", "mcp"],
      cwd: path.resolve(import.meta.dir, "../.."),
      stderr: "pipe",
      env: {
        ...getDefaultEnvironment(),
        PATH: process.env.PATH ?? "",
        [envName("DATA_DIR")]: dirsForTest.data,
        [envName("FILES_DIR")]: dirsForTest.files,
        [envName("HOME")]: dirsForTest.root,
      },
    });
    const client = new Client({ name: "transcript-client", version: "0.0.0" });
    await client.connect(transport);
    const search = await client.callTool({
      name: "search",
      arguments: {
        query: "focus states",
        connection: "slack",
        sourceId: record().source.id,
        since: "2026-10-12T00:00:00.000Z",
        until: "2026-10-12T23:59:59.000Z",
      },
    });
    const searchText = textOf(search);
    expect(searchText).toContain("Input focus states");
    expect(searchText).toContain("https://app.slack.com/client/T024BE7LD/C01ABCD2EFG");

    const yesterday = await client.callTool({
      name: "search",
      arguments: {
        query: "focus ring",
        since: "2026-10-11T00:00:00.000Z",
        until: "2026-10-11T23:59:59.000Z",
      },
    });
    expect(textOf(yesterday)).toContain("Yesterday");
    expect(textOf(yesterday)).toContain("https://app.slack.com/client/T024BE7LD/C01ABCD2EFG");

    const recent = await client.callTool({ name: "recent", arguments: { connection: "slack", checkpoint: true } });
    expect(textOf(recent)).toContain("Alex Kim");
    const recentAgain = await client.callTool({
      name: "recent",
      arguments: { connection: "slack", checkpoint: true },
    });
    expect(textOf(recentAgain)).toBe("No matching records.");

    const coverage = await client.callTool({
      name: "coverage",
      arguments: { sourceId: record().source.id },
    });
    expect(textOf(coverage)).toContain("load budget reached");
    expect(textOf(coverage)).toContain("https://app.slack.com/client/T024BE7LD/C01ABCD2EFG");

    const sources = await client.callTool({ name: "sources", arguments: { connection: "slack" } });
    expect(textOf(sources)).toContain("#design-foundations");
    const got = await client.callTool({ name: "get", arguments: { sourceId: record().source.id } });
    expect(textOf(got)).toContain("Sam Patel");
    await client.close();
    rmSync(dirsForTest.root, { recursive: true, force: true });
  }, 20_000);
});

function textOf(result: { [key: string]: unknown }): string {
  return (Array.isArray(result.content) ? result.content : [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}
