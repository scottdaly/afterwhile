import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { parseHTML } from "linkedom";
import manifest from "./connection.json";
import selectors from "./selectors.json";
import { applyVisible, channelPolicy, extractSlack, parseSlackUrl, type KnownMessage } from "./extract.ts";
import { decidePace, drawingStalled, scrollStepPx, USER_INPUT_EVENTS } from "./pace.ts";

const URL = "https://app.slack.com/client/T024BE7LD/C01ABCD2EFG";

function doc(name: string) {
  const html = readFileSync(new globalThis.URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return parseHTML(html).document;
}

function pace(partial: Partial<Parameters<typeof decidePace>[0]> = {}, rng?: () => number) {
  return decidePace({
    now: 1_000_000,
    lastUserInputAt: 0,
    tabHidden: false,
    windowLocked: false,
    loadsThisVisit: 0,
    loadsThisHour: 0,
    visitBudget: 20,
    hourlyBudget: 100,
    reachedBeginning: false,
    reachedOldest: false,
    pushback: null,
    stalled: false,
    blockedUntil: null,
    ...partial,
  }, rng);
}

describe("slack fixtures", () => {
  test("selectors are plain strings", () => {
    const banned = ["steps", "conditions", "expressions", "script", "code"];
    const walk = (value: unknown, key = ""): void => {
      expect(banned).not.toContain(key);
      if (typeof value === "string") return;
      expect(value && typeof value === "object").toBe(true);
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) walk(child, childKey);
    };
    walk(selectors);
  });

  test("captures a public channel", () => {
    const result = extractSlack(doc("channel.html"), { url: URL, now: new Date("2026-10-12T17:00:00Z") });
    expect(result.status).toBe("ok");
    expect(result.channel?.kind).toBe("public");
    expect(result.channel?.title).toBe("#design-foundations");
    expect(result.messages).toHaveLength(2);
    const first = result.messages[0];
    expect(first?.id).toBe("slack:T024BE7LD:C01ABCD2EFG:1791822000.000100");
    expect(first?.text).toContain("Input focus states");
    expect(first?.author).toEqual({ name: "Alex Kim", id: "U02XYZ" });
    expect(first?.fields.replyCount).toBe(3);
    expect(first?.occurredAt.startsWith("2026-10-12T16:20:00")).toBe(true);
    expect(first?.source.url).toBe(URL);
  });

  test("live-shaped channel list excludes sidebar rows and unknown privacy stays off", () => {
    const result = extractSlack(doc("enterprise-channel.html"), {
      url: "https://app.slack.com/client/ETEST123/C01ABCD2EFG",
    });
    expect(result.status).toBe("ok");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe("Synthetic channel message.");
    expect(result.channel?.title).toBe("synthetic-public-channel");
    expect(result.channel?.kind).toBe("private");
    expect(channelPolicy(result.channel!.kind, { includeDms: false, includePrivate: false }).capture).toBe(false);
  });

  test("live-shaped public icon is required; lock or unknown icons stay private", () => {
    for (const [icon, kind] of [["channel-filled", "public"], ["lock-filled", "private"], ["unknown", "private"]] as const) {
      const document = doc("enterprise-channel.html");
      const node = document.querySelector(".p-view_header__channel_title_icon")!;
      node.setAttribute("data-inline-channel-type-icon", icon);
      node.querySelector("svg")!.setAttribute("data-qa", icon);
      const result = extractSlack(document, { url: "https://app.slack.com/client/ETEST123/C01ABCD2EFG" });
      expect(result.channel?.kind).toBe(kind);
      expect(channelPolicy(result.channel!.kind, { includeDms: false, includePrivate: false }).capture).toBe(kind === "public");
    }
  });

  test("reload of the same messages does not emit duplicates", () => {
    const first = extractSlack(doc("channel.html"), { url: URL });
    const applied = applyVisible([], first.messages);
    const again = applyVisible(applied.known, first.messages);
    expect(again.upserts).toHaveLength(0);
    expect(again.deleted).toHaveLength(0);
  });

  test("an edited message is a new upsert and keeps the id", () => {
    const original = extractSlack(doc("channel.html"), { url: URL });
    const edited = extractSlack(doc("channel-edited.html"), { url: URL });
    const applied = applyVisible([], original.messages);
    const next = applyVisible(applied.known, edited.messages);
    expect(next.upserts.map((message) => message.id)).toEqual([
      "slack:T024BE7LD:C01ABCD2EFG:1791822000.000100",
    ]);
    expect(next.upserts[0]?.text).toContain("Thursday");
    expect(next.upserts[0]?.fields.edited).toBe(true);
  });

  test("deletes only when both neighbors are on screen", () => {
    const older = extractSlack(doc("channel-older.html"), { url: URL });
    const withJordan = extractSlack(doc("channel.html"), { url: URL });
    const known: KnownMessage[] = [
      ...older.messages.map((message) => ({
        ...message,
        position: null,
      })),
      ...withJordan.messages
        .filter((message) => message.author?.id === "U03ABC")
        .map((message) => ({
          ...message,
          position: null,
        })),
    ];
    const deletedView = extractSlack(doc("channel-deleted.html"), { url: URL });
    const plan = applyVisible(known, deletedView.messages);
    expect(plan.deleted.map((message) => message.id)).toEqual([
      "slack:T024BE7LD:C01ABCD2EFG:1791822000.000100",
    ]);
    const onlyTop = applyVisible(known, [deletedView.messages[0]!]);
    expect(onlyTop.deleted).toHaveLength(0);
  });

  test("threads keep the parent timestamp", () => {
    const result = extractSlack(doc("thread.html"), { url: URL });
    const reply = result.messages.find((message) => message.kind === "thread_reply");
    expect(reply?.fields.threadTs).toBe("1791822000.000100");
    expect(reply?.text).toContain("focus ring");
  });

  test("DMs and private channels are off by default, and unknown ids are private", () => {
    const dm = extractSlack(doc("dm.html"), { url: "https://app.slack.com/client/T024BE7LD/D0123456789" });
    expect(dm.channel?.kind).toBe("dm");
    expect(channelPolicy("dm", { includeDms: false, includePrivate: false }).capture).toBe(false);
    const priv = extractSlack(doc("private.html"), { url: URL });
    expect(priv.channel?.kind).toBe("private");
    expect(channelPolicy("private", { includeDms: false, includePrivate: false }).reason).toBe(
      "Private channels are off",
    );
    const unsure = extractSlack(doc("unsure.html"), {
      url: "https://app.slack.com/client/T024BE7LD/G0123456789",
    });
    expect(unsure.channel?.kind).toBe("private");
  });

  test("beginning banner completes the source", () => {
    const result = extractSlack(doc("beginning.html"), { url: URL, now: new Date("2026-10-12T17:00:00Z") });
    expect(result.reachedBeginning).toBe(true);
    const decision = pace({ reachedBeginning: true });
    expect(decision).toEqual({ action: "stop", reason: "reached the start", complete: true });
  });

  test("changed markup reports capture stopped working and saves nothing", () => {
    for (const name of ["changed-markup.html", "changed-markup-inside-list.html"]) {
      const result = extractSlack(doc(name), { url: URL });
      expect(result.status).toBe("stopped");
      expect(result.reason).toBe("capture stopped working");
      expect(result.messages).toHaveLength(0);
    }
  });

  test("a loading shell is not treated as a broken connection", () => {
    const result = extractSlack(doc("loading.html"), { url: URL });
    expect(result.status).toBe("ok");
    expect(result.messages).toHaveLength(0);
    expect(result.reason).toBeNull();
  });

  test("pushback fixtures stop the scroll and do not yield messages", () => {
    const cases: Array<[string, string]> = [
      ["pushback-captcha.html", "CAPTCHA"],
      ["pushback-slowdown.html", "slow down"],
      ["pushback-error.html", "something went wrong"],
      ["pushback-signin.html", "sign-in prompt"],
    ];
    for (const [name, reason] of cases) {
      const result = extractSlack(doc(name), { url: URL });
      expect(result.pushback).toBe(reason);
      expect(result.messages).toHaveLength(0);
      const decision = pace({ pushback: result.pushback });
      expect(decision.action).toBe("stop");
      if (decision.action === "stop") expect(decision.complete).toBe(false);
    }
  });
});

describe("pacing", () => {
  test("user input events do not include scroll", () => {
    expect(USER_INPUT_EVENTS).not.toContain("scroll");
    expect(USER_INPUT_EVENTS).toContain("wheel");
  });

  test("a visible tab waits while the person was just using it", () => {
    const decision = pace({ now: 50_000, lastUserInputAt: 40_000, tabHidden: false });
    expect(decision).toMatchObject({ action: "wait", reason: "person is using this tab" });
  });

  test("a hidden tab can scroll immediately", () => {
    const decision = pace({ now: 50_000, lastUserInputAt: 49_000, tabHidden: true }, () => 0.5);
    expect(decision.action).toBe("scroll");
    if (decision.action === "scroll") {
      expect(decision.maxStepRatio).toBe(0.5);
      expect(decision.pauseMs).toBeGreaterThanOrEqual(500);
      expect(decision.pauseMs).toBeLessThanOrEqual(2500);
    }
  });

  test("pauses are sometimes longer", () => {
    const decision = pace({ tabHidden: true }, () => 0);
    expect(decision.action).toBe("scroll");
    if (decision.action === "scroll") expect(decision.pauseMs).toBeGreaterThanOrEqual(4000);
  });

  test("load budget and hourly budget stop as partial", () => {
    expect(pace({ loadsThisVisit: manifest.pace.loadBudget ?? 20 }).action).toBe("stop");
    expect(pace({ loadsThisHour: manifest.pace.hourlyLoadBudget ?? 100 })).toMatchObject({
      action: "stop",
      reason: "hourly load budget reached",
      complete: false,
    });
    expect(pace({ loadsThisVisit: 20 })).toMatchObject({ reason: "load budget reached", complete: false });
  });

  test("a stalled background tab waits instead of trusting scrollTop", () => {
    expect(drawingStalled({ scrollTop: 400, rowIds: ["a"] }, { scrollTop: 200, rowIds: ["a"] })).toBe(true);
    expect(drawingStalled({ scrollTop: 400, rowIds: ["a"] }, { scrollTop: 200, rowIds: ["b", "a"] })).toBe(false);
    expect(pace({ stalled: true, tabHidden: true })).toMatchObject({ action: "wait", reason: "drawing stalled" });
    expect(scrollStepPx(501)).toBe(250);
  });

  test("older history from the fixture counts as another load's worth of messages", () => {
    const current = extractSlack(doc("channel.html"), { url: URL });
    const older = extractSlack(doc("channel-older.html"), { url: URL });
    const seen = new Set(current.messages.map((message) => message.id));
    const oldest = Math.min(...current.messages.map((message) => Date.parse(message.occurredAt)));
    const loads = older.messages.filter((message) => !seen.has(message.id) && Date.parse(message.occurredAt) < oldest);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.text).toContain("Yesterday");
  });

  test("enterprise client URLs capture under the visible organization scope", () => {
    const url = "https://app.slack.com/client/ETEST123/C01ABCD2EFG";
    expect(parseSlackUrl(url)).toEqual({ teamId: "ETEST123", channelId: "C01ABCD2EFG" });
    const result = extractSlack(doc("channel.html"), { url });
    expect(result.status).toBe("ok");
    expect(result.channel?.sourceId).toBe("slack:ETEST123:C01ABCD2EFG");
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.every((message) => message.source.url === url)).toBe(true);
  });

  test("composer identifies thread replies without revising the repeated parent", () => {
    const document = doc("thread.html");
    const pane = document.querySelector("[data-qa='threads_flexpane']")!;
    const parent = pane.getAttribute("data-thread-ts")!;
    pane.removeAttribute("data-thread-ts");
    pane.insertAdjacentHTML("beforeend", `<div class="c-texty_input_unstyled" data-thread-ts="${parent}"></div>`);
    const root = document.querySelector("[data-qa='virtual-list'] [data-qa='virtual-list-item']")!.cloneNode(true);
    pane.insertBefore(root, pane.firstChild);
    const result = extractSlack(document, { url: URL });
    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((message) => message.kind)).toEqual(["message", "thread_reply"]);
    expect(result.messages[1]?.fields.threadTs).toBe(parent);
    expect(new Set(result.messages.map((message) => message.id)).size).toBe(2);
    document.querySelector(".c-texty_input_unstyled")!.setAttribute("data-thread-ts", "1791800000.000100");
    expect(extractSlack(document, { url: URL }).messages).toHaveLength(1);
  });

  test("rendered thread root verifies its channel when the main-list parent is offscreen", () => {
    const document = doc("thread.html");
    const pane = document.querySelector("[data-qa='threads_flexpane']")!;
    const parentRow = document.querySelector("[data-qa='virtual-list'] [data-qa='virtual-list-item']")!;
    const root = parentRow.cloneNode(true) as Element;
    root.classList.add("c-message_kit__thread_message--root");
    root.setAttribute("data-msg-channel-id", "C01ABCD2EFG");
    pane.insertBefore(root, pane.firstChild);
    parentRow.remove();
    const result = extractSlack(document, { url: URL });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.kind).toBe("thread_reply");
    root.setAttribute("data-msg-channel-id", "COTHER123");
    expect(extractSlack(document, { url: URL }).messages).toHaveLength(0);
  });

  test("parse rejects a non-client url", () => {
    expect(parseSlackUrl("https://example.com/client/T/C")).toBeNull();
    expect(parseSlackUrl(URL)?.channelId).toBe("C01ABCD2EFG");
    for (const route of ["unreads", "threads", "ctest", "Ctest"]) {
      expect(parseSlackUrl(`https://app.slack.com/client/TTEST/${route}`)).toBeNull();
    }
    expect(parseSlackUrl("https://evilslack.com/client/TTEST/CTEST")).toBeNull();
  });
});
