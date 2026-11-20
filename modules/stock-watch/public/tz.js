/* Stock-out Watch — the store's time zone (SW-049). The ONE place that turns a moment (UTC ms) into the
 * store's calendar day / clock hour and back. Rules: LOGIC.md §0a.
 *
 * Runs in the browser (window.SW_TZ, loaded before app.js) and in Node (src/tz.js re-exports it), like roles.js.
 *
 * A zone is:
 *   - an IANA name, "Asia/Kolkata", "Europe/London" (daylight saving followed: the offset is looked up per moment)
 *   - a fixed offset "+05:30" / "-03:00" (no daylight saving)
 *   - a number: minutes east of UTC (the old `tzOffsetMin` setting; 330 = India); read as a fixed offset
 * The store's zone is settings.timeZone; an older store without it keeps its saved tzOffsetMin (zoneOf()).
 */
(function (root) {
  'use strict';

  const DAY = 864e5;
  const DEFAULT_ZONE = 'Asia/Kolkata';
  const FIXED = /^([+-])(\d{2}):(\d{2})$/;
  const SLOT = 15 * 60e3;   // every real zone changes offset on a quarter hour (UTC), so one lookup per 15 min is exact

  /** Minutes east of UTC of a fixed zone (number or "+05:30"), else null. */
  function fixedMinutes(zone) {
    if (typeof zone === 'number') return Number.isFinite(zone) ? zone : null;
    if (typeof zone !== 'string' || (zone[0] !== '+' && zone[0] !== '-')) return null;   // hot path: IANA names skip the regex
    const m = zone.match(FIXED);
    if (!m) return null;
    const v = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
    return v >= -720 && v <= 840 && +m[3] < 60 ? v : null;
  }
  /** "+05:30" from minutes east of UTC. */
  function fixedName(min) {
    const a = Math.abs(Math.round(min));
    return `${min < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
  }

  const formatters = new Map();   // zone → Intl.DateTimeFormat (null when the zone is unknown)
  function formatter(zone) {
    if (formatters.has(zone)) return formatters.get(zone);
    let f = null;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); } catch { f = null; }
    formatters.set(zone, f);
    return f;
  }

  /** The zone's canonical name when it is a zone this runtime knows (IANA, "UTC", or "+05:30"), else null. */
  function canonical(zone) {
    if (typeof zone !== 'string' || !zone.trim() || zone.length > 64) return null;
    const z = zone.trim();
    if (FIXED.test(z)) return fixedMinutes(z) == null ? null : z;
    if (!formatter(z)) return null;
    const known = all().find((x) => x.toLowerCase() === z.toLowerCase()) || (z.toUpperCase() === 'UTC' ? 'UTC' : z);
    return MODERN[known] || known;   // the name as the zone list spells it ("Asia/Kolkata", not ICU's old "Asia/Calcutta")
  }
  const valid = (zone) => canonical(zone) != null;

  /** The old minutes setting as a zone: India's 330 is Asia/Kolkata, anything else a fixed offset ("+05:45"). */
  function fromOffset(min) {
    const v = Number(min);
    if (!Number.isFinite(v)) return DEFAULT_ZONE;
    return v === 330 ? DEFAULT_ZONE : fixedName(v);
  }
  /** The store's zone from its settings: timeZone when it is one this runtime knows, else the old tzOffsetMin. */
  function zoneOf(settings) {
    const s = settings || {};
    const z = canonical(s.timeZone);
    if (z) return z;
    return s.tzOffsetMin == null ? DEFAULT_ZONE : fromOffset(s.tzOffsetMin);
  }

  const cache = new Map();   // zone → Map(15-minute slot → minutes)
  const last = { z: null, slot: NaN, v: 0 };
  /** Minutes east of UTC in `zone` at moment t (ms). Unknown zone → the default zone's. */
  function offsetAt(zone, t) {
    const fixed = fixedMinutes(zone);
    if (fixed != null) return fixed;
    const z = typeof zone === 'string' ? zone : DEFAULT_ZONE;
    const slot = Math.floor(t / SLOT);
    if (z === last.z && slot === last.slot) return last.v;   // rows come in time order: most lookups hit the same slot
    let byZone = cache.get(z);
    if (!byZone) { byZone = new Map(); cache.set(z, byZone); }
    let v = byZone.get(slot);
    if (v !== undefined) { last.z = z; last.slot = slot; last.v = v; return v; }
    const f = formatter(z) || formatter(DEFAULT_ZONE);
    const at = slot * SLOT, p = {};
    for (const x of f.formatToParts(new Date(at))) p[x.type] = x.value;
    v = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - at) / 60e3);
    if (byZone.size > 200000) byZone.clear();
    byZone.set(slot, v);
    last.z = z; last.slot = slot; last.v = v;
    return v;
  }

  /** A Date whose getUTC*() read the store's wall clock at moment t. */
  const local = (t, zone) => new Date(t + offsetAt(zone, t) * 60e3);
  /** Store calendar day "YYYY-MM-DD" of moment t. */
  const dayKey = (t, zone) => local(t, zone).toISOString().slice(0, 10);
  /** Store clock hour 0–23 of moment t. */
  const hour = (t, zone) => local(t, zone).getUTCHours();

  /**
   * The moment (UTC ms) at which the store's wall clock reads `wall` (ms from Date.UTC(y, m, d, h, mi, s)).
   * Daylight saving: a wall time skipped in spring (02:30 on the change day) gives the first moment after the
   * gap; a wall time that happens twice in autumn gives the first of the two.
   */
  function fromLocal(wall, zone) {
    const fixed = fixedMinutes(zone);
    if (fixed != null) return wall - fixed * 60e3;
    const o1 = offsetAt(zone, wall);
    const t1 = wall - o1 * 60e3, o2 = offsetAt(zone, t1);
    if (o2 === o1) {
      const tEarly = wall - offsetAt(zone, t1 - 3 * 36e5) * 60e3;   // twice-occurring wall time: the earlier moment
      return tEarly < t1 && offsetAt(zone, tEarly) * 60e3 + tEarly === wall ? tEarly : t1;
    }
    const t2 = wall - o2 * 60e3, o3 = offsetAt(zone, t2);
    if (o3 === o2) return t2;
    return Math.max(t1, t2);   // in the spring gap: the moment the clock jumps
  }
  /** Start of the store's calendar day that moment t falls in. */
  function dayStart(t, zone) { const d = local(t, zone); return fromLocal(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), zone); }
  /** Start of the store's next calendar day after moment t. */
  function nextDayStart(t, zone) { const d = local(t, zone); return fromLocal(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1), zone); }
  /** Start of the store's calendar day n − 1 days before the day moment t falls in: "the last n days, today included"
   *  (1.1.5, LOGIC.md §5a). Calendar days, so a 23- or 25-hour day still counts as one. */
  function daysStart(t, n, zone) { const d = local(t, zone); return fromLocal(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (Math.max(1, Math.round(n)) - 1)), zone); }
  /** Start of the store's calendar month that moment t falls in. */
  function monthStart(t, zone) { const d = local(t, zone); return fromLocal(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), zone); }
  /** Start of the store's clock hour after moment t (clocks change on an hour of the store's day, so this never jumps a change). */
  function nextHour(t, zone) { const off = offsetAt(zone, t) * 60e3; return Math.floor((t + off) / 36e5) * 36e5 + 36e5 - off; }
  /** Every store calendar day from moment `from` to moment `to` (both included), oldest first. A 23- or 25-hour day is one day. */
  function dayKeys(from, to, zone) {
    const out = [];
    for (let t = from, n = 0; t <= to && n < 4000; n++) { out.push(dayKey(t, zone)); t = nextDayStart(t, zone); }
    const last = dayKey(to, zone);
    if (out[out.length - 1] !== last && from <= to) out.push(last);
    return out;
  }
  /** "UTC+5:30" at moment t. */
  function offsetLabel(zone, t = Date.now()) {
    const m = offsetAt(zone, t), a = Math.abs(m);
    return `UTC${m < 0 ? '−' : '+'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`;
  }
  /** Does the zone change its clocks in the year around t? */
  function hasDst(zone, t = Date.now()) {
    if (fixedMinutes(zone) != null) return false;
    const a = offsetAt(zone, t);
    for (let i = 1; i <= 12; i++) if (offsetAt(zone, t + i * 30 * DAY) !== a) return true;
    return false;
  }

  /* Time zones offered on Data & settings, most likely first; "All time zones" lists the rest. */
  const COMMON = [
    ['Asia/Kolkata', 'India'], ['Asia/Kathmandu', 'Nepal'], ['Asia/Dhaka', 'Bangladesh'], ['Asia/Colombo', 'Sri Lanka'],
    ['Asia/Dubai', 'UAE'], ['Asia/Riyadh', 'Saudi Arabia'], ['Asia/Singapore', 'Singapore'],
    ['Europe/London', 'UK'], ['America/New_York', 'US Eastern'], ['America/Los_Angeles', 'US Pacific'], ['Australia/Sydney', 'Australia (Sydney)'], ['UTC', 'UTC'],
  ];
  /** Every IANA zone this runtime knows (browser or Node), or just the common ones. */
  /* ICU still lists some zones under old names; show today's */
  const MODERN = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv', 'Atlantic/Faeroe': 'Atlantic/Faroe' };
  let allZones = null;
  function all() {
    if (!allZones) {
      let list; try { list = Intl.supportedValuesOf('timeZone'); } catch { list = []; }
      allZones = [...new Set([...COMMON.map(([z]) => z), ...list.map((z) => MODERN[z] || z)])].filter((z) => !!formatter(z)).sort();
    }
    return allZones;
  }

  const api = { DEFAULT_ZONE, COMMON, valid, canonical, fromOffset, zoneOf, offsetAt, local, dayKey, hour, fromLocal, dayStart, nextDayStart, daysStart, monthStart, nextHour, dayKeys, offsetLabel, hasDst, all, fixedName, fixedMinutes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SW_TZ = api;
})(typeof window !== 'undefined' ? window : globalThis);
