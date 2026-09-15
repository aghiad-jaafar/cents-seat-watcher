import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCalendar, AVAILABILITY } from '../src/parse.js';
import { diffRows, emptyCalendarState, EVENT } from '../src/diff.js';
import { filterEvents, matchesFilter, shouldAlert } from '../src/filter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENTS = fs.readFileSync(path.join(HERE, 'fixtures', 'cents-2026-09-15.html'), 'utf8');
const { rows: LIVE_ROWS } = parseCalendar(CENTS);

const CONFIG = {
  filter: { formats: ['CENT@HOME'], universities: [], cities: [] },
  alertOnNewDate: true,
  alertOnNotYetOpen: true,
  alertOnRunningLow: true,
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
  deadlineExpired: false,
  seats: null,
  label: 'POSTI ESAURITI',
  colour: 'crimson',
  availability: AVAILABILITY.FULL,
  date: '15/10/2026',
  dateISO: '2026-10-15',
  bookingUrl: null,
  key: 'CENT@HOME|Universita degli studi di Udine|UDINE|15/10/2026',
  ...over,
});

const open = (over = {}) =>
  row({ availability: AVAILABILITY.OPEN, colour: 'limegreen', seats: 12, bookingUrl: 'https://x', ...over });

test('first run seeds silently instead of alerting on the whole calendar', () => {
  const result = diffRows(emptyCalendarState(), LIVE_ROWS);
  assert.equal(result.seeded, true);
  assert.equal(result.events.length, 0);
  assert.equal(Object.keys(result.nextRows).length, 26);
  assert.deepEqual(result.nextDates, ['17/09/2026', '15/10/2026']);
});

test('an unchanged calendar produces no events (dedup)', () => {
  assert.equal(diffRows(stateFrom(LIVE_ROWS), LIVE_ROWS).events.length, 0);
});

test('a seat freeing up fires exactly one alert, then goes quiet', () => {
  const first = diffRows(stateFrom([row()]), [open({ seats: 3 })]);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].type, EVENT.BECAME_AVAILABLE);

  const second = diffRows({ rows: first.nextRows, dates: first.nextDates }, [open({ seats: 3 })]);
  assert.equal(second.events.length, 0);
});

test('a not-yet-open session turning green alerts', () => {
  const before = [row({ availability: AVAILABILITY.NOT_OPEN, label: 'ISCRIZIONI CHIUSE' })];
  const { events } = diffRows(stateFrom(before), [open({ seats: 40 })]);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENT.BECAME_AVAILABLE);
});

// The case that is invisible if you only watch for green.
test('a newly discovered session with bookings not yet open is reported', () => {
  const existing = row({ key: 'existing' });
  const pending = row({
    key: 'CENT@HOME|Uni Nuova|MILANO|20/11/2026',
    university: 'Uni Nuova',
    city: 'MILANO',
    date: '20/11/2026',
    availability: AVAILABILITY.NOT_OPEN,
    label: 'ISCRIZIONI CHIUSE',
  });

  const { events } = diffRows(stateFrom([existing]), [existing, pending]);
  const found = events.find((e) => e.type === EVENT.NEW_ROW_PENDING);

  assert.ok(found, 'a session whose bookings have not opened should be surfaced');
  assert.equal(found.row.city, 'MILANO');
  assert.equal(shouldAlert(found, CONFIG), true);
  assert.equal(shouldAlert(found, { ...CONFIG, alertOnNotYetOpen: false }), false);
});

test('a newly discovered sold-out session is not reported as pending news', () => {
  const existing = row({ key: 'existing' });
  const soldOut = row({ key: 'other', city: 'BARI', availability: AVAILABILITY.FULL });

  const { events } = diffRows(stateFrom([existing]), [existing, soldOut]);
  assert.equal(events.some((e) => e.type === EVENT.NEW_ROW_PENDING), false);
});

test('green turning orange warns that seats are running out', () => {
  const before = [open({ seats: 30 })];
  const after = [open({ seats: 4, availability: AVAILABILITY.OPEN_LIMITED, colour: 'orange' })];

  const { events } = diffRows(stateFrom(before), after);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENT.RUNNING_LOW);
  assert.equal(shouldAlert(events[0], CONFIG), true);
});

test('orange is still bookable, so it never counts as losing availability', () => {
  const before = [open({ seats: 30 })];
  const after = [open({ seats: 4, availability: AVAILABILITY.OPEN_LIMITED, colour: 'orange' })];
  const { events } = diffRows(stateFrom(before), after);
  assert.notEqual(events[0].type, EVENT.BECAME_UNAVAILABLE);
});

test('expired rows never generate events', () => {
  const before = [open({ seats: 5 })];
  const after = [
    row({ availability: AVAILABILITY.EXPIRED, deadlineExpired: true, label: 'ISCRIZIONI CONCLUSE', seats: 5 }),
  ];
  const { events } = diffRows(stateFrom(before), after);
  assert.equal(events.length, 0, 'a passed deadline is not news');
});

test('seat increases and decreases are treated differently', () => {
  const before = [open({ seats: 2 })];

  const up = diffRows(stateFrom(before), [open({ seats: 5 })]);
  assert.equal(up.events[0].type, EVENT.SEATS_INCREASED);
  assert.equal(up.events[0].previous.seats, 2);

  const down = diffRows(stateFrom(before), [open({ seats: 1 })]);
  assert.equal(down.events.length, 0, 'someone else booking is not news');
});

test('losing availability is detected but silent by default', () => {
  const { events } = diffRows(stateFrom([open({ seats: 5 })]), [row()]);

  assert.equal(events[0].type, EVENT.BECAME_UNAVAILABLE);
  assert.equal(filterEvents(events, CONFIG).length, 0);
  assert.equal(filterEvents(events, { ...CONFIG, alertOnClose: true }).length, 1);
});

test('a brand new bookable session alerts', () => {
  const { events } = diffRows(stateFrom([row()]), [
    row(),
    open({ key: 'CENT@HOME|Uni Nuova|MILANO|15/10/2026', university: 'Uni Nuova', city: 'MILANO', seats: 9 }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENT.NEW_ROW_AVAILABLE);
});

test('a newly published test date is reported even if not yet bookable', () => {
  const { events } = diffRows(stateFrom([row()]), [
    row(),
    row({ key: 'CENT@HOME|Uni X|ROMA|20/11/2026', city: 'ROMA', date: '20/11/2026' }),
  ]);

  const newDate = events.find((e) => e.type === EVENT.NEW_DATE);
  assert.ok(newDate);
  assert.equal(newDate.date, '20/11/2026');
});

test('a date that arrives already expired is not announced', () => {
  const { events } = diffRows(stateFrom([row()]), [
    row(),
    row({
      key: 'CENT@HOME|Uni X|ROMA|01/01/2026',
      city: 'ROMA',
      date: '01/01/2026',
      availability: AVAILABILITY.EXPIRED,
      deadlineExpired: true,
    }),
  ]);
  assert.equal(events.some((e) => e.type === EVENT.NEW_DATE), false);
});

// --- filtering ------------------------------------------------------------

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

test('CENT@UNI availability is tracked but filtered out of alerts', () => {
  const before = [row({ format: 'CENT@UNI', key: 'uni-key' })];
  const after = [open({ format: 'CENT@UNI', key: 'uni-key', seats: 7 })];

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
