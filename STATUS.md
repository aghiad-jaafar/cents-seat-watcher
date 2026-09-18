# Project status

**Last updated:** 2026-09-18
**State:** 🟢 **LIVE** — deployed to GitHub Actions, checking every 5 minutes.
**Repo:** https://github.com/aghiad-jaafar/cents-seat-watcher

---

## Picking this back up later

**Nothing needs restarting.** The watcher runs on GitHub's servers, not on this laptop. It
keeps checking every 5 minutes whether or not the computer is on. Closing everything
changes nothing.

To work on the code again:

1. Open a terminal — press Start, type `cmd`, press Enter
2. Run: `cd C:\Users\ASUS\cents-seat-watcher`
3. Run: `claude`
4. Say: **"read STATUS.md, we're continuing the CEnT-S watcher"**

That last step matters — a new session starts with no memory of the previous one. This
file is the handover note.

Useful commands from that folder:

| Command | What it does |
| --- | --- |
| `npm run check:dry` | Show what the calendar says right now. Sends nothing, saves nothing. Always safe. |
| `npm run telegram:test` | Send yourself a sample alert, to confirm Telegram still works. |
| `npm test` | Run all 60 tests. |
| `git log --oneline` | See what was changed and why. |

**Do not delete `C:\Users\ASUS\cents-seat-watcher\.env`** — it holds the Telegram bot token
and chat id, and it is deliberately not on GitHub, so it exists nowhere else. If it is ever
lost: reissue the token with `/revoke` in @BotFather, and recover the chat id with
`npm run telegram:chatid`.

### Checking on it without touching anything

- **Is it running?** https://github.com/aghiad-jaafar/cents-seat-watcher/actions — green ticks mean healthy.
- **What has it seen?** `state/seen.json` in the repo; its commit history is a log of every calendar change.
- **Is it alive?** The daily 💚 heartbeat on Telegram. If that stops arriving, something is wrong.

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

Built 2026-09-15, deployed and live since 2026-09-18.

| Commit | What it did |
| --- | --- |
| `f91a9a9` | Initial watcher: fetch, parse, diff, filter, notify, state, CI workflows, README |
| `7b3fe9a` | Reworked availability detection to be driven by **status colour** |
| `fe7f2f5` | Remember seat counts the calendar stops publishing |
| `22d8c7f` | Covered the Telegram path; added a delivery self-test |
| `b71f5af` | Added this status document |
| `81e548d` | Load credentials from a gitignored `.env` rather than the command line |
| `f16fdc5` | *(the watcher's own first commit — it saved its baseline unprompted)* |
| `333719f` | Bumped Actions to v5, pinned Node 24 |
| `6fdd6ae` | Rewrote the Telegram messages to be warm and readable |
| `cde92b4` | Updated this document now the watcher is live |
| `5aa1844` | Fixed sample alerts being indistinguishable from real ones |

**60 tests, all passing.** Unit tests for parsing and diffing, end-to-end tests that drive
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

- [x] Telegram bot created (`@Cents_test_watcher_bot`), delivery confirmed
- [x] Pushed to a public GitHub repo, secrets added, workflow permissions set to read/write
- [x] Armed — the watcher has run and committed its own baseline
- [x] Messages rewritten to be readable rather than a data dump

### Still outstanding — one thing

- [ ] **Add a `WATCHER_PAT` secret** so the cron survives past 60 days.

GitHub switches off scheduled workflows in repos with no activity for 60 days, and the
watcher's own commits deliberately do not count. Without this it could go silent around
**mid-November 2026**. Not urgent — the current test deadline is 09/10/2026 — but it matters
if the watch needs to continue into a later CEnT-S macro-period.

To do it: create a fine-grained token at https://github.com/settings/personal-access-tokens/new
scoped to this repo only, with **Contents: read and write**, then add it as a secret named
`WATCHER_PAT`.

---

## What we learned about the site (this shaped the design)

Four things changed the implementation. The first three were verified against the live
site rather than assumed; the fourth was a bug found in the field.

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

### 4. A silent failure mode worth remembering

On 2026-09-18 two sample alerts were mistaken for real free seats. The sample used to mark
itself by passing a calendar name of `CEnT-S (TEST)`, which the formatter printed as a
header. A redesign removed that header, but the parameter carried on being accepted and
silently discarded — nothing errored, the marking simply stopped appearing.

Fixed by moving the marking into `formatSampleAlert`, which wraps the alert in 🧪 banners
top and bottom, and by deleting the now-meaningless parameter rather than leaving a no-op
that invites the same mistake. Two tests pin it in both directions.

**The lesson for future changes:** a parameter that is accepted but unused is not harmless.
If a formatting change drops something, make the old input fail loudly instead of being
quietly ignored.

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

## How it was set up (all done - kept for reference)

### 1. Create the Telegram bot (DONE)

Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token. Send your new bot
a message (it cannot message you first), then:

```bash
cp .env.example .env   # then put your token in it
npm run telegram:chatid
```

### 2. Confirm delivery (DONE)

```bash
npm run telegram:test
```

A sample alert should reach your phone. Common failures are handled with explicit guidance:
`chat not found` means you have not messaged the bot; `Unauthorized` means a bad token.

### 3. Push and arm (DONE)

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
