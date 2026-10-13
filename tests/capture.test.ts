import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import path from "path";
import { localDay, sourceSlug } from "../shared/src/index.ts";
import { ExtensionFixture, fixture, page, row, SOURCE_ID } from "./extension-fixture.ts";

const active: ExtensionFixture[] = [];
function make(...args: ConstructorParameters<typeof ExtensionFixture>) {
  const h = new ExtensionFixture(...args);
  active.push(h);
  return h;
}
afterEach(async () => { for (const h of active.splice(0)) await h.close(); });

describe("real content script → service worker → helper → SQLite/Markdown", () => {
  test("DM and private gating happens before sending records, and opt-in captures them", async () => {
    for (const [name, control, url, source] of [
      ["dm.html", "includeDms", "https://app.slack.com/client/TTEST/DTEST", "slack:TTEST:DTEST"],
      ["private.html", "includePrivate", "https://app.slack.com/client/TTEST/CTEST", SOURCE_ID],
    ]) {
      const h = make(fixture(name!), { url });
      await h.start();
      expect(h.db.getSource(source!)).toHaveLength(0);
      expect(h.sent.filter((message) => message.type === "records")).toHaveLength(0);
      expect(h.storage.lastPage.skipped).toContain("off");
      await h.setStorage({ [control!]: true });
      await h.clock.advance(0);
      expect(h.db.getSource(source!)).toHaveLength(1);
      expect(h.storage.pendingRecords).toEqual([]);
      const record = h.db.getSource(source!)[0]!;
      expect(readFileSync(path.join(h.root, "files", "slack", sourceSlug(source!), `${localDay(record.occurredAt)}.md`), "utf8"))
        .toContain(record.text);
    }
  });

  test("pushback without a channel pauses the site until local midnight", async () => {
    for (const [name, reason] of [
      ["pushback-captcha.html", "CAPTCHA"], ["pushback-slowdown.html", "slow down"],
      ["pushback-error.html", "something went wrong"], ["pushback-signin.html", "sign-in prompt"],
    ]) {
      const h = make(fixture(name!), { hidden: true });
      await h.start();
      const end = new Date(h.clock.now); end.setHours(24, 0, 0, 0);
      expect(h.storage.slackBlockedUntil).toBe(end.getTime());
      expect(h.storage.slackPauseReason).toBe(reason);
      expect(h.storage.lastPage.error).toContain(reason);
      expect(h.scrolls).toHaveLength(0);
      h.mutate(() => { h.dom.document.body.innerHTML = fixture("channel.html").split("<body>")[1]!.split("</body>")[0]!; });
      await h.clock.advance(60_000);
      expect(h.db.sources()).toHaveLength(0);
      expect(h.scrolls).toHaveLength(0);
    }
  });

  test("closing or switching a thread does not delete replies between channel rows", async () => {
    const thread = `<div data-qa="threads_flexpane" data-thread-ts="1791822100.000100"><div data-qa="virtual-list">${row(200)}</div></div>`;
    const h = make(page(row(100) + row(300), thread));
    await h.start();
    const reply = h.db.getSource(SOURCE_ID).find((record) => record.kind === "thread_reply")!;
    h.mutate(() => { h.dom.document.querySelector("[data-qa='threads_flexpane']")!.remove(); });
    await h.clock.advance(200);
    expect(h.db.revisions(reply.id)).toHaveLength(1);
    h.mutate(() => { h.dom.document.body.insertAdjacentHTML("beforeend", thread.replace("1791822100", "1791822300").replace(row(200), row(250))); });
    await h.clock.advance(200);
    expect(h.db.revisions(reply.id)).toHaveLength(1);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(4);
    expect(h.sent.flatMap((message) => message.records ?? []).filter((record: any) => record.deleted)).toHaveLength(0);
  });

  test("empty text is visible, and an actual missing row still gets a deletion revision", async () => {
    const h = make(page(row(100) + row(200) + row(300)));
    await h.start();
    const middle = h.db.getSource(SOURCE_ID)[1]!;
    const middleRow = h.list.querySelectorAll("[data-qa='virtual-list-item']")[1]!;
    h.mutate(() => { middleRow.querySelector(".p-rich_text_section")!.textContent = ""; });
    await h.clock.advance(200);
    expect(h.db.revisions(middle.id)).toHaveLength(1);
    h.mutate(() => { middleRow.querySelector(".p-rich_text_section")!.textContent = middle.text; });
    await h.clock.advance(200);
    expect(h.db.revisions(middle.id)).toHaveLength(1);
    h.mutate(() => { middleRow.remove(); });
    await h.clock.advance(200);
    expect(h.db.revisions(middle.id).map((record) => record.deleted)).toEqual([false, true]);
  });

  test("unrelated lists and unattributed threads cannot bypass the current channel policy", async () => {
    const thread = `<div data-qa="threads_flexpane" data-thread-ts="1791822999.000100"><div data-qa="virtual-list">${row(250, "Synthetic private reply")}</div></div>`;
    const h = make(page(row(100) + row(300), thread) + row(900, "Synthetic unrelated preview"));
    await h.start();
    expect(h.db.getSource(SOURCE_ID).map((record) => record.text)).toEqual(["Synthetic message 100", "Synthetic message 300"]);
  });

  test("a loading channel without its privacy header is private until classified", async () => {
    const h = make(page(row(100)).replace(/<div data-qa="channel_header">.*?<\/div>/, ""));
    await h.start();
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(0);
    expect(h.storage.lastPage.skipped).toBe("Private channels are off");
    h.mutate(() => { h.dom.document.body.insertAdjacentHTML("afterbegin", '<div data-qa="channel_header"><span data-qa="channel-name">#synthetic</span></div>'); });
    await h.clock.advance(200);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(1);
  });

  test("a reply still visible in its thread cannot be deleted when its channel copy disappears", async () => {
    const thread = `<div data-qa="threads_flexpane" data-thread-ts="1791822100.000100"><div data-qa="virtual-list">${row(200)}</div></div>`;
    const h = make(page(row(100) + row(200) + row(300), thread));
    await h.start();
    const reply = h.db.getSource(SOURCE_ID)[1]!;
    h.mutate(() => { h.list.querySelectorAll("[data-qa='virtual-list-item']")[1]!.remove(); });
    await h.clock.advance(200);
    expect(h.db.revisions(reply.id)).toHaveLength(1);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(3);
  });

  test("an undrawn timestamp between neighbours is not proof of a deletion", async () => {
    const h = make(page(row(100) + row(200) + row(300))); await h.start();
    const middle = h.db.getSource(SOURCE_ID)[1]!;
    h.mutate(() => { h.list.querySelectorAll("[data-qa='virtual-list-item']")[1]!.querySelector("[data-ts]")!.remove(); });
    await h.clock.advance(200);
    expect(h.db.revisions(middle.id)).toHaveLength(1);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(3);
  });

  test("rich text captures all paragraphs, lists and code", async () => {
    const rich = row(100, "First paragraph").replace("</div></div>", `</div>
      <div class="p-rich_text_section">Second paragraph</div>
      <ul class="p-rich_text_list"><li><span class="p-rich_text_section">List one</span></li><li>List two</li></ul>
      <pre class="p-rich_text_preformatted">const value = 1;\n  return value;</pre></div>`);
    const h = make(page(rich));
    await h.start();
    const text = h.db.getSource(SOURCE_ID)[0]!.text;
    expect(text).toContain("First paragraph\n\nSecond paragraph");
    expect(text).toContain("List one");
    expect(text).toContain("List two");
    expect(text.match(/List one/g)).toHaveLength(1);
    expect(text).toContain("const value = 1;\n  return value;");
  });

  test("a missing reply with both thread neighbours visible keeps its thread metadata", async () => {
    const thread = `<div data-qa="threads_flexpane" data-thread-ts="1791822100.000100"><div data-qa="virtual-list">${row(150) + row(200) + row(250)}</div></div>`;
    const h = make(page(row(100) + row(300), thread)); await h.start();
    const middle = h.db.getSource(SOURCE_ID).find((record) => record.text === "Synthetic message 200")!;
    h.mutate(() => { h.dom.document.querySelector("[data-qa='threads_flexpane']")!.querySelectorAll("[data-qa='virtual-list-item']")[1]!.remove(); });
    await h.clock.advance(200);
    expect(h.db.revisions(middle.id)[1]).toMatchObject({ kind: "thread_reply", deleted: true, fields: { threadTs: "1791822100.000100" } });
  });

  test("DOM churn and helper/storage writes cannot shorten the reader's pause", async () => {
    const h = make(undefined, { hidden: true });
    let ts = 90;
    h.onScroll = () => h.mutate(() => { h.list.insertAdjacentHTML("afterbegin", row(ts--)); });
    await h.start();
    expect(h.scrolls).toHaveLength(1);
    for (let i = 0; i < 18; i++) {
      h.mutate(() => { h.dom.document.body.appendChild(h.dom.document.createElement("span")); });
      await h.clock.advance(100);
    }
    expect(h.storage.slackHourLoads).toBe(1);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(3);
    expect(h.scrolls).toHaveLength(1);
    await h.clock.advance(50);
    expect(h.scrolls.map((step) => step.at - h.scrolls[0]!.at)).toEqual([0, 1850]);
    expect(h.scrolls.map((step) => step.top)).toEqual([800, 600]);
  });

  test("history drawn after the 350ms sample still spends the load budget", async () => {
    const h = make(undefined, { hidden: true, settings: { slackHourBucket: "2026-10-12T17", slackHourLoads: 99 } });
    h.onScroll = () => {
      h.onScroll = null;
      h.clock.setTimeout(() => h.mutate(() => { h.list.insertAdjacentHTML("afterbegin", row(90)); }), 600);
    };
    await h.start(); await h.clock.advance(2500);
    expect(h.storage.slackHourLoads).toBe(100);
    expect(h.db.coverage(SOURCE_ID)).toMatchObject({ complete: false, reason: "hourly load budget reached" });
    expect(h.scrolls.map((scroll) => scroll.top)).toEqual([800, 1000]);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(3);
  });

  test("unchanged overscan rows while moving are not a site failure", async () => {
    const h = make();
    await h.start(); await h.clock.advance(34_050);
    expect(h.scrolls.map((scroll) => scroll.top)).toEqual([800, 600, 400]);
    expect(h.storage.slackBlockedUntil ?? 0).toBe(0);
    await h.clock.advance(10_000);
    expect(h.storage.slackPauseReason).toBe("content stopped loading");
    expect(h.scrolls.filter((scroll) => scroll.top > 0).slice(0, 5).map((scroll) => scroll.top)).toEqual([800, 600, 400, 200, 1000]);
  });

  test("three no-progress steps at the top stop as pushback without spending budget", async () => {
    const h = make(undefined, { hidden: true }); h.top = 0;
    await h.start();
    await h.clock.advance(4050);
    expect(h.storage.slackPauseReason).toBe("content stopped loading");
    expect(h.db.coverage(SOURCE_ID)).toMatchObject({ complete: false, reason: "content stopped loading" });
    expect(h.storage.slackHourLoads).toBe(0);
    const steps = h.scrolls.length;
    await h.clock.advance(120_000);
    expect(h.scrolls).toHaveLength(steps);
  });

  test("a stalled hidden tab waits and resumes when visible and idle", async () => {
    const h = make(undefined, { hidden: true });
    await h.start();
    await h.clock.advance(40_000);
    expect(h.scrolls).toHaveLength(1);
    expect(h.storage.slackBlockedUntil ?? 0).toBe(0);
    Object.defineProperty(h.dom.document, "hidden", { value: false, writable: true });
    h.dom.document.dispatchEvent(new h.dom.window.Event("visibilitychange"));
    await h.clock.advance(0);
    expect(h.scrolls).toHaveLength(2);
  });

  test("mousemove interrupts a job; restore waits for idle and follows a history anchor", async () => {
    const h = make(undefined, { hidden: true });
    await h.start(); await h.clock.advance(350);
    h.height += 600; // History was inserted above the saved row.
    Object.defineProperty(h.dom.document, "hidden", { value: false, writable: true });
    h.input("mousemove");
    await h.clock.advance(0);
    expect(h.top).toBe(800);
    const steps = h.scrolls.length;
    // A stop condition arriving during input must also leave the viewport alone.
    h.mutate(() => { h.dom.document.body.insertAdjacentHTML("afterbegin", '<div data-qa="beginning-banner">This is the very beginning</div>'); });
    await h.clock.advance(29_999);
    expect(h.scrolls).toHaveLength(steps);
    await h.clock.advance(201);
    expect(h.top).toBe(1600);
    expect(h.db.coverage(SOURCE_ID)?.complete).toBe(true);
  });

  test("a person's own scroll supersedes the saved position", async () => {
    const h = make(undefined, { hidden: true });
    await h.start(); await h.clock.advance(350);
    Object.defineProperty(h.dom.document, "hidden", { value: false, writable: true });
    h.input("wheel"); h.top = 450;
    h.mutate(() => { h.dom.document.body.insertAdjacentHTML("afterbegin", '<div data-qa="beginning-banner">This is the very beginning</div>'); });
    await h.clock.advance(31_000);
    expect(h.top).toBe(450);
    expect(h.scrolls).toHaveLength(1);
  });

  test("an input wait restores the anchor on idle even while the job can continue", async () => {
    const h = make(undefined, { hidden: true });
    await h.start(); await h.clock.advance(350);
    h.height += 600;
    Object.defineProperty(h.dom.document, "hidden", { value: false, writable: true });
    h.input("mousemove"); await h.clock.advance(0);
    expect(h.top).toBe(800);
    await h.clock.advance(30_000);
    expect(h.top).toBe(1600);
    expect(h.scrolls).toHaveLength(2);
    expect(h.db.coverage(SOURCE_ID)).toBeNull();
  });

  test("disabling during input still restores the saved anchor once idle", async () => {
    const h = make(undefined, { hidden: true });
    await h.start(); await h.clock.advance(350);
    h.height += 600;
    Object.defineProperty(h.dom.document, "hidden", { value: false, writable: true });
    h.input("mousemove");
    await h.setStorage({ slackEnabled: false }); await h.clock.advance(0);
    expect(h.top).toBe(800);
    await h.clock.advance(30_000);
    expect(h.top).toBe(1600);
    expect(h.scrolls).toHaveLength(2);
  });

  test("script-generated input cannot reset the person's idle timer", async () => {
    const h = make(); await h.start(); await h.clock.advance(30_350);
    h.input("mousemove", false);
    await h.clock.advance(1500);
    expect(h.scrolls.map((scroll) => scroll.top)).toEqual([800, 600]);
  });

  test("restoration falls back to distance from the bottom after the anchor is virtualized away", async () => {
    const h = make(undefined, { hidden: true });
    h.onScroll = () => {
      h.onScroll = null; h.height += 600;
      h.mutate(() => { h.list.innerHTML = row(90) + row(95); });
    };
    await h.start(); await h.clock.advance(350);
    h.mutate(() => { h.dom.document.body.insertAdjacentHTML("afterbegin", '<div data-qa="beginning-banner">This is the very beginning</div>'); });
    await h.clock.advance(200);
    expect(h.top).toBe(1600);
  });

  test("injecting again into an existing tab does not start a second capture job", async () => {
    const h = make(undefined, { hidden: true });
    await h.start(); await h.startContent();
    expect(h.scrolls).toHaveLength(1);
    expect(h.sent.filter((message) => message.type === "records")).toHaveLength(1);
    expect(h.db.getSource(SOURCE_ID)).toHaveLength(2);
  });

  test("scrolling stays inside the list and releases the lock if the list vanishes", async () => {
    const h = make(undefined, { hidden: true });
    h.height = h.visibleHeight;
    let outerTop = 5000;
    Object.defineProperties(h.dom.document.body, {
      scrollHeight: { value: 10_000 }, clientHeight: { value: 1000 },
      scrollTop: { get: () => outerTop, set: (value) => { outerTop = value; } },
    });
    await h.start(); await h.clock.advance(350);
    expect(outerTop).toBe(5000);
    const other = make(undefined, { hidden: true });
    other.onSend = (message) => {
      if (message.type === "scroll-lock" && message.op === "acquire") other.list.remove();
    };
    await other.start();
    other.onSend = null;
    expect(await other.send({ type: "scroll-lock", op: "acquire", site: "slack" }, { tab: { id: 3, incognito: false } })).toEqual({ ok: true });
  });
});
