'use strict';
/*
 * Read-only Shopify pull. Every call goes through gql(), which refuses anything that isn't a
 * plain GraphQL query, so this app cannot change a store even if its token could.
 *
 * Needs only these read scopes: read_products, read_inventory, read_orders.
 *
 *   pullStock   every variant's total stock now; a stock row is stored only when it changed, and the
 *               whole catalog (stock now, price, cost, type, tags, status) is returned on every pull
 *   pullOrders  orders changed since the last pull (first run: created in the last 60 days). Each order's
 *               lines are replaced whole, so later cancellations, refunds and edits are picked up.
 *               What counts as a sale: not cancelled, not a test order, units net of refunds and
 *               removals (currentQuantity), price after line AND order-level discounts.
 *
 * Paced by Shopify's own cost budget: waits whenever less than half of it is left,
 * so the store's other apps are never starved.
 */

const keys = require('./keys');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const BACKFILL_DAYS = 60;            // read_orders sees 60 days; older needs read_all_orders
const OVERLAP = 30 * 60e3;           // re-read the last 30 minutes so late-indexed orders aren't missed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The read-only guard: only query documents, never a mutation or subscription (a tokeniser, SW-051: src/gql-guard.js). */
const { assertReadOnly } = require('./gql-guard');

/** One GraphQL query. Retries throttling and a rejected (rotated) token once. `version` = another Admin API version (ShopifyQL, src/history.js). */
async function gql(doc, variables = {}, { fetchImpl = fetch, tries = 0, version = API_VERSION } = {}) {
  assertReadOnly(doc);
  const { shop, token } = await keys.access();
  const r = await fetchImpl(`https://${shop}.myshopify.com/admin/api/${version}/graphql.json`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query: doc, variables }),
  });
  if (r.status === 401 || r.status === 403) {
    keys.clear();
    if (tries < 1) return gql(doc, variables, { fetchImpl, tries: tries + 1, version });
    throw new Error(r.status === 401 ? 'Shopify rejected the token' : 'The token lacks a read permission (needs read_products, read_inventory, read_orders)');
  }
  if (r.status === 429 || r.status >= 500) {
    if (tries >= 5) throw new Error(`Shopify: HTTP ${r.status}`);
    await sleep(2000 * (tries + 1));
    return gql(doc, variables, { fetchImpl, tries: tries + 1, version });
  }
  if (r.status === 404) throw new Error('Store not found: check SHOPIFY_STORE (the part before .myshopify.com)');
  if (!r.ok) throw new Error(`Shopify: HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
    if (tries >= 8) throw new Error('Shopify kept throttling');
    await sleep(3000); return gql(doc, variables, { fetchImpl, tries: tries + 1, version });
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
    nodes { id sku title price inventoryQuantity inventoryItem { tracked unitCost { amount } } product { id title status productType tags vendor } }
  }
}`;

const LINE_FIELDS = 'id currentQuantity sku variant { id } discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }';
const ORDERS_Q = `query Orders($after: String, $q: String) {
  orders(first: 40, after: $after, query: $q, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt updatedAt cancelledAt test
      lineItems(first: 20) {
        pageInfo { hasNextPage endCursor }
        nodes { ${LINE_FIELDS} }
      }
    }
  }
}`;

const MORE_LINES_Q = `query Lines($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${LINE_FIELDS} }
    }
  }
}`;

const vid = (gid) => String(gid || '').replace(/^gid:\/\/shopify\/ProductVariant\//, '');

/**
 * Compare the store's stock now with what we saw last time.
 * Returns stock rows for what changed (active, tracked variants only), the new last-seen map, and
 * the catalog: every variant returned, with stock now, attributes and whether it's active (SW-002).
 * Inactive = product archived or draft, or stock not tracked; it's kept in the catalog, marked.
 */
function diffStock(variants, lastQty, t) {
  const rows = []; const next = {}; const catalog = {}; const excluded = { notActive: 0, untracked: 0 };   // counted for the run history (SW-030)
  for (const v of variants) {
    const id = vid(v.id); const now = Number(v.inventoryQuantity);
    if (!id) continue;
    const tracked = !(v.inventoryItem && v.inventoryItem.tracked === false);
    const status = v.product?.status || 'ACTIVE';
    const cost = Number(v.inventoryItem?.unitCost?.amount) > 0 ? Number(v.inventoryItem.unitCost.amount) : null;
    const variant = v.title === 'Default Title' ? '' : (v.title || '');
    catalog[id] = {
      productId: String(v.product?.id || '').replace(/^gid:\/\/shopify\/Product\//, ''), product: v.product?.title || '', variant, sku: v.sku || '',
      type: v.product?.productType || '', vendor: v.product?.vendor || '', tags: Array.isArray(v.product?.tags) ? v.product.tags : [], price: Number(v.price) || 0, cost,
      status: tracked ? status : (status === 'ACTIVE' ? 'UNTRACKED' : status), tracked, active: tracked && status === 'ACTIVE',
      stock: Number.isFinite(now) ? now : null, seenAt: t,
    };
    if (!tracked) excluded.untracked++; else if (status !== 'ACTIVE') excluded.notActive++;
    if (!catalog[id].active || !Number.isFinite(now)) continue;
    next[id] = now;
    const before = Object.prototype.hasOwnProperty.call(lastQty, id) ? lastQty[id] : null;
    if (before === now) continue;
    rows.push({ t, variantId: id, sku: v.sku || '', product: v.product?.title || '', variant, before, now, price: Number(v.price) || 0, ...(v.product?.productType ? { type: v.product.productType } : {}), ...(v.product?.vendor ? { vendor: v.product.vendor } : {}), ...(cost ? { cost } : {}) });
  }
  return { rows, lastQty: next, catalog, excluded };
}

/** An order → its sale lines. Cancelled and test orders have none; fully refunded lines drop out. */
function orderRows(order, lines) {
  if (order.test || order.cancelledAt) return [];
  const t = Date.parse(order.createdAt);
  return lines.filter((l) => l.variant?.id && l.currentQuantity > 0).map((l) => ({
    t, order: order.name, line: String(l.id || '').replace(/^gid:\/\/shopify\/LineItem\//, ''), variantId: vid(l.variant.id), sku: l.sku || '',
    qty: l.currentQuantity, price: Number(l.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount) || 0,
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
 * Orders changed since `since` (ms; the newest updatedAt seen last time), oldest change first.
 * First run (no `since`): every order created in the last 60 days.
 * onPage(orderNames, rows, cursor) after each page: the caller replaces those orders' lines whole,
 * and saves the cursor so a long first load resumes where it stopped.
 */
async function pullOrders(since, { q = gql, now = Date.now(), onPage = () => {} } = {}) {
  const filter = since
    ? `updated_at:>='${new Date(since - OVERLAP).toISOString()}'`
    : `created_at:>='${new Date(now - BACKFILL_DAYS * 864e5).toISOString()}'`;
  let after = null; let cursor = since || 0; let total = 0;
  do {
    const d = await q(ORDERS_Q, { after, q: filter });
    const rows = [], names = [];
    for (const o of d.orders.nodes) {
      names.push(o.name);
      const lines = [...o.lineItems.nodes];
      let li = o.lineItems.pageInfo;
      while (li.hasNextPage) {
        const m = await q(MORE_LINES_Q, { id: o.id, after: li.endCursor });
        lines.push(...m.order.lineItems.nodes); li = m.order.lineItems.pageInfo;
      }
      rows.push(...orderRows(o, lines));
      cursor = Math.max(cursor, Date.parse(o.updatedAt) || Date.parse(o.createdAt) || 0);
    }
    total += rows.length;
    await onPage(names, rows, cursor);
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);
  return { total, cursor };
}

module.exports = { gql, assertReadOnly, diffStock, orderRows, pullStock, pullOrders, API_VERSION, SCOPES: ['read_products', 'read_inventory', 'read_orders'] };
