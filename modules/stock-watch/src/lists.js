'use strict';
/*
 * Saved product lists (SW-044, LOGIC.md §9d). A pasted list of SKUs / names / variant IDs, saved by name per store
 * and shared by the team: admin saves and deletes, view reads. The matching runs in the page (public/lists.js).
 * Kept in <store folder>/lists.json (src/sidefile.js: atomic, .bak, carried in backups):
 *
 *   lists.json = { [id]: { name, items: [string], at, by } }      id = the name in lower case, spaces → '-'
 */
const { sideFile } = require('./sidefile');

const MAX_LISTS = 100;
const MAX_ITEMS = 2000;
const MAX_ITEM = 200;
const MAX_NAME = 60;
const box = sideFile('lists.json');

const all = () => box.read();
const idOf = (name) => String(name).trim().toLowerCase().replace(/\s+/g, '-').slice(0, MAX_NAME);
/** A pasted list → its entries: split on new lines, commas, tabs and semicolons, trimmed, blanks and repeats (any case) dropped. */
function split(text) {
  const seen = new Set(), out = [];
  for (const x of String(text ?? '').split(/[\n\r\t,;]+/)) { const v = x.trim(), k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } }
  return out;
}

/** Every list, newest first: [{ id, name, items, at, by }]. */
const list = () => Object.entries(all()).map(([id, x]) => ({ id, ...x })).sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));

/** Save (or replace) a list by name. items = an array of strings or the pasted text. Returns { ok, id } or { ok: false, error }. */
function save(name, items, by = null, now = Date.now()) {
  const nm = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!nm) return { ok: false, error: 'Give the list a name' };
  if (nm.length > MAX_NAME) return { ok: false, error: `Name: at most ${MAX_NAME} characters` };
  const id = idOf(nm);
  if (!id || id === '__proto__') return { ok: false, error: 'Give the list a name' };
  const arr = split(Array.isArray(items) ? items.map((x) => String(x ?? '').replace(/[\n\r\t,;]+/g, ' ')).join('\n') : items);
  if (!arr.length) return { ok: false, error: 'The list is empty' };
  if (arr.length > MAX_ITEMS) return { ok: false, error: `At most ${MAX_ITEMS} entries per list` };
  if (arr.some((x) => x.length > MAX_ITEM)) return { ok: false, error: `Each entry: at most ${MAX_ITEM} characters` };
  const f = all();
  if (!Object.hasOwn(f, id) && Object.keys(f).length >= MAX_LISTS) return { ok: false, error: `At most ${MAX_LISTS} lists` };
  f[id] = { name: nm, items: arr, at: now, by: by ? String(by).slice(0, 40) : null };
  box.write();
  return { ok: true, id };
}

function remove(id) {
  const f = all(), k = String(id ?? '');
  if (!Object.hasOwn(f, k)) return { ok: false, error: 'No such list' };
  delete f[k]; box.write();
  return { ok: true, removed: true };
}

/**
 * HTTP: GET /api/lists (view) → { ok, lists }; POST /api/lists { name, items } saves, { id, delete: true } removes
 * (admin; view-only refused before this, server.js). Returns { code, body } or null when not ours.
 */
async function handle(req, url, readBody, ctx = {}) {
  if (url.pathname !== '/api/lists') return null;
  if (req.method === 'GET') return { code: 200, body: { ok: true, lists: list() } };
  if (req.method !== 'POST') return { code: 405, body: { ok: false, error: 'Use GET or POST' } };
  let b;
  try { b = JSON.parse(await readBody(req, 256e3) || '{}'); } catch { return { code: 400, body: { ok: false, error: 'Body must be JSON' } }; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { code: 400, body: { ok: false, error: 'Body must be a JSON object' } };
  if (b.delete === true) { const r = remove(b.id); return { code: r.ok ? 200 : 404, body: r.ok ? { ...r, lists: list() } : r }; }
  const r = save(b.name, b.items, ctx.by);
  return { code: r.ok ? 200 : 400, body: r.ok ? { ...r, lists: list() } : r };
}

module.exports = { all, list, save, remove, split, idOf, handle, MAX_LISTS, MAX_ITEMS, FILE_NAME: box.name, reset: box.reset };
