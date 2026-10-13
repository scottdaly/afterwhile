import type { Coverage } from "../../shared/src/index.ts";
import { RecordDatabase } from "./database.ts";
import { acceptCoverage, acceptRecords, forgetSaved } from "./ingest.ts";
import { log } from "./log.ts";
import { encodeNative, NativeDecoder } from "./native-frame.ts";
import { filesDir } from "./paths.ts";

export function handleHostMessage(db: RecordDatabase, filesRoot: string, message: unknown): unknown {
  if (!message || typeof message !== "object") return { type: "error", message: "empty message" };
  const body = message as { type?: string; batchId?: string; records?: unknown; coverage?: Coverage; scope?: string; id?: string };
  if (body.type === "records" && Array.isArray(body.records)) {
    const result = acceptRecords(db, filesRoot, body.records);
    return { type: "ack", batchId: body.batchId, ...result, ids: result.ids };
  }
  if (body.type === "coverage" && body.coverage && typeof body.coverage.sourceId === "string") {
    acceptCoverage(db, body.coverage);
    return { type: "ack", todayCount: db.todayCount() };
  }
  if (body.type === "forget" && (body.scope === "source" || body.scope === "connection") && typeof body.id === "string") {
    const result = forgetSaved(db, filesRoot, body.scope, body.id);
    return { type: "forgotten", ...result, todayCount: db.todayCount() };
  }
  if (body.type === "stats" || body.type === "hello") {
    return { type: "stats", todayCount: db.todayCount() };
  }
  return { type: "error", message: "unknown message" };
}

export function runHost(): void {
  const db = RecordDatabase.openDefault();
  const root = filesDir();
  const decoder = new NativeDecoder();
  log("host listening");
  process.stdin.on("data", (chunk: Buffer) => {
    let messages: unknown[] = [];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      log("rejected message", error instanceof Error ? error.message : "bad message");
      process.exit(1);
    }
    for (const message of messages) {
      try {
        const response = handleHostMessage(db, root, message);
        process.stdout.write(encodeNative(response));
      } catch (error) {
        log("host error", error instanceof Error ? error.message : "failed");
        process.stdout.write(encodeNative({ type: "error", message: "failed to write records" }));
      }
    }
  });
  process.stdin.on("end", () => {
    db.close();
    process.exit(0);
  });
}
