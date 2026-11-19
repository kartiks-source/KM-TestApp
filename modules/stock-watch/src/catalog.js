'use strict';
/*
 * The catalog that Group by (SW-022) rolls up on: which parent product each variant belongs to, its
 * category and tags, and which collections each product is in. Read-only from Shopify, kept in
 * DATA_DIR/catalog.json (separate from store.json). Rules: LOGIC.md §9b.
 *
 *   variants     from the stock pull every 15 minutes (STOCK_Q reads product { id tags productType })
 *   collections  every collection and its products, re-read once a day (24 h cache). Progress is saved
 *                after every page, so a restart carries on where it stopped instead of starting again.
 *
 * Every query goes through shopify.gql, so the read-only guard applies.
 */
const fs = require('node:fs');
const path = require('node:path');

const TTL = 24 * 36e5;          // collections change rarely; once a day is enough
const MAX_PAGES = 400;          // per run; the rest carries on with the next pull

const COLLECTIONS_Q = `query Collections($after: String) {
  collections(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id title }
  }
}`;
const MEMBERS_Q = `query CollectionProducts($id: ID!, $after: String) {
  collection(id: $id) {
    products(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
}`;

const gidTail = (gid) => String(gid || '').replace(/^gid:\/\/shopify\/\w+\//, '');
let FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'catalog.json');
let cat = null;
let running = null;

const blank = () => ({ variants: {}, variantsAt: null, collections: {}, collectionsAt: null, pending: null, lastError: null });
function load() {
  if (cat) return cat;
  try { cat = { ...blank(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { cat = blank(); }
  return cat;
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cat));
  fs.renameSync(FILE + '.tmp', FILE);
}
/** Tests: point at another file and forget what's in memory. */
function use(file) { FILE = file; cat = null; running = null; }

/** Stock-pull variant nodes → { variantId: { productId, product, type, tags } }. */
function fromVariants(nodes) {
  const out = {};
  for (const v of nodes || []) {
    const id = gidTail(v.id); if (!id) continue;
    out[id] = { productId: gidTail(v.product?.id), product: v.product?.title || '', type: v.product?.productType || '', tags: Array.isArray(v.product?.tags) ? v.product.tags : [] };
  }
  return out;
}

/** Called with every variant node of a stock pull. */
function setVariants(nodes, now = Date.now()) {
  const c = load(); c.variants = fromVariants(nodes); c.variantsAt = now; save();
}

/**
 * Read collections and their products, at most once a day. Resumes an unfinished read.
 * Returns { skipped } (fresh), { partial } (page budget used up; carries on next time) or { collections }.
 */
function refreshCollections(opts = {}) {
  if (running) return running;
  running = (async () => {
    const { q = require('./shopify').gql, now = Date.now(), maxPages = MAX_PAGES } = opts;
    const c = load();
    if (!c.pending) {
      if (c.collectionsAt && now - c.collectionsAt < TTL) return { skipped: true };
      c.pending = { listAfter: null, listDone: false, list: [], i: 0, after: null, members: {} }; save();
    }
    const P = c.pending; let pages = 0;
    try {
      while (!P.listDone) {
        if (pages++ >= maxPages) return { partial: true };
        const d = await q(COLLECTIONS_Q, { after: P.listAfter });
        P.list.push(...d.collections.nodes.map((n) => ({ gid: n.id, id: gidTail(n.id), title: n.title || '' })));
        P.listAfter = d.collections.pageInfo.endCursor; P.listDone = !d.collections.pageInfo.hasNextPage;
        save();
      }
      while (P.i < P.list.length) {
        if (pages++ >= maxPages) return { partial: true };
        const col = P.list[P.i];
        const d = await q(MEMBERS_Q, { id: col.gid, after: P.after });
        const conn = d.collection?.products;
        if (conn) (P.members[col.id] = P.members[col.id] || []).push(...conn.nodes.map((n) => gidTail(n.id)));
        if (conn?.pageInfo.hasNextPage) P.after = conn.pageInfo.endCursor; else { P.i++; P.after = null; }
        save();
      }
      c.collections = Object.fromEntries(P.list.map((x) => [x.id, { title: x.title, productIds: [...new Set(P.members[x.id] || [])] }]));
      c.collectionsAt = now; c.pending = null; c.lastError = null; save();
      return { collections: P.list.length };
    } catch (e) { c.lastError = e.message; save(); throw e; }
  })().finally(() => { running = null; });
  return running;
}

/** The catalog to group by: the demo's own when the data is the demo, else what Shopify gave us. */
function current(source) {
  if (source === 'demo') return require('./demo').catalog();
  return load();
}

/** What the page says about the catalog. */
function info(c) {
  return { demo: !!c.demo, variants: Object.keys(c.variants || {}).length, collections: Object.keys(c.collections || {}).length,
    variantsAt: c.variantsAt || null, collectionsAt: c.collectionsAt || null, reading: !!c.pending, lastError: c.lastError || null };
}

module.exports = { fromVariants, setVariants, refreshCollections, current, info, use, load, TTL, COLLECTIONS_Q, MEMBERS_Q };
