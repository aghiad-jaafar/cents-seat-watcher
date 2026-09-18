/**
 * Renders events into message bodies.
 *
 * Telegram is sent with parse_mode=HTML rather than MarkdownV2: university
 * names are full of apostrophes, dashes and dots that MarkdownV2 requires
 * escaping individually, whereas HTML only needs & < >.
 *
 * Telegram HTML supports only a small tag set (b, i, u, s, a, code, pre,
 * blockquote) and no layout control, so structure comes from emoji labels,
 * blank lines and dividers rather than from markup.
 */

import { EVENT } from './diff.js';
import { AVAILABILITY, toISODate } from './parse.js';

const TELEGRAM_LIMIT = 4096;
const BOOKING_URL = 'https://testcisia.it/studenti_tolc/login_sso.php';
const DIVIDER = '━━━━━━━━━━━━━';

export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "BRESCIA, LOMBARDIA" reads as shouting; soften it to "Brescia, Lombardia". */
export function titleCase(text) {
  return String(text ?? '')
    .toLocaleLowerCase('it-IT')
    .replace(/(^|[\s'\-/(])([\p{L}])/gu, (_, before, letter) => before + letter.toLocaleUpperCase('it-IT'));
}

/** "15/10/2026" -> "Thu 15 Oct 2026". Falls back to the raw string. */
export function humanDate(ddmmyyyy) {
  const iso = toISODate(ddmmyyyy);
  if (!iso) return ddmmyyyy ?? '';
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return ddmmyyyy;
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Whole days from today until a DD/MM/YYYY date, or null if unparseable. */
export function daysUntil(ddmmyyyy, now = new Date()) {
  const iso = toISODate(ddmmyyyy);
  if (!iso) return null;
  const target = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

/** "Book by Fri 9 Oct 2026 (21 days left)" - urgency people can feel. */
function deadlinePhrase(deadline) {
  const days = daysUntil(deadline);
  const when = escapeHtml(humanDate(deadline));
  if (days == null) return `Book by ${when}`;
  if (days < 0) return `Deadline passed (${when})`;
  if (days === 0) return `<b>Closes TODAY</b> (${when})`;
  if (days === 1) return `<b>Closes TOMORROW</b> (${when})`;
  if (days <= 7) return `Book by ${when} — <b>only ${days} days left</b>`;
  return `Book by ${when} (${days} days left)`;
}

const FORMAT_LABEL = {
  'CENT@HOME': '\u{1F3E0}  From home',
  'CENT@UNI': '\u{1F3DB}\u{FE0F}  In person',
  'TOLC@CASA': '\u{1F3E0}  From home',
  'TOLC@UNI': '\u{1F3DB}\u{FE0F}  In person',
};

function formatLine(row) {
  const label = FORMAT_LABEL[row.format] ?? `\u{1F4CD}  ${escapeHtml(row.format)}`;
  return `${label} <i>(${escapeHtml(row.format)})</i>`;
}

function seatLine(event) {
  const { row, previous, type } = event;

  if (type === EVENT.SEATS_INCREASED && previous?.seats != null) {
    const gained = row.seats - previous.seats;
    return `\u{1F4BA}  <b>${row.seats} seats</b> now — ${gained} more than before`;
  }
  if (row.availability === AVAILABILITY.OPEN_LIMITED) {
    return `\u{1F525}  <b>Only ${row.seats} left!</b>`;
  }
  if (row.seats != null) {
    return `\u{1F4BA}  <b>${row.seats} seats</b> available`;
  }
  if (row.availability === AVAILABILITY.NOT_OPEN) {
    return `\u{1F512}  Bookings haven't opened yet`;
  }
  return `\u{1F6AB}  Fully booked right now`;
}

/** Headline and the human line under it, per event type. */
const VOICE = {
  [EVENT.BECAME_AVAILABLE]: {
    title: '\u{1F389} <b>A SEAT JUST OPENED UP!</b>',
    subtitle: 'Someone cancelled — this is your chance.',
    footer: '⚡ <i>Seats like this can vanish in minutes. Go now!</i>',
  },
  [EVENT.NEW_ROW_AVAILABLE]: {
    title: '✨ <b>NEW SESSION — BOOKABLE NOW!</b>',
    subtitle: 'A new session just appeared, and you can book it.',
    footer: '⚡ <i>Get in early while there is plenty of room.</i>',
  },
  [EVENT.RUNNING_LOW]: {
    title: '\u{1F525} <b>SEATS RUNNING OUT</b>',
    subtitle: 'This one is nearly full now.',
    footer: '⏳ <i>If you want it, do not sleep on it.</i>',
  },
  [EVENT.SEATS_INCREASED]: {
    title: '\u{1F4C8} <b>MORE SEATS APPEARED</b>',
    subtitle: 'A few people dropped out.',
    footer: '\u{1F44D} <i>Better odds than a moment ago.</i>',
  },
  [EVENT.NEW_ROW_PENDING]: {
    title: '\u{1F440} <b>NEW SESSION SPOTTED</b>',
    subtitle: 'It exists, but bookings are not open yet.',
    footer: '\u{1F514} <i>Nothing to do yet — I will ping you the second it opens.</i>',
  },
  [EVENT.BECAME_UNAVAILABLE]: {
    title: '\u{1F614} <b>SEATS GONE</b>',
    subtitle: 'Someone got there first.',
    footer: '\u{1F440} <i>Still watching — it can open up again.</i>',
  },
};

/** One event -> a readable block. */
function renderEvent(event) {
  if (event.type === EVENT.NEW_DATE) {
    const lines = [
      `\u{1F4C5} <b>NEW TEST DATE PUBLISHED!</b>`,
      `<i>A university just added ${escapeHtml(humanDate(event.date))}.</i>`,
      '',
    ];
    for (const row of event.rows.slice(0, 8)) {
      const status =
        row.availability === AVAILABILITY.OPEN || row.availability === AVAILABILITY.OPEN_LIMITED
          ? '✅ bookable'
          : row.availability === AVAILABILITY.NOT_OPEN
            ? '\u{1F512} not open yet'
            : '\u{1F6AB} full';
      lines.push(`   • ${escapeHtml(titleCase(row.city))} — ${escapeHtml(row.university)}  ${status}`);
    }
    if (event.rows.length > 8) lines.push(`   • <i>…and ${event.rows.length - 8} more</i>`);
    lines.push('', `\u{1F440} <i>I will tell you the moment one of these opens.</i>`);
    return lines.join('\n');
  }

  const row = event.row;
  const voice = VOICE[event.type] ?? { title: `<b>${event.type}</b>`, subtitle: '', footer: '' };

  const lines = [voice.title];
  if (voice.subtitle) lines.push(`<i>${voice.subtitle}</i>`);
  lines.push(
    '',
    `\u{1F4C5}  <b>${escapeHtml(humanDate(row.date))}</b>`,
    formatLine(row),
    `\u{1F3DB}\u{FE0F}  ${escapeHtml(row.university)}`,
    `\u{1F4CD}  ${escapeHtml(titleCase(row.city))}, ${escapeHtml(titleCase(row.region))}`,
    seatLine(event),
    `⏰  ${deadlinePhrase(row.deadline)}`,
    '',
  );

  // A session whose bookings have not opened cannot be booked yet, so a login
  // link would only send them somewhere useless.
  if (event.type !== EVENT.NEW_ROW_PENDING && event.type !== EVENT.BECAME_UNAVAILABLE) {
    lines.push(`\u{1F449} <a href="${escapeHtml(row.bookingUrl || BOOKING_URL)}"><b>BOOK IT NOW</b></a>`, '');
  }

  if (voice.footer) lines.push(voice.footer);
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
 *
 * Takes no calendar name on purpose. It used to accept one and print it as a
 * header, which is how `npm run telegram:test` marked itself by passing
 * "CEnT-S (TEST)". When the header was removed the parameter kept being
 * accepted and silently ignored, so sample alerts became indistinguishable
 * from real ones. Test marking now lives in formatSampleAlert, where it cannot
 * be lost by a formatting change.
 */
export function formatTelegram(events) {
  if (events.length === 0) return [];
  const blocks = sortByUrgency(events).map(renderEvent);

  const messages = [];
  let current = blocks[0];
  for (const block of blocks.slice(1)) {
    const candidate = `${current}\n\n${DIVIDER}\n\n${block}`;
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

/**
 * Wraps a real alert in unmissable "this is only a test" banners, top and
 * bottom, so a sample can never be mistaken for a genuine free seat.
 */
export function formatSampleAlert(events) {
  const messages = formatTelegram(events);
  if (messages.length === 0) return messages;

  const top =
    `\u{1F9EA} <b>TEST MESSAGE — NOT A REAL SEAT</b>\n` +
    `<i>A sample, so you can see what a genuine alert looks like.</i>`;
  const bottom =
    `\u{1F9EA} <b>End of test.</b> <i>No seat is actually free — ignore everything above.</i>`;

  messages[0] = `${top}\n\n${DIVIDER}\n\n${messages[0]}`;
  messages[messages.length - 1] = `${messages[messages.length - 1]}\n\n${DIVIDER}\n\n${bottom}`;
  return messages;
}

export function formatEmail(events, { calendarName = 'CEnT-S' } = {}) {
  const urgent = events.filter(
    (e) => e.type === EVENT.BECAME_AVAILABLE || e.type === EVENT.NEW_ROW_AVAILABLE,
  ).length;
  const subject = urgent > 0
    ? `\u{1F389} [${calendarName}] ${urgent} seat${urgent === 1 ? '' : 's'} available now!`
    : `[${calendarName}] ${events.length} calendar change${events.length === 1 ? '' : 's'}`;
  const body = sortByUrgency(events).map(renderEvent).join(`\n\n${DIVIDER}\n\n`);
  return {
    subject,
    html: `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap;line-height:1.6">${body}</div>`,
    text: body.replace(/<a href="([^"]+)">[^<]*<\/a>/g, '$1').replace(/<[^>]+>/g, ''),
  };
}

const WATCHLIST_LIMIT = 8;

const WATCHLIST_ICON = {
  [AVAILABILITY.OPEN]: '✅',
  [AVAILABILITY.OPEN_LIMITED]: '\u{1F525}',
  [AVAILABILITY.FULL]: '\u{1F6AB}',
  [AVAILABILITY.NOT_OPEN]: '\u{1F512}',
};

const WATCHLIST_WORD = {
  [AVAILABILITY.OPEN]: 'bookable now',
  [AVAILABILITY.OPEN_LIMITED]: 'almost full',
  [AVAILABILITY.FULL]: 'fully booked',
  [AVAILABILITY.NOT_OPEN]: 'not open yet',
};

export function formatHeartbeat({ calendarName, tracked, available, pending, matching, watchlist = [] }) {
  const lines = [
    `\u{1F49A} <b>Still watching for you</b>`,
    `<i>Daily check-in from your ${escapeHtml(calendarName)} watcher.</i>`,
    '',
    `\u{1F441}\u{FE0F}  Tracking <b>${tracked}</b> sessions`,
    `✅  <b>${available}</b> bookable right now`,
    `⏳  <b>${pending}</b> waiting to open or fully booked`,
  ];

  if (watchlist.length > 0) {
    lines.push('', `\u{1F4CB} <b>Your sessions</b>`);
    for (const item of watchlist.slice(0, WATCHLIST_LIMIT)) {
      const icon = WATCHLIST_ICON[item.availability] ?? '•';
      const word = WATCHLIST_WORD[item.availability] ?? item.availability;
      const history =
        item.lastSeats != null && item.availability !== AVAILABILITY.OPEN
          ? ` <i>(had ${item.lastSeats} seats on ${escapeHtml(item.lastSeatsOn)})</i>`
          : '';
      lines.push(`   ${icon}  ${escapeHtml(titleCase(item.city))} — ${escapeHtml(humanDate(item.date))} — ${word}${history}`);
    }
    if (watchlist.length > WATCHLIST_LIMIT) {
      lines.push(`   •  <i>…and ${watchlist.length - WATCHLIST_LIMIT} more</i>`);
    }
  }

  lines.push(
    '',
    matching > 0
      ? `\u{1F389} <b>${matching} of your sessions can be booked right now!</b>`
      : `\u{1F634} Nothing free yet — but I am not going anywhere.`,
  );
  return lines.join('\n');
}

export function formatArmed({ calendarName, tracked, bookable, pending }) {
  return [
    `\u{1F680} <b>Watcher is live!</b>`,
    `<i>I am now watching the ${escapeHtml(calendarName)} calendar for you, day and night.</i>`,
    '',
    `\u{1F441}\u{FE0F}  Tracking <b>${tracked}</b> sessions`,
    `✅  <b>${bookable}</b> of yours bookable now`,
    `⏳  <b>${pending}</b> of yours still in play`,
    '',
    `\u{1F4A4} <i>Go to sleep — I will wake you if a seat opens.</i>`,
  ].join('\n');
}

export function formatFailureWarning(calendarName, failures, lastError) {
  return [
    `⚠\u{FE0F} <b>Something is wrong with me</b>`,
    `<i>I could not check the ${escapeHtml(calendarName)} calendar.</i>`,
    '',
    `❌  <b>${failures}</b> failed checks in a row`,
    `\u{1F4AC}  ${escapeHtml(lastError)}`,
    '',
    `\u{1F527} <i>The site may be down, or its page may have changed. Worth a look.</i>`,
  ].join('\n');
}
