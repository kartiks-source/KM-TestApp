'use strict';
/*
 * Morning digest delivery (SW-028): API routes, an optional outbound webhook (POST JSON), the daily
 * schedule at a set store-time hour, and a log of every send. No email provider, no dependencies.
 * The text comes from src/digest.js. Rules: LOGIC.md §14.
 *
 * Settings live in the store under `digest` (not in `settings`, so the webhook URL never goes out with
 * GET /api/settings). DIGEST_WEBHOOK_URL (Railway variable) overrides the saved URL. PUBLIC_URL or
 * RAILWAY_PUBLIC_DOMAIN gives the address for links in scheduled digests.
 *
 * server.js passes ctx = { report({ days, now }) → report with .yesterday, pull() → fresh data }.
 */
const store = require('./store');
const R = require('../public/roles');
const digest = require('./digest');

const DAY = 864e5;
const CATCH_UP_HOURS = 3;     // after a restart, a missed digest still goes out within 3 h of the set hour
const LOG_KEEP = 50;
const SCHEDULED = R.ORDER.filter((r) => R.ROLES[r].digest);
const DEFAULTS = () => ({ webhookUrl: '', hour: 9, roles: SCHEDULED.slice(), paused: false, lastSent: {}, log: [] });

function conf() {
  const d = store.load();
  d.digest = { ...DEFAULTS(), ...(d.digest || {}) };
  return d.digest;
}
const envUrl = () => (process.env.DIGEST_WEBHOOK_URL || '').trim();
const webhookUrl = () => envUrl() || conf().webhookUrl;

/** '' when fine, else why not. https only; http just for this machine (local testing). */
function checkUrl(u) {
  if (u.length > 500) return 'Webhook URL is too long';
  let x; try { x = new URL(u); } catch { return 'Webhook URL isn’t a valid address'; }
  if (x.protocol === 'https:') return '';
  if (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) return '';
  return 'Webhook URL must start with https://';
}

/** What the page may see: never the URL itself (it often carries a token), only its host. */
function publicConf() {
  const c = conf(), u = webhookUrl();
  let host = null; try { host = u ? new URL(u).host : null; } catch { /* bad env value */ }
  return {
    webhook: { set: !!u, host, fromEnv: !!envUrl() }, tzOffsetMin: store.load().settings.tzOffsetMin, hour: c.hour, roles: c.roles, paused: c.paused,
    scheduled: SCHEDULED.map((r) => ({ role: r, name: R.ROLES[r].name, cadence: R.ROLES[r].digest })),
    log: c.log.slice(-20).reverse(),
  };
}

function applyPatch(b) {
  const c = conf();
  if (typeof b.webhookUrl === 'string') {
    const u = b.webhookUrl.trim();
    if (u) { const err = checkUrl(u); if (err) return err; }
    c.webhookUrl = u;
  }
  if (b.hour != null) {
    const h = Number(b.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return 'Hour must be 0–23';
    c.hour = h;
  }
  if (Array.isArray(b.roles)) c.roles = SCHEDULED.filter((r) => b.roles.includes(r));
  if (typeof b.paused === 'boolean') c.paused = b.paused;
  store.save(true);
  return '';
}

/* links in digests: env first, else the address the app was last opened at (signed-in requests only) */
let lastBase = '';
const baseUrl = () => (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') || lastBase;

/** The digest for one role ('' = everyone) as of `now`. */
function make(role, ctx, now = Date.now()) {
  const r = ctx.report({ days: 30, now });
  const weekly = R.valid(role) && R.ROLES[role].digest === 'monday';   // CEO, finance: "last 7 days", vs the 7 before
  const week = weekly ? ctx.report({ days: 7, now }) : null;
  const prev = weekly ? ctx.report({ days: 7, now: now - 7 * DAY }) : null;
  return digest.build({ report: r, yesterday: r.yesterday, week, prev, role, storeName: store.load().settings.storeName, base: baseUrl(), now });
}

function logSend(entry) {
  const c = conf();
  c.log.push(entry);
  if (c.log.length > LOG_KEEP) c.log.splice(0, c.log.length - LOG_KEEP);
  store.save();
  console.log(`digest: ${entry.role || 'everyone'} ${entry.trigger} → ${entry.ok ? `sent (${entry.status})` : `failed: ${entry.error}`}`);
}

/** POST one role's digest to the webhook. Always logged. Never throws. */
async function send(role, ctx, trigger, now = Date.now(), note = '') {
  const url = webhookUrl();
  const entry = { at: now, role, trigger, ok: false, status: null, error: null };
  try {
    if (!url) throw new Error('No webhook URL set');
    const d = make(role, ctx, now);
    const res = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', 'user-agent': 'stock-watch-digest' },
      body: JSON.stringify({ app: 'stock-watch', kind: 'digest', at: new Date(now).toISOString(), store: store.load().settings.storeName, role: d.role, roleName: d.roleName, title: d.title, lines: d.lines, link: d.link, text: d.text, ...(note ? { note } : {}) }),
    });
    entry.status = res.status; entry.ok = res.ok;
    if (!res.ok) entry.error = `HTTP ${res.status}`;
  } catch (e) { entry.error = e.name === 'TimeoutError' ? 'No answer in 10 s' : e.message; }
  if (note) entry.note = note;
  logSend(entry);
  return entry;
}

/** Which roles are due at `now`: the set hour (store time) has passed today, within the catch-up window,
 *  not yet sent today; weekly roles only on Mondays. */
function due(now = Date.now()) {
  const c = conf();
  if (c.paused || !webhookUrl()) return [];
  const local = new Date(now + store.load().settings.tzOffsetMin * 60e3);
  const h = local.getUTCHours();
  if (h < c.hour || h >= c.hour + CATCH_UP_HOURS) return [];
  const day = local.toISOString().slice(0, 10), monday = local.getUTCDay() === 1;
  return c.roles.filter((r) => R.valid(r) && c.lastSent[r] !== day && (R.ROLES[r].digest === 'daily' || (R.ROLES[r].digest === 'monday' && monday)))
    .map((r) => ({ role: r, day }));
}

let running = null;
/** One scheduler step: if anything is due, pull fresh data first, then send each due role once. */
function tick(ctx, now = Date.now()) {
  if (running) return running;
  const list = due(now);
  if (!list.length) return Promise.resolve([]);
  running = (async () => {
    const c = conf();
    for (const { role, day } of list) c.lastSent[role] = day;   // one try per role per day, even if it fails (see the log)
    store.save(true);
    let note = '';
    try { await ctx.pull(); } catch (e) { note = `Data pull failed (${e.message}); numbers are from the last good pull`; }
    const out = [];
    for (const { role } of list) out.push(await send(role, ctx, 'schedule', Date.now(), note));
    return out;
  })().finally(() => { running = null; });
  return running;
}

function schedule(ctx) {
  const t = setInterval(() => tick(ctx).catch((e) => console.warn('digest:', e.message)), 60e3);
  t.unref();
  return t;
}

/**
 * Routes (call after the login check). Returns { code, body, type? } or null when not a digest route.
 *   GET  /api/digest?role=ops        → { ok, role, roleName, title, lines, link, text }
 *   GET  /api/digest.txt?role=ops    → the text
 *   GET  /api/digest/settings        → hour, roles, paused, webhook host (never the URL), last 20 sends
 *   PUT  /api/digest/settings        { webhookUrl?, hour?, roles?, paused? }
 *   POST /api/digest/send?role=ops   → send now (no role: every ticked role), logged
 */
async function handle(req, url, readBody, ctx) {
  const p = url.pathname;
  if (p !== '/api/digest' && p !== '/api/digest.txt' && !p.startsWith('/api/digest/')) return null;
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
    const err = applyPatch(b);
    return err ? { code: 400, body: { ok: false, error: err } } : { code: 200, body: { ok: true, ...publicConf() } };
  }
  if (p === '/api/digest/send' && req.method === 'POST') {
    if (!webhookUrl()) return { code: 400, body: { ok: false, error: 'Set a webhook URL first' } };
    const roles = role ? [role] : conf().roles;
    if (!roles.length) return { code: 400, body: { ok: false, error: 'No roles ticked' } };
    const sent = [];
    for (const r of roles) sent.push(await send(r, ctx, 'manual'));
    return { code: sent.every((s) => s.ok) ? 200 : 502, body: { ok: sent.every((s) => s.ok), sent, error: sent.find((s) => !s.ok)?.error } };
  }
  return { code: 404, body: { ok: false, error: 'Not found' } };
}

module.exports = { handle, schedule, tick, due, send, make, checkUrl, publicConf, applyPatch, CATCH_UP_HOURS };
