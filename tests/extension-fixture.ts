import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { runInNewContext } from "vm";
import { parseHTML } from "linkedom";
import { APP_NAME } from "../shared/src/index.ts";
import { RecordDatabase } from "../helper/src/database.ts";
import { handleHostMessage } from "../helper/src/host.ts";

export const SLACK_URL = "https://app.slack.com/client/TTEST/CTEST";
export const SOURCE_ID = "slack:TTEST:CTEST";

export function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dir, "../connections/slack/fixtures", name), "utf8");
}

export function row(ts: number, text = `Synthetic message ${ts}`): string {
  return `<div data-qa="virtual-list-item"><a data-ts="1791822${String(ts).padStart(3, "0")}.000100"></a><div class="p-rich_text_section">${text}</div></div>`;
}

export function page(rows: string, thread = ""): string {
  return `<html><body><div data-qa="channel_header"><span data-qa="channel-name">#synthetic</span></div><div data-qa="virtual-list">${rows}</div>${thread}</body></html>`;
}

class Events {
  listeners: Array<(...args: any[]) => any> = [];
  addListener = (listener: (...args: any[]) => any) => { this.listeners.push(listener); };
  emit(...args: any[]) { return this.listeners.map((listener) => listener(...args)); }
}

// Timers and Date share one clock across the content script and worker realms.
export class FakeClock {
  now = Date.parse("2026-10-12T17:00:00Z");
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay = 0): number => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  async settle() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
  async advance(ms: number) {
    const end = this.now + ms;
    await this.settle();
    let steps = 0;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      if (++steps > 10_000) throw new Error("timer loop in fixture");
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await this.settle();
    }
    this.now = end;
    await this.settle();
  }
}

type HostMode = "healthy" | "missing" | "before-ingest" | "drop-ack";

export class ExtensionFixture {
  readonly clock = new FakeClock();
  readonly root = mkdtempSync(path.join(tmpdir(), `${APP_NAME}-extension-`));
  readonly db = new RecordDatabase(path.join(this.root, "records.db"));
  readonly dom: ReturnType<typeof parseHTML>;
  readonly storage: Record<string, any>;
  readonly scrolls: Array<{ at: number; top: number }> = [];
  readonly sent: any[] = [];
  readonly errors: unknown[][] = [];
  readonly injections: any[] = [];
  readonly ports: any[] = [];
  readonly contentChanges = new Events();
  workerChanges = new Events();
  installed = new Events();
  runtimeMessages = new Events();
  hostMode: HostMode = "healthy";
  tabs: any[] = [{ id: 1, incognito: false }, { id: 2, incognito: true }];
  registered: any[] = [];
  onScroll: (() => void) | null = null;
  onSend: ((message: any) => void) | null = null;
  beforeStorageSet: ((values: Record<string, unknown>) => Promise<void>) | null = null;
  height = 2000;
  visibleHeight = 400;
  top = 1000;
  private observers: Array<() => void> = [];
  private workerTimers: number[] = [];
  private contentWindow: any;
  private inputHandlers = new Map<string, Array<(event: Event) => void>>();
  private static bundles: Promise<{ content: string; worker: string }> | null = null;

  constructor(html = page(row(100) + row(300)), options: { hidden?: boolean; settings?: Record<string, any>; url?: string; hostMode?: HostMode } = {}) {
    this.dom = parseHTML(html);
    Object.defineProperty(this.dom.document, "hidden", { value: options.hidden ?? false, writable: true });
    this.storage = { slackEnabled: true, slackHourLoads: 0, ...options.settings };
    this.url = options.url ?? SLACK_URL;
    this.hostMode = options.hostMode ?? "healthy";
    this.configureList();
  }
  url: string;

  get list() { return this.dom.document.querySelector("[data-qa='virtual-list']")!; }
  configureList() {
    const list = this.list;
    if (!list) return;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, get: () => this.visibleHeight },
      scrollHeight: { configurable: true, get: () => this.height },
      scrollTop: { configurable: true, get: () => this.top, set: (value: number) => {
        this.top = Math.max(0, Math.min(value, this.height - this.visibleHeight));
        this.scrolls.push({ at: this.clock.now, top: this.top });
        this.onScroll?.();
      } },
    });
    list.getBoundingClientRect = () => ({ top: 0, bottom: this.visibleHeight } as DOMRect);
    for (const el of Array.from(list.querySelectorAll("[data-qa='virtual-list-item']"))) {
      // Rows keep a synthetic document coordinate as history is added above them.
      el.getBoundingClientRect = () => ({ top: this.height - 1000 - this.top, bottom: this.height - 950 - this.top } as DOMRect);
    }
  }

  private static getBundles() {
    return this.bundles ??= Promise.all(["content-slack", "service-worker"].map(async (entry) => {
      const result = await Bun.build({ entrypoints: [path.join(import.meta.dir, `../extension/src/${entry}.ts`)], target: "browser", format: "iife" });
      if (!result.success) throw new Error(result.logs.join("\n"));
      return result.outputs[0]!.text();
    })).then(([content, worker]) => ({ content, worker }));
  }

  private globals() {
    const clock = this.clock;
    class FixtureDate extends Date {
      constructor(value?: string | number) { super(value ?? clock.now); }
      static now() { return clock.now; }
    }
    const math = Object.create(Math);
    math.random = () => 0.5; // A 1500ms reader pause.
    return { Date: FixtureDate, Math: math, URL, crypto, TextEncoder,
      console: { log() {}, error: (...args: unknown[]) => this.errors.push(args) } };
  }

  private storageApi(changes: Events) {
    return { local: {
      get: async (keys: string | string[]) => {
        const names = typeof keys === "string" ? [keys] : keys;
        return structuredClone(Object.fromEntries(names.filter((key) => key in this.storage).map((key) => [key, this.storage[key]])));
      },
      set: async (values: Record<string, unknown>) => this.setStorage(values),
    }, onChanged: changes };
  }

  async setStorage(values: Record<string, unknown>) {
    await this.beforeStorageSet?.(values);
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(this.storage[key]) === JSON.stringify(value)) continue;
      changes[key] = { oldValue: this.storage[key], newValue: value };
      this.storage[key] = structuredClone(value);
    }
    if (Object.keys(changes).length) {
      this.workerChanges.emit(changes, "local");
      this.contentChanges.emit(changes, "local");
    }
  }

  async startWorker() {
    for (const id of this.workerTimers) this.clock.clearTimeout(id);
    this.workerTimers = [];
    this.workerChanges = new Events();
    this.runtimeMessages = new Events();
    this.installed = new Events();
    const chrome = {
      storage: this.storageApi(this.workerChanges),
      runtime: { onMessage: this.runtimeMessages, onInstalled: this.installed, connectNative: () => this.connectHost() },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
      scripting: {
        getRegisteredContentScripts: async () => this.registered,
        registerContentScripts: async (scripts: any[]) => { this.registered.push(...scripts); },
        unregisterContentScripts: async () => { this.registered = []; },
        executeScript: async (details: any) => { this.injections.push(details); },
      },
      tabs: { onRemoved: new Events(), query: async () => this.tabs },
      idle: { setDetectionInterval() {}, queryState: (_seconds: number, reply: (state: string) => void) => reply("active") },
    };
    runInNewContext((await ExtensionFixture.getBundles()).worker, {
      ...this.globals(), chrome,
      setTimeout: (fn: () => void, delay: number) => {
        const id = this.clock.setTimeout(fn, delay);
        this.workerTimers.push(id);
        return id;
      }, clearTimeout: this.clock.clearTimeout,
    });
    await this.clock.settle();
  }

  private connectHost() {
    const port = {
      onMessage: new Events(), onDisconnect: new Events(), disconnected: false,
      postMessage: (message: any) => {
        this.sent.push(structuredClone(message));
        if (this.hostMode === "missing" || (message.type === "records" && this.hostMode === "before-ingest")) return;
        const response = handleHostMessage(this.db, path.join(this.root, "files"), message);
        if (message.type === "records" && this.hostMode === "drop-ack") return;
        this.clock.setTimeout(() => { if (!port.disconnected) port.onMessage.emit(response); }, 0);
      },
      disconnect: () => { port.disconnected = true; port.onDisconnect.emit(); },
    };
    this.ports.push(port);
    return port;
  }

  send(message: any, sender = { tab: { id: 1, incognito: false } }): Promise<any> {
    this.onSend?.(message);
    return new Promise((resolve) => { this.runtimeMessages.emit(message, sender, resolve); });
  }

  async startContent() {
    const owner = this;
    const window = this.contentWindow ??= {
      addEventListener: (type: string, handler: (event: Event) => void) => {
        const handlers = this.inputHandlers.get(type) ?? [];
        handlers.push(handler); this.inputHandlers.set(type, handlers);
        this.dom.window.addEventListener(type, handler);
      },
      setTimeout: this.clock.setTimeout, clearTimeout: this.clock.clearTimeout,
    };
    runInNewContext((await ExtensionFixture.getBundles()).content, {
      ...this.globals(), window, document: this.dom.document, location: { href: this.url },
      HTMLElement: this.dom.window.HTMLElement,
      chrome: { storage: this.storageApi(this.contentChanges), runtime: { sendMessage: (message: any) => this.send(message) } },
      MutationObserver: class { constructor(callback: () => void) { owner.observers.push(callback); } observe() {} },
    });
    await this.clock.advance(0);
  }

  async start() { await this.startWorker(); await this.startContent(); }
  mutate(work: () => void) { work(); this.configureList(); for (const callback of this.observers) callback(); }
  // Model browser input explicitly; dispatchEvent itself produces untrusted events.
  input(type: string, trusted = true) { for (const handler of this.inputHandlers.get(type) ?? []) handler({ isTrusted: trusted } as Event); }
  async close() { this.db.close(); rmSync(this.root, { recursive: true, force: true }); }
}
