// Reads the public health feed at /status.json. Pure and DOM-free so it is unit tested.
// The feed is optional: the repository copy has "updated_at": null, which means no probe
// publishes one. See docs/status-page.md for the schema and the operator setup.
export const STATES = ['operational', 'degraded', 'outage'];
export const STALE_AFTER_MS = 15 * 60 * 1000;
// A visitor's clock can run a little ahead of the probe's. Beyond this the timestamp is not trusted.
export const CLOCK_SKEW_MS = 2 * 60 * 1000;
export const MAX_ITEMS = 20;
const text = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);
// Timestamps must be full ISO 8601 with a zone and a real calendar date. Date.parse alone
// would turn 2026-11-31 into December 1 and accept it.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
export function time(value) {
  const match = typeof value === 'string' ? STAMP.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (match[8] !== 'Z' && (Number(match[8].slice(1, 3)) > 14 || Number(match[8].slice(4, 6)) > 59)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
// Optional fields may be absent or null. A supplied value that is not valid makes the whole
// feed invalid, so a broken note or resolution time can never be silently dropped.
const BAD = Symbol('bad');
const optional = (value, read) => { if (value === undefined || value === null) return null; const result = read(value); return result === null ? BAD : result; };

export function readFeed(feed, now = Date.now()) {
  if (!feed || typeof feed !== 'object' || feed.schema !== 1) return {kind: 'invalid'};
  // Only an absent timestamp means "no feed". A present but malformed one is a broken feed.
  if (feed.updated_at === null || feed.updated_at === undefined) return {kind: 'none'};
  const updated = time(feed.updated_at);
  if (!updated) return {kind: 'invalid'};
  if (!Array.isArray(feed.components) || !Array.isArray(feed.incidents)) return {kind: 'invalid'};
  const components = [];
  // Every entry is validated and counted: an oversized feed is rejected, never truncated, so
  // a component that is not displayed can never be left out of the overall state.
  if (feed.components.length > MAX_ITEMS || feed.incidents.length > MAX_ITEMS) return {kind: 'invalid'};
  for (const item of feed.components) {
    const name = text(item?.name, 80);
    if (!name || !STATES.includes(item.status)) return {kind: 'invalid'};
    const note = optional(item.note, value => text(value, 300));
    if (note === BAD) return {kind: 'invalid'};
    components.push({name, status: item.status, note});
  }
  if (!components.length) return {kind: 'invalid'};
  const incidents = [];
  for (const item of feed.incidents) {
    const title = text(item?.title, 160), started = time(item?.started_at);
    if (!title || !started) return {kind: 'invalid'};
    const resolved = optional(item.resolved_at, time), body = optional(item.body, value => text(value, 1000));
    if (resolved === BAD || body === BAD || (resolved && resolved < started)) return {kind: 'invalid'};
    incidents.push({title, started_at: started, resolved_at: resolved, body});
  }
  const age = now - Date.parse(updated);
  // A feed nobody refreshed proves nothing about now, so it is never shown as current.
  if (age > STALE_AFTER_MS || age < -CLOCK_SKEW_MS) return {kind: 'stale', updated_at: updated, components, incidents};
  const worst = STATES[Math.max(...components.map(item => STATES.indexOf(item.status)))];
  return {kind: 'current', updated_at: updated, overall: worst, components, incidents};
}
