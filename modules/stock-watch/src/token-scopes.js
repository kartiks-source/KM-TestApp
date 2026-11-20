'use strict';
/*
 * Token permissions check (SW-051), once at the start of every Shopify pull:
 *   query { currentAppInstallation { accessScopes { handle } } }
 *
 *   Our own apps (key source vault / variables): the brand installed the app for us, read-only (ADR-0001). A token
 *   that can also write (any write_* scope) is refused: the pull stops with a plain error, so the brand removes
 *   the write permissions instead of a broad token sitting on our server.
 *   Performity's token (tokenapi, ADR-0014): their app needs write scopes for its own work, so the pull goes on;
 *   the Data page says "token also allows writes; this app only reads" and the server log says it once per store.
 *
 * Either way every call still goes through the read-only guard (src/gql-guard.js), so nothing is ever written.
 */
const shopify = require('./shopify');

const SCOPES_Q = 'query Scopes { currentAppInstallation { accessScopes { handle } } }';
const OWN = new Set(['vault', 'variables']);
const warned = new Map();   // store id → the write scopes last logged for it

/** The write scopes in a list of handles, sorted. */
const writes = (handles) => [...new Set(handles.filter((h) => /^write_/.test(h)))].sort();

/** Plain-words refusal for one of our own apps holding write permissions. */
function refusal(write) {
  return `This store’s Shopify app can also change data (${write.join(', ')}). Stock-out Watch only reads: remove the write permissions from the app in Shopify (keep read_products, read_inventory, read_orders), then pull again.`;
}

/**
 * Read the token's scopes and apply the rule above. Returns { handles, write } (write = the write_* scopes).
 * Throws for our own apps when write is not empty, or when the scopes can't be read (fail closed). For the
 * Performity token a failed read is logged and the pull goes on ({ handles: null, write: [] }).
 */
async function check(source, storeId = '', { q = shopify.gql, log = console } = {}) {
  let handles;
  try {
    const d = await q(SCOPES_Q);
    const list = d && d.currentAppInstallation && d.currentAppInstallation.accessScopes;
    if (!Array.isArray(list)) throw new Error('Shopify didn’t list the token’s permissions');
    handles = list.map((s) => String(s && s.handle || '')).filter(Boolean);
  } catch (e) {
    if (OWN.has(source)) throw new Error(`Couldn’t check the Shopify app’s permissions: ${e.message}`);
    log.warn(`shopify (${storeId}): token permissions not checked: ${e.message}`);
    return { handles: null, write: [] };
  }
  const write = writes(handles);
  if (write.length && OWN.has(source)) throw new Error(refusal(write));
  if (write.length) {
    const key = write.join(',');
    if (warned.get(storeId) !== key) { warned.set(storeId, key); log.warn(`shopify (${storeId}): token also allows writes (${key}); this app only reads (ADR-0014)`); }
  } else warned.delete(storeId);
  return { handles, write };
}

module.exports = { check, writes, refusal, SCOPES_Q, _reset: () => warned.clear() };
