import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCalendar,
  classifyAvailability,
  extractColour,
  ParseError,
  rowKey,
  toISODate,
  isAvailable,
  isPending,
  isExpired,
  AVAILABILITY,
} from '../src/parse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');

const CENTS = read('cents-2026-09-15.html');
// A larger TOLC calendar, captured because it is the only page that exercises
// every state the site can render, including Orange and ISCRIZIONI CHIUSE.
const FARMACIA = read('tolc-farmacia-2026-09-15.html');

test('parses every row of the CEnT-S page', () => {
  const { rows, unknownColours } = parseCalendar(CENTS);
  assert.equal(rows.length, 26);
  assert.deepEqual(unknownColours, [], 'an unknown colour means the site changed its palette');
});

test('extracts all eight columns correctly', () => {
  const { rows } = parseCalendar(CENTS);
  const row = rows.find((r) => r.city === 'SIENA' && isAvailable(r));

  assert.equal(row.format, 'CENT@UNI');
  assert.equal(row.university, "Universita' di Siena - Economia");
  assert.equal(row.region, 'TOSCANA');
  assert.equal(row.deadline, '09/10/2026');
  assert.equal(row.seats, 52);
  assert.equal(row.date, '15/10/2026');
  assert.equal(row.dateISO, '2026-10-15');
  assert.equal(row.colour, 'limegreen');
  assert.equal(row.bookingUrl, 'https://testcisia.it/studenti_tolc/login_sso.php');
});

// --- colour is the signal -------------------------------------------------

test('every state the site renders is classified', () => {
  const { rows, unknownColours } = parseCalendar(FARMACIA);
  assert.deepEqual(unknownColours, []);

  const seen = new Set(rows.map((r) => r.availability));
  for (const expected of Object.values(AVAILABILITY)) {
    assert.ok(seen.has(expected), `fixture should exercise ${expected}`);
  }
});

test('green means bookable', () => {
  assert.equal(
    classifyAvailability({ colour: 'limegreen', label: 'POSTI DISPONIBILI', deadlineExpired: false, hasBookingLink: true }),
    AVAILABILITY.OPEN,
  );
});

// Orange renders the same words as green but means "hurry" - text matching
// alone cannot tell them apart.
test('orange means bookable but running out', () => {
  assert.equal(
    classifyAvailability({ colour: 'orange', label: 'POSTI DISPONIBILI', deadlineExpired: false, hasBookingLink: true }),
    AVAILABILITY.OPEN_LIMITED,
  );

  const { rows } = parseCalendar(FARMACIA);
  const limited = rows.filter((r) => r.availability === AVAILABILITY.OPEN_LIMITED);
  assert.ok(limited.length > 0, 'fixture must contain an orange row');
  for (const row of limited) {
    assert.equal(isAvailable(row), true, 'orange is bookable');
    assert.ok(row.seats > 0);
    assert.ok(row.bookingUrl, 'orange rows carry a booking link');
  }
});

test('red is never bookable, whatever the wording', () => {
  for (const label of ['POSTI ESAURITI', 'ISCRIZIONI CONCLUSE', 'ISCRIZIONI CHIUSE', 'SOMETHING NEW']) {
    const result = classifyAvailability({ colour: 'crimson', label, deadlineExpired: false, hasBookingLink: false });
    assert.notEqual(result, AVAILABILITY.OPEN);
    assert.notEqual(result, AVAILABILITY.OPEN_LIMITED);
  }
});

// The three red meanings are separated by the deadline cell, not by language.
test('a struck-through deadline means expired, not merely closed', () => {
  assert.equal(
    classifyAvailability({ colour: 'crimson', label: 'ISCRIZIONI CONCLUSE', deadlineExpired: true, hasBookingLink: false }),
    AVAILABILITY.EXPIRED,
  );
  assert.equal(
    classifyAvailability({ colour: 'crimson', label: 'ISCRIZIONI CHIUSE', deadlineExpired: false, hasBookingLink: false }),
    AVAILABILITY.NOT_OPEN,
  );
});

test('sold out is distinguished from not-yet-open in both languages', () => {
  const red = { colour: 'crimson', deadlineExpired: false, hasBookingLink: false };
  assert.equal(classifyAvailability({ ...red, label: 'POSTI ESAURITI' }), AVAILABILITY.FULL);
  assert.equal(classifyAvailability({ ...red, label: 'NOT LONGER AVAILABLE' }), AVAILABILITY.FULL);
  assert.equal(classifyAvailability({ ...red, label: 'ISCRIZIONI CHIUSE' }), AVAILABILITY.NOT_OPEN);
});

test('an unrecognised colour is treated as bookable rather than ignored', () => {
  assert.equal(
    classifyAvailability({ colour: 'blue', label: 'QUALCOSA', deadlineExpired: false, hasBookingLink: true }),
    AVAILABILITY.OPEN,
    'a new colour should over-alert, never silently hide a seat',
  );
});

test('a colourless cell falls back to whether a booking link was offered', () => {
  assert.equal(
    classifyAvailability({ colour: null, label: '', deadlineExpired: false, hasBookingLink: true }),
    AVAILABILITY.OPEN,
  );
  assert.equal(
    classifyAvailability({ colour: null, label: '', deadlineExpired: false, hasBookingLink: false }),
    AVAILABILITY.NOT_OPEN,
  );
});

test('extractColour reads the inline style', () => {
  assert.equal(extractColour('<span style="color: LimeGreen;font-weight:bold;">x</span>'), 'limegreen');
  assert.equal(extractColour('<span>x</span>'), null);
});

// --- the seat-count trap --------------------------------------------------

test('expired rows keep a stale seat count and are never bookable', () => {
  const { rows } = parseCalendar(CENTS);
  const stale = rows.filter((r) => isExpired(r) && r.seats > 0);

  assert.ok(stale.length > 0, 'fixture should contain expired rows with leftover seat counts');
  for (const row of stale) assert.equal(isAvailable(row), false);
});

test('sold-out rows report null seats, not zero', () => {
  const { rows } = parseCalendar(CENTS);
  const full = rows.filter((r) => r.availability === AVAILABILITY.FULL);

  assert.ok(full.length > 0);
  for (const row of full) assert.equal(row.seats, null);
});

test('pending covers sold-out and not-yet-open, but never expired', () => {
  const { rows } = parseCalendar(FARMACIA);
  for (const row of rows) {
    assert.equal(isPending(row), row.availability === AVAILABILITY.FULL || row.availability === AVAILABILITY.NOT_OPEN);
    assert.equal(isAvailable(row) && isPending(row), false, 'a row cannot be both');
    if (isExpired(row)) assert.equal(isPending(row), false);
  }
});

// --- identity and misc ----------------------------------------------------

test('decodes accented university names', () => {
  const { rows } = parseCalendar(CENTS);
  assert.ok(rows.some((r) => r.university.includes('Università')));
});

test('row keys are stable and unique', () => {
  const { rows } = parseCalendar(CENTS);
  const keys = rows.map(rowKey);
  assert.equal(new Set(keys).size, keys.length, 'duplicate keys would make rows shadow each other');
});

test('row key ignores volatile columns', () => {
  const base = { format: 'CENT@HOME', university: 'Uni X', city: 'ROMA', date: '15/10/2026' };
  assert.equal(
    rowKey({ ...base, seats: 0, deadline: '01/01/2026' }),
    rowKey({ ...base, seats: 40, deadline: '09/10/2026' }),
    'a changed seat count or deadline must not look like a brand-new row',
  );
});

test('toISODate handles the page format and rejects junk', () => {
  assert.equal(toISODate('15/10/2026'), '2026-10-15');
  assert.equal(toISODate('nonsense'), null);
  assert.equal(toISODate(undefined), null);
});

test('throws rather than returning nothing when the table is missing', () => {
  assert.throws(() => parseCalendar('<html><body>Service unavailable</body></html>'), ParseError);
  assert.throws(() => parseCalendar(''), ParseError);
});

test('throws when the table exists but holds no usable rows', () => {
  const empty = '<table id="calendario"><tr class="head"><th>FORMAT</th></tr></table>';
  assert.throws(() => parseCalendar(empty), ParseError);
});

test('ignores tables other than the calendar', () => {
  const decoy = `<table id="other"><tr><td>a</td></tr></table>${CENTS}`;
  assert.equal(parseCalendar(decoy).rows.length, 26);
});
