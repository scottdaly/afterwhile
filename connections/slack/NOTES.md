# Slack connection

Channel and thread structure in `selectors.json` was compared with one live `app.slack.com` page on macOS during the October 13, 2026 trial. The original selectors were based on hints and synthetic fixtures. Private/DM views, edit markers, beginning banners, and pushback markup remain unverified live. All fixtures contain synthetic data.

## Mac trial, October 13, 2026

- A live Enterprise Slack channel used `/client/E…/C…`. The original URL parser accepted only `T…` and returned `capture stopped working` before extraction. Accept `T` and `E` scopes; preserve the visible URL scope in record/source IDs and links. Do not read hidden workspace state to translate it. A synthetic Enterprise URL regression checks extraction and provenance.
- Structure-only live probe found no `[data-qa='virtual-list']`. The channel list is `.p-message_pane .c-virtual_list`; its `.c-scrollbar__hider` descendant is the viewport (686px tall with 6,232px scroll height in the probe), while `.c-virtual_list__scroll_container` has content height and is not the viewport. Selecting the list wrapper lets the content script find its scrolling descendant. Global `virtual-list-item` rows also include the sidebar, so never select them outside the channel list.
- Live header: `.p-view_header`, containing `[data-qa='channel_name']` and `.p-view_header__channel_title`. The original `channel_header` and `channel-name` selectors did not match. The tested public channel has `.p-view_header__channel_title_icon[data-inline-channel-type-icon='channel-filled']` containing `svg[data-qa='channel-filled']`. Require this positive public marker for modern headers; a missing legacy lock selector alone does not prove a channel is public. Other/unknown modern icons stay private and off by default. Private and DM icon shapes have not been inspected live.
- Timestamps still render as `a[data-ts]`, rich text as `.p-rich_text_section`, and authors as `[data-qa='message_sender_name']`. Message rows contain `[data-qa='message_container']` with `data-msg-ts` and `data-msg-channel-id`. Attribute names and counts were inspected without message text.
- Thread pane `[data-qa='threads_flexpane']` matches, but live `data-thread-ts` is on its descendant `.c-texty_input_unstyled` composer, not the pane. The root row is `.c-message_kit__thread_message--root[data-msg-channel-id]`; its rendered channel ID and timestamp match the current channel and composer parent. That verifies thread provenance even when the parent has scrolled offscreen in the main list. Exclude the repeated root from replies so opening a thread does not revise its existing channel record. Other-channel roots are skipped. Edit-marker and beginning-banner markup remain unverified.
- Live capture worked after selector repair. In the test channel, saved records grew from 5 to 31; coverage reported `load budget reached` and remained partial. Recent batches were typically 1–2 messages at intervals of roughly 1.1–2.5 seconds, with longer pauses. This confirms incremental capture and budget stopping; the user later reported that scrolling felt okay and the active view did not move unexpectedly.
- Reloading the unpacked extension produced `Extension context invalidated` from stale content scripts. Retire invalidated instances: cancel their scheduled tick, disconnect observers/listeners, and catch messaging rejections. Shutdown must not restore or move the person's view. Reload the Slack page after an extension reload; Chrome's stored errors can remain visible until cleared.
- Publish partial coverage during successful capture passes, not only when backfill stops, so MCP clients can see a channel while it is being read.
- After reopening, the content script's visit count can be lower than the saved source total. The helper derives Slack coverage `have` from latest non-deleted database records, and refreshes it after record ingest if coverage arrived first.
- Initial live thread test saved no replies because the parent timestamp was sought on the pane. Composer/root repair passed the live retest: five replies saved; closing the pane retained their exact revisions without deletions. A visible-tab sample kept the same scroll position for five seconds after reload. Do not infer reply deletions from pane absence.
- Live editing preserved the same logical message ID: the test source stayed at 37 messages while one message gained revisions 2 and 3, captured about half a second apart. Both changed text; the stored `edited` flag stayed false. The user confirmed saving more than once; this explains the two changed versions. Edit-marker markup remains unverified. Do not infer a one-to-one relationship between a user edit and stored revisions.

## What the fixtures assume

- Web client URL shape: `https://app.slack.com/client/<team id>/<channel id>`. The installable web app is treated as that same page.
- Message list: `[data-qa='virtual-list']` of `[data-qa='virtual-list-item']`.
- The scroll container must be the list or a descendant; never an ancestor outside it. Channel scrolling excludes the thread pane.
- Message text includes all rich text sections, lists and preformatted blocks. Paragraph breaks and code whitespace are retained; nested sections are not read twice.
- Stable id: `slack:<team>:<channel>:<data-ts>`. `data-ts` looks like `1791822000.000100`. The record time is that value as Unix seconds, converted to UTC.
- Author: `[data-qa='message_sender_name']` plus `data-user-id`.
- Thread replies render in `[data-qa='threads_flexpane']`. Legacy fixtures put `data-thread-ts` on the pane; current Slack puts it on a descendant composer. `fields.threadTs` links a reply to its parent. Threads are captured only while their pane is open; repeated root messages are excluded from replies.
- Extraction reads the channel list and verified threads. Modern root rows must identify the current channel and match the composer parent. Legacy threads need their parent rendered in the channel list. Other previews and unattributed threads are skipped: an open thread can belong to another, possibly private, channel.
- A channel without a drawn privacy header is treated as private. Header selectors, including the lock and DM indicators, still require live validation.
- Deletion neighbours are tracked separately for the channel and each thread. Closing a pane provides no deletion evidence. A timestamped row with undrawn text is still visible and retains its previous text.
- Channel history is virtualized. Scrolling **up** (`scrollTop` decreases) is treated as the way older messages load. That direction is an assumption.
- A history **load** is a scroll step after which new older message ids appear. Reveal paints that do not add older ids do not spend budget.
- Load budget defaults: 20 loads per batch followed by a one-minute cooldown, 100 per hour. Both come from `connection.json`.
- "This is the very beginning" is detected from `[data-qa='beginning-banner']`. Backfill range is selectable: 7 days, 30 days (default), or all available history. A chosen range boundary is not whole-channel completeness.
- DMs: channel id starts with `D`, or `[data-qa='dm_channel_name']` is present. Off unless the popup turns DMs on.
- Private: `[data-qa='channel-lock-icon']`. Ids that do not start with `C` or `D` (for example a `G` id) are treated as private when there is no clearer signal. Off unless the popup turns private channels on.
- Pushback banners: `[data-qa='captcha']`, `[data-qa='signin_form']`, `[data-qa='banner_error']` containing "slow down" or "something went wrong".
- If the page has a lot of text but none of the shell selectors, or the virtual list has text and no `data-ts`, extraction returns **capture stopped working** and saves nothing.

## Hands-off behavior

- Visible messages are read immediately. Backfill scrolling waits until the tab is hidden, the OS session is locked, or 30 seconds have passed without wheel, keyboard, mouse, or touch input in that tab. Scroll events are not treated as user input.
- Steps move at most half the visible height. Pauses vary from about 0.5s to 2.5s, with an occasional longer pause.
- Mutation-driven captures do not advance the next scroll deadline. Internal storage updates do not wake the reader.
- After each step the drawn message ids must change. A background tab whose rows do not draw is stalled and resumed only once it is visible and idle.
- One scroll job per site at a time, coordinated by the service worker. Its owner is kept in session storage across worker restarts and released on tab removal or navigation.
- Restore uses a row timestamp and viewport offset, with distance from the bottom as a fallback when that row is virtualized away. Input waits request restoration once the person is idle; restoration never moves an active person's view. Their own scroll supersedes the saved position.
- Three consecutive steps without new drawn rows stop with `content stopped loading`, including when `scrollTop` is already zero and the beginning selector misses. Hidden tabs that move without redrawing wait for visibility and idle instead.
- Pushback pauses Slack until the next local midnight. Already saved messages stay saved. The popup shows the reason.
- The script never clicks, navigates, fetches, or synthesizes pointer or keyboard input. It sets `scrollTop` on the list container.

## Check on a real Slack page

1. Public channel, private channel, DM, and a group DM.
2. Whether `data-qa` values match this file.
3. Which element actually scrolls, and whether older history loads when `scrollTop` decreases.
4. Thread pane markup and the parent timestamp attribute.
5. The beginning-of-channel banner text.
6. Edit and delete markup. Deletes are inferred only when both adjacent messages are on screen and the middle one is gone.
7. What Slack shows for a rate limit, a sign-in wall, and a loading shell.

## Backfill controls and resumable progress

Automatic backfill defaults off, independently of visible capture. Turning it off does not stop saving rendered messages. Range and backfill enablement apply to opened channels allowed by the DM/private settings. Per-source progress in extension storage remembers the oldest saved date, range boundary, load batch and cooldown. A channel stays at its frontier while idle during budget pauses, and returns to the saved reading position only when doing so will not move an active person's view. Returning to a tab starts a fresh 30-second grace period. Hourly allowance resets at the next UTC hour; batch pauses last one minute. Both include paced retracing of older rows, not just new database records.

A timestamp checkpoint cannot jump to undrawn history without navigating or making extra requests, which this connection does not do. After reload or a user scroll, it may need to walk the same history again at half-viewport steps. The popup labels that as retracing when the drawn rows are newer than the oldest saved point. Progress is not proof of contiguous history, and un-opened thread replies are not backfilled.

Native acknowledgements return per-source saved counts without content, so the popup reports the saved source total rather than the current visit's drawn records. Forgetting a source/site clears its stored progress and cached count. Synthetic regressions exercise capture with backfill off, cancellation before scrolling, automatic cooldown/hourly continuation, persisted progress through restart/reload, range changes, count accumulation, and active-view protection.
