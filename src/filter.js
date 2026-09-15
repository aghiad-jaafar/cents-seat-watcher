/**
 * Decides which events are worth waking someone up for.
 *
 * Note the split of responsibilities: diff.js tracks EVERY row, and filtering
 * happens only here, at notification time. If rows were filtered out before
 * being tracked, widening the filter later would replay every previously
 * hidden row as "new" and flood the user.
 */

import { EVENT } from './diff.js';

const norm = (value) => String(value ?? '').trim().toLowerCase();

/** Case-insensitive substring match, so "brescia" matches the full official name. */
function matchesAny(value, needles) {
  if (!needles || needles.length === 0) return true; // empty list = no constraint
  const haystack = norm(value);
  return needles.some((needle) => haystack.includes(norm(needle)));
}

export function matchesFilter(row, filter = {}) {
  const formats = filter.formats ?? [];
  const formatOk = formats.length === 0 || formats.some((f) => norm(f) === norm(row.format));
  return formatOk && matchesAny(row.university, filter.universities) && matchesAny(row.city, filter.cities);
}

/** Event types that are on unless explicitly disabled in config. */
function typeEnabled(type, config) {
  switch (type) {
    case EVENT.BECAME_AVAILABLE:
    case EVENT.NEW_ROW_AVAILABLE:
      return true;
    case EVENT.SEATS_INCREASED:
      return config.alertOnSeatIncrease !== false;
    case EVENT.NEW_DATE:
      return config.alertOnNewDate !== false;
    case EVENT.BECAME_UNAVAILABLE:
      return config.alertOnClose === true;
    default:
      return false;
  }
}

export function shouldAlert(event, config = {}) {
  if (!typeEnabled(event.type, config)) return false;
  const filter = config.filter ?? {};
  // A NEW_DATE event covers many rows; it is relevant if any of them match.
  const rows = event.rows ?? [event.row];
  return rows.some((row) => row && matchesFilter(row, filter));
}

export function filterEvents(events, config = {}) {
  return events.filter((event) => shouldAlert(event, config));
}
