import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { extractTeams, exactCoverage, documentIdentity, parseSpeakerTime } from "./extract.ts";

import { fixture, page, row, STREAM, FRAME } from "./fixtures/helpers.ts";

test("complete Stream part has exact positions, speaker, offsets and distinct events", async () => {
  const result = await extractTeams(parseHTML(fixture()).document, { url: STREAM });
  expect(result.status).toBe("ok");
  const part = result.parts[0]!;
  expect(part.records.map((r) => r.kind)).toEqual(["transcript-line", "transcript-event", "transcript-line"]);
  expect(part.records[0]?.author?.name).toBe("Avery Finch");
  expect(part.records[2]?.fields.offsetSeconds).toBe(63);
  expect(part.records[2]?.position).toBe(3);
  expect(exactCoverage(part.source.id, part.expected, part.records.map((r) => r.position!))).toMatchObject({ have: 3, expected: 3, complete: true, gaps: [] });
});

test("Recap parent leaves capture to the SharePoint all-frames script", async () => {
  const parent = parseHTML(fixture("recap")).document;
  expect((await extractTeams(parent, { url: "https://teams.cloud.microsoft/v2/" })).status).toBe("waiting");
  const frame = parent.querySelector("iframe")!.getAttribute("src")!;
  const a = await extractTeams(parseHTML(fixture()).document, { url: frame });
  const b = await extractTeams(parseHTML(fixture()).document, { url: STREAM });
  expect(a.parts[0]?.source.id).toBe(b.parts[0]?.source.id);
  expect(a.parts[0]?.records.map((r) => r.id)).toEqual(b.parts[0]?.records.map((r) => r.id));
});

test("two selected parts restart positions and offsets without id collisions", async () => {
  const a = await extractTeams(parseHTML(page(row(1, 1), "one")).document, { url: FRAME });
  const b = await extractTeams(parseHTML(page(row(1, 1), "two")).document, { url: FRAME });
  expect(a.status).toBe("ok"); expect(b.status).toBe("ok");
  expect(a.parts[0]?.source.id).not.toBe(b.parts[0]?.source.id);
  expect(a.parts[0]?.records[0]?.fields.offset).toBe(b.parts[0]?.records[0]?.fields.offset);
});

test("coverage detects the gap from an oversized reveal step", () => {
  expect(exactCoverage("synthetic", 12, [1, 2, 3, 8, 9, 10, 12])).toMatchObject({ have: 7, complete: false, gaps: [[4, 7], [11, 11]] });
  expect(exactCoverage("synthetic", 3, [1, 1, 2, 4])).toMatchObject({ have: 2, complete: false, gaps: [[3, 3]] });
});

test("changed rows, invalid totals and unidentified documents save nothing", async () => {
  for (const html of [fixture("changed-markup"), fixture().replace('aria-setsize="3"', 'aria-setsize="4"'), fixture().replace('aria-posinset="1"', 'aria-posinset="3"'), fixture().replace('entryText-fixture', 'newText'), fixture().replace('Avery Finch, 00:01', 'unknown timestamp')]) {
    const result = await extractTeams(parseHTML(html).document, { url: STREAM });
    expect(result).toMatchObject({ status: "stopped", reason: "capture stopped working", parts: [] });
  }
  expect((await extractTeams(parseHTML(fixture()).document, { url: STREAM.split("?")[0]! })).status).toBe("stopped");
});

test("copy restrictions, labels and pushback stop before reading speech", async () => {
  for (const mark of ['<span data-copy-blocked="true"></span>', '<span data-sensitivity-label="Internal"></span>', '<div role="alert">Copying is disabled</div>', '<div role="alert">Something went wrong</div>']) {
    const result = await extractTeams(parseHTML(fixture().replace("<body>", `<body>${mark}`)).document, { url: STREAM });
    expect(result.status).toBe("blocked"); expect(result.parts).toHaveLength(0);
  }
});

test("identity strips token-like parameters and labels parse hours", () => {
  expect(documentIdentity(`${STREAM}&access_token=never-use&temporaryDownloadUrl=never-use`)?.url).not.toContain("never-use");
  expect(parseSpeakerTime("Robin Vale, 1:02:03")).toEqual({ name: "Robin Vale", offset: "1:02:03", seconds: 3723 });
  expect(parseSpeakerTime("Robin Vale, 00:99")).toBeNull();
});

test("hidden roots, retained rows and hidden descendants are excluded", async () => {
  for (const marker of ['hidden', 'style="display:none"', 'style="visibility:hidden"', 'aria-hidden="true"']) {
    const d = parseHTML(fixture().replace('id="OneTranscript"', `id="OneTranscript" ${marker}`)).document;
    expect((await extractTeams(d, { url: STREAM })).parts).toHaveLength(0);
  }
  const d = parseHTML(fixture().replace('The paper kite is ready.', 'The paper kite<span hidden>Hidden retained words.</span> is ready.')).document;
  const result = await extractTeams(d, { url: STREAM });
  expect(result.parts[0]?.records[0]?.text).toBe('The paper kite is ready.');
  d.querySelector('[aria-posinset="2"]')!.setAttribute('hidden', '');
  const visible = (await extractTeams(d, { url: STREAM })).parts[0]!;
  expect(visible.records).toHaveLength(2);
  expect(exactCoverage(visible.source.id, 3, visible.records.map((r) => r.position!)).gaps).toEqual([[2, 2]]);
});

test("unrecognized visible notices fail closed, hidden warnings do not block", async () => {
  for (const notice of ["Your organization doesn’t allow copying this content", "Unfamiliar localized warning"]) {
    const d = parseHTML(fixture().replace('<body>', `<body><div role="alert">${notice}</div>`)).document;
    expect((await extractTeams(d, { url: STREAM })).status).toBe("blocked");
  }
  const d = parseHTML(fixture().replace('<body>', '<body><div hidden role="alert">Inactive warning</div>')).document;
  expect((await extractTeams(d, { url: STREAM })).status).toBe("ok");
});

test("part switch during async hashing cannot mix text and identity", async () => {
  const d = parseHTML(page(row(1, 1), "one")).document;
  const pending = extractTeams(d, { url: STREAM });
  d.querySelector("option")!.setAttribute("value", "two");
  d.querySelector("[class*='entryText-']")!.textContent = "Synthetic second part.";
  const snapshot = (await pending).parts[0]!;
  const after = (await extractTeams(d, { url: STREAM })).parts[0]!;
  expect(snapshot.part).toBe("one"); expect(snapshot.records[0]?.text).toBe("Invented ribbon line 1.");
  expect(after.part).toBe("two"); expect(after.records[0]?.text).toBe("Synthetic second part.");
  expect(snapshot.source.id).not.toBe(after.source.id);
});

test("source links round-trip the same part; missing Stream part fails closed", async () => {
  for (const url of [STREAM, FRAME]) {
    const a = (await extractTeams(parseHTML(fixture()).document, { url })).parts[0]!;
    const b = (await extractTeams(parseHTML(fixture()).document, { url: a.source.url })).parts[0]!;
    expect(a.source.id).toBe(b.source.id);
    expect(a.source.url).toContain("docid=");
    expect(a.source.url).toContain("transcriptId=part-one");
  }
  const noPart = new URL(STREAM); noPart.searchParams.delete("transcriptId");
  expect((await extractTeams(parseHTML(fixture()).document, { url: noPart.href })).status).toBe("stopped");
});

test("a copy notice inside the transcript root outside speech still blocks", async () => {
  const d = parseHTML(fixture().replace('<div id="OneTranscript">', '<div id="OneTranscript"><div role="alert">Copying is restricted.</div>')).document;
  expect((await extractTeams(d, { url: STREAM })).status).toBe("blocked");
  expect((await extractTeams(d, { url: STREAM })).parts).toHaveLength(0);
  const speech = parseHTML(fixture().replace('The paper kite is ready.', '<span role="alert">The paper kite is ready.</span>')).document;
  expect((await extractTeams(speech, { url: STREAM })).status).toBe("ok");
});
