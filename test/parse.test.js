import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCalendar,
  ParseError,
  rowKey,
  toISODate,
  isAvailable,
  AVAILABLE,
  CLOSED,
  FULL,
} from '../src/parse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'cents-2026-09-15.html'), 'utf8');

test('parses every row of the real calendar page', () => {
  const { rows, unknownStates } = parseCalendar(FIXTURE);
  assert.equal(rows.length, 26);
  assert.deepEqual(unknownStates, [], 'an unknown STATE means the site changed its wording');
  assert.equal(rows.filter(isAvailable).length, 3);
});

test('extracts all eight columns correctly', () => {
  const { rows } = parseCalendar(FIXTURE);
  const row = rows.find((r) => r.city === 'SIENA' && r.state === AVAILABLE);

  assert.equal(row.format, 'CENT@UNI');
  assert.equal(row.university, "Universita' di Siena - Economia");
  assert.equal(row.region, 'TOSCANA');
  assert.equal(row.deadline, '09/10/2026');
  assert.equal(row.seats, 52);
  assert.equal(row.date, '15/10/2026');
  assert.equal(row.dateISO, '2026-10-15');
  assert.equal(row.bookingUrl, 'https://testcisia.it/studenti_tolc/login_sso.php');
});

// This is the single most important behaviour in the parser. A closed row still
// renders a stale non-zero seat count; treating seats > 0 as "bookable" would
// fire a false alert on every closed session in the calendar.
test('BOOKINGS CLOSED rows keep a stale seat count and are never available', () => {
  const { rows } = parseCalendar(FIXTURE);
  const stale = rows.filter((r) => r.state === CLOSED && r.seats > 0);

  assert.ok(stale.length > 0, 'fixture should contain closed rows with leftover seat counts');
  for (const row of stale) assert.equal(isAvailable(row), false);
});

test('NOT LONGER AVAILABLE rows report null seats, not zero', () => {
  const { rows } = parseCalendar(FIXTURE);
  const full = rows.filter((r) => r.state === FULL);

  assert.ok(full.length > 0);
  for (const row of full) assert.equal(row.seats, null);
});

test('decodes accented university names', () => {
  const { rows } = parseCalendar(FIXTURE);
  assert.ok(rows.some((r) => r.university.includes('Università')));
});

test('row keys are stable and unique', () => {
  const { rows } = parseCalendar(FIXTURE);
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
  const decoy = `<table id="other"><tr><td>a</td></tr></table>${FIXTURE}`;
  assert.equal(parseCalendar(decoy).rows.length, 26);
});
