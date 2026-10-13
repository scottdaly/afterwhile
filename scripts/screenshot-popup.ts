import { mkdirSync, rmSync } from "fs";
import path from "path";
import { APP_NAME, UNPACKED_EXTENSION_ID } from "../shared/src/index.ts";

const root = path.resolve(import.meta.dir, "..");
const extensionDir = path.join(root, "extension", "dist");
const profile = `/tmp/${APP_NAME}-chrome-profile`;
const port = 9334;
const outDir = "/tmp/popup-shots";
mkdirSync(outDir, { recursive: true });
rmSync(profile, { recursive: true, force: true });

const chrome = Bun.spawn(
  [
    process.env.CHROME_BIN ?? "google-chrome",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--window-size=420,820",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "about:blank",
  ],
  { stdout: "pipe", stderr: "pipe" },
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let version: { webSocketDebuggerUrl: string } | null = null;
let extensionLoaded = false;
for (let i = 0; i < 40; i++) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (response.ok) version = (await response.json()) as { webSocketDebuggerUrl: string };
    const list = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (list.ok) {
      const targets = (await list.json()) as Array<{ url: string }>;
      extensionLoaded = targets.some((target) => target.url.includes(UNPACKED_EXTENSION_ID));
    }
    if (version && extensionLoaded) break;
  } catch {
    // Chrome is still starting.
  }
  await sleep(250);
}
if (!version || !extensionLoaded) {
  chrome.kill();
  throw new Error(
    version
      ? "Unpacked extension did not load. Branded Chrome ignores --load-extension; use Chrome for Testing."
      : "Chrome did not open a devtools port.",
  );
}

const browser = new WebSocket(version.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  browser.addEventListener("open", () => resolve());
  browser.addEventListener("error", () => reject(new Error("devtools socket failed")));
});

let nextId = 0;
const pending = new Map<number, (value: unknown) => void>();
browser.addEventListener("message", (event) => {
  const data = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
  if (data.id == null) return;
  const done = pending.get(data.id);
  if (!done) return;
  pending.delete(data.id);
  if (data.error) throw new Error(data.error.message);
  done(data.result);
});

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++nextId;
  browser.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, 10000);
  });
}

const targets = (await send("Target.getTargets")) as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
console.log("targets", targets.targetInfos.map((target) => `${target.type} ${target.url}`).join("\n"));
console.log("extension loaded", UNPACKED_EXTENSION_ID);

const popupUrl = `chrome-extension://${UNPACKED_EXTENSION_ID}/popup.html`;
const created = (await send("Target.createTarget", { url: popupUrl })) as { targetId: string };
const attached = (await send("Target.attachToTarget", { targetId: created.targetId, flatten: true })) as {
  sessionId: string;
};

function sendSession(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++nextId;
  browser.send(JSON.stringify({ id, method, params, sessionId: attached.sessionId }));
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, 10000);
  });
}

await sendSession("Page.enable");
await sendSession("Runtime.enable");
await sendSession("Emulation.setDeviceMetricsOverride", {
  width: 400,
  height: 760,
  deviceScaleFactor: 2,
  mobile: false,
});
await sleep(400);

async function shot(name: string) {
  const result = (await sendSession("Page.captureScreenshot", { format: "png" })) as { data: string };
  const file = path.join(outDir, name);
  const bytes = Buffer.from(result.data, "base64");
  await Bun.write(file, bytes);
  console.log(`${file} ${bytes.length}`);
}

await shot("popup-off.png");

await sendSession("Runtime.evaluate", {
  expression: `chrome.storage.local.set(${JSON.stringify({
    slackEnabled: true,
    paused: false,
    includeDms: false,
    includePrivate: false,
    todayCount: 3,
    helperConnected: true,
    slackPauseReason: null,
    lastPage: {
      sourceId: "slack:T024BE7LD:C01ABCD2EFG",
      title: "#design-foundations",
      url: "https://app.slack.com/client/T024BE7LD/C01ABCD2EFG",
      count: 3,
      coverage: "#design-foundations is only partly saved (load budget reached). Open it and scroll to capture more.",
      error: null,
      skipped: null,
    },
  })})`,
  awaitPromise: true,
});
await sleep(300);
await shot("popup-partial.png");

await sendSession("Runtime.evaluate", {
  expression: `chrome.storage.local.set(${JSON.stringify({
    slackPauseReason: "CAPTCHA",
    lastPage: {
      sourceId: "slack:T024BE7LD:C01ABCD2EFG",
      title: "#design-foundations",
      url: "https://app.slack.com/client/T024BE7LD/C01ABCD2EFG",
      count: 3,
      coverage: "#design-foundations is only partly saved (CAPTCHA). Open it and scroll to capture more.",
      error: "Slack paused for today: CAPTCHA",
      skipped: null,
    },
  })})`,
  awaitPromise: true,
});
await sleep(300);
await shot("popup-pushback.png");

browser.close();
chrome.kill();
console.log("screenshots: unpacked extension in Chrome for Testing on Xvfb");
