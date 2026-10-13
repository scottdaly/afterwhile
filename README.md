# afterwhile

afterwhile saves what you read in web apps you turn on, on your own computer, so any AI can search it.

It is a Chrome extension plus one local program. The extension reads pages that are already open. The program stores them in SQLite and as Markdown, and answers an MCP server over stdio. There is no account, no server, and no telemetry.

Nothing here is encrypted beyond what the operating system does for the disk.

This repository is M0 and M1: Slack capture, and MCP tools `search`, `recent`, `get`, `sources`, and `coverage`.

## Layout

- `extension/` Chrome extension (Manifest V3). Load the built folder `extension/dist`.
- `helper/` the `afterwhile` program: `host`, `mcp`, `install`, `uninstall`.
- `shared/` types and the product name.
- `connections/slack/` the Slack connection, synthetic fixtures, and notes on selectors that are not yet checked against a live Slack page.

The product name is defined once, in `shared/src/constants.ts`.

## Develop

Install [Bun](https://bun.sh), then:

```sh
bun install
bun test
bun run build
```

`bun run build` writes `extension/dist` and a compiled `dist/afterwhile` for this machine.

Run from source without compiling:

```sh
bun run helper/src/index.ts install
bun run helper/src/index.ts mcp
```

Chrome starts `afterwhile host` itself after install. `host` and `mcp` keep protocol bytes on stdout and write logs to stderr and the data directory.

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
6. Open a public Slack channel in https://app.slack.com. Visible messages should show up in the popup and in that day's Markdown within a couple of seconds.
7. Point Claude Code or Codex at the snippet `install` printed, then ask what was said in that channel. The reply should come from `search` or `recent` and include the channel URL.

Slack selectors are unverified. See `connections/slack/NOTES.md`. If the popup says "capture stopped working", the live page does not match the fixtures and nothing from that broken page is saved.

The extension does not run in Incognito. It does not request every site at install. It only scrolls a channel you already opened, and only when you are not using that tab.

## Tests

`bun test` uses synthetic Slack HTML. It does not talk to Slack. It covers extraction, a changed-markup failure, edits and deletes, pacing, pushback, dedupe, Markdown, native messaging, install paths for macOS and Windows, and an MCP client from the official TypeScript SDK.
