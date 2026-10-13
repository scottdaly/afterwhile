import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { APP_NAME, UNPACKED_EXTENSION_ID, type CaptureRecord } from "../shared/src/index.ts";
import { RecordDatabase } from "../helper/src/database.ts";
import { encodeNative, NativeDecoder } from "../helper/src/native-frame.ts";
import { envName } from "../helper/src/paths.ts";

const buildDirs: string[] = [];
afterEach(() => { for (const dir of buildDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("compiled helper accepts Chrome's native-host launch arguments and ingests a framed batch", async () => {
  const root = path.resolve(import.meta.dir, "..");
  const temp = mkdtempSync(path.join(tmpdir(), `${APP_NAME}-chrome-launch-`));
  buildDirs.push(temp);
  const executable = path.join(temp, `${APP_NAME}${process.platform === "win32" ? ".exe" : ""}`);
  const build = Bun.spawn([process.execPath, "build", path.join(root, "helper/src/index.ts"), "--compile", "--outfile", executable], {
    cwd: temp, stdout: "pipe", stderr: "pipe",
  });
  const [buildOutput, buildErrors, buildCode] = await Promise.all([
    new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited,
  ]);
  expect({ code: buildCode, diagnostics: buildCode ? buildOutput + buildErrors : "" }).toEqual({ code: 0, diagnostics: "" });
  const record: CaptureRecord = {
    id: "slack:TTEST:CTEST:1791822000.000100", connection: "slack", connectionVersion: "0.1.0",
    kind: "message", source: { id: "slack:TTEST:CTEST", title: "#synthetic", url: "https://app.slack.com/client/TTEST/CTEST" },
    position: null, occurredAt: "2026-10-12T16:20:00.100Z", capturedAt: "2026-10-12T16:31:12Z",
    author: null, text: "Synthetic Chrome launch", fields: {}, revision: 1, deleted: false,
  };
  const proc = Bun.spawn([
    executable, `chrome-extension://${UNPACKED_EXTENSION_ID}/`,
    ...(process.platform === "win32" ? ["--parent-window=0"] : []),
  ], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, [envName("DATA_DIR")]: path.join(temp, "data"), [envName("FILES_DIR")]: path.join(temp, "files") },
  });
  try {
    proc.stdin.write(encodeNative({ type: "records", batchId: "launch-test", records: [record] }));
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect({ code, diagnostics: code ? stderr : "" }).toEqual({ code: 0, diagnostics: "" });
    expect(stdout.byteLength).toBeLessThan(1024 * 1024);
    expect(new NativeDecoder().push(Buffer.from(stdout))[0]).toMatchObject({ type: "ack", batchId: "launch-test", inserted: 1 });
    const db = new RecordDatabase(path.join(temp, "data", "records.db"));
    try { expect(db.getSource(record.source.id)[0]?.text).toBe(record.text); }
    finally { db.close(); }
  } finally {
    proc.kill();
    await proc.exited;
  }
}, 30_000);
