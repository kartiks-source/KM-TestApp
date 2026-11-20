'use strict';
/*
 * Morning digest delivery (SW-028): API routes, an optional outbound webhook (POST JSON), the daily
 * schedule at a set store-time hour, and a log of every send. No email provider, no dependencies.
 * The text comes from src/digest.js. Rules: LOGIC.md §17.
 *
 * Webhook URLs come from env only (they often carry a token; secrets stay out of store.json):
 * DIGEST_WEBHOOK_URL for every role, DIGEST_WEBHOOK_URL_<ROLE> (e.g. _CEO) for a role's own recipient.
 * Hour, roles, pause and the send log live in the store under `digest`. PUBLIC_URL or
 * RAILWAY_PUBLIC_DOMAIN gives the address for links in scheduled digests.
 *
 * server.js passes ctx = { report({ days, now }) → report with .yesterday, pull() → fresh data,
 *   storeName() → the store's name, storeId() → its id (for the link) }.
 * Per store (ADR-0015): settings and the send log live in each store's store.json; the scheduler runs each
 * store's tick inside scope.run (server.js), one store at a time; every digest names its store.
 */
const scope = require('./scope');
const store = require('./store');
const R = require('../public/roles');
const digest = require('./digest');
const audit = require('./audit');

const DAY = 864e5;
const CATCH_UP_HOURS = 3;     // after a restart, a missed digest still goes out within 3 h of the set hour
const LOG_KEEP = 50;
const SCHEDULED = R.ORDER.filter((r) => R.ROLES[r].digest);
const DEFAULTS = () => ({ hour: 9, roles: SCHEDULED.slice(), paused: false, lastSent: {}, log: [] });

function conf() {
  const d = store.load();
  d.digest = { ...DEFAULTS(), ...(d.digest || {}) };
  delete d.digest.webhookUrl;   // no longer kept in the store (env only)
  return d.digest;
}
const env = (k) => (process.env[k] || '').trim();
/** The webhook for one role: its own DIGEST_WEBHOOK_URL_<ROLE>, else DIGEST_WEBHOOK_URL. '' = none. */
const webhookUrl = (role = '') => (R.valid(role) && env(`DIGEST_WEBHOOK_URL_${role.toUpperCase()}`)) || env('DIGEST_WEBHOOK_URL');
const anyWebhook = (roles) => !!env('DIGEST_WEBHOOK_URL') || roles.some((r) => webhookUrl(r));
const hostOf = (u) => { try { return u ? new URL(u).host : null; } catch { return null; } };

/** '' when fine, else why not. https only; http just for this machine (local testing). */
function checkUrl(u) {
  if (u.length > 500) return 'Webhook URL is too long';
  let x; try { x = new URL(u); } catch { return 'Webhook URL isn’t a valid address'; }
  if (x.protocol === 'https:') return '';
  if (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) return '';
  return 'Webhook URL must start with https://';
}

/** What the page may see: never a URL itself (it often carries a token), only its host. */
function publicConf() {
  const c = conf(), u = env('DIGEST_WEBHOOK_URL');
  return {
    webhook: { set: anyWebhook(SCHEDULED), host: hostOf(u) }, tzOffsetMin: store.load().settings.tzOffsetMin, hour: c.hour, roles: c.roles, paused: c.paused,
    scheduled: SCHEDULED.map((r) => ({ role: r, name: R.ROLES[r].name, cadence: R.ROLES[r].digest, host: hostOf(webhookUrl(r)), own: !!env(`DIGEST_WEBHOOK_URL_${r.toUpperCase()}`) })),
    log: c.log.slice(-20).reverse(),
  };
}

/* Every change goes to the store's settings change log (SW-029, src/audit.js) as digest.hour / digest.roles / digest.paused,
 * and digest.webhook when the server's webhook hosts change (env, seen on the next digest call or scheduler tick). */
const LOG_KEYS = { hour: 'digest.hour', roles: 'digest.roles', paused: 'digest.paused' };
function applyPatch(b, by = 'admin') {
  const c = conf();
  if (b.webhookUrl !== undefined) return 'The webhook URL is set on the server (DIGEST_WEBHOOK_URL), not here';
  const next = {};
  if (b.hour != null) {
    const h = Number(b.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return 'Hour must be 0–23';
    next.hour = h;
  }
  if (Array.isArray(b.roles)) next.roles = SCHEDULED.filter((r) => b.roles.includes(r));
  if (typeof b.paused === 'boolean') next.paused = b.paused;
  const changes = [];
  for (const [k, v] of Object.entries(next)) {
    const was = c[k], same = Array.isArray(v) ? Array.isArray(was) && was.join(',') === v.join(',') : was === v;
    if (!same) changes.push({ key: LOG_KEYS[k], old: Array.isArray(was) ? was.join(', ') : was ?? null, new: Array.isArray(v) ? v.join(', ') : v });
    c[k] = v;
  }
  audit.record(store.load(), changes, by);
  store.save(true);
  return '';
}

/** Which hosts the digest goes to, from env ('' = none): "everyone → hooks.example; ceo → own.example". Hosts only, never a URL. */
const hooksSeen = () => [env('DIGEST_WEBHOOK_URL') ? `everyone → ${hostOf(env('DIGEST_WEBHOOK_URL')) || '?'}` : '',
  ...SCHEDULED.filter((r) => env(`DIGEST_WEBHOOK_URL_${r.toUpperCase()}`)).map((r) => `${r} → ${hostOf(webhookUrl(r)) || '?'}`)].filter(Boolean).join('; ');
/** A webhook change made on the server (env) is logged once per store, by "server (env)". The first look only records it. */
function noteWebhook() {
  const c = conf(), now = hooksSeen();
  if (c.webhookSeen === undefined) { c.webhookSeen = now; store.save(); return; }
  if (c.webhookSeen === now) return;
  audit.record(store.load(), [{ key: 'digest.webhook', old: c.webhookSeen || null, new: now || null }], 'server (env)');
  c.webhookSeen = now; store.save();
}

/* links in digests: env first, else the address the app was last opened at (signed-in requests only; set
 * PUBLIC_URL when the proxy's Host / X-Forwarded-Host can't be trusted, see LOGIC.md §17) */
let lastBase = '';
const baseUrl = () => (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') || lastBase;

const nameOf = (ctx) => (ctx.storeName ? ctx.storeName() : store.load().settings.storeName);
/** The digest for one role ('' = everyone) as of `now`. */
function make(role, ctx, now = Date.now()) {
  const r = ctx.report({ days: 30, now });
  const weekly = R.valid(role) && R.ROLES[role].digest === 'monday';   // CEO, finance: "last 7 days", vs the 7 before
  const week = weekly ? ctx.report({ days: 7, now }) : null;
  const prev = weekly ? ctx.report({ days: 7, now: now - 7 * DAY }) : null;
  return digest.build({ report: r, yesterday: r.yesterday, week, prev, role, storeName: nameOf(ctx), storeId: ctx.storeId ? ctx.storeId() : '', base: baseUrl(), now, review: ctx.review ? ctx.review() : null });
}

function logSend(entry) {
  const c = conf();
  c.log.push(entry);
  if (c.log.length > LOG_KEEP) c.log.splice(0, c.log.length - LOG_KEEP);
  store.save();
  console.log(`digest${scope.current() ? ` (store ${scope.current()})` : ''}: ${entry.role || 'everyone'} ${entry.trigger} → ${entry.ok ? `sent (${entry.status})` : `failed: ${entry.error}`}`);
}

/** POST one role's digest to the webhook. Always logged. Never throws. */
async function send(role, ctx, trigger, now = Date.now(), note = '') {
  const url = webhookUrl(role);
  const entry = { at: now, role, trigger, ok: false, status: null, error: null };
  try {
    if (!url) throw new Error('No webhook URL set');
    const bad = checkUrl(url); if (bad) throw new Error(bad);
    const d = make(role, ctx, now);
    const res = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'user-agent': 'stock-watch-digest' },
      body: JSON.stringify({ app: 'stock-watch', kind: 'digest', at: new Date(now).toISOString(), store: nameOf(ctx), storeId: ctx.storeId ? ctx.storeId() : null, role: d.role, roleName: d.roleName, title: d.title, lines: d.lines, link: d.link, text: d.text, ...(note ? { note } : {}) }),
    });
    entry.status = res.status; entry.ok = res.ok;
    if (!res.ok) entry.error = `HTTP ${res.status}`;
  } catch (e) { entry.error = e.name === 'TimeoutError' ? 'No answer in 10 s' : e.message; }
  if (note) entry.note = note;
  logSend(entry);
  return entry;
}

/** Which roles are due at `now`: within CATCH_UP_HOURS after the set hour (store time; wraps past midnight,
 *  so 23:00 still has until 02:00), not yet sent for that day; weekly roles only on Mondays. "That day" is the
 *  day the set hour fell on, so a 23:00 send caught up at 01:00 counts for the day before. */
function due(now = Date.now()) {
  const c = conf();
  if (c.paused) return [];
  const local = new Date(now + store.load().settings.tzOffsetMin * 60e3);
  const since = (local.getUTCHours() - c.hour + 24) % 24;   // whole hours since the set hour
  if (since >= CATCH_UP_HOURS) return [];
  const slot = new Date(local.getTime() - since * 36e5);
  const day = slot.toISOString().slice(0, 10), monday = slot.getUTCDay() === 1;
  return c.roles.filter((r) => R.valid(r) && webhookUrl(r) && c.lastSent[r] !== day && (R.ROLES[r].digest === 'daily' || (R.ROLES[r].digest === 'monday' && monday)))
    .map((r) => ({ role: r, day }));
}

const running = new Map();   // store id → its tick in progress
/** One scheduler step for the current store: if anything is due, pull fresh data first, then send each due role once. */
function tick(ctx, now = Date.now()) {
  const key = scope.current() || '';
  noteWebhook();
  if (running.has(key)) return running.get(key);
  const list = due(now);
  if (!list.length) return Promise.resolve([]);
  const p = (async () => {
    const c = conf();
    for (const { role, day } of list) c.lastSent[role] = day;   // one try per role per day, even if it fails (see the log)
    store.save(true);
    let note = '';
    try { await ctx.pull(); } catch (e) { note = `Data pull failed (${e.message}); numbers are from the last good pull`; }
    const out = [];
    for (const { role } of list) out.push(await send(role, ctx, 'schedule', Date.now(), note));
    return out;
  })().finally(() => { running.delete(key); });
  running.set(key, p);
  return p;
}

/** Every minute: each(fn) runs fn for every store, one after the other, inside scope.run (server.js). */
function schedule(ctx, each = (fn) => fn()) {
  const t = setInterval(() => Promise.resolve(each(() => tick(ctx))).catch((e) => console.warn('digest:', e.message)), 60e3);
  t.unref();
  return t;
}

/**
 * Routes (call after the login check). Returns { code, body, type? } or null when not a digest route.
 *   GET  /api/digest?role=ops        → { ok, role, roleName, title, lines, link, text }
 *   GET  /api/digest.txt?role=ops    → the text
 *   GET  /api/digest/settings        → hour, roles, paused, webhook host (never the URL), last 20 sends
 *   PUT  /api/digest/settings        { hour?, roles?, paused? }   (webhook URLs: env only → 400); changes logged (by = who)
 *   POST /api/digest/send?role=ops   → send now (no role: every ticked role), logged
 */
async function handle(req, url, readBody, ctx, by = 'admin') {
  const p = url.pathname;
  if (p !== '/api/digest' && p !== '/api/digest.txt' && !p.startsWith('/api/digest/')) return null;
  noteWebhook();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) lastBase = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${host}`;
  const roleQ = url.searchParams.get('role') || '';
  const role = R.valid(roleQ) ? roleQ : '';
  if (roleQ && roleQ !== 'all' && !role) return { code: 400, body: { ok: false, error: `Unknown role. Use one of: ${R.ORDER.join(', ')}` } };

  if (p === '/api/digest' && req.method === 'GET') return { code: 200, body: { ok: true, ...make(role, ctx) } };
  if (p === '/api/digest.txt' && req.method === 'GET') return { code: 200, body: make(role, ctx).text, type: 'text/plain; charset=utf-8' };
  if (p === '/api/digest/settings' && req.method === 'GET') return { code: 200, body: { ok: true, ...publicConf() } };
  if (p === '/api/digest/settings' && req.method === 'PUT') {
    let b; try { b = JSON.parse((await readBody(req, 64e3)) || '{}'); } catch { return { code: 400, body: { ok: false, error: 'Body must be JSON' } }; }
    if (!b || typeof b !== 'object') return { code: 400, body: { ok: false, error: 'Body must be a JSON object' } };
    const err = applyPatch(b, by);
    return err ? { code: 400, body: { ok: false, error: err } } : { code: 200, body: { ok: true, ...publicConf() } };
  }
  if (p === '/api/digest/send' && req.method === 'POST') {
    const roles = role ? [role] : conf().roles;
    if (!roles.length) return { code: 400, body: { ok: false, error: 'No roles ticked' } };
    if (!anyWebhook(roles)) return { code: 400, body: { ok: false, error: 'No webhook: set DIGEST_WEBHOOK_URL on the server' } };
    const sent = [];
    for (const r of roles.filter((x) => webhookUrl(x))) sent.push(await send(r, ctx, 'manual'));
    return { code: sent.every((s) => s.ok) ? 200 : 502, body: { ok: sent.every((s) => s.ok), sent, error: sent.find((s) => !s.ok)?.error } };
  }
  return { code: 404, body: { ok: false, error: 'Not found' } };
}

module.exports = { handle, schedule, tick, due, send, make, checkUrl, publicConf, applyPatch, noteWebhook, CATCH_UP_HOURS };
