'use strict';
/*
 * Which store the current work is for (multi-store, ADR-0015). Every per-store module (store.js, sidefile.js,
 * catalog.js, backup.js, digest-service.js) asks dir() for its folder, DATA_DIR/stores/<id>/, so stores can't mix:
 * the server runs each request, each pull and each scheduled job inside run(id, fn) (Node's AsyncLocalStorage
 * carries the id through every await and timer started inside it).
 *
 * Outside run() there is no store: id() and dir() throw. Never a silent default (that is how stores would mix).
 * Tests that use a module on its own point it at a folder with useDir(dir).
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');

const als = new AsyncLocalStorage();
/** A store id: a Performity brand uuid, or a shop handle / demo id. Used in folder names and URLs, so nothing else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const validId = (id) => typeof id === 'string' && (UUID.test(id) || SLUG.test(id));

const root = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const storesDir = () => path.join(root(), 'stores');
let testDir = null;

/** Run fn with `id` as the current store. Throws on an id that isn't valid (never reaches the file system). */
function run(id, fn) {
  if (!validId(id)) throw Object.assign(new Error('Unknown store'), { status: 404 });
  return als.run(id, fn);
}
/** The current store's id, or null outside run(). */
const current = () => als.getStore() || null;
/** The current store's id. Throws outside run(). */
function id() {
  const v = current();
  if (!v) throw new Error('No store chosen (code ran outside scope.run)');
  return v;
}
/** The current store's folder: DATA_DIR/stores/<id>. Tests: the folder given to useDir() when no store is chosen. */
function dir(storeId) {
  if (storeId != null) { if (!validId(storeId)) throw new Error('Bad store id'); return path.join(storesDir(), storeId); }
  const v = current();
  if (v) return path.join(storesDir(), v);
  if (testDir) return testDir;
  throw new Error('No store chosen (code ran outside scope.run)');
}
/** Tests only: a module used outside run() reads and writes `d`. null turns it off. */
function useDir(d) { testDir = d || null; }

module.exports = { run, id, current, dir, root, storesDir, validId, useDir, UUID, SLUG };
