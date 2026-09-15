/**
 * Turns "previous snapshot vs current snapshot" into a list of events.
 *
 * Persisted state is the only thing stopping this from re-alerting the same
 * open seat every five minutes: an event fires on a TRANSITION, never on a
 * steady state.
 */

import { AVAILABILITY, isAvailable, isExpired } from './parse.js';

export const STATE_VERSION = 2;

export const EVENT = {
  /** A session you were watching turned green. The one that matters. */
  BECAME_AVAILABLE: 'BECAME_AVAILABLE',
  /** A session appeared already green. */
  NEW_ROW_AVAILABLE: 'NEW_ROW_AVAILABLE',
  /** A session exists but its bookings have not been opened yet. */
  NEW_ROW_PENDING: 'NEW_ROW_PENDING',
  /** A test date nobody had published before. */
  NEW_DATE: 'NEW_DATE',
  /** Still bookable, more seats than before - somebody cancelled. */
  SEATS_INCREASED: 'SEATS_INCREASED',
  /** Went from plenty of seats to "few seats left" (green -> orange). */
  RUNNING_LOW: 'RUNNING_LOW',
  /** Was bookable, now is not. */
  BECAME_UNAVAILABLE: 'BECAME_UNAVAILABLE',
};

/** Per-calendar slice of the state file. */
export function emptyCalendarState() {
  return { rows: {}, dates: [] };
}

/** Whole state document. Calendars are namespaced so two calendars cannot collide. */
export function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: null,
    lastHeartbeatAt: null,
    consecutiveFailures: 0,
    calendars: {},
  };
}

/** Snapshot the parts of a row worth persisting. */
function snapshot(row) {
  return { availability: row.availability, seats: row.seats };
}

const bookable = (availability) =>
  availability === AVAILABILITY.OPEN || availability === AVAILABILITY.OPEN_LIMITED;

/** Sort DD/MM/YYYY chronologically. */
function byDate(a, b) {
  const key = (d) => String(d).split('/').reverse().join('');
  return key(a).localeCompare(key(b));
}

/**
 * @param {object} previous per-calendar state (see emptyCalendarState)
 * @param {object[]} rows freshly parsed rows
 * @returns {{events: object[], nextRows: object, nextDates: string[], seeded: boolean}}
 */
export function diffRows(previous, rows) {
  const prevRows = previous?.rows ?? {};
  const prevDates = new Set(previous?.dates ?? []);
  const isFirstRun = Object.keys(prevRows).length === 0;

  const nextRows = {};
  for (const row of rows) nextRows[row.key] = snapshot(row);

  const nextDates = [...new Set(rows.map((r) => r.date))].sort(byDate);

  // First ever run: adopt reality as the baseline and stay quiet, otherwise
  // every row in the calendar would be reported as "new".
  if (isFirstRun) {
    return { events: [], nextRows, nextDates, seeded: true };
  }

  const events = [];

  for (const row of rows) {
    // An expired booking window is dead; nothing about it is ever news.
    if (isExpired(row)) continue;

    const prev = prevRows[row.key];

    if (!prev) {
      if (isAvailable(row)) {
        events.push({ type: EVENT.NEW_ROW_AVAILABLE, row });
      } else if (row.availability === AVAILABILITY.NOT_OPEN) {
        // The case that is invisible if you only watch for green: a session
        // exists whose bookings have not been opened yet.
        events.push({ type: EVENT.NEW_ROW_PENDING, row });
      }
      continue;
    }

    const wasBookable = bookable(prev.availability);
    const nowBookable = isAvailable(row);

    if (!wasBookable && nowBookable) {
      events.push({ type: EVENT.BECAME_AVAILABLE, row, previous: prev });
    } else if (wasBookable && nowBookable) {
      if (row.seats != null && prev.seats != null && row.seats > prev.seats) {
        events.push({ type: EVENT.SEATS_INCREASED, row, previous: prev });
      } else if (
        prev.availability === AVAILABILITY.OPEN &&
        row.availability === AVAILABILITY.OPEN_LIMITED
      ) {
        events.push({ type: EVENT.RUNNING_LOW, row, previous: prev });
      }
    } else if (wasBookable && !nowBookable) {
      events.push({ type: EVENT.BECAME_UNAVAILABLE, row, previous: prev });
    }
  }

  // A university publishing a whole new test date is worth knowing about even
  // if its rows are not bookable the instant we see them.
  for (const date of nextDates) {
    if (prevDates.has(date)) continue;
    const dateRows = rows.filter((r) => r.date === date);
    // A date that arrives already expired is history, not news.
    if (dateRows.every(isExpired)) continue;
    events.push({ type: EVENT.NEW_DATE, date, rows: dateRows });
  }

  return { events, nextRows, nextDates, seeded: false };
}
