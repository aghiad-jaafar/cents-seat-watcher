# CEnT-S Seat Watcher

Watches the [CISIA CEnT-S booking calendar](https://testcisia.it/calendario.php?tolc=cents&l=gb&lingua=inglese)
and pushes a Telegram alert the moment a seat frees up — including at 3am, with your
computer switched off.

Runs entirely on GitHub Actions. No server, no hosting bill, no browser left open.

See **[STATUS.md](STATUS.md)** for current progress, what was learned about the site, and the remaining setup steps.

## The problem

CEnT-S is the entry test for admission to English-taught degree courses at Italian
universities. Popular sessions fill up, and seats reappear only when other candidates
cancel — unpredictably, at any hour. Whoever refreshes the page first gets the seat.

A browser extension cannot solve this: it only runs while your browser is open, which is
precisely not the case while you sleep. So this runs on someone else's computer instead.

## How it works

```
GitHub Actions cron (*/5)
        │
        ├─ fetch    calendario.php          (plain server-rendered HTML, no login)
        ├─ parse    <table id="calendario">  → 8 columns per row
        ├─ diff     against state/seen.json  → transitions only
        ├─ filter   config.json              → only what you care about
        └─ notify   Telegram (+ optional email)
                │
                └─ commit state/seen.json back to the repo
```

Actions runners are ephemeral, so **the repository is the database**. `state/seen.json` is
committed after every run, and it is the only reason you get *one* alert when a seat opens
instead of one every five minutes for as long as it stays open.

### Availability is decided by colour, not by wording or seat count

The status cell is colour-coded, and the colour is the only trustworthy signal. Surveying
656 rows across 13 CISIA calendars turns up five distinct renderings:

| Colour | Label | Tooltip | Meaning |
| --- | --- | --- | --- |
| 🟢 LimeGreen | POSTI DISPONIBILI | *registrations are open, you can book* | **bookable** |
| 🟠 Orange | POSTI DISPONIBILI | *open but few seats remain* | **bookable, hurry** |
| 🔴 Crimson | POSTI ESAURITI | *seats exhausted* | sold out |
| 🔴 Crimson | ISCRIZIONI CONCLUSE | *deadline expired* | dead |
| 🔴 Crimson | ISCRIZIONI CHIUSE | — | **not opened yet** |

Two traps live in that table:

**Orange and green share the same words.** Matching on the text alone cannot tell "112
seats free" apart from "6 left, hurry" — only the colour can. Orange is the most urgent
alert this tool sends.

**Red means three different things**, and they are separated by the *deadline* cell, not by
language: an expired row has its deadline wrapped in `<del>` (struck through). So a red row
with a live deadline is still worth watching, because it can still turn green — while a
struck-through one is history and is silenced permanently.

### The seat count for a sold-out session is not in the page

CISIA publishes a seat count only while a session is bookable. Once it sells out the cell
becomes literally `<td class="center">---</td>` — the figure is not hidden in an attribute,
a script, or a JSON payload. The page carries no `data-*` row attributes, no hidden inputs,
no AJAX and no API; sorting and filtering are client-side over the already-rendered table.
The only other endpoint on the site is the authenticated booking area.

So the watcher records it instead: whenever a session is bookable it stores that count as
`lastSeats`, and keeps it after the session sells out. The daily heartbeat can then report
*"sold out — had 40 seats on 2026-09-28"*, which is the capacity information the page
itself refuses to give you. Stale counts on expired rows are deliberately not recorded.

And the seat number is never a signal. Expired rows keep a stale non-zero count (Siena
renders `42` while closed) and sold-out rows render `---`. Reading `42` as availability
would fire a false alert on nearly every closed session in the calendar.

Anything red is unavailable; anything that is not red is treated as bookable — including a
colour the site has never used before, so a palette change over-alerts rather than silently
hiding a seat.

### What triggers an alert

| Event | Meaning | Default |
| --- | --- | --- |
| `BECAME_AVAILABLE` | a watched session turned green | **on** — the one that matters |
| `NEW_ROW_AVAILABLE` | a session appeared already bookable | **on** |
| `RUNNING_LOW` | green → orange: seats are nearly gone | on |
| `SEATS_INCREASED` | more seats than last time (someone cancelled) | on |
| `NEW_DATE` | a university published a brand-new test date | on |
| `NEW_ROW_PENDING` | a session exists whose **bookings have not opened yet** | on |
| `BECAME_UNAVAILABLE` | seats gone | off |

`NEW_ROW_PENDING` is the "get ready" signal: the session is on the calendar, it is not
bookable yet, and you will be pinged again the moment it turns green. Expired sessions
never generate events at all.

Every row in the calendar is **tracked**, regardless of your filter; the filter is applied
only when deciding what to notify. That ordering matters — filtering before tracking would
mean that widening your filter later replays every previously hidden row as "new" and
floods you with alerts.

## Setup

### 1. Create the repository

Fork or push this to a **public** repo. Public repos get unlimited Actions minutes; a
private one only gets 2,000/month, which a 5-minute cron would exhaust. Your credentials
live in encrypted Actions secrets either way, never in the code.

### 2. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. Send your new bot any message, so it has something to report.
3. Find your chat id:

```bash
TELEGRAM_BOT_TOKEN=123456:AA... npm run telegram:chatid
```

### 3. Confirm delivery works

Before trusting it to wake you at 3am, send yourself a sample alert:

```bash
TELEGRAM_BOT_TOKEN=123:AA... TELEGRAM_CHAT_ID=99887766 npm run telegram:test
```

If that arrives on your phone, the same two values will work as GitHub secrets.

### 4. Add repository secrets


**Settings → Secrets and variables → Actions**

| Secret | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | bot token from BotFather |
| `TELEGRAM_CHAT_ID` | yes | where to send alerts |
| `WATCHER_PAT` | recommended | keeps the cron alive (see below) |
| `SMTP_USER` / `SMTP_PASS` / `ALERT_EMAIL_TO` | no | enables the optional email channel |

### 5. Arm it

Enable Actions, then run **Check CEnT-S seats → Run workflow** once. The first run adopts
the current calendar as its baseline, stays quiet about it, and sends a single "Watcher
armed" confirmation so you know the pipeline works end to end.

## Configuration

`config.json`, no code changes needed:

```json
{
  "calendars": [
    { "name": "CEnT-S", "url": "https://testcisia.it/calendario.php?tolc=cents&l=gb&lingua=inglese" }
  ],
  "filter": { "formats": ["CENT@HOME"], "universities": [], "cities": [] },
  "alertOnNewDate": true,
  "alertOnNotYetOpen": true,
  "alertOnRunningLow": true,
  "alertOnSeatIncrease": true,
  "alertOnClose": false,
  "heartbeatHours": 24
}
```

- **`filter`** — an empty list means "no constraint". `universities` and `cities` match
  case-insensitive substrings, so `"brescia"` matches `Università degli studi di Brescia`.
- **`calendars`** — add other CISIA calendars (`?tolc=ingegneria`, `?tolc=economia`, …) and
  they are watched too, each with its own independent baseline.
- **`heartbeatHours`** — how often to confirm the watcher is alive.

## Not failing silently

A monitor that dies quietly is worse than no monitor, because you stop checking manually.

- **Parse guard** — if the table is missing or yields zero rows, the baseline is left
  untouched and the run fails loudly. Overwriting it with nothing would make the next run
  treat the entire calendar as new.
- **Cliff guard** — if the row count collapses to under 30% of what was known, the result
  is treated as suspect: you get warned, the baseline is not updated.
- **Retries** — three attempts with exponential backoff; 4xx fails fast since it will not
  fix itself.
- **Failure alert** — after three consecutive failed checks, Telegram tells you the watcher
  is broken.
- **Heartbeat** — every 24 hours, a short "alive, N tracked, M bookable" message. This is
  what distinguishes "no seats available" from "the watcher has been dead for a week".
- **Concurrency + rebase** — overlapping runs cannot corrupt the state file.

### The 60-day trap

GitHub disables scheduled workflows in repositories with no activity for 60 days — and
commits made with the default `GITHUB_TOKEN` **do not count as activity**, so the watcher's
own state commits will not save it. `keepalive.yml` pushes a weekly empty commit using
`WATCHER_PAT` (a fine-grained PAT with *Contents: read and write*), which does count.
Without that secret the workflow warns you; GitHub also emails before disabling.

## Local development

```bash
npm test              # 58 tests, incl. the Telegram path against a stubbed Bot API
npm run check:dry     # hit the live site, print what would be sent, change nothing
npm run check:once    # one real check, including notifications
```

`npm run check:dry` is safe to run anytime: it sends nothing and writes nothing.

## Rate limiting

One `GET` per poll — three polls per 5-minute run, roughly one request every 100 seconds,
comparable to a single person refreshing the page. `testcisia.it` serves no `robots.txt`,
so there are no crawl directives to honour, but the User-Agent identifies the tool anyway.
Tune with `POLL_ITERATIONS` and `POLL_INTERVAL_SEC` in `.github/workflows/check.yml`.

## Project layout

```
src/parse.js           HTML → rows, with the colour-based availability rule
src/diff.js            snapshot vs snapshot → transition events
src/filter.js          which events are worth an alert
src/format.js          events → Telegram HTML / email
src/fetchCalendar.js   retries, timeouts, honest User-Agent
src/notify/            telegram.js (zero-dep), email.js (optional)
src/index.js           orchestration, guards, heartbeat
test/                  unit + end-to-end tests, against two real captured pages
```

## Licence

MIT.
