'use strict';
/*
 * Sync alerts. When ALERT_WEBHOOK_URL is set (https; e.g. a Slack/Google Chat incoming webhook or
 * any endpoint taking JSON), we post one short message when Shopify pulls start failing, a reminder
 * every 6 hours while they keep failing, and one when they work again. Never includes a token or key.
 */
const REMIND = 6 * 3600e3;
let failingSince = null, lastSent = 0;

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

/** Call after every pull: ok=true on success, ok=false with the error message on failure. */
async function syncResult(ok, message, { now = Date.now(), store = '', fetchImpl } = {}) {
  const name = store ? `Stock-out Watch (${store})` : 'Stock-out Watch';
  if (ok) {
    if (failingSince) { const since = failingSince; failingSince = null; lastSent = 0; return post(`✅ ${name}: Shopify pulls work again (failing since ${new Date(since).toISOString()}).`, fetchImpl); }
    return false;
  }
  const clean = String(message || 'unknown error').replace(/(shpat_|shpca_|Bearer\s+)\S+/gi, '$1…').slice(0, 300);
  if (!failingSince) { failingSince = now; lastSent = now; return post(`⚠️ ${name}: Shopify pull failed: ${clean}. Data on the page is getting stale.`, fetchImpl); }
  if (now - lastSent >= REMIND) { lastSent = now; return post(`⚠️ ${name}: Shopify pulls still failing for ${Math.round((now - failingSince) / 3600e3)} h: ${clean}`, fetchImpl); }
  return false;
}

module.exports = { syncResult, _reset: () => { failingSince = null; lastSent = 0; } };
