import { mkdirSync, cpSync, rmSync } from "fs";
import path from "path";
import {
  allExtensionIds,
  APP_NAME,
  NATIVE_HOST_ID,
  UNPACKED_EXTENSION_KEY,
} from "../shared/src/index.ts";

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "extension", "dist");
const helperOut = path.join(root, "dist", APP_NAME);

async function bundle(entry: string, outfile: string, format: "esm" | "iife"): Promise<void> {
  const proc = Bun.spawn(
    [process.execPath, "build", entry, "--outfile", outfile, "--target", "browser", `--format=${format}`],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`bundle failed: ${entry}`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "icons"), { recursive: true });

await bundle(path.join(root, "extension/src/content-slack.ts"), path.join(dist, "content-slack.js"), "iife");
await bundle(path.join(root, "extension/src/popup.ts"), path.join(dist, "popup.js"), "iife");
await bundle(path.join(root, "extension/src/service-worker.ts"), path.join(dist, "service-worker.js"), "esm");

cpSync(path.join(root, "extension/src/popup.html"), path.join(dist, "popup.html"));
cpSync(path.join(root, "extension/src/popup.css"), path.join(dist, "popup.css"));
cpSync(path.join(root, "extension/icons"), path.join(dist, "icons"), { recursive: true });

const manifest = {
  manifest_version: 3,
  name: APP_NAME,
  version: "0.1.0",
  description: "Saves what you read in web apps you choose to your computer, so your AI tools can search it.",
  incognito: "not_allowed",
  permissions: ["storage", "nativeMessaging", "scripting", "idle"],
  optional_host_permissions: ["https://app.slack.com/*"],
  background: { service_worker: "service-worker.js", type: "module" },
  action: {
    default_popup: "popup.html",
    default_title: APP_NAME,
    default_icon: { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
  },
  icons: { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
  key: UNPACKED_EXTENSION_KEY,
};

await Bun.write(path.join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const helper = Bun.spawn(
  [process.execPath, "build", path.join(root, "helper/src/index.ts"), "--compile", "--outfile", helperOut],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
const helperCode = await helper.exited;
if (helperCode !== 0) throw new Error("helper compile failed");

console.log(`extension ${dist}`);
console.log(`helper ${helperOut}`);
console.log(`native host ${NATIVE_HOST_ID}`);
console.log(`extension ids ${allExtensionIds().join(",")}`);
