# The companion: save what you read in your web apps, for your AI

**Proposal · 12 October 2026 · Everyday Studio · working name "the companion" (naming is open)**

An open-source Chrome extension and small local helper. As you (or your AI) use Slack, Teams, Amazon and other web apps, it saves what's on the page as clean, searchable records on your own computer, and lets any AI search them over MCP. Community-maintained **connections** teach it each site. It's separate from Midlight, works with any AI, and Midlight is its best client.

## Why

People want their AI to know their working life and their own history, but the official doors are often shut:

- Your employer doesn't allow the Slack MCP or API.
- Only a Teams meeting's organizer can download the transcript, so you message people asking for it.
- Amazon removed its order-history export in 2020.
- Official connectors have quotas (Figma's MCP reportedly allows as few as six read calls a month on some seats).

Today the choices are bad: have an agent click through the site every time (slow, token-hungry, a little different each run), or do it by hand (saving pages as PDFs). Meanwhile everyone who solves this writes their own private scraper, and each one breaks alone when the site changes.

The companion makes the solved version shared: one open library of connections, fixed in public when sites change, feeding a local store any AI can read.

## What it is, and isn't

**It is:**
- **Hands-off.** It reads pages as they render in your browser and, when a page is only partly loaded, scrolls it to finish the job, paced like a patient reader (see [Hands-off capture and pacing](#hands-off-capture-and-pacing)). Nobody has to scroll a whole transcript for it. It never navigates to new pages, clicks things, or makes requests a page wouldn't make for a person scrolling it.
- **Local.** Records live on your computer. No account, no server, no telemetry by default.
- **Open.** The extension, helper and every connection are open source. Fixes arrive as pull requests, often written by people's agents.
- **For any AI.** It exposes a local MCP server and plain files. Midlight, Claude, ChatGPT, Codex or a script can all use it.

**It isn't:**
- **A crawler.** It finishes pages that are open; it doesn't go looking for new ones. Opening pages you haven't opened is the AI's job, using its own browser tools (or Midlight on a schedule). When an agent opens a Slack channel or your order history, the companion captures it like any other page. That keeps the companion simple, low-risk for bot detection, and easy to explain to the Chrome Web Store.
- **A way around restrictions.** It saves what's rendered for you to read. It never replays tokens to fetch files, never recreates a download someone turned off, and never reads hidden page state.
- **Part of Midlight.** Separate brand and listing, so Midlight's own extension keeps its narrow purpose ("lets Midlight use Chrome when you ask"), and scraping risk stays off Midlight's reputation.

## How it works

```
 Chrome                                          Your computer
┌──────────────────────────────┐   native     ┌──────────────────────────────┐
│ Extension                    │  messaging   │ Local helper                 │
│  • connections (per site)    │ ───────────▶ │  • dedupe, edits, checkpoints│
│  • watch rendered pages      │              │  • SQLite + Markdown files   │
│  • popup: what's captured,   │              │  • search index              │
│    pause, per-site on/off    │              │  • MCP server (stdio)        │
└──────────────────────────────┘              └──────────────┬───────────────┘
        ▲ selector updates (signed data)                     │ MCP / files
        │                                                    ▼
┌──────────────────────────────┐              ┌──────────────────────────────┐
│ Open-source repo             │              │ Any AI: Midlight, Claude,    │
│  connections, fixtures, PRs  │              │ ChatGPT, Codex, scripts      │
└──────────────────────────────┘              └──────────────────────────────┘
```

### The extension (Chrome, Manifest V3)

- Content scripts only on the sites of connections you turned on. Host permissions are **optional and requested per connection**, so installing it grants nothing until you enable, say, Slack.
- A connection watches the page as it renders (MutationObserver plus the site's own scrolling) and turns what's visible into records: a Slack message, a Teams transcript line, an Amazon order.
- The popup shows what's being captured on the current page, a count for today, and pause and per-site switches. A small badge shows when capture is on.
- Sensible defaults: DMs and private channels off until you turn them on; nothing captured in Incognito; one click to forget a page or a site.

### The local helper

A small native app (one binary per platform), installed by a one-line command or by Midlight. It:

- receives records over Chrome native messaging,
- dedupes them by source id, and keeps edits and deletions as new versions rather than silently overwriting,
- keeps everything in one local SQLite database with a search index, and writes a Markdown file per source per day you can read and grep (layout in the [build brief](#decisions-already-made)),
- keeps a checkpoint per AI client ("seen up to here"), so AIs can ask what's new,
- serves MCP to AI clients over stdio.

The extension alone would also work, storing to IndexedDB, but MCP needs a local process anyway, and files outside the browser are what make this useful to every AI.

### MCP tools

| Tool | What it does |
| --- | --- |
| `search` | Full-text search across captured records, with links back to the original page |
| `recent` | What's new in a channel, meeting or source since a time or this client's checkpoint |
| `get` | One thread, transcript or order, in order |
| `sources` | What's been captured, from where, and how complete it is |
| `coverage` | What the companion has and hasn't seen, so an AI knows to open a page to fill a gap |

Exact inputs and outputs are in the [build brief](#mcp-tools-1).

### Records

Every record has the same envelope, whatever the site:

- **content:** the fields the connection defines (author, text, time for Slack; speaker, time, text for Teams; items, totals, dates for Amazon),
- **provenance:** site, page URL, source id, when captured, connection version,
- **coverage:** for sources with a known extent (a transcript's 252 lines, a year of orders), whether it's complete and where the gaps are,
- **checkpoint:** enough to say "new since last time".

Coverage is the part most scrapers skip. A connection that quietly saves half a transcript is worse than one that fails, so connections declare how to tell they got everything (Teams numbers every transcript line; Amazon shows an order count per year) and the helper marks sources complete or partial.

### Hands-off capture and pacing

The companion should get complete captures without anyone scrolling for it, while behaving like a careful person reading the page. Two kinds of scrolling are different and treated differently:

- **Reveal scrolling:** the content is already loaded and the page only draws what's on screen (a Teams transcript draws about 44 lines at a time). Scrolling makes few or no requests. Allowed within the pacing below.
- **Load scrolling:** scrolling makes the site fetch more (scrolling up in Slack loads older messages). Every load counts against a budget.

**When it scrolls**
- Only in tabs that are already open, only inside the connection's own container (the transcript panel, the message list), and only to finish the current source.
- Never while the person is using that tab. If they've used the wheel, keyboard, mouse or touch there in the last 30 seconds, it waits. Count only real input events: the companion's own scrolling fires `scroll` events too, so `scroll` can't be the signal. A tab the person isn't looking at (another tab is active, or the window is minimized) can go straight away; that covers tabs an AI agent opened, without needing to know who opened them. When done, it puts the scroll position back.
- Background tabs: Chrome throttles timers there (to about once a second, and after five hidden minutes to about once a minute), and virtualized lists may not draw. So in a hidden tab, pacing is whatever Chrome allows, which is slower than a reader, and that's fine. After every step, check that the drawn rows actually changed; never trust the scroll position alone (background Chromium can move `scrollTop` without firing the events that make lists re-render). If drawing stalls, stop and resume when the tab is visible and idle.

**Pacing like a patient reader**
- Steps of at most half the visible height, so every row is seen at least once (bigger steps skip rows in virtualized lists).
- Pauses that vary the way a reader's do, roughly 0.5 to 2.5 seconds, with an occasional longer one.
- Load scrolling has a budget per site. The extension can't see the network, so a "load" is a scroll step after which new older items appeared in the page. The budget is set in each connection's `connection.json`, with conservative defaults (for Slack, something like 20 history loads per channel visit and 100 an hour overall). Past the budget, coverage stays partial and the popup says so.
- One scrolling job per site at a time, across all tabs.
- **Stop when the site pushes back**: a CAPTCHA, a "slow down" or "something went wrong" message, a sign-in prompt, or content that stops loading. Pause that site for the rest of the day, keep what was captured, and show why in the popup.

**Never disguise it.** No changing the browser's fingerprint, user agent or automation flags, and no faking mouse or keyboard input: scroll the container directly. The goal is to be a well-behaved reader in the person's real browser, within what the site tolerates, not to look like something it isn't.

## Connections

A connection is a folder in the open-source repo:

```
connections/slack/
  connection.json     sites, permissions, fields, risks, version
  extract.ts          the extraction code (bundled into the extension)
  selectors.json      selectors and field mappings (can update without a release)
  fixtures/           saved synthetic pages for tests; never real data
  NOTES.md            for people and agents: how the site works, what breaks, how to fix it
```

### Three ways connection updates reach people

| Lane | What it carries | How it ships | Store implications |
| --- | --- | --- | --- |
| **Built in** | `extract.ts`: the code | A new extension release | None: all code is in the package and reviewed |
| **Selector data** | `selectors.json`: selectors and field mappings only | Fetched from the repo's releases, signed, applied after a self-test against fixtures, with automatic rollback if capture breaks | Fine as long as it stays plain data. Google treats complex instructions disguised as data as remote code, so this format never grows steps, conditions or expressions |
| **User scripts** | Experimental and community connections, as full code | Installed by the person, Tampermonkey-style, through Chrome's User Scripts API | Allowed: it's one of two documented routes for code not in the package. The person must turn on **Allow User Scripts** on the extension's details page (Chrome 138+) |

Most breakage is a moved selector, so the data lane handles most fixes within hours, without a Store review and without anyone running a stranger's code. Experimental connections start as user scripts and graduate into the built-in set once they've proven themselves.

### The repair loop

1. **Notice.** A connection's self-check fails on a real page (expected elements are missing, coverage won't close), and the popup says so: "Slack capture stopped working on this page."
2. **Fix locally.** The person, or their agent, writes a local override. Agents get `NOTES.md`, the fixtures and the page's structure. The override applies immediately on that computer.
3. **Share.** The agent proposes the change upstream as a pull request, with a new synthetic fixture reproducing the change. Never real content, never sign-in details: the PR template and a checker enforce it.
4. **Release.** Maintainers merge; selector fixes go out through the data lane, code fixes in the next release.

### Risk, stated up front

Each connection lists its risks in plain words, shown when you turn it on:

- what the site's terms say about automated access, as far as anyone knows,
- what your employer might think about copying work content (for work apps),
- that captured content is sensitive and lives on this computer.

Then it's your call. The companion doesn't refuse risks people take on for themselves. It does enforce the things that protect other people: no bypassing restrictions others set, no sending data anywhere but the local helper, and no running community code unless you chose to install it.

## Chrome Web Store

- **Single purpose:** "Saves what you read in web apps you choose to your computer, so your AI tools can search it." No "scraper" language.
- **Permissions:** `storage`, `nativeMessaging`, `scripting` (to register a connection's content scripts once you turn it on), `idle`, optional host permissions per connection, `userScripts` (optional, for the experimental lane). No `debugger`, no `<all_urls>` at install.
- **Remote code:** "No" for the core: selector data isn't logic. The user-scripts lane uses the documented API.
- **Data disclosure:** personal communications, web history and whatever the enabled sites show, handled locally and never sold or transferred. Same honest approach as Midlight's listing.
- **Precedent:** [Amazon Order History Reporter](https://chromewebstore.google.com/detail/mgkilgclilajckgnedgjgnfdokkgnibi), open source ([philipmulcahy/azad](https://github.com/philipmulcahy/azad)), about 50,000 users, does site-specific extraction in the Store today.
- **Publisher:** Everyday Studio LLC, the same trader account planned for Midlight's listing. Start Unlisted, as with Midlight.
- **Managed computers:** corporate Chrome policy can block any extension. That's the employer's call; the docs say so plainly.

## How Midlight uses it

> **Context only; not built in this repo.** [Midlight](https://midlight.ai) is Everyday Studio's desktop app for working with AI agents; it can drive Chrome for its agents. This section explains how it will use the companion, so the companion's MCP and files should suit it. Build nothing Midlight-specific here.


- Settings detects the companion and offers to install the helper and add its MCP server as a connector.
- When an agent needs your Slack history, it searches the companion first; for gaps that `coverage` reports, it opens the channel in Midlight Chrome, and the companion captures it.
- Scheduled jobs ("every evening, pick up new Teams transcripts") are Midlight's: it opens the pages, the companion captures them, and an agent summarizes from the files.
- Midlight's earlier Recipes design is retired in favour of this. Its Teams Recap selectors and lessons are written out in the [build brief](#teams-transcripts-what-is-already-known).

## First connections

1. **Slack** (web and the installable web app). Scott has a working extractor (a private Chrome extension); if it's provided, start from it, otherwise start from the hints in the build brief. Channels, threads, DMs (off by default), edits and deletions.
2. **Teams meeting transcripts** from Recap and Stream. The selectors are known; see the [build brief](#teams-transcripts-what-is-already-known). Coverage via each line's position and total. Captures only what's rendered for a viewer; never the download route.
3. **Amazon orders**, in collaboration with or inspired by azad (check its license first).

People who use the Slack or Teams desktop apps can install the web version as a Chrome app: its own window and dock icon, and the companion can see it. Onboarding offers this in one click.

## Milestones

| | Outcome | Proves |
| --- | --- | --- |
| **M0** | Extension + helper skeleton; Slack captures channels you open into files | Hands-off capture works, paced, and stops when the site pushes back |
| **M1** | MCP server with search, recent and coverage; Midlight connects to it | Any AI can use it; Midlight's agent answers "what happened in #channel" from it |
| **M2** | Teams transcripts with complete-or-partial coverage | Coverage on a virtualized list, on the work Mac |
| **M3** | Selector data lane plus one full repair loop: break a fixture, an agent fixes it locally, sends a PR, a second computer picks it up | The crowdsourced-repair idea is real |
| **M4** | Unlisted Chrome Web Store submission | Approval |
| **M5** | User-scripts lane for experimental connections; Amazon orders | Community connections without releases |

## Open questions

- **Name and brand.** Under Everyday Studio, separate from Midlight. Something about gleaning or keeping, not scraping.
- **License.** MIT or Apache-2.0 for the code; connections under the same license so fixes flow freely.
- **Helper install.** The build brief picks a Bun-compiled TypeScript binary per platform; still open is how people install it (Midlight, a one-line command, a small installer) and how the extension guides people who haven't.
- **Who maintains connections.** Early on, Scott and his agents; later, a CODEOWNERS file per connection.
- **Retention.** Default to keeping everything, or offer per-source limits from the start? Work content argues for limits.
- **Other browsers.** Edge works almost for free (Chromium, with its own add-ons store); Firefox and Safari later.
- **Desktop apps.** Reading the Slack or Teams desktop apps through accessibility APIs stays out of scope; the installable web app covers most people.

---

# Build brief

For the agent building this. Everything above is the why and the what; this is the how. **Build M0 and M1 only, then stop and show the result** (screenshots of the popup, a sample Markdown file, an MCP search answered by a real AI client). Don't start later milestones unasked.

## Decisions already made

- **TypeScript everywhere.** The extension is MV3 TypeScript. The helper is TypeScript compiled to one executable per platform with `bun build --compile`, using `bun:sqlite` and the official MCP TypeScript SDK. Shared types (records, connection manifests) live in one package both import.
- **macOS and Windows from the start**, Chrome first. Edge needs its own native-host registration (its own manifest folder and registry key) and has a different extension id from its add-ons store; `install` should register both browsers. Linux is nice to have.
- **Extension id:** pin a `key` in the unpacked manifest so the id, and the host's `allowed_origins`, stay stable across machines. The Store copy gets its own id; `allowed_origins` lists both.
- **Signing:** unsigned executables hit Gatekeeper on macOS and SmartScreen/Defender on Windows. Local development can skip it; anything handed to someone else must be signed.
- **Storage:** one SQLite database in WAL mode with FTS5 for search, plus Markdown renderings per source for people and `grep`.
  - Database: macOS `~/Library/Application Support/<Name>/`, Windows `%LOCALAPPDATA%\<Name>\`.
  - Readable files: `~/<Name>/<connection>/<source slug>/YYYY-MM-DD.md` on both (the home folder, not Documents: on macOS, Documents is privacy-protected and would prompt "Chrome wants to access Documents", and on Windows OneDrive often syncs Documents to the cloud). Slug source ids for file names; colons aren't allowed on Windows. Days are in the computer's local time zone.
  - No encryption beyond the OS's disk encryption in v1; the README says so.
  - Check that `bun:sqlite` has FTS5 on every platform (on macOS it may use the system SQLite); bundle SQLite if not. Every process sets a `busy_timeout`.
- **Repo layout:** `extension/`, `helper/`, `shared/`, `connections/<site>/`, `docs/`. Tests run locally (`bun test`) against fixtures. MIT license unless Scott says otherwise.
- **Placeholder name:** use `companion` for binaries and ids until the real name is chosen; keep it in one constants file.

## Process model

One executable, three commands. Getting this right matters: Chrome starts native messaging hosts itself, and AI clients start their MCP servers themselves, so one long-running "helper" process can't serve both.

| Command | Started by | Does |
| --- | --- | --- |
| `companion host` | Chrome, when the extension calls `chrome.runtime.connectNative` | Validates and writes records, updates coverage, renders Markdown. The extension keeps one port open from its service worker, which also keeps the worker alive. |
| `companion mcp` | Each AI client (Claude Code, Codex, Midlight), over stdio | Reads the database and answers MCP tools. Writes only its own read checkpoints. |
| `companion install` | The person, once | Registers the native messaging host (macOS: JSON manifest in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`; Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\<host id>` pointing at the manifest), with `allowed_origins` set to the extension's id(s). Prints MCP config snippets for common clients. `companion uninstall` reverses it. |

Several `mcp` processes and one `host` can run at once. Only `host` writes records; `mcp` writes only checkpoints. SQLite WAL handles that with a `busy_timeout`. Both protocols run over stdout, so nothing else may ever print there: logs go to a file or stderr. Native messages from the host to the extension are capped at 1 MB, so keep replies small and send records from the extension in small batches.

## Record schema

```json
{
  "id": "slack:T024BE7LD:C01ABCD2EFG:1728750000.000100",
  "connection": "slack",
  "connectionVersion": "0.1.0",
  "kind": "message",
  "source": {
    "id": "slack:T024BE7LD:C01ABCD2EFG",
    "title": "#design-foundations",
    "url": "https://app.slack.com/client/T024BE7LD/C01ABCD2EFG"
  },
  "position": null,
  "occurredAt": "2026-10-12T16:20:00Z",
  "capturedAt": "2026-10-12T16:31:12Z",
  "author": { "name": "Alex Kim", "id": "U02XYZ" },
  "text": "We should revisit the Input focus states before Friday.",
  "fields": { "threadTs": null, "replyCount": 3, "edited": false },
  "revision": 1,
  "deleted": false
}
```

- `id` is stable and built from the site's own ids, so recapturing is idempotent. Changed text writes a new `revision`; the old one is kept.
- `position` is the record's place in an ordered source when the site provides one (Teams transcript lines are numbered); otherwise `null`.
- `fields` holds connection-specific extras, declared in `connection.json`.
- Mark `deleted` only when both of its neighbours (the records just before and after it in the source, by position or time) are visible on screen at the same moment and it isn't between them. Never because it simply wasn't seen.

Coverage, one row per source:

```json
{
  "sourceId": "teams:meeting:<id>:part:1",
  "expected": 252,
  "have": 240,
  "gaps": [[118, 129]],
  "complete": false,
  "reason": "load budget reached",
  "updatedAt": "2026-10-12T16:31:12Z"
}
```

`expected` is `null` when the site gives no total (most Slack channels). Then `complete` means the capture reached the start of the channel (Slack shows its "This is the very beginning" banner) or the oldest point the connection is set to go back to (default: 30 days). Back-fill stops there.

## MCP tools

| Tool | Input | Output |
| --- | --- | --- |
| `search` | `query`, optional `connection`, `sourceId`, `since`, `until`, `limit` (default 20) | Matching records (id, source title and URL, author, time, text snippet), newest first |
| `recent` | `sourceId` or `connection`, `since` (time) or `checkpoint: true`, optional `client` | Records since then. With `checkpoint: true`, records new since this client last asked, then advance that client's checkpoint. The client is the `client` argument if given, otherwise the MCP `clientInfo.name`; two sessions of one app share a checkpoint unless they pass different names |
| `get` | `sourceId`, optional `from`/`to` position or time | The whole source in order: a transcript, a thread, an order |
| `sources` | optional `connection` | Each source with title, URL, record count, last captured, coverage summary |
| `coverage` | `sourceId` | The coverage row, plus a plain-words hint ("open this meeting's transcript to finish lines 118–129") |

Keep outputs compact text an AI can read directly; include the source URL with every record so answers can cite it.

## Connection manifest

```json
{
  "id": "teams-transcript",
  "version": "0.1.0",
  "title": "Teams meeting transcripts",
  "sites": [
    { "match": "https://teams.cloud.microsoft/*" },
    { "match": "https://*.sharepoint.com/*", "frames": true }
  ],
  "kinds": ["transcript-line", "transcript-event"],
  "pace": { "reveal": true, "loadBudget": null },
  "defaults": { "enabled": false },
  "risks": [
    "Your organization may not allow copying meeting transcripts or giving them to AI tools.",
    "Captured transcripts are stored on this computer."
  ]
}
```

## Teams transcripts: what is already known

From a 6 October 2026 probe on a corporate Mac, as a regular attendee whose download was disabled. Third-party scrapers use the same selectors. Verified on one tenant only.

- **Where:** the meeting's Recap tab in Teams web (`https://teams.cloud.microsoft`) embeds the transcript in iframe `#xplatIframe`, served from the organizer's SharePoint (`https://<tenant>-my.sharepoint.com/personal/<organizer>/_layouts/15/xplatplugins.aspx`). The content script must run in that frame (`all_frames`, SharePoint host permission). The Stream player page (`stream.aspx`, top-level) shows the same component.
- **Structure:** root `#OneTranscript`; scroll container `#scrollToTargetTargetedFocusZone`; lines `[id^="sub-entry-"][role="listitem"]` with `aria-posinset` (position) and `aria-setsize` (total), and stable ids. Speech text `[class*="entryText-"]`, events (joins, leaves, recording started) `[class*="eventText-"]`. Speaker and time are in the enclosing `[id^="entry-"][role="group"]`'s `aria-label`.
- **Virtualized:** about 44 lines exist in the page at once. Use reveal scrolling in steps of at most half the container's height; bigger steps skip lines. Coverage is exact: positions 1..`aria-setsize` with no gaps means complete.
- **Several parts:** one meeting can have several transcript parts (say, a transcribe-only part and a recording part), and positions and timestamps restart in each. Treat each part as its own source; the Stream page showed only the recording part.
- **Speed:** a complete 30-minute part took about 20 seconds in the probe (60/60 and 252/252 lines, Recap and Stream matching exactly).
- **Never:** fetch the transcript file, use `temporaryDownloadUrl` or Graph/SharePoint APIs, or reuse the page's tokens. When download is disabled, reading what's displayed is the only route. Untested: unfocused tabs, other tenants, sensitivity-labelled meetings.

## Slack: starting hints (unverified)

- The web client lives at `https://app.slack.com/client/<team id>/<channel id>`; the installable web app is the same page.
- The message list is virtualized; scrolling up loads older history (load scrolling, budgeted).
- Look for Slack's `data-qa` attributes and per-message timestamp ids; team id, channel id and the message timestamp make a stable record id. Verify everything on a real page; none of this has been checked here.
- Threads open in a side pane; capture them when open, with `threadTs` linking replies to their parent.
- Off by default: DMs and private channels, until the person turns them on in the popup. Channel ids starting with `D` are DMs; group DMs and private channels need a check on the page (Slack shows a lock icon for private channels). Verify on a real page; when unsure, treat it as private.

## Done criteria

**M0, Slack capture into files**
- Load the unpacked extension, run `companion install`, turn on Slack in the popup (it asks for the Slack site permission then).
- Open a channel: visible messages are in the database and the day's Markdown file within 2 seconds. Scrolling up yourself captures more; reloading creates no duplicates; an edited message gets a new revision.
- Hands-off: leave a channel open and idle, and the companion back-fills history within its load budget, then stops and reports partial coverage in the popup. Pacing and stop-on-pushback are covered by fixture tests.
- Works on macOS and Windows; `companion uninstall` leaves nothing registered.
- Fixture tests: synthetic Slack pages, including a changed-markup case where the connection reports "capture stopped working" instead of saving garbage.

**M1, any AI can use it**
- `companion mcp` works with Claude Code and Codex from the printed config snippets.
- An AI asked "what was discussed in #<channel> yesterday?" answers from `search`/`recent` and cites message URLs.
- `recent` with checkpoints returns only new messages on the second call; `coverage` explains gaps in plain words.

## Out of scope until asked

The selector data lane and signing, user scripts, the repair-loop tooling, Store submission, Amazon, Teams (M2), anything Midlight-specific, and desktop-app capture.

## How to work

- Never commit real captured content. Fixtures are synthetic. When testing on real pages, print counts and ids, not message text.
- Keep each connection's site-specific code in its own folder so fixing a site never touches the core.
- Write down what you learn about each site in its `NOTES.md` as you go; that's the start of the shared knowledge this project is for.
