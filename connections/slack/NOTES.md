# Slack connection

Selectors in `selectors.json` are **unverified**. They were written from the build brief's hints and checked only against synthetic HTML fixtures on Linux. They have not been compared with a live `app.slack.com` page.

## What the fixtures assume

- Web client URL shape: `https://app.slack.com/client/<team id>/<channel id>`. The installable web app is treated as that same page.
- Message list: `[data-qa='virtual-list']` of `[data-qa='virtual-list-item']`.
- Stable id: `slack:<team>:<channel>:<data-ts>`. `data-ts` looks like `1791822000.000100`. The record time is that value as Unix seconds, converted to UTC.
- Author: `[data-qa='message_sender_name']` plus `data-user-id`.
- Thread replies render in `[data-qa='threads_flexpane']` with `data-thread-ts` on the pane. `fields.threadTs` links a reply to its parent. Threads are captured only while that pane is open.
- Channel history is virtualized. Scrolling **up** (`scrollTop` decreases) is treated as the way older messages load. That direction is an assumption.
- A history **load** is a scroll step after which new older message ids appear. Reveal paints that do not add older ids do not spend budget.
- Load budget defaults: 20 loads per channel visit, 100 per hour. Both come from `connection.json`.
- "This is the very beginning" is detected from `[data-qa='beginning-banner']`. Backfill also stops at 30 days.
- DMs: channel id starts with `D`, or `[data-qa='dm_channel_name']` is present. Off unless the popup turns DMs on.
- Private: `[data-qa='channel-lock-icon']`. Ids that do not start with `C` or `D` (for example a `G` id) are treated as private when there is no clearer signal. Off unless the popup turns private channels on.
- Pushback banners: `[data-qa='captcha']`, `[data-qa='signin_form']`, `[data-qa='banner_error']` containing "slow down" or "something went wrong".
- If the page has a lot of text but none of the shell selectors, or the virtual list has text and no `data-ts`, extraction returns **capture stopped working** and saves nothing.

## Hands-off behavior

- Visible messages are read immediately. Backfill scrolling waits until the tab is hidden, the OS session is locked, or 30 seconds have passed without wheel, keyboard, mouse, or touch input in that tab. Scroll events are not treated as user input.
- Steps move at most half the visible height. Pauses vary from about 0.5s to 2.5s, with an occasional longer pause.
- After each step the drawn message ids must change. A background tab whose rows do not draw is stalled and resumed only once it is visible and idle.
- One scroll job per site at a time, coordinated by the service worker.
- Scroll position is restored when backfill stops.
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
