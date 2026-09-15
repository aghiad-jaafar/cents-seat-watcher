/**
 * Parser for the CISIA test calendar page (testcisia.it/calendario.php).
 *
 * The page is plain server-rendered HTML: a single `<table id="calendario">`
 * whose rows each carry exactly 8 `<td>` cells, in this order:
 *
 *   FORMAT | UNIVERSITY | REGION | CITY | BOOKINGS DEADLINE | SEATS | STATE | DATE
 *
 * Availability is decided by the COLOUR of the STATE cell, not by its wording
 * and not by the seat count. Observed across 13 CISIA calendars (656 rows):
 *
 *   LimeGreen  "POSTI DISPONIBILI"    open, book now              -> bookable
 *   Orange     "POSTI DISPONIBILI"    open, few seats remain      -> bookable
 *   Crimson    "POSTI ESAURITI"       sold out                    -> not bookable
 *   Crimson    "ISCRIZIONI CONCLUSE"  deadline expired            -> not bookable
 *   Crimson    "ISCRIZIONI CHIUSE"    bookings not opened yet     -> not bookable
 *
 * Two traps this encodes:
 *
 *  1. The SEATS number is not a signal. Expired rows keep a stale non-zero
 *     count (Siena renders "42" while closed), and sold-out rows render "---".
 *
 *  2. Red covers three very different situations. They are separated by the
 *     deadline cell: an expired row has its deadline wrapped in `<del>`, which
 *     works in any language. A red row with a LIVE deadline is still worth
 *     watching, because it can still turn green.
 */

/** Availability classes, derived from colour + deadline. */
export const AVAILABILITY = {
  /** Green: bookings open. */
  OPEN: 'OPEN',
  /** Orange: bookings open but few seats left - the most urgent case. */
  OPEN_LIMITED: 'OPEN_LIMITED',
  /** Red, live deadline: sold out, but a cancellation can reopen it. */
  FULL: 'FULL',
  /** Red, live deadline: bookings have not been opened yet. Watch this one. */
  NOT_OPEN: 'NOT_OPEN',
  /** Red, deadline struck through: dead, never alert on it. */
  EXPIRED: 'EXPIRED',
};

/** Colours that mean "you cannot book". Everything else is treated as bookable. */
const RED_COLOURS = new Set(['crimson', 'red', 'firebrick', 'darkred', '#ff0000', '#dc143c']);
/** Colours that mean "open, but hurry". */
const LIMITED_COLOURS = /^(orange|darkorange|gold|goldenrod|#ffa500)$/i;
/** Matches the "sold out" wording in both Italian and English. */
const SOLD_OUT_WORDING = /ESAURIT|NO[T]? LONGER AVAILABLE|SOLD\s*OUT|EXHAUST/i;

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

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

/** Pull the inline `color:` out of a cell's markup, lowercased. */
export function extractColour(cellHtml) {
  const match = /color:\s*([#\w]+)/i.exec(cellHtml);
  return match ? match[1].toLowerCase() : null;
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

function parseSeats(text) {
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * Decide what a row's state cell actually means.
 *
 * @param {{colour: string|null, label: string, deadlineExpired: boolean, hasBookingLink: boolean}} input
 * @returns {string} one of AVAILABILITY
 */
export function classifyAvailability({ colour, label, deadlineExpired, hasBookingLink }) {
  // No colour at all is unexpected; fall back to whether the site offered a
  // booking link, erring towards telling the user rather than staying silent.
  if (!colour) {
    return hasBookingLink ? AVAILABILITY.OPEN : AVAILABILITY.NOT_OPEN;
  }

  if (!RED_COLOURS.has(colour)) {
    return LIMITED_COLOURS.test(colour) ? AVAILABILITY.OPEN_LIMITED : AVAILABILITY.OPEN;
  }

  // Red. Separate the three meanings.
  if (deadlineExpired) return AVAILABILITY.EXPIRED;
  if (SOLD_OUT_WORDING.test(label)) return AVAILABILITY.FULL;
  return AVAILABILITY.NOT_OPEN;
}

/**
 * @param {string} html raw page source
 * @returns {{rows: object[], unknownColours: string[]}}
 * @throws {ParseError} if the calendar table is absent or yields no rows
 */
export function parseCalendar(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new ParseError('empty response body');
  }

  const tableStart = html.search(/<table[^>]*\bid=["']?calendario\b/i);
  if (tableStart === -1) {
    throw new ParseError('could not find <table id="calendario"> - page layout changed?');
  }
  const tableEnd = html.indexOf('</table>', tableStart);
  const table = html.slice(tableStart, tableEnd === -1 ? html.length : tableEnd);

  const rows = [];
  const unknownColours = [];

  for (const rowMatch of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length !== 8) continue; // header row, or a layout row

    const text = cells.map(cellText);
    const colour = extractColour(cells[6]);
    const label = text[6].toUpperCase();
    // An expired booking window is struck through: <td><del>11/09/2026</del></td>
    const deadlineExpired = /<del\b/i.test(cells[4]);
    const linkMatch = /<a[^>]*href=["']([^"']+)["']/i.exec(cells[6]);

    const availability = classifyAvailability({
      colour,
      label,
      deadlineExpired,
      hasBookingLink: Boolean(linkMatch),
    });

    if (colour && !RED_COLOURS.has(colour) && !LIMITED_COLOURS.test(colour) && colour !== 'limegreen') {
      unknownColours.push(colour);
    }

    const row = {
      format: text[0],
      university: text[1],
      region: text[2],
      city: text[3],
      deadline: text[4],
      deadlineExpired,
      seats: parseSeats(text[5]),
      label,
      colour,
      availability,
      date: text[7],
      dateISO: toISODate(text[7]),
      bookingUrl: linkMatch ? decodeEntities(linkMatch[1]) : null,
    };
    row.key = rowKey(row);
    rows.push(row);
  }

  if (rows.length === 0) {
    throw new ParseError('calendar table found but contained 0 parseable rows');
  }

  return { rows, unknownColours: [...new Set(unknownColours)] };
}

/** Can this be booked right now? */
export const isAvailable = (row) =>
  row.availability === AVAILABILITY.OPEN || row.availability === AVAILABILITY.OPEN_LIMITED;

/** Not bookable now, but the booking window is still live, so it may yet open. */
export const isPending = (row) =>
  row.availability === AVAILABILITY.FULL || row.availability === AVAILABILITY.NOT_OPEN;

/** Dead: the deadline has passed and nothing will change. */
export const isExpired = (row) => row.availability === AVAILABILITY.EXPIRED;
