# Afterwhile Mac trial

Date: October 13, 2026. Final automated checks at 10:00 PDT; observation limits are recorded below.
No Slack message content, author names, or channel names are included.

## Environment and preflight

- macOS 26.4.1 (25E253), arm64.
- Google Chrome 155.0.8059.40, installed in `/Applications`.
- Bun 1.4.3 installed for this user at `~/.bun/bin/bun`; installer added it to `~/.zshrc`.
- Repo: https://github.com/scottdaly/afterwhile, `main` at `c79bb8b4d7770ca1389e32466241b966a29052ea`, cloned into `~/code/afterwhile`.
- Read `docs/PROPOSAL.md` and README's "Try it with real Slack" before preflight/build. Clone copies matched the documents read.
- Chrome policy screenshots supplied by the user show `ExtensionInstallBlocklist` as Platform / Machine / Mandatory / OK. Full managed preferences contain 113 entries (44 distinct); no `*` and no Afterwhile ID `kkfafeljlbmkedmgblfbaefpngdomlah`. This is an explicit-ID blocklist and does not block Afterwhile.
- `ExtensionInstallAllowlist`, `ExtensionDeveloperModeSettings`, `DeveloperToolsAvailability`, `NativeMessagingBlocklist`, `NativeMessagingAllowlist`, and `NativeMessagingUserLevelHosts`: not listed in the supplied policy screenshots and absent from the machine's Chrome managed preferences. No blocker found among the seven requested policies.
- Policy interpretation checked against Chromium's [ExtensionInstallBlocklist definition](https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Extensions/ExtensionInstallBlocklist.yaml).

## Build and helper installation

| Step | Result | Timing / detail |
| --- | --- | --- |
| `bun install` | Pass | 122 packages; 1.487 seconds reported by Bun |
| `bun test` | Pass | 83 pass, 0 fail; 368 assertions across 8 files; 6.70 seconds |
| First `bun run build` | Fail, resolved | Invoking Bun by absolute path did not put Bun on subprocess PATH; script exited 127 |
| `bun run build` with Bun on PATH | Pass | Three extension bundles and compiled macOS helper; compile reported 188 ms |
| `dist/afterwhile install` | Pass | Compiled executable ran; no macOS unsigned-binary block observed; source fallback unnecessary |
| Native host manifest | Pass | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.everydaystudio.afterwhile.json`; executable path exists; stdio host; correct pinned extension origin |

Installer also registered Edge and Chromium, as documented. MCP configuration printed `~/code/afterwhile/dist/afterwhile` with argument `mcp`.
Before loading the extension, no real `records.db` existed.

## Extension and live Slack checks

Extension loaded and public Slack channel opened (user screenshot, 08:01 PDT). The popup still showed "Turn on" and 0 saved: capture had not yet been enabled. A read-only database check found 0 logical records / 0 revision rows and 0 day files. This is expected while capture is off; selector behavior is not yet tested. User instructed to read risks, enable Slack, grant the site permission, and reload. DMs/private channels remain unchecked in the screenshot.

After enabling Slack, the popup showed "capture stopped working" and 0 saved. The visible URL has an `E…` organization scope, which the original `T…`-only parser rejected. Repair branch: `fix/mac-slack-trial`. DOM structure-only probes supplied to the user; verified findings follow. The initially active Midlight Chrome tools did not expose JavaScript evaluation, so the first probe was run manually in DevTools. Later, the approved OpenAI Chrome client provided direct structure-only evaluation through Node REPL.

At 08:08 PDT, user reported the same error after reloading extension and Slack. Verified the built content script contains the organization-scope parser fix. SQLite still has 0 logical records, 0 revision rows, and 0 coverage rows; today's Markdown files: 0, bytes: 0. The URL repair is insufficient for the live page. DOM structure output is required to identify the remaining mismatch; no selector guesses applied.

First live probe: expected message list 0, message rows 98 globally, rich-text blocks 5, timestamps 3, authors 3, channel name 0, channel header 0, thread pane 0, beginning banner 0. The global row count includes sidebar rows and must not be treated as a message count. The first probe returned arbitrary `data-qa` attributes, some containing sidebar names, and Chrome truncated its long string before useful ancestry data. This was a diagnostic privacy/usability defect. Replaced the probe with a compact clipboard report focused on timestamp ancestors and header nodes, omitting text and arbitrary attribute values and allowing only fixed structural `data-qa` values. No returned sidebar names copied into this report or fixtures.

| Check | Result |
| --- | --- |
| Visible capture timing, SQLite count, day-file size | Capture works: test channel 5 messages initially, then 31; timing from page rendering not measured. Today's test-channel file exists, 495 bytes. |
| Reload without duplicates | Pass at 08:41 PDT: popup 42 saved across 3 sources; SQLite still 42 logical records / 42 revision rows, with test channel unchanged at 31 / 31. No added duplicate or edit revisions. |
| Edit creates revision without another logical record | Pass for identity/revision behavior: after the user edited, test-channel logical records stayed 37, revision rows rose from 37 to 39, and one existing message gained revisions 2 and 3. Both changed text; no new logical record or deletion. Two changed versions arrived 489 ms apart; the user confirmed saving more than once. The unverified edited flag is noted below. |
| Hidden-tab backfill, pace, and coverage | Incremental capture observed: test channel grew from 5 to 31 while user was working in extension/Console tabs. Recent batches 1–2 messages; sampled intervals roughly 1.1–2.5 seconds with longer pauses. User reported scrolling felt okay, without unexpected movement; exact tab-idle state was not independently observed. |
| Visit/hour budgets and channel-start stopping | Test channel reported `load budget reached` with 31 saved, expected unknown, complete false at 08:36:01 PDT. Visit budget is 20 loads. Hourly cap and channel-start stopping still untested live. |
| Return to tab without view movement | After reload, visible-tab scrollTop stayed at 5,816 for 5 seconds; content height 10,762 and viewport height 662 were unchanged. User reported no unexpected view movement while using Slack. |
| Thread replies captured; close causes no deletion | Pass: 5 replies saved, one parent link, parent remains revision 1. Agent closed the pane through its rendered Close control. After a subsequent capture pass, all five replies kept their exact revisions, with 0 missing/deleted replies. The test channel held 37 logical records / 37 revision rows (one additional channel message had been captured). |
| Popup capture-stopped errors | Initial "capture stopped working" repaired. Lifecycle repair active; connected browser log check found 0 new `Extension context invalidated` entries. Chrome's historical extension errors may remain until cleared. User reported no new popup errors after the final reload. |

Configured limits: 20 history loads per channel visit, 100 per hour, 30-day backfill boundary. Configured scrolling is at most half the viewport per step, with varying pauses, and waits for 30 seconds of no real input on a visible tab. These are code/document settings, not yet live observations.

## Selector changes

Live structure verified the list wrapper, scrolling descendant, header, title, and positive public-channel icon. Selector repair retains synthetic/legacy selectors and adds the observed modern structure. Private/unknown modern channel icons remain off unless explicitly opted in. No real text or IDs copied into fixtures.

URL parser repair in `connections/slack/extract.ts`: accept uppercase `E` organization scopes as well as `T` workspace scopes and retain the visible scope in provenance. A new synthetic test reproduced the original failure (19 pass / 1 fail in the targeted fixture suite), then passed after the change. `NOTES.md` documents the observed route without real IDs or content.

```diff
diff --git a/connections/slack/extract.ts b/connections/slack/extract.ts
index d647699..b80dfe4 100644
--- a/connections/slack/extract.ts
+++ b/connections/slack/extract.ts
@@ -73,7 +73,9 @@ export function parseSlackUrl(url: string): { teamId: string; channelId: string
   if (client < 0 || parts.length < client + 3) return null;
   const teamId = parts[client + 1] ?? "";
   const channelId = parts[client + 2] ?? "";
-  if (!/^T[A-Z0-9]+$/.test(teamId) || !/^[CDG][A-Z0-9]+$/.test(channelId)) return null;
+  // Enterprise client routes use an E-prefixed organization scope. Preserve
+  // that visible scope in IDs and links instead of reading hidden workspace state.
+  if (!/^[TE][A-Z0-9]+$/.test(teamId) || !/^[CDG][A-Z0-9]+$/.test(channelId)) return null;
   return { teamId, channelId };
 }

@@ -123,9 +125,14 @@ export function extractSlack(document: QueryRoot, options: ExtractOptions): Slac
   const roots: QueryRoot[] = list ? [list] : [];
   const channelIds = new Set(messages.map((message) => message.id));
   for (const pane of sliceNodes(document.querySelectorAll(selectors.threadPane))) {
-    const parent = pane.getAttribute(selectors.threadTsAttr);
-    // A thread can remain open from another channel; its own source is unverified.
-    if (parent && channelIds.has(`${channel.sourceId}:${parent}`)) {
+    const parent = threadTimestamp(pane);
+    const root = pane.querySelector(selectors.threadRoot);
+    // Modern Slack identifies the thread's source on its rendered root row.
+    // Legacy markup needs its parent visible in the current channel instead.
+    const sameChannel = root
+      ? root.getAttribute(selectors.channelIdAttr) === channel.channelId && messageTimestamp(root) === parent
+      : parent != null && channelIds.has(`${channel.sourceId}:${parent}`);
+    if (parent && sameChannel) {
       roots.push(pane);
       messages.push(...readMessages(pane, channel));
     }
@@ -250,9 +257,11 @@ function readChannel(
   const dm = header?.querySelector(selectors.dmIndicator) != null || ids.channelId.startsWith("D");
   const lock = header?.querySelector(selectors.privateChannelLock) != null;
   const publicId = ids.channelId.startsWith("C");
+  const modernHeader = header?.closest(".p-view_header") != null;
+  const publicIcon = header?.querySelector(selectors.publicChannelIcon) != null;
   let kind: SlackChannel["kind"];
   if (dm) kind = "dm";
-  else if (lock || !publicId || !header?.querySelector(selectors.channelName)?.textContent?.trim()) kind = "private";
+  else if (lock || !publicId || (modernHeader && !publicIcon) || !header?.querySelector(selectors.channelName)?.textContent?.trim()) kind = "private";
   else kind = "public";

   const nameEl =
@@ -285,6 +294,11 @@ function readMessages(root: QueryRoot, channel: SlackChannel): SlackDraft[] {
   for (const node of nodes) {
     const ts = messageTimestamp(node);
     if (!ts) continue;
+    const pane = node.closest(selectors.threadPane);
+    const threadTs = pane ? threadTimestamp(pane) : null;
+    // Slack repeats the parent in the thread list; do not change its channel
+    // record's kind or revision merely because the pane opened.
+    if (pane && ts === threadTs) continue;
     const blocks = sliceNodes(node.querySelectorAll(selectors.messageText));
     const text = blocks
       .filter((block) => !blocks.includes(block.parentElement?.closest(selectors.messageText) as QueryEl))
@@ -298,8 +312,6 @@ function readMessages(root: QueryRoot, channel: SlackChannel): SlackDraft[] {
     const authorId = authorEl?.getAttribute(selectors.authorIdAttr)?.trim() ?? "";
     const repliesText = node.querySelector(selectors.threadReplies)?.textContent ?? "";
     const replyMatch = repliesText.match(/(\d+)/);
-    const pane = node.closest(selectors.threadPane);
-    const threadTs = pane?.getAttribute(selectors.threadTsAttr) ?? null;
     const occurredMs = Number(ts) * 1000;
     if (!Number.isFinite(occurredMs)) continue;
     messages.push({
@@ -320,6 +332,12 @@ function readMessages(root: QueryRoot, channel: SlackChannel): SlackDraft[] {
   return messages;
 }

+function threadTimestamp(pane: QueryEl): string | null {
+  return pane.getAttribute(selectors.threadTsAttr)
+    ?? pane.querySelector(selectors.threadParent)?.getAttribute(selectors.threadTsAttr)
+    ?? null;
+}
+
 function messageTimestamp(node: QueryEl): string | null {
   const ts = node.getAttribute(selectors.timestampAttr) ?? node.querySelector(selectors.timestamp)?.getAttribute(selectors.timestampAttr);
   return ts && /^\d+\.\d+$/.test(ts) ? ts : null;
diff --git a/connections/slack/selectors.json b/connections/slack/selectors.json
index 5df0c9a..7e2e5e9 100644
--- a/connections/slack/selectors.json
+++ b/connections/slack/selectors.json
@@ -1,5 +1,5 @@
 {
-  "messageList": "[data-qa='virtual-list']",
+  "messageList": "[data-qa='virtual-list'], .p-message_pane .c-virtual_list",
   "message": "[data-qa='virtual-list-item']",
   "messageText": ".p-rich_text_section, .p-rich_text_list, .p-rich_text_preformatted",
   "messageCode": ".p-rich_text_preformatted",
@@ -9,15 +9,19 @@
   "authorIdAttr": "data-user-id",
   "threadReplies": "[data-qa='thread_replies']",
   "edited": "[data-qa='message_edited']",
-  "channelName": "[data-qa='channel-name']",
-  "channelHeader": "[data-qa='channel_header']",
+  "channelName": "[data-qa='channel-name'], [data-qa='channel_name'] .p-view_header__channel_title",
+  "channelHeader": "[data-qa='channel_header'], .p-view_header",
   "dmIndicator": "[data-qa='dm_channel_name']",
   "privateChannelLock": "[data-qa='channel-lock-icon']",
+  "publicChannelIcon": ".p-view_header__channel_title_icon[data-inline-channel-type-icon='channel-filled'] svg[data-qa='channel-filled']",
   "threadPane": "[data-qa='threads_flexpane']",
   "threadTsAttr": "data-thread-ts",
+  "threadParent": "[data-thread-ts]",
+  "threadRoot": ".c-message_kit__thread_message--root[data-msg-channel-id]",
+  "channelIdAttr": "data-msg-channel-id",
   "beginning": "[data-qa='beginning-banner']",
   "captcha": "[data-qa='captcha']",
   "errorBanner": "[data-qa='banner_error']",
   "login": "[data-qa='signin_form']",
-  "shell": "[data-qa='client_loading'], [data-qa='virtual-list'], [data-qa='channel_header'], [data-qa='signin_form']"
+  "shell": "[data-qa='client_loading'], [data-qa='virtual-list'], [data-qa='channel_header'], [data-qa='signin_form'], .p-message_pane .c-virtual_list"
 }
```

The first full repair test run had 83 pass / 1 fail because the product-name test scans root Markdown and rejected this trial report. Report moved to `docs/afterwhile-trial.md`, following the existing documentation exemption; test code unchanged. Recheck: 84 pass / 0 fail, 373 assertions, 4.21 seconds. Rebuild passed (helper compile: 128 ms). That URL-only repair did not resolve the live error; selector repair follows.

The compact live probe confirmed `.p-message_pane .c-virtual_list` and `.p-view_header`; the scrolling viewport is the descendant `.c-scrollbar__hider`, not the inner content container. Public marker: `data-inline-channel-type-icon="channel-filled"` with matching SVG `data-qa="channel-filled"`. New synthetic fixture and regression tests check Enterprise routes, channel-only capture (excluding sidebar previews), actual scrolling descendant, and private/unknown icon gating. Final checks: 87 pass / 0 fail, 392 assertions, 3.42 seconds. Build passed; subsequent live capture and thread checks passed as described below.

## Reload lifecycle and coverage repairs

User supplied extension errors showing `Uncaught (in promise) Error: Extension context invalidated` from `content-slack.js`. Stale scripts previously continued ticking after an extension reload and several fire-and-forget messaging calls had no rejection handler. Repair cancels the scheduled tick, disconnects observers/listeners, handles rejected messages, and drops the stale instance's saved scroll without moving the view. A regression invalidates both storage and messaging APIs and checks that later mutations/input cause no new API calls, scrolling, or saves. A separate regression checks partial coverage is available while a visible tab waits for user input.

Coverage used to be written only after reading stopped; during the first successful capture, MCP could see 5 test-channel records but no coverage row. Repair publishes partial coverage during capture as well. Existing scroll-restoration assertions retained; expected coverage assertion updated for the new behavior. Latest tests: 89 pass / 0 fail, 406 assertions, 4.17 seconds. Rebuild passed (helper compile: 135 ms). Subsequent reload activated these repairs; the browser log check found no new invalid-context errors.

After the next reload, records stayed unchanged, but active coverage reported only 3 (later 29) from the current visit despite 31 stored records. Helper repair derives unknown-total Slack coverage from the latest non-deleted saved records across visits and refreshes it when queued records arrive after coverage. A regression checks arrival order, edits, and deletions. Tests: 90 pass / 0 fail, 410 assertions, 3.95 seconds. Live check after the latest reload: coverage have 36 matches all 36 saved test-channel records, including the five replies.

## MCP

Official MCP SDK client script launched the installed compiled helper over stdio: 5 tools registered; `sources` and test-channel `coverage` both responded. Initial check: 0 sources and 0 records. After live capture and budget stopping: 3 sources, 31 test-channel records, coverage row present with have 31 and expected unknown. Across all captured sources, SQLite held 42 logical records / 42 revision rows / 0 deletion rows at 08:36 PDT. Check after thread closure and another reload: 10 sources, 37 test-channel records, coverage have 37; all sources totaled 91 logical records / 96 revision rows / 0 deletion rows. Final check after editing at 10:00 PDT: 11 sources, 37 test-channel records, coverage have 37 and expected unknown; all sources totaled 96 logical records / 104 revision rows / 0 deletion rows. Other sources continued capturing during the trial. No client configuration modified and no returned source names/URLs or message content printed.

## Intrusiveness and risk observations

- Live capture and budget stopping observed from local counts. Thread closure retained all replies without false deletions. The visible view stayed stable for the sampled five seconds after reload. The user reported no new errors or unexpected movement, and scrolling felt okay.
- The user must review Slack's risks in the popup before enabling capture.
- Captures are readable local SQLite/Markdown, without additional encryption beyond the OS. The initial trial used public channels with DMs/private capture off. The user later enabled private-channel capture for the follow-up below; that switch permits any private channel opened while enabled. DMs remain untested.
- Installation changes native-host registration in three browser folders and adds Bun PATH setup to the user's shell configuration.
- Live inspections and this report must exclude Slack message content. No captured data should be committed.
- First diagnostic probe unexpectedly exposed names embedded in sidebar `data-qa` attributes. Revised probe avoids arbitrary attribute values; structural attributes can contain sensitive metadata even without reading text nodes.

## Thread repair and direct browser inspection

Activated the Node REPL connection and the installed OpenAI Chrome client. Midlight requested and received local approval for Full Chrome access. Claimed the existing test tab without foregrounding it; all page queries returned structure/counts only. The first manual probes were therefore no longer needed for thread inspection. Chrome internal tabs cannot be claimed by this client, so the extension reload remains a user action.

Live thread structure: the existing pane selector matches; parent timestamp is on its descendant composer. The thread contains 8 virtual rows, 6 timestamped rows (one repeated root, five replies). Root timestamp matches the composer, and its rendered channel ID matches the current channel, even after the parent leaves the main list. Repair reads the nested parent timestamp, verifies modern root channel provenance, and excludes the repeated parent from replies. Synthetic regressions check composer linkage, offscreen parents, foreign-channel roots, and pane closure without revisions/deletions. Latest validation: 93 pass / 0 fail, 427 assertions, 5.46 seconds. Rebuild completed (helper compile: 132 ms). Live retest saved all five replies without revising the parent; closing the pane retained replies and their revisions.


## Final edit and file check

At 10:00 PDT, compared the saved pre-edit baseline with read-only SQLite aggregates. The test channel stayed at 37 logical messages; one existing ID gained two text-changing revisions, for 39 revision rows and no deletion rows. Those revisions were captured at 09:59:44.438 and 09:59:44.927 PDT, 489 ms apart. The user confirmed saving more than once, explaining the two changed versions. This verifies revision identity, but does not establish latency from clicking Save Changes. All three revisions carry `edited=false`, so the current edit-marker selector is not confirmed by this trial; text differences still create revisions.

Test-channel Markdown output: 22 day files totaling 13,209 bytes; today's file is 495 bytes. The edited message belongs to an earlier day. File contents were not printed or copied into this report. No messages, author names, channel names, or live message IDs appear in fixtures or this artifact.

Latest implementation validation: 93 tests passed, 0 failed, 427 assertions, 5.46 seconds; build passed. Repairs remain uncommitted on local branch `fix/mac-slack-trial`. No remote changes were published. Live limitations: exact visible-capture latency, hourly cap, channel-start banner, private/DM markup, and edit-marker markup were not fully verified. Pacing and active-use behavior passed the user's observation; the independent active-view sample lasted five seconds.

## Second public-channel check

At approximately 10:48 PDT, the user switched to a second public channel and reported automatic capture. SQLite confirmed 17 logical records / 17 revision rows / 0 deletion rows for that channel. Output comprised 9 day files totaling 8,167 bytes; no file existed for today, since the captured messages were from older days. MCP `sources` and `coverage` both responded, each reporting 17 saved records. Coverage was partial, expected total unknown, with `load budget reached`. This verifies automatic capture after switching channels and budget stopping; reload/edit/thread checks were not repeated in this channel. No channel name or content recorded here.

## Private-channel follow-up

At approximately 11:17 PDT, after the user reported enabling private channels and identified the private channel to check, read-only SQLite aggregates confirmed 71 logical records / 71 revision rows / 0 deletion rows. Output comprised 4 day files totaling 10,927 bytes; today's file was 1,811 bytes. MCP `sources` and `coverage` both responded with 71 saved records. Coverage remained partial, expected total unknown, with no stop reason recorded. This verifies saved data and MCP availability for the user-identified private channel. It does not independently verify the live private icon, exclusion while the switch is off, or completion of all history. No channel name, message content, or author data recorded here.


## Backfill improvements built after the trial

At the user's request, added independent automatic-backfill controls and selectable past-7-day, past-30-day and all-available-history ranges. Backfill defaults off for new and existing installations without that setting; visible capture, public/private permissions and previously saved records remain available. The popup shows the saved source total, oldest saved date, retracing/waiting status and budget resume time. `Pause all capture` stops both capture and backfill.

Per-source progress persists the oldest saved point, selected range boundary, batch loads and cooldown through content/helper-worker restarts. Twenty history loads now trigger a one-minute rest rather than ending the visit; the reader can continue while the channel remains open and idle. The site-wide 100-load hourly allowance remains enforced and reading can resume at the next UTC hour. During a budget pause the idle tab retains its frontier. Returning to the tab grants a fresh 30-second activity grace period; restoration waits until safe. Half-viewport steps and variable pauses remain in place.

Browser-only progress cannot jump into undrawn history. After reload or a user scroll, the connection may need to retrace already saved history, spending the same load allowance. Closed channels are not opened. Reaching a lookback boundary is reported as the selected range reached, with MCP coverage still partial. Reaching channel start also leaves whole-source completeness unconfirmed because unopened thread replies and gaps are not proven captured. Forget clears the source's stored progress and cached count.

Validation: 105 tests passed / 0 failed, 489 assertions across 9 files, 4.60 seconds. Tests cover capture/editing with backfill off, cancellation during lock acquisition, batch/hourly automatic continuation, the full 100-load limit, fresh content instances and worker restarts, cumulative counts, selected-range and channel-start reporting, forgetting progress, and protecting the active view. Build passed; helper compile 90 ms. Six additional headless checks exercised the actual popup bundle against a synthetic Chrome API: saved total, backfill switch, all-history range selection, global pause/resume, disabled control while paused, and horizontal layout. Screenshot `docs/screenshots/popup-backfill.png` uses synthetic data only.

Live activation/retest of these improvements is pending an extension reload and Slack refresh. Changes are being submitted for review from `fix/mac-slack-trial`; no merge or release has been performed. Earlier uncommitted/unpublished notes describe the state at those checkpoints.
