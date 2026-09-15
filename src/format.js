/**
 * Renders events into message bodies.
 *
 * Telegram is sent with parse_mode=HTML rather than MarkdownV2: university
 * names are full of apostrophes, dashes and dots that MarkdownV2 requires
 * escaping individually, whereas HTML only needs & < >.
 */

import { EVENT } from './diff.js';

const TELEGRAM_LIMIT = 4096;

export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HEADLINE = {
  [EVENT.BECAME_AVAILABLE]: '\u{1F7E2} SEAT FREED UP',
  [EVENT.NEW_ROW_AVAILABLE]: '\u{1F195} NEW SESSION, SEATS OPEN',
  [EVENT.SEATS_INCREASED]: '\u{1F4C8} MORE SEATS',
  [EVENT.NEW_DATE]: '\u{1F4C5} NEW TEST DATE',
  [EVENT.BECAME_UNAVAILABLE]: '\u{26AA} SEATS GONE',
};

const BOOKING_URL = 'https://testcisia.it/studenti_tolc/login_sso.php';

function seatPhrase(event) {
  const { row, previous, type } = event;
  if (type === EVENT.SEATS_INCREASED && previous?.seats != null) {
    return `${previous.seats} → ${row.seats} seats`;
  }
  return row.seats == null ? 'seats open' : `${row.seats} seats`;
}

/** One event -> a few lines of HTML. */
function renderEvent(event) {
  const head = HEADLINE[event.type] ?? event.type;

  if (event.type === EVENT.NEW_DATE) {
    const lines = event.rows
      .slice(0, 10)
      .map((r) => `  • ${escapeHtml(r.university)} — ${escapeHtml(r.city)} (${escapeHtml(r.format)}) — ${escapeHtml(r.state)}`);
    if (event.rows.length > 10) lines.push(`  • …and ${event.rows.length - 10} more`);
    return [`<b>${head} — ${escapeHtml(event.date)}</b>`, ...lines].join('\n');
  }

  const row = event.row;
  return [
    `<b>${head}</b>`,
    `<b>${escapeHtml(row.date)}</b> — ${escapeHtml(row.format)}`,
    `${escapeHtml(row.university)}`,
    `${escapeHtml(row.city)}, ${escapeHtml(row.region)}`,
    `${escapeHtml(seatPhrase(event))} · book by ${escapeHtml(row.deadline)}`,
    `<a href="${escapeHtml(row.bookingUrl || BOOKING_URL)}">Book now</a>`,
  ].join('\n');
}

/**
 * @returns {string[]} one or more Telegram-sized HTML messages
 */
export function formatTelegram(events, { calendarName = 'CEnT-S' } = {}) {
  if (events.length === 0) return [];
  const header = `<b>${escapeHtml(calendarName)} calendar update</b>`;
  const blocks = events.map(renderEvent);

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
  const body = events.map(renderEvent).join('\n\n');
  return {
    subject,
    html: `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap">${body}</div>`,
    text: body.replace(/<a href="([^"]+)">[^<]*<\/a>/g, '$1').replace(/<[^>]+>/g, ''),
  };
}

export function formatHeartbeat({ calendarName, tracked, available, matching }) {
  return [
    `<b>\u{1F493} Watcher alive</b>`,
    `${escapeHtml(calendarName)}: ${tracked} sessions tracked, ${available} currently bookable.`,
    `${matching} match your filter.`,
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
