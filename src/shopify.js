'use strict';
/*
 * Read-only Shopify pull. Every call goes through gql(), which refuses anything that isn't a
 * plain GraphQL query, so this app cannot change a store even if its token could.
 *
 * Needs only these read scopes: read_products, read_inventory, read_orders.
 *
 *   pullStock   every variant's total stock now; a stock row is stored only when it changed
 *   pullOrders  order lines created since the last pull (first run: the last 60 days)
 *
 * Paced by Shopify's own cost budget: waits whenever less than half of it is left,
 * so the store's other apps are never starved.
 */

const keys = require('./keys');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const BACKFILL_DAYS = 60;            // read_orders sees 60 days; older needs read_all_orders
const OVERLAP = 30 * 60e3;           // re-read the last 30 minutes so late-indexed orders aren't missed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The read-only guard: only a query document, never a mutation or subscription. */
function assertReadOnly(doc) {
  const s = String(doc).replace(/#[^\n]*/g, '').replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (!/^\s*(query\b|\{)/.test(s) || /\b(mutation|subscription)\b/.test(s)) throw new Error('Blocked: this app only reads from Shopify');
}

/** One GraphQL query. Retries throttling and a rejected (rotated) token once. */
async function gql(doc, variables = {}, { fetchImpl = fetch, tries = 0 } = {}) {
  assertReadOnly(doc);
  const { shop, token } = await keys.access();
  const r = await fetchImpl(`https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: doc, variables }),
  });
  if (r.status === 401 || r.status === 403) {
    keys.clear();
    if (tries < 1) return gql(doc, variables, { fetchImpl, tries: tries + 1 });
    throw new Error(r.status === 401 ? 'Shopify rejected the token' : 'The token lacks a read permission (needs read_products, read_inventory, read_orders)');
  }
  if (r.status === 429 || r.status >= 500) {
    if (tries >= 5) throw new Error(`Shopify: HTTP ${r.status}`);
    await sleep(2000 * (tries + 1));
    return gql(doc, variables, { fetchImpl, tries: tries + 1 });
  }
  if (r.status === 404) throw new Error('Store not found: check SHOPIFY_STORE (the part before .myshopify.com)');
  if (!r.ok) throw new Error(`Shopify: HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
    if (tries >= 8) throw new Error('Shopify kept throttling');
    await sleep(3000); return gql(doc, variables, { fetchImpl, tries: tries + 1 });
  }
  if (j.errors?.length) {
    const msg = j.errors.map((e) => e.message).join('; ');
    if (/access denied|scope/i.test(msg)) throw new Error('The token lacks a read permission (needs read_products, read_inventory, read_orders)');
    throw new Error(`Shopify: ${msg.slice(0, 200)}`);
  }
  const t = j.extensions?.cost?.throttleStatus;
  if (t && t.currentlyAvailable < t.maximumAvailable / 2) {
    await sleep(Math.min(20000, ((t.maximumAvailable / 2 - t.currentlyAvailable) / Math.max(1, t.restoreRate)) * 1000));
  }
  return j.data;
}

const STOCK_Q = `query Stock($after: String) {
  productVariants(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id sku title price inventoryQuantity inventoryItem { tracked } product { title status } }
  }
}`;

const ORDERS_Q = `query Orders($after: String, $q: String) {
  orders(first: 40, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt test
      lineItems(first: 20) {
        pageInfo { hasNextPage endCursor }
        nodes { quantity sku variant { id } discountedUnitPriceSet { shopMoney { amount } } }
      }
    }
  }
}`;

const MORE_LINES_Q = `query Lines($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { quantity sku variant { id } discountedUnitPriceSet { shopMoney { amount } } }
    }
  }
}`;

const vid = (gid) => String(gid || '').replace(/^gid:\/\/shopify\/ProductVariant\//, '');

/**
 * Compare the store's stock now with what we saw last time.
 * Returns stock rows for what changed, and the new last-seen map.
 */
function diffStock(variants, lastQty, t) {
  const rows = []; const next = {};
  for (const v of variants) {
    if (v.inventoryItem && v.inventoryItem.tracked === false) continue;
    if (v.product && v.product.status && v.product.status !== 'ACTIVE') continue;
    const id = vid(v.id); const now = Number(v.inventoryQuantity);
    if (!id || !Number.isFinite(now)) continue;
    next[id] = now;
    const before = Object.prototype.hasOwnProperty.call(lastQty, id) ? lastQty[id] : null;
    if (before === now) continue;
    rows.push({ t, variantId: id, sku: v.sku || '', product: v.product?.title || '', variant: v.title === 'Default Title' ? '' : (v.title || ''), before, now, price: Number(v.price) || 0 });
  }
  return { rows, lastQty: next };
}

/** Order nodes → order rows (test orders skipped). */
function orderRows(order, lines) {
  if (order.test) return [];
  const t = Date.parse(order.createdAt);
  return lines.filter((l) => l.variant?.id && l.quantity > 0).map((l) => ({
    t, order: order.name, variantId: vid(l.variant.id), sku: l.sku || '', qty: l.quantity,
    price: Number(l.discountedUnitPriceSet?.shopMoney?.amount) || 0,
  }));
}

async function pullStock(lastQty, { q = gql, now = Date.now() } = {}) {
  const all = []; let after = null;
  do {
    const d = await q(STOCK_Q, { after });
    all.push(...d.productVariants.nodes);
    after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
  } while (after);
  return diffStock(all, lastQty || {}, now);
}

/**
 * Order lines created after `since` (ms), oldest first. onPage(rows, cursor) is called after every
 * page so progress is saved as it goes (cursor = newest createdAt seen so far).
 */
async function pullOrders(since, { q = gql, now = Date.now(), onPage = () => {} } = {}) {
  const from = Math.max(since ? since - OVERLAP : 0, now - BACKFILL_DAYS * 864e5);
  const filter = `created_at:>='${new Date(from).toISOString()}'`;
  let after = null; let cursor = since || from; let total = 0;
  do {
    const d = await q(ORDERS_Q, { after, q: filter });
    const rows = [];
    for (const o of d.orders.nodes) {
      const lines = [...o.lineItems.nodes];
      let li = o.lineItems.pageInfo;
      while (li.hasNextPage) {
        const m = await q(MORE_LINES_Q, { id: o.id, after: li.endCursor });
        lines.push(...m.order.lineItems.nodes); li = m.order.lineItems.pageInfo;
      }
      rows.push(...orderRows(o, lines));
      cursor = Math.max(cursor, Date.parse(o.createdAt) || 0);
    }
    total += rows.length;
    await onPage(rows, cursor);
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);
  return { total, cursor };
}

module.exports = { gql, assertReadOnly, diffStock, orderRows, pullStock, pullOrders, API_VERSION, SCOPES: ['read_products', 'read_inventory', 'read_orders'] };
