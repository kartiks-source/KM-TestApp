'use strict';
/*
 * Per-store access (SW-062, ADR-0016). The owner (ADMIN_PASSWORD) gives a person their own password for one or more
 * stores, as admin (changes that store's settings) or viewer (sees, changes nothing). ADMIN_PASSWORD and VIEW_PASSWORD
 * still open every store.
 *
 *   DATA_DIR/access.json  { schemaVersion: 1, people: [{ id, name, role, stores[], hash, gen, createdAt, updatedAt, lastSignInAt }] }
 *   hash  = "scrypt$N$r$p$<salt>$<key>" (base64url). The password itself is never stored or logged; it is shown once.
 *   password = "<id>-<20 random base64url chars>" (29 chars, 120 random bits). The id prefix finds the person, so a
 *              sign-in costs one scrypt, not one per person.
 *   session cookie = "exp.p.<id>.<gen>.sig", signed with the app's session key. Remove the person → every session ends;
 *              a new password bumps gen → old sessions end; role and store changes apply on the next request.
 * Pure-ish: file I/O here, HTTP in server.js.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const scope = require('./scope');

const SCHEMA = 1;
const ROLES = ['admin', 'view'];
const MAX_PEOPLE = 200;
const ID = /^[a-z0-9]{8}$/;
const KDF = { N: 16384, r: 8, p: 1, len: 32 };
const NOT_YOURS = 'This store isn’t open to your sign-in';
const OWNER_ONLY = 'Only the owner (main admin password) can manage people';

const file = () => path.join(scope.root(), 'access.json');
let db = null;        // { schemaVersion, people[] } once loaded
let broken = null;    // why access.json couldn't be read: nobody from it signs in, and nothing is written over it
const verified = new Map();   // sha256(password) → hash it matched (Basic auth on every call: one scrypt per password, not per request)

function load() {
  if (db) return db;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!j || !Array.isArray(j.people)) throw new Error('no people list');
    if (j.schemaVersion > SCHEMA) throw new Error(`schemaVersion ${j.schemaVersion} is newer than this app (${SCHEMA})`);
    db = { schemaVersion: SCHEMA, people: j.people.filter((p) => p && ID.test(p.id) && ROLES.includes(p.role) && Array.isArray(p.stores) && typeof p.hash === 'string') };
  } catch (e) {
    if (e.code !== 'ENOENT') { broken = e.message; console.error(`access.json unreadable (${e.message}): per-store sign-ins are off until it is fixed`); }
    db = { schemaVersion: SCHEMA, people: [] };
  }
  return db;
}
function save() {
  if (broken) throw Object.assign(new Error(`access.json couldn’t be read (${broken}); fix or remove it first`), { status: 409 });
  const f = file(), tmp = `${f}.tmp`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 });
  try { fs.copyFileSync(f, `${f}.bak`); fs.chmodSync(`${f}.bak`, 0o600); } catch { /* first save */ }
  fs.renameSync(tmp, f);
  verified.clear();
}

/* ---------- passwords ---------- */
const b64 = (b) => Buffer.from(b).toString('base64url');
function hash(pass, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(String(pass), salt, KDF.len, { N: KDF.N, r: KDF.r, p: KDF.p });
  return `scrypt$${KDF.N}$${KDF.r}$${KDF.p}$${b64(salt)}$${b64(key)}`;
}
function matches(pass, h) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(String(h || ''));
  if (!m) return false;
  const want = Buffer.from(m[5], 'base64url');
  const got = crypto.scryptSync(String(pass), Buffer.from(m[4], 'base64url'), want.length, { N: +m[1], r: +m[2], p: +m[3], maxmem: 64 * 1024 * 1024 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const newId = () => { for (;;) { const id = Array.from(crypto.randomBytes(8), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b & 31]).join(''); if (!byId(id)) return id; } };
const newPassword = (id) => `${id}-${crypto.randomBytes(15).toString('base64url')}`;

const byId = (id) => load().people.find((p) => p.id === id) || null;
/** The person a typed password belongs to, or null. */
function find(pass) {
  const m = /^([a-z0-9]{8})-.{16,}$/.exec(String(pass || ''));
  if (!m) return null;
  const p = byId(m[1]); if (!p) return null;
  const k = crypto.createHash('sha256').update(pass).digest('hex');
  if (verified.get(k) === p.hash) return p;
  if (!matches(pass, p.hash)) return null;
  if (verified.size > 200) verified.clear();
  verified.set(k, p.hash);
  return p;
}

/* ---------- sessions ---------- */
const signed = (exp, p) => `${exp}|p|${p.id}|${p.gen || 0}`;
const cookieValue = (exp, p, sign) => `${exp}.p.${p.id}.${p.gen || 0}.${sign(signed(exp, p))}`;
/** The person a session cookie names, or null (not a person cookie, expired, not ours, removed, or password reset since). */
function fromCookie(value, sign, eq, now = Date.now()) {
  const parts = String(value || '').split('.');
  if (parts.length !== 5 || parts[1] !== 'p' || !/^\d+$/.test(parts[0]) || +parts[0] <= now || !/^\d+$/.test(parts[3])) return null;
  const p = byId(parts[2]);
  if (!p || String(p.gen || 0) !== parts[3]) return null;
  return eq(parts[4], sign(signed(parts[0], p))) ? p : null;
}
function touch(p, now = Date.now()) { if (broken) return; p.lastSignInAt = now; try { save(); } catch (e) { console.warn('access.json not saved:', e.message); } }

/* ---------- which stores ---------- */
const allows = (person, storeId) => !person || person.stores.includes(String(storeId || '').toLowerCase());
/**
 * The store for this request. No person: stores.pick as before. A person: ?store= must be one of theirs (else 403, also for
 * an unknown id, so ids can't be probed); else the cookie's store when it is theirs; else their first listed store.
 */
function pick(registry, asked, cookie, person) {
  if (!person) return registry.pick(asked, cookie);
  if (asked != null && asked !== '') {
    const pk = registry.pick(asked, '');
    return pk.error === 503 ? pk : !pk.error && allows(person, pk.id) ? pk : { error: 403, message: NOT_YOURS };
  }
  const pk = registry.pick('', cookie);
  if (pk.error) return pk;
  if (allows(person, pk.id)) return pk;
  const first = registry.list().find((s) => allows(person, s.id));
  return first ? { id: first.id } : { error: 403, message: 'None of your stores is listed right now. Ask the owner.' };
}

/* ---------- the owner's changes ---------- */
const bad = (m) => Object.assign(new Error(m), { status: 400 });
function clean(b, known, { partial = false } = {}) {
  const out = {};
  if (!partial || b.name !== undefined) {
    const n = typeof b.name === 'string' ? b.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
    if (!n) throw bad('Give the person a name');
    out.name = n;
  }
  if (!partial || b.role !== undefined) {
    if (!ROLES.includes(b.role)) throw bad('Role must be admin or view');
    out.role = b.role;
  }
  if (!partial || b.stores !== undefined) {
    if (!Array.isArray(b.stores) || !b.stores.length) throw bad('Pick at least one store');
    const ids = [...new Set(b.stores.map((s) => String(s).toLowerCase()))];
    const unknown = ids.filter((s) => !known.includes(s));
    if (unknown.length) throw bad('Unknown store');
    out.stores = ids;
  }
  return out;
}
const view = (p) => ({ id: p.id, name: p.name, role: p.role, stores: [...p.stores], createdAt: p.createdAt, updatedAt: p.updatedAt, lastSignInAt: p.lastSignInAt || null });
const list = () => load().people.map(view);
/** Add a person. `known`: the listed store ids. → { person, password } (the password is shown once). */
function create(b, known, now = Date.now()) {
  const c = clean(b || {}, known);
  if (load().people.length >= MAX_PEOPLE) throw bad(`At most ${MAX_PEOPLE} people`);
  const id = newId(), password = newPassword(id);
  const p = { id, ...c, hash: hash(password), gen: 0, createdAt: now, updatedAt: now };
  db.people.push(p); save();
  return { person: view(p), password };
}
function update(id, b, known, now = Date.now()) {
  const p = byId(id); if (!p) return null;
  Object.assign(p, clean(b || {}, known, { partial: true }), { updatedAt: now }); save();
  return view(p);
}
/** A new password: the old one and every session made with it stop working. */
function reset(id, now = Date.now()) {
  const p = byId(id); if (!p) return null;
  const password = newPassword(p.id);
  Object.assign(p, { hash: hash(password), gen: (p.gen || 0) + 1, updatedAt: now }); save();
  return { person: view(p), password };
}
function remove(id) {
  const i = load().people.findIndex((p) => p.id === id); if (i < 0) return false;
  db.people.splice(i, 1); save();
  return true;
}

/**
 * /api/people routes (owner only). ctx: { owner, signIn (ADMIN_PASSWORD is set), stores() → [{ id, name }] }. → { code, body }.
 *   GET    /api/people              → { ok, people[], stores[], signIn }
 *   POST   /api/people              { name, role, stores[] } → 201 { ok, person, password }   (the password is shown once)
 *   PUT    /api/people/<id>         { name?, role?, stores? } → { ok, person }
 *   POST   /api/people/<id>/reset   → { ok, person, password }
 *   DELETE /api/people/<id>         → { ok }
 */
async function handle(req, p, readBody, ctx) {
  const no = (code, error) => ({ code, body: { ok: false, error } });
  if (!ctx.owner) return no(403, OWNER_ONLY);
  const m = /^\/api\/people(?:\/([a-z0-9]{8})(\/reset)?)?$/.exec(p);
  if (!m) return no(404, 'Not found');
  const [, id, isReset] = m, M = req.method;
  if (M === 'GET' && !id) { const st = ctx.stores(); return { code: 200, body: { ok: true, people: list(), stores: st, signIn: !!ctx.signIn } }; }
  if (!ctx.signIn) return no(409, 'Set ADMIN_PASSWORD first: without it nobody signs in, so a personal password would do nothing');
  const body = async () => { let b; try { b = JSON.parse((await readBody(req, 8192)) || '{}'); } catch { throw bad('Send JSON'); } if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Send a JSON object'); return b; };
  const known = () => ctx.stores().map((s) => s.id);
  if (M === 'POST' && !id) { const r = create(await body(), known()); console.log(`people: added ${r.person.id} (${r.person.role}, ${r.person.stores.length} store(s))`); return { code: 201, body: { ok: true, ...r } }; }
  if (!id || !byId(id)) return no(404, 'No such person');
  if (M === 'POST' && isReset) { const r = reset(id); console.log(`people: new password for ${id} (old sessions ended)`); return { code: 200, body: { ok: true, ...r } }; }
  if (isReset) return no(405, 'Use POST');
  if (M === 'PUT') { const person = update(id, await body(), known()); console.log(`people: changed ${id} (${person.role}, ${person.stores.length} store(s))`); return { code: 200, body: { ok: true, person } }; }
  if (M === 'DELETE') { remove(id); console.log(`people: removed ${id} (sessions ended)`); return { code: 200, body: { ok: true } }; }
  return no(405, 'Method not allowed');
}

module.exports = { handle,  ROLES, ID, NOT_YOURS, OWNER_ONLY, MAX_PEOPLE, load, find, hash, matches, cookieValue, fromCookie, touch, allows, pick, list, create, update, reset, remove, byId,
  file, _reset: () => { db = null; broken = null; verified.clear(); } };
