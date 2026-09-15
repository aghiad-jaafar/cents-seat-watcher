#!/usr/bin/env node
/**
 * CEnT-S seat watcher - entry point.
 *
 * Runs on GitHub Actions. The runner is ephemeral, so `state/seen.json` is
 * committed back to the repo and IS the database: it is what makes an alert
 * fire once on a transition rather than every five minutes forever.
 *
 * Flags:
 *   --once      single poll instead of the in-run poll loop
 *   --dry-run   fetch, parse and diff, but send nothing and write nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchCalendar } from './fetchCalendar.js';
import { parseCalendar, isAvailable, isPending, isExpired } from './parse.js';
import { diffRows, emptyState, emptyCalendarState, STATE_VERSION } from './diff.js';
import { filterEvents, matchesFilter } from './filter.js';
import {
  formatTelegram,
  formatEmail,
  formatHeartbeat,
  formatFailureWarning,
} from './format.js';
import { sendTelegram, telegramConfigured } from './notify/telegram.js';
import { sendEmail, emailConfigured } from './notify/email.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so tests can run against a throwaway config and state file.
const CONFIG_PATH = process.env.WATCHER_CONFIG ?? path.join(ROOT, 'config.json');
const STATE_PATH = process.env.WATCHER_STATE ?? path.join(ROOT, 'state', 'seen.json');

/** If the row count collapses below this fraction of what we knew, distrust it. */
const CLIFF_RATIO = 0.3;
/** Warn after this many consecutive failed checks. */
const FAILURE_ALERT_THRESHOLD = 3;

const argv = new Set(process.argv.slice(2));
const ONCE = argv.has('--once');
const DRY_RUN = argv.has('--dry-run');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`could not read ${path.basename(file)}: ${error.message}`);
  }
}

function loadState() {
  const state = loadJson(STATE_PATH, emptyState());
  state.calendars ??= {};
  state.consecutiveFailures ??= 0;

  // What a stored snapshot means changed in v2 (an availability class derived
  // from colour, rather than the raw label). Re-seed rather than diff against
  // incomparable data, which would fire a flood of bogus transitions.
  if (state.version !== STATE_VERSION) {
    log(`state is v${state.version ?? 'unknown'}, expected v${STATE_VERSION}; re-seeding baseline`);
    state.version = STATE_VERSION;
    state.calendars = {};
  }
  return state;
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  log(`state written to ${path.relative(ROOT, STATE_PATH)}`);
}

/** Fan a message out to every configured channel. */
async function notify(messages, { emailPayload } = {}) {
  const list = Array.isArray(messages) ? messages : [messages];
  if (list.length === 0) return;

  if (DRY_RUN) {
    log('--dry-run: would have sent:\n' + list.join('\n---\n'));
    return;
  }

  if (telegramConfigured()) {
    await sendTelegram(list, { log });
  } else {
    log('WARNING: Telegram is not configured; alert not delivered');
  }

  if (emailPayload && emailConfigured()) {
    await sendEmail(emailPayload, { log });
  }
}

/**
 * Check one calendar once. Mutates `state`.
 * @returns {{ok: boolean, rows?: object[], alerted: boolean}}
 */
async function checkCalendar(calendar, state, config) {
  const name = calendar.name;
  const previous = state.calendars[name] ?? emptyCalendarState();

  let rows;
  try {
    const html = await fetchCalendar(calendar.url, { log });
    const parsed = parseCalendar(html);
    rows = parsed.rows;
    if (parsed.unknownColours.length > 0) {
      // An unseen colour is classified as bookable, erring towards alerting.
      log(`NOTE: unrecognised STATE colour(s): ${parsed.unknownColours.join(', ')}`);
    }
  } catch (error) {
    // Deliberately do NOT touch rows/dates here. Overwriting the baseline with
    // nothing would make the next successful run treat the whole calendar as
    // new and fire a flood of false alerts.
    state.consecutiveFailures += 1;
    log(`ERROR checking ${name}: ${error.message} (consecutive failures: ${state.consecutiveFailures})`);

    if (state.consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
      await notify(formatFailureWarning(name, state.consecutiveFailures, error.message)).catch((e) =>
        log(`could not deliver failure warning: ${e.message}`),
      );
    }
    return { ok: false, alerted: false };
  }

  state.consecutiveFailures = 0;

  const knownCount = Object.keys(previous.rows).length;
  if (knownCount > 0 && rows.length < knownCount * CLIFF_RATIO) {
    log(`SUSPICIOUS: row count fell from ${knownCount} to ${rows.length}; not updating baseline`);
    const warning =
      `<b>⚠️ Unexpected calendar shrink</b>\n` +
      `${name}: ${knownCount} → ${rows.length} rows. ` +
      `Baseline left untouched; check the page manually.`;
    await notify(warning).catch((e) => log(`could not deliver shrink warning: ${e.message}`));
    return { ok: true, rows, alerted: false };
  }

  const { events, nextRows, nextDates, seeded } = diffRows(previous, rows);
  const alerts = filterEvents(events, config);

  log(
    `${name}: ${rows.length} rows (${rows.filter(isAvailable).length} bookable, ` +
      `${rows.filter(isPending).length} pending, ${rows.filter(isExpired).length} expired), ` +
      `${events.length} change(s), ${alerts.length} alert(s)`,
  );

  if (seeded) {
    const mine = rows.filter((r) => matchesFilter(r, config.filter));
    log(`${name}: first run - adopting ${rows.length} rows as the baseline, staying quiet`);
    const armed =
      `<b>✅ Watcher armed</b>\n` +
      `${name}: baseline set from ${rows.length} sessions.\n` +
      `Matching your filter: ${mine.filter(isAvailable).length} bookable now, ` +
      `${mine.filter(isPending).length} still live (sold out or not yet open).\n` +
      `You will be pinged when any of them turns green.`;
    await notify(armed);
    // The "armed" message is itself proof of life; don't follow it with a heartbeat.
    state.lastHeartbeatAt = new Date().toISOString();
  } else if (alerts.length > 0) {
    await notify(formatTelegram(alerts, { calendarName: name }), {
      emailPayload: formatEmail(alerts, { calendarName: name }),
    });
  }

  state.calendars[name] = { rows: nextRows, dates: nextDates };
  return { ok: true, rows, alerted: alerts.length > 0 || seeded };
}

async function maybeHeartbeat(state, config, rowsByCalendar) {
  const hours = Number(config.heartbeatHours ?? 24);
  if (!(hours > 0)) return false;

  const last = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : 0;
  if (Number.isFinite(last) && last > 0 && Date.now() - last < hours * 3_600_000) return false;

  for (const [calendarName, rows] of Object.entries(rowsByCalendar)) {
    // Expired rows are noise in a status report; count only what can still change.
    const live = rows.filter((r) => !isExpired(r));
    const snapshots = state.calendars[calendarName]?.rows ?? {};

    // Sessions you care about that have not happened yet, annotated with the
    // last seat count we saw while they were bookable.
    const watchlist = live
      .filter((r) => matchesFilter(r, config.filter))
      .map((r) => ({
        date: r.date,
        city: r.city,
        availability: r.availability,
        lastSeats: r.seats ?? snapshots[r.key]?.lastSeats ?? null,
        lastSeatsOn: r.seats != null ? 'today' : snapshots[r.key]?.lastSeatsOn ?? null,
      }));

    await notify(
      formatHeartbeat({
        calendarName,
        tracked: live.length,
        available: live.filter(isAvailable).length,
        pending: live.filter(isPending).length,
        matching: live.filter((r) => isAvailable(r) && matchesFilter(r, config.filter)).length,
        watchlist,
      }),
    );
  }
  state.lastHeartbeatAt = new Date().toISOString();
  return true;
}

async function main() {
  const config = loadJson(CONFIG_PATH);
  const calendars = config.calendars ?? [];
  if (calendars.length === 0) throw new Error('config.json lists no calendars');

  const iterations = ONCE ? 1 : Math.max(1, Number(process.env.POLL_ITERATIONS ?? 3));
  const intervalMs = Math.max(30, Number(process.env.POLL_INTERVAL_SEC ?? 90)) * 1000;

  const state = loadState();
  let dirty = false;
  let anyFailure = false;
  const rowsByCalendar = {};

  log(`starting: ${iterations} poll(s), ${intervalMs / 1000}s apart, dryRun=${DRY_RUN}`);

  for (let i = 1; i <= iterations; i += 1) {
    if (iterations > 1) log(`--- poll ${i}/${iterations} ---`);

    for (const calendar of calendars) {
      const result = await checkCalendar(calendar, state, config);
      if (result.rows) rowsByCalendar[calendar.name] = result.rows;
      if (!result.ok) anyFailure = true;
      dirty = true;

      // Persist immediately after an alert so a job killed mid-loop can at
      // worst repeat an alert, and never silently swallows one.
      if (result.alerted && !DRY_RUN) saveState(state);
    }

    if (i < iterations) await sleep(intervalMs);
  }

  if (Object.keys(rowsByCalendar).length > 0) {
    await maybeHeartbeat(state, config, rowsByCalendar);
  }

  if (dirty && !DRY_RUN) saveState(state);

  if (anyFailure) {
    log('finished with errors');
    process.exitCode = 1;
  } else {
    log('finished cleanly');
  }
}

main().catch((error) => {
  log(`FATAL: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
