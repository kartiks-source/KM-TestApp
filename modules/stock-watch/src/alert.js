'use strict';
/*
 * Sync alerts. When ALERT_WEBHOOK_URL is set (https; e.g. a Slack/Google Chat incoming webhook or
 * any endpoint taking JSON), we post one short message when Shopify pulls start failing, a reminder
 * every 6 hours while they keep failing, and one when they work again. Never includes a token or key.
 * Each store is tracked on its own (ADR-0015) and every message names the store.
 */
const REMIND = 6 * 3600e3;
const state = new Map();   // store id ('' = one store) → { failingSince, lastSent }

function url() {
  const u = String(process.env.ALERT_WEBHOOK_URL || '').trim();
  return /^https:\/\/[^\s]+$/i.test(u) ? u : '';
}

async function post(text, fetchImpl = fetch) {
  const u = url(); if (!u) return false;
  try {
    await fetchImpl(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    return true;
  } catch { return false; }                                   // an alert that can't be sent must never break the sync
}

/** Call after every pull: ok=true on success, ok=false with the error message on failure.
 *  store = the name people know the store by; key = its id (each store's failures are tracked apart). */
async function syncResult(ok, message, { now = Date.now(), store = '', key = '', fetchImpl } = {}) {
  const name = store ? `Stock-out Watch (${store})` : 'Stock-out Watch';
  const id = String(key || store || '');
  const st = state.get(id) || { failingSince: null, lastSent: 0 };
  state.set(id, st);
  if (ok) {
    if (st.failingSince) { const since = st.failingSince; st.failingSince = null; st.lastSent = 0; return post(`✅ ${name}: Shopify pulls work again (failing since ${new Date(since).toISOString()}).`, fetchImpl); }
    return false;
  }
  const clean = String(message || 'unknown error').replace(/(shpat_|shpca_|Bearer\s+)\S+/gi, '$1…').slice(0, 300);
  if (!st.failingSince) { st.failingSince = now; st.lastSent = now; return post(`⚠️ ${name}: Shopify pull failed: ${clean}. Data on the page is getting stale.`, fetchImpl); }
  if (now - st.lastSent >= REMIND) { st.lastSent = now; return post(`⚠️ ${name}: Shopify pulls still failing for ${Math.round((now - st.failingSince) / 3600e3)} h: ${clean}`, fetchImpl); }
  return false;
}

module.exports = { syncResult, _reset: () => { state.clear(); } };
