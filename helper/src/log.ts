import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import { dataDir } from "./paths.ts";

export function log(...parts: unknown[]): void {
  const line = parts
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .join(" ");
  console.error(line);
  try {
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "log.txt"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must not break the stdio protocols.
  }
}
