# M0 and M1 report

afterwhile is a Chrome extension plus one local program. M0 saves Slack channels you open. M1 answers `search`, `recent`, `get`, `sources`, and `coverage` over MCP. The product name lives only in `shared/src/constants.ts`.

## What works

- Unpacked MV3 extension, id `kkfafeljlbmkedmgblfbaefpngdomlah`, pinned with a public key. Host permission for Slack is optional and requested when Slack is turned on. No `<all_urls>`. Incognito is `not_allowed`. The badge shows ON while capture is enabled.
- Popup: current page, today's count, Slack risks, Turn on, DMs and private channels off by default, pause, forget this page, forget Slack, helper connection.
- Slack extraction against synthetic fixtures: public channels, threads, edits, deletes only when both neighbors are on screen, DMs and private channels skipped unless enabled, unknown channel ids treated as private.
- Changed markup returns `capture stopped working` and saves nothing.
- Hands-off pacing: half a screen per step, pauses about 0.5–2.5s with occasional longer ones, hidden tabs scroll immediately, visible tabs wait 30s after real input (not scroll events), load budget 20 per visit and 100 per hour, stall if drawn rows do not change, pushback (CAPTCHA, slow down, something went wrong, sign-in) stops the site for the rest of the local day.
- Helper commands: `afterwhile host`, `afterwhile mcp`, `afterwhile install`, `afterwhile uninstall`. `host` and `mcp` keep stdout for the protocol and log to stderr. The compiled binary starts; with no command and a terminal it prints help, and with a piped stdin and no command it runs the host.
- SQLite WAL, `busy_timeout` 5000, FTS5 checked at startup. Recapture is idempotent. An edit keeps the old revision. Deletes are a new revision and drop out of search.
- Markdown at `~/<name>/<connection>/<source slug>/YYYY-MM-DD.md`, local time zone, slugs without colons.
- MCP tools work with the official TypeScript SDK client. `recent` with `checkpoint: true` returns only new rows on the second call. Coverage says what is missing in plain words and includes the source URL.
- Linux native-host install writes Chrome, Edge, and Chromium manifests and uninstall removes them. macOS and Windows plans (paths and registry keys) are covered by tests, not by running those operating systems.

## Verified here

- `bun test`: 34 tests, synthetic fixtures only.
- Compiled `dist/afterwhile` on Linux starts and prints the four commands.
- FTS5 in Bun's SQLite on this Linux machine.
- MCP transcript from `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` against a database built from synthetic fixtures. Search for "focus states" on 12 October 2026 returns Alex Kim's edited line and cites `https://app.slack.com/client/T024BE7LD/C01ABCD2EFG`. A second `recent` with the same checkpoint is empty.
- Sample day file `docs/samples/2026-10-12.md` from those fixtures.
- Popup screenshots: Chrome for Testing 155 on Xvfb, unpacked `extension/dist` loaded. Branded Google Chrome 154 on this machine ignores `--load-extension`, so it cannot load an unpacked extension from the command line. The service worker target was `chrome-extension://kkfafeljlbmkedmgblfbaefpngdomlah/service-worker.js`. The off state is the real default popup. The partial and CAPTCHA shots are the same popup after `chrome.storage.local.set` inside that extension page, because there is no Slack tab here.

## Not verified

- Real Slack pages. Selectors in `connections/slack/selectors.json` are unverified. See `connections/slack/NOTES.md`.
- macOS or Windows install, including the Windows `.exe` native host and `reg add`.
- Claude Code or Codex actually loading the printed MCP snippets.
- Live capture timing ("visible messages within 2 seconds") on a real channel. The content script sends the current DOM immediately; only backfill scrolling waits.

## Try it on your Mac or Windows machine

1. Install Bun and Chrome. Clone the repo. Run `bun install`, `bun test`, and `bun run build`.
2. On Windows, use the compiled `dist/afterwhile.exe` from that machine. Chrome will not launch a Bun script as a native host there. On macOS, `dist/afterwhile` or `bun run helper/src/index.ts install` both work; a shell launcher is written if you have not compiled.
3. Run `dist/afterwhile install`. It registers the native host for Chrome and Edge and prints MCP snippets.
4. Open `chrome://extensions`, turn on Developer mode, and Load unpacked `extension/dist`.
5. Open the popup, read the Slack risks, click Turn on, and allow `https://app.slack.com/*`. Leave DMs and private channels off unless you want them.
6. Open a public channel at `https://app.slack.com`. Visible messages should show in the popup and in that day's Markdown. Scroll up while idle to backfill until the load budget or the start of the channel. If the popup says "capture stopped working", the live DOM does not match the fixtures and nothing from that broken page is saved.
7. Point Claude Code or Codex at the snippet from `install`, then ask what was said in that channel. The answer should come from search or recent and include the channel URL.

Saved files are not encrypted beyond the disk encryption the operating system already provides. `uninstall` removes the host registration and leaves the database and Markdown in place.

Nothing in this repository is real Slack content. Fixtures and the sample day file are synthetic.
