/**
 * Turns "previous snapshot vs current snapshot" into a list of events.
 *
 * Persisted state is the only thing stopping this from re-alerting the same
 * open seat every five minutes: an event fires on a TRANSITION, never on a
 * steady state.
 */

import { AVAILABLE } from './parse.js';

export const EVENT = {
  BECAME_AVAILABLE: 'BECAME_AVAILABLE',
  NEW_ROW_AVAILABLE: 'NEW_ROW_AVAILABLE',
  NEW_DATE: 'NEW_DATE',
  SEATS_INCREASED: 'SEATS_INCREASED',
  BECAME_UNAVAILABLE: 'BECAME_UNAVAILABLE',
};

/** Per-calendar slice of the state file. */
export function emptyCalendarState() {
  return { rows: {}, dates: [] };
}

/** Whole state document. Calendars are namespaced so two calendars cannot collide. */
export function emptyState() {
  return {
    version: 1,
    updatedAt: null,
    lastHeartbeatAt: null,
    consecutiveFailures: 0,
    calendars: {},
  };
}

/** Snapshot the parts of a row worth persisting. */
function snapshot(row) {
  return { state: row.state, seats: row.seats };
}

/**
 * @param {object} previous state object (see emptyState)
 * @param {object[]} rows freshly parsed rows
 * @returns {{events: object[], nextRows: object, nextDates: string[], seeded: boolean}}
 */
export function diffRows(previous, rows) {
  const prevRows = previous?.rows ?? {};
  const prevDates = new Set(previous?.dates ?? []);
  const isFirstRun = Object.keys(prevRows).length === 0;

  const nextRows = {};
  for (const row of rows) nextRows[row.key] = snapshot(row);

  const nextDates = [...new Set(rows.map((r) => r.date))].sort((a, b) =>
    String(a).split('/').reverse().join('').localeCompare(String(b).split('/').reverse().join('')),
  );

  // First ever run: adopt reality as the baseline and stay quiet, otherwise
  // every row in the calendar would be reported as "new".
  if (isFirstRun) {
    return { events: [], nextRows, nextDates, seeded: true };
  }

  const events = [];

  for (const row of rows) {
    const prev = prevRows[row.key];

    if (!prev) {
      if (row.state === AVAILABLE) {
        events.push({ type: EVENT.NEW_ROW_AVAILABLE, row });
      }
      continue;
    }

    const wasAvailable = prev.state === AVAILABLE;
    const nowAvailable = row.state === AVAILABLE;

    if (!wasAvailable && nowAvailable) {
      events.push({ type: EVENT.BECAME_AVAILABLE, row, previous: prev });
    } else if (wasAvailable && nowAvailable) {
      if (row.seats != null && prev.seats != null && row.seats > prev.seats) {
        events.push({ type: EVENT.SEATS_INCREASED, row, previous: prev });
      }
    } else if (wasAvailable && !nowAvailable) {
      events.push({ type: EVENT.BECAME_UNAVAILABLE, row, previous: prev });
    }
  }

  // A university publishing a whole new test date is worth knowing about even
  // if its rows are not bookable the instant we see them.
  for (const date of nextDates) {
    if (prevDates.has(date)) continue;
    events.push({
      type: EVENT.NEW_DATE,
      date,
      rows: rows.filter((r) => r.date === date),
    });
  }

  return { events, nextRows, nextDates, seeded: false };
}
