# afterwhile

afterwhile saves what you read in web apps you turn on, on your own computer, so any AI can search it.

It is a Chrome extension plus one local program. The extension reads pages that are already open. The program stores them in SQLite and as Markdown, and answers an MCP server over stdio. There is no account, no server, and no telemetry.

Nothing here is encrypted beyond what the operating system does for the disk.

This repository includes Slack capture (M0/M1), the Teams transcript connection (M2, awaiting its live work-Mac trial), and MCP tools `search`, `recent`, `get`, `sources`, and `coverage`.

## Layout

- `extension/` Chrome extension (Manifest V3). Load the built folder `extension/dist`.
- `helper/` the `afterwhile` program: `host`, `mcp`, `install`, `uninstall`.
- `shared/` types and the product name.
- `connections/teams/` Teams Recap/Stream transcripts, synthetic fixtures, and explicit live-validation gaps.
- `connections/slack/` the Slack connection, synthetic fixtures, and notes on selectors that are not yet checked against a live Slack page.

The product name is defined once, in `shared/src/constants.ts`.

## Develop

Install [Bun](https://bun.sh), then:

```sh
bun install
bun test
bun run build
```

`bun run build` writes `extension/dist` and a compiled `dist/afterwhile` (`dist/afterwhile.exe` on Windows) for this machine.

Run from source without compiling:

```sh
bun run helper/src/index.ts install
bun run helper/src/index.ts mcp
```

Chrome starts the registered executable with its extension origin and, on Windows, a parent-window argument. The executable enters `host` mode for that invocation. `host` and `mcp` keep protocol bytes on stdout and write logs to stderr and the data directory.

## Where files go

| | macOS | Windows | Linux (dev) |
| --- | --- | --- | --- |
| Database | `~/Library/Application Support/afterwhile/records.db` | `%LOCALAPPDATA%\afterwhile\records.db` | `$XDG_DATA_HOME/afterwhile` or `~/.local/share/afterwhile` |
| Markdown | `~/afterwhile/<connection>/<source>/YYYY-MM-DD.md` | `%USERPROFILE%\afterwhile\...` | `~/afterwhile/...` |

Days use the computer's time zone. Source folders are slugs, so Windows paths do not contain colons.

`install` registers a native messaging host for Chrome, Edge, and Chromium.

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` and the Edge and Chromium folders beside it.
- Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\<host id>` and the Edge and Chromium keys, each pointing at the manifest JSON.
- Linux: `~/.config/google-chrome/NativeMessagingHosts/` and the Edge and Chromium folders.

`uninstall` removes that registration and leaves the database and Markdown where they are.

`install` prints MCP snippets for Claude Code (`.mcp.json`) and Codex (`~/.codex/config.toml`). Those snippets were not run inside Claude Code or Codex on the machine that built this repository.

## Try it with real Slack

On a Mac or Windows machine, with Chrome:

1. Install Bun, clone this repo, and run `bun install`, `bun test`, and `bun run build`.
2. Run `dist/afterwhile install` (or `bun run helper/src/index.ts install` if you have not compiled). On Windows, compile first. Chrome will not launch a Bun script as a native host there.
3. Open `chrome://extensions`, turn on Developer mode, and Load unpacked `extension/dist`.
4. Open the afterwhile popup. Read the Slack risks, click Turn on, and allow `https://app.slack.com/*`.
5. Leave DMs and private channels off unless you want those too.
6. Open a public Slack channel in https://app.slack.com. Visible messages should show up in the popup and in that day's Markdown within a couple of seconds. Automatic backfill starts off, so capture can run without scrolling.
7. If you want older history, turn on **Automatic backfill** in the popup and choose **Past 7 days**, **Past 30 days**, or **All available history**. This applies to opened channels allowed by your capture settings. It waits while you use the tab, reads in batches of 20 history loads, rests for a minute between batches, and pauses at 100 loads an hour. The popup shows the oldest saved date and when it can resume. Per-channel progress survives reloads; if Slack no longer has the older rows loaded, it retraces saved history at the same pace. These steps also spend the load allowance. A channel must remain open for reading to continue. Open threads separately to capture their replies.
8. Point Claude Code or Codex at the snippet `install` printed, then ask what was said in that channel. The reply should come from `search` or `recent` and include the channel URL.

The channel and thread selectors have been tested on one modern Slack layout; other layouts, private/DM icons, edit markers and beginning banners still need validation. See `connections/slack/NOTES.md`. If the popup says "capture stopped working", the live page does not match the fixtures and nothing from that broken page is saved.

The extension does not run in Incognito. It does not request every site at install. It only scrolls a channel you already opened, and only when you are not using that tab.

## Try Teams transcripts

Build/install the helper and load `extension/dist` as above. In the popup, read the Teams risks and turn Teams on; Chrome requests access to Teams web and SharePoint at that point. Open a transcript you can read in a meeting's Recap or Stream. Rendered rows save immediately; reveal scrolling waits for idle or a background tab. Open each part yourself. The Teams section lists observed parts, database-saved lines and exact complete/partial coverage with gaps. Forgetting a Teams part or site turns Teams capture off to prevent immediate recapture; turn it back on when you want to capture again.

Your employer may not allow copying meeting content or giving it to AI tools. Explicit copy blocks, recognized sensitivity labels and unrecognized visible page notices stop capture. Teams defaults off, and pause applies to both connections. Nothing downloads transcripts or calls their APIs.

The implementation needs its first live extension trial, especially part identity, localized time labels and protection markers; read [Teams notes](connections/teams/NOTES.md) before enabling it. Both views must expose an explicit part identity; a missing part identity or changed row markup reports “capture stopped working”. Per-part offsets are authoritative; meeting dates are unknown, so Teams date filters and file dates use first-capture time. Completeness of an opened part does not prove every meeting part was opened.

## Tests

`bun test` type-checks shared, helper, extension and test code, then exercises synthetic Slack and Teams HTML, the real content script and service worker with fake timers, helper ingest, SQLite/Markdown, missing-host and crash replay, and the official MCP SDK client. It also compiles and launches the helper with Chrome's native-host arguments and framed stdio. Tests never contact Slack or write the real browser registry; helper paths and logs use temporary directories.

Checkpoint reads page in database insertion order and advance only to the last returned row. Browser capture timestamps do not control this cursor. Existing databases migrate automatically; legacy time checkpoints replay once to avoid skipping records. Ordinary `recent` reads and search still return newest message times first.
