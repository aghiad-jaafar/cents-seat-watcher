/**
 * Parser for the CISIA test calendar page (testcisia.it/calendario.php).
 *
 * The page is plain server-rendered HTML: a single `<table id="calendario">`
 * whose rows each carry exactly 8 `<td>` cells, in this order:
 *
 *   FORMAT | UNIVERSITY | REGION | CITY | BOOKINGS DEADLINE | SEATS | STATE | DATE
 *
 * IMPORTANT: the SEATS column is not a reliable availability signal. Rows that
 * are BOOKINGS CLOSED still render a stale non-zero count (Siena shows 42), and
 * NOT LONGER AVAILABLE rows render "---". Availability is decided by STATE only.
 */

export const AVAILABLE = 'AVAILABLE SEATS';
export const FULL = 'NOT LONGER AVAILABLE';
export const CLOSED = 'BOOKINGS CLOSED';

export const KNOWN_STATES = new Set([AVAILABLE, FULL, CLOSED]);

/** Thrown when the page no longer looks like the calendar we expect. */
export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    const key = entity.toLowerCase();
    return key in NAMED_ENTITIES ? NAMED_ENTITIES[key] : match;
  });
}

/** Strip tags, decode entities, collapse whitespace. */
function cellText(innerHtml) {
  return decodeEntities(innerHtml.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "15/10/2026" -> "2026-10-15" (sortable). Returns null if unrecognised. */
export function toISODate(ddmmyyyy) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy ?? '');
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year}-${month}-${day}`;
}

/**
 * Stable identity for a calendar row.
 *
 * Deliberately excludes deadline and seat count: both mutate over time, and
 * folding them into the key would make every ordinary change look like a
 * brand-new row and fire a false alert.
 */
export function rowKey(row) {
  return [row.format, row.university, row.city, row.date].join('|');
}

/** "52" -> 52, "---" -> null. */
function parseSeats(text) {
  const match = /^\d+$/.exec(text);
  return match ? Number(text) : null;
}

/**
 * @param {string} html raw page source
 * @returns {{rows: object[], unknownStates: string[]}}
 * @throws {ParseError} if the calendar table is absent or yields no rows
 */
export function parseCalendar(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new ParseError('empty response body');
  }

  // Scope to the calendar table so unrelated tables can never leak in.
  const tableStart = html.search(/<table[^>]*\bid=["']?calendario\b/i);
  if (tableStart === -1) {
    throw new ParseError('could not find <table id="calendario"> - page layout changed?');
  }
  const tableEnd = html.indexOf('</table>', tableStart);
  const table = html.slice(tableStart, tableEnd === -1 ? html.length : tableEnd);

  const rows = [];
  const unknownStates = [];

  for (const rowMatch of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length !== 8) continue; // header row, or a layout row

    const text = cells.map(cellText);
    const state = text[6].toUpperCase();
    if (!KNOWN_STATES.has(state)) unknownStates.push(state);

    // Available rows wrap the state in a link to the booking login.
    const href = /<a[^>]*href=["']([^"']+)["']/i.exec(cells[6]);

    const row = {
      format: text[0],
      university: text[1],
      region: text[2],
      city: text[3],
      deadline: text[4],
      seats: parseSeats(text[5]),
      state,
      date: text[7],
      dateISO: toISODate(text[7]),
      bookingUrl: href ? decodeEntities(href[1]) : null,
    };
    row.key = rowKey(row);
    rows.push(row);
  }

  if (rows.length === 0) {
    throw new ParseError('calendar table found but contained 0 parseable rows');
  }

  return { rows, unknownStates: [...new Set(unknownStates)] };
}

export const isAvailable = (row) => row.state === AVAILABLE;
