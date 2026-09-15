import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCalendar, AVAILABLE, FULL, CLOSED } from '../src/parse.js';
import { diffRows, emptyCalendarState, EVENT } from '../src/diff.js';
import { filterEvents, matchesFilter, shouldAlert } from '../src/filter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'cents-2026-09-15.html'), 'utf8');
const { rows: LIVE_ROWS } = parseCalendar(FIXTURE);

const CONFIG = {
  filter: { formats: ['CENT@HOME'], universities: [], cities: [] },
  alertOnNewDate: true,
  alertOnSeatIncrease: true,
  alertOnClose: false,
};

/** Build a state object as if `rows` had already been seen. */
function stateFrom(rows) {
  const { nextRows, nextDates } = diffRows(emptyCalendarState(), rows);
  return { rows: nextRows, dates: nextDates };
}

const row = (over = {}) => ({
  format: 'CENT@HOME',
  university: 'Universita degli studi di Udine',
  region: 'FRIULI-VENEZIA GIULIA',
  city: 'UDINE',
  deadline: '09/10/2026',
  seats: null,
  state: FULL,
  date: '15/10/2026',
  dateISO: '2026-10-15',
  bookingUrl: null,
  key: 'CENT@HOME|Universita degli studi di Udine|UDINE|15/10/2026',
  ...over,
});

test('first run seeds silently instead of alerting on the whole calendar', () => {
  const result = diffRows(emptyCalendarState(), LIVE_ROWS);
  assert.equal(result.seeded, true);
  assert.equal(result.events.length, 0);
  assert.equal(Object.keys(result.nextRows).length, 26);
  assert.deepEqual(result.nextDates, ['17/09/2026', '15/10/2026']);
});

test('an unchanged calendar produces no events (dedup)', () => {
  const { events } = diffRows(stateFrom(LIVE_ROWS), LIVE_ROWS);
  assert.equal(events.length, 0);
});

test('a seat freeing up fires exactly one BECAME_AVAILABLE, then goes quiet', () => {
  const before = [row({ state: FULL, seats: null })];
  const after = [row({ state: AVAILABLE, seats: 3 })];

  const first = diffRows(stateFrom(before), after);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, EVENT.BECAME_AVAILABLE);

  // Re-running against the same reality must stay silent.
  const second = diffRows({ rows: first.nextRows, dates: first.nextDates }, after);
  assert.equal(second.events.length, 0);
});

test('a closed row keeping stale seats never fires an alert', () => {
  const before = [row({ state: CLOSED, seats: 42 })];
  const after = [row({ state: CLOSED, seats: 42 })];
  assert.equal(diffRows(stateFrom(before), after).events.length, 0);
});

test('seat increases and decreases are treated differently', () => {
  const before = [row({ state: AVAILABLE, seats: 2 })];

  const up = diffRows(stateFrom(before), [row({ state: AVAILABLE, seats: 5 })]);
  assert.equal(up.events[0].type, EVENT.SEATS_INCREASED);
  assert.equal(up.events[0].previous.seats, 2);

  const down = diffRows(stateFrom(before), [row({ state: AVAILABLE, seats: 1 })]);
  assert.equal(down.events.length, 0, 'someone else booking is not news');
});

test('losing availability is detected but silent by default', () => {
  const before = [row({ state: AVAILABLE, seats: 5 })];
  const { events } = diffRows(stateFrom(before), [row({ state: FULL, seats: null })]);

  assert.equal(events[0].type, EVENT.BECAME_UNAVAILABLE);
  assert.equal(filterEvents(events, CONFIG).length, 0);
  assert.equal(filterEvents(events, { ...CONFIG, alertOnClose: true }).length, 1);
});

test('a brand new bookable session alerts', () => {
  const { events } = diffRows(stateFrom([row()]), [
    row(),
    row({ key: 'CENT@HOME|Uni Nuova|MILANO|15/10/2026', university: 'Uni Nuova', city: 'MILANO', state: AVAILABLE, seats: 9 }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENT.NEW_ROW_AVAILABLE);
});

test('a newly published test date is reported even if not yet bookable', () => {
  const { events } = diffRows(stateFrom([row()]), [
    row(),
    row({ key: 'CENT@HOME|Uni X|ROMA|20/11/2026', city: 'ROMA', date: '20/11/2026', state: FULL }),
  ]);

  const newDate = events.find((e) => e.type === EVENT.NEW_DATE);
  assert.ok(newDate);
  assert.equal(newDate.date, '20/11/2026');
  assert.equal(newDate.rows.length, 1);
});

test('filter keeps CENT@HOME and drops CENT@UNI', () => {
  assert.equal(matchesFilter(row({ format: 'CENT@HOME' }), CONFIG.filter), true);
  assert.equal(matchesFilter(row({ format: 'CENT@UNI' }), CONFIG.filter), false);
});

test('an empty filter list means no constraint', () => {
  assert.equal(matchesFilter(row({ format: 'CENT@UNI' }), {}), true);
});

test('university and city filters match case-insensitive substrings', () => {
  const filter = { formats: [], universities: ['udine'], cities: [] };
  assert.equal(matchesFilter(row(), filter), true);
  assert.equal(matchesFilter(row({ university: 'Politecnico di Milano' }), filter), false);
});

test('CENT@UNI availability is filtered out of alerts under the current config', () => {
  const before = [row({ format: 'CENT@UNI', key: 'uni-key', state: FULL })];
  const after = [row({ format: 'CENT@UNI', key: 'uni-key', state: AVAILABLE, seats: 7 })];

  const { events } = diffRows(stateFrom(before), after);
  assert.equal(events.length, 1, 'the change is still tracked...');
  assert.equal(filterEvents(events, CONFIG).length, 0, '...but does not alert');
});

// Rows must be tracked regardless of filter, otherwise widening the filter later
// replays every previously hidden row as "new" and floods the user.
test('filtered-out rows are still recorded in state', () => {
  const { nextRows } = diffRows(emptyCalendarState(), LIVE_ROWS);
  const uniRows = Object.keys(nextRows).filter((k) => k.startsWith('CENT@UNI'));
  assert.ok(uniRows.length > 0, 'CENT@UNI rows must be tracked even though they never alert');
});

test('shouldAlert requires only one matching row for a multi-row event', () => {
  const event = {
    type: EVENT.NEW_DATE,
    date: '20/11/2026',
    rows: [row({ format: 'CENT@UNI' }), row({ format: 'CENT@HOME' })],
  };
  assert.equal(shouldAlert(event, CONFIG), true);
});
