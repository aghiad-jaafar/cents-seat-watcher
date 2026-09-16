# Project status

**Last updated:** 2026-09-17
**State:** code complete and tested; not yet deployed — waiting on Telegram credentials.

---

## What we are building

A monitor that watches the [CISIA CEnT-S booking calendar](https://testcisia.it/calendario.php?tolc=cents&l=gb&lingua=inglese)
and sends a Telegram push the moment a test seat becomes bookable.

CEnT-S is the entry test for English-taught degree courses at Italian universities. The
sessions worth having are sold out, and seats only reappear when other candidates cancel —
at unpredictable hours. Whoever refreshes first gets the seat. The whole point is to be
notified while asleep, with the computer switched off.

### Why this is not a browser extension

The original idea was a web extension. It was dropped deliberately: an extension only runs
while the browser is open on your machine, so it would be asleep at exactly the hours that
matter. The monitor therefore runs on **GitHub Actions**, on GitHub's servers, for free.

---

## Where we have reached

Four commits, all work done on 2026-09-15, tree clean:

| Commit | What it did |
| --- | --- |
| `f91a9a9` | Initial watcher: fetch, parse, diff, filter, notify, state, CI workflows, README |
| `7b3fe9a` | Reworked availability detection to be driven by **status colour** |
| `fe7f2f5` | Remember seat counts the calendar stops publishing |
| `22d8c7f` | Covered the Telegram path; added a delivery self-test |

**58 tests, all passing.** Unit tests for parsing and diffing, end-to-end tests that drive
the real entry point against a local stub of the CISIA site, and tests that drive a real
`sendMessage` request against a local stub of the Telegram Bot API.

### Done

- [x] Fetch and parse the calendar (public, server-rendered HTML — no login needed)
- [x] Colour-based availability classification, covering all five states the site renders
- [x] Diff against committed state so an alert fires **once**, on a transition
- [x] Filter to CENT@HOME only, configurable without touching code
- [x] Telegram notifier, verified end to end against a stubbed Bot API
- [x] Optional email notifier (dormant unless SMTP secrets are added)
- [x] GitHub Actions cron every 5 minutes, with in-run polling for tighter granularity
- [x] Failure handling: retries, parse guard, row-count cliff guard, failure alerts
- [x] Daily heartbeat so a dead watcher is distinguishable from a quiet calendar
- [x] Keepalive workflow for GitHub's 60-day auto-disable rule
- [x] README, tests, config file — presentable as a public portfolio repo

### Not done — needs you

- [ ] Create the Telegram bot and get the chat id
- [ ] Confirm delivery with `npm run telegram:test`
- [ ] Create a **public** GitHub repo and push
- [ ] Add repository secrets
- [ ] Run the workflow once to arm it

---

## What we learned about the site (this shaped the design)

Three findings changed the implementation. Each was verified against the live site, not
assumed.

### 1. The page is trivially scrapeable

Public, server-rendered HTML. No login, no JavaScript rendering, no AJAX. A single
`<table id="calendario">` with 8 `<td>` per row. This is why no browser automation is
needed — a plain HTTP GET is enough.

### 2. Availability is the status **colour**, not the label text

Surveying 656 rows across 13 CISIA calendars found five distinct renderings:

| Colour | Label | Meaning | Bookable |
| --- | --- | --- | --- |
| 🟢 LimeGreen | POSTI DISPONIBILI | open | yes |
| 🟠 Orange | POSTI DISPONIBILI | open, **few seats left** | yes |
| 🔴 Crimson | POSTI ESAURITI | sold out | no |
| 🔴 Crimson | ISCRIZIONI CONCLUSE | deadline expired | no, permanently |
| 🔴 Crimson | ISCRIZIONI CHIUSE | **not opened yet** | no, but can still open |

Orange and green render *identical words*, so text matching cannot tell "112 seats free"
from "6 left, hurry". And `ISCRIZIONI CHIUSE` was a state the first implementation had
never seen; it would have been logged as unknown and silently treated as dead, despite its
deadline still being in the future.

Red is split three ways by the **deadline cell**: an expired row has its deadline wrapped
in `<del>` (struck through). That discriminator works regardless of page language, which
matters because the English page uses "BOOKINGS CLOSED" for more than one of these.

Anything not red is treated as bookable, so an unfamiliar colour over-alerts rather than
silently hiding a seat.

### 3. The seat count for a sold-out session is genuinely not in the page

Investigated on request. The sold-out cell is literally `<td class="center">---</td>` —
there is no hidden value. Checked and ruled out: `data-*` row attributes (none), hidden
inputs (none), inline script data (only tablesorter config and a modal), AJAX/fetch/XHR
(zero references), other endpoints (only the page itself and the authenticated booking
area), response headers (plain Apache/PHP).

CISIA simply does not send the figure once a session sells out.

**Workaround built:** a session *does* publish a real count while it is bookable. The
watcher now records that as `lastSeats` and retains it afterwards, so the heartbeat can
report *"sold out — had 40 seats on 2026-09-28"*. That is the capacity information the page
refuses to give, derived by observation instead. Stale counts on expired rows are excluded,
since those are leftovers rather than observed availability.

---

## How it works

```
GitHub Actions cron (*/5)
        │
        ├─ fetch    calendario.php          (public HTML, no login)
        ├─ parse    <table id="calendario">  → 8 columns per row
        ├─ classify status colour            → OPEN / OPEN_LIMITED / FULL / NOT_OPEN / EXPIRED
        ├─ diff     against state/seen.json  → transitions only
        ├─ filter   config.json              → CENT@HOME only
        └─ notify   Telegram
                │
                └─ commit state/seen.json back to the repo
```

Actions runners are ephemeral, so **the repository is the database**. `state/seen.json` is
committed after each run and is the only reason you get one alert per opening rather than
one every five minutes.

Every row is *tracked* regardless of the filter; filtering happens only when deciding what
to notify. If it worked the other way, widening the filter later would replay every hidden
row as "new" and flood you.

### Alerts

| Event | Meaning | Default |
| --- | --- | --- |
| `BECAME_AVAILABLE` | a watched session turned green | on — the one that matters |
| `NEW_ROW_AVAILABLE` | a session appeared already bookable | on |
| `RUNNING_LOW` | green → orange, seats nearly gone | on |
| `SEATS_INCREASED` | more seats than before (a cancellation) | on |
| `NEW_DATE` | a university published a new test date | on |
| `NEW_ROW_PENDING` | a session exists, **bookings not opened yet** | on |
| `BECAME_UNAVAILABLE` | seats gone | off |

---

## Next steps

### 1. Create the Telegram bot

Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token. Send your new bot
a message (it cannot message you first), then:

```bash
TELEGRAM_BOT_TOKEN=paste-token npm run telegram:chatid
```

### 2. Confirm delivery

```bash
TELEGRAM_BOT_TOKEN=paste-token TELEGRAM_CHAT_ID=paste-id npm run telegram:test
```

A sample alert should reach your phone. Common failures are handled with explicit guidance:
`chat not found` means you have not messaged the bot; `Unauthorized` means a bad token.

### 3. Push and arm

Create a **public** repo (public gets unlimited Actions minutes; private gets 2,000/month,
which a 5-minute cron would exhaust), then:

```bash
git remote add origin <url>
git push -u origin main
```

Add secrets under **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | bot token |
| `TELEGRAM_CHAT_ID` | yes | where alerts go |
| `WATCHER_PAT` | recommended | keeps the cron alive past 60 days |
| `SMTP_USER` / `SMTP_PASS` / `ALERT_EMAIL_TO` | no | enables the email channel |

Then **Actions → Check CEnT-S seats → Run workflow**. The first run adopts the current
calendar as its baseline, stays quiet about it, and sends one "Watcher armed" confirmation.

---

## What to expect once armed

Live calendar as of 2026-09-17 — 26 rows, 9 still in play, 3 bookable:

| Your CENT@HOME sessions | Status | Deadline |
| --- | --- | --- |
| 15/10/2026 ROMA (Sapienza) | sold out | 09/10/2026 |
| 15/10/2026 MILANO (Bicocca) | sold out | 09/10/2026 |
| 15/10/2026 BRESCIA | sold out | 09/10/2026 |
| 15/10/2026 TERAMO | sold out | 09/10/2026 |

**Expect silence at first.** All four are sold out, so nothing fires until someone cancels
or a university publishes a new CENT@HOME date. Their booking windows stay open until
09/10/2026, so they can all still turn green. The daily heartbeat is how you tell "nothing
available yet" apart from "the watcher broke".

The calendar is demonstrably live: between 2026-09-15 and 2026-09-17 the bookable CENT@UNI
sessions moved from 52/20/54 seats to 50/16/53 as people booked. Movement in the other
direction is exactly what triggers an alert.

If the silence is too quiet, adding `"CENT@UNI"` to `filter.formats` in `config.json` widens
it to in-person sessions — three of which are bookable right now.

---

## Deliberate limitations

- **5-minute cron, best-effort.** GitHub's scheduler runs late under load. Each run polls
  3 times internally (~90s apart) to compensate, giving roughly one check every 100 seconds.
- **Not real-time.** A seat freed and taken within a minute can be missed. Nothing short of
  a paid always-on host fixes that.
- **The authenticated booking area is not touched.** Seat counts for sold-out sessions live
  there, but scraping it would mean putting CISIA account credentials in GitHub secrets and
  fighting an SSO login that breaks often. Not worth it.
- **Filtered to CENT@HOME.** A one-line config change, not a code change.
- **Email is dormant.** Wired and ready, activates only if SMTP secrets are added.
