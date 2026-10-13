import { expect, test } from "bun:test";
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { APP_NAME, UNPACKED_EXTENSION_ID, UNPACKED_EXTENSION_KEY } from "./constants.ts";
import { chunkRecords } from "./batch.ts";

test("pinned extension key matches the unpacked id", () => {
  const der = Buffer.from(UNPACKED_EXTENSION_KEY, "base64");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = [...hex].map((char) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(char, 16))).join("");
  expect(id).toBe(UNPACKED_EXTENSION_ID);
});

test("record batches stay small", () => {
  const items = Array.from({ length: 25 }, (_, index) => ({ id: index, text: "x".repeat(20) }));
  const chunks = chunkRecords(items, 20, 1024 * 1024);
  expect(chunks.map((chunk) => chunk.length)).toEqual([20, 5]);
});

test("the product name is only spelled in the constants file", () => {
  const root = path.resolve(import.meta.dir, "../..");
  const allowed = new Set(["shared/src/constants.ts", "README.md"]);
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = path.join(dir, entry);
      const rel = path.relative(root, full);
      if (rel === path.join("extension", "dist") || rel.startsWith(`docs${path.sep}`) || rel.startsWith("docs/")) {
        continue;
      }
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|json|md|html|css|toml)$/.test(entry)) continue;
      if (allowed.has(rel)) continue;
      if (readFileSync(full, "utf8").includes(APP_NAME)) offenders.push(rel);
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});
