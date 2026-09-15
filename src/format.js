/**
 * Renders events into message bodies.
 *
 * Telegram is sent with parse_mode=HTML rather than MarkdownV2: university
 * names are full of apostrophes, dashes and dots that MarkdownV2 requires
 * escaping individually, whereas HTML only needs & < >.
 */

import { EVENT } from './diff.js';
import { AVAILABILITY } from './parse.js';

const TELEGRAM_LIMIT = 4096;
const BOOKING_URL = 'https://testcisia.it/studenti_tolc/login_sso.php';

export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HEADLINE = {
  [EVENT.BECAME_AVAILABLE]: '\u{1F7E2} SEAT FREED UP',
  [EVENT.NEW_ROW_AVAILABLE]: '\u{1F195} NEW SESSION, BOOKABLE NOW',
  [EVENT.NEW_ROW_PENDING]: '\u{1F7E1} SESSION FOUND — BOOKINGS NOT OPEN YET',
  [EVENT.SEATS_INCREASED]: '\u{1F4C8} MORE SEATS',
  [EVENT.RUNNING_LOW]: '\u{1F534} SEATS RUNNING OUT',
  [EVENT.NEW_DATE]: '\u{1F4C5} NEW TEST DATE',
  [EVENT.BECAME_UNAVAILABLE]: '\u{26AA} SEATS GONE',
};

/** Short human label for an availability class. */
const AVAILABILITY_LABEL = {
  [AVAILABILITY.OPEN]: 'bookings open',
  [AVAILABILITY.OPEN_LIMITED]: 'open — few seats left',
  [AVAILABILITY.FULL]: 'sold out',
  [AVAILABILITY.NOT_OPEN]: 'bookings not opened yet',
  [AVAILABILITY.EXPIRED]: 'deadline passed',
};

function seatPhrase(event) {
  const { row, previous, type } = event;
  if (type === EVENT.SEATS_INCREASED && previous?.seats != null) {
    return `${previous.seats} → ${row.seats} seats`;
  }
  if (row.seats == null) return AVAILABILITY_LABEL[row.availability] ?? 'status unknown';
  const suffix = row.availability === AVAILABILITY.OPEN_LIMITED ? ' left — hurry' : ' seats';
  return `${row.seats}${suffix}`;
}

/** One event -> a few lines of HTML. */
function renderEvent(event) {
  const head = HEADLINE[event.type] ?? event.type;

  if (event.type === EVENT.NEW_DATE) {
    const lines = event.rows.slice(0, 10).map((r) => {
      const status = AVAILABILITY_LABEL[r.availability] ?? r.label;
      return `  • ${escapeHtml(r.university)} — ${escapeHtml(r.city)} (${escapeHtml(r.format)}) — ${escapeHtml(status)}`;
    });
    if (event.rows.length > 10) lines.push(`  • …and ${event.rows.length - 10} more`);
    return [`<b>${head} — ${escapeHtml(event.date)}</b>`, ...lines].join('\n');
  }

  const row = event.row;
  const lines = [
    `<b>${head}</b>`,
    `<b>${escapeHtml(row.date)}</b> — ${escapeHtml(row.format)}`,
    `${escapeHtml(row.university)}`,
    `${escapeHtml(row.city)}, ${escapeHtml(row.region)}`,
    `${escapeHtml(seatPhrase(event))} · book by ${escapeHtml(row.deadline)}`,
  ];

  // A session whose bookings have not opened cannot be booked yet, so point at
  // the calendar to watch rather than at a login that will not help.
  if (event.type === EVENT.NEW_ROW_PENDING) {
    lines.push('<i>Not bookable yet — you will be alerted the moment it opens.</i>');
  } else {
    lines.push(`<a href="${escapeHtml(row.bookingUrl || BOOKING_URL)}">Book now</a>`);
  }

  return lines.join('\n');
}

/** Most urgent first, so the top of the message is the actionable part. */
const PRIORITY = {
  [EVENT.BECAME_AVAILABLE]: 0,
  [EVENT.NEW_ROW_AVAILABLE]: 1,
  [EVENT.SEATS_INCREASED]: 2,
  [EVENT.RUNNING_LOW]: 3,
  [EVENT.NEW_DATE]: 4,
  [EVENT.NEW_ROW_PENDING]: 5,
  [EVENT.BECAME_UNAVAILABLE]: 6,
};

export function sortByUrgency(events) {
  return [...events].sort((a, b) => (PRIORITY[a.type] ?? 9) - (PRIORITY[b.type] ?? 9));
}

/**
 * @returns {string[]} one or more Telegram-sized HTML messages
 */
export function formatTelegram(events, { calendarName = 'CEnT-S' } = {}) {
  if (events.length === 0) return [];
  const header = `<b>${escapeHtml(calendarName)} calendar update</b>`;
  const blocks = sortByUrgency(events).map(renderEvent);

  const messages = [];
  let current = header;
  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > TELEGRAM_LIMIT) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}

export function formatEmail(events, { calendarName = 'CEnT-S' } = {}) {
  const urgent = events.filter(
    (e) => e.type === EVENT.BECAME_AVAILABLE || e.type === EVENT.NEW_ROW_AVAILABLE,
  ).length;
  const subject = urgent > 0
    ? `[${calendarName}] ${urgent} seat${urgent === 1 ? '' : 's'} available now`
    : `[${calendarName}] ${events.length} calendar change${events.length === 1 ? '' : 's'}`;
  const body = sortByUrgency(events).map(renderEvent).join('\n\n');
  return {
    subject,
    html: `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap">${body}</div>`,
    text: body.replace(/<a href="([^"]+)">[^<]*<\/a>/g, '$1').replace(/<[^>]+>/g, ''),
  };
}

export function formatHeartbeat({ calendarName, tracked, available, pending, matching }) {
  return [
    `<b>\u{1F493} Watcher alive</b>`,
    `${escapeHtml(calendarName)}: ${tracked} live sessions tracked.`,
    `${available} bookable now, ${pending} waiting to open or sold out.`,
    `${matching} bookable session(s) match your filter.`,
    `No news is good news — you will be pinged the moment that changes.`,
  ].join('\n');
}

export function formatFailureWarning(calendarName, failures, lastError) {
  return [
    `<b>\u{26A0}\u{FE0F} Watcher is failing</b>`,
    `${escapeHtml(calendarName)}: ${failures} consecutive failed checks.`,
    `Last error: ${escapeHtml(lastError)}`,
    `The site may be down or its page layout may have changed.`,
  ].join('\n');
}
