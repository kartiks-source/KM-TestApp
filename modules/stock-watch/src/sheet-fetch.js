'use strict';
/*
 * Google Sheet sync fetch (SW-052). The Sheet links are typed on the Data page, so the fetch is fenced:
 *   - the link must be https://docs.google.com/… ("Publish to web" CSV);
 *   - redirects are followed by hand, at most 3, and only to https://docs.google.com or https://*.googleusercontent.com
 *     (where Google serves published CSVs), never to another host, http, a user:password@ or another port;
 *   - the body is capped at 20 MB (Content-Length checked first, then counted while it streams);
 *   - 20 s for the whole thing, redirects and body included.
 * Errors are plain sentences; the link itself is never put in an error or a log (it is a read key to the Sheet).
 */

const MAX_REDIRECTS = 3;
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/** '' when `u` (a URL object) may be fetched; else why not. `first`: the link typed on the page (docs.google.com only). */
function refuse(u, first) {
  if (u.protocol !== 'https:') return 'only https links are read';
  if (u.username || u.password) return 'links with a user name or password are not read';
  if (u.port && u.port !== '443') return 'links with a port are not read';
  const h = u.hostname.toLowerCase();
  if (h === 'docs.google.com') return '';
  if (!first && h.endsWith('.googleusercontent.com') && h.length > '.googleusercontent.com'.length) return '';
  return first ? 'Sheet links must be Google Sheets "Publish to web" CSV links' : `it redirected to ${h}, which isn’t Google`;
}

/** Reads the body up to `max` bytes; throws past it (and stops the download), or when `signal` fires mid-body. */
async function readCapped(r, max, signal) {
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) { try { await r.body?.cancel(); } catch { /* already closed */ } throw new Error(`the file is over ${Math.round(max / 1048576)} MB`); }
  if (!r.body) return '';
  const reader = r.body.getReader();
  const stopped = new Promise((_, reject) => {
    const stop = () => { reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); reader.cancel().catch(() => {}); };
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
  stopped.catch(() => {});   // only raced below
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), stopped]);
    if (done) { if (signal.aborted) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); break; }
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch { /* closed */ } throw new Error(`the file is over ${Math.round(max / 1048576)} MB`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/**
 * The text at a published Sheet link. Throws Error with a plain message (prefix it with the tab's name).
 * Options for tests: fetchImpl, maxRedirects, maxBytes, timeoutMs.
 */
async function sheetText(link, { fetchImpl = fetch, maxRedirects = MAX_REDIRECTS, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let u;
  try { u = new URL(String(link)); } catch { throw new Error('Sheet links must be Google Sheets "Publish to web" CSV links'); }
  const why = refuse(u, true);
  if (why) throw new Error(why);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let hops = 0; ; hops++) {
      const r = await fetchImpl(u.href, { redirect: 'manual', signal, headers: { accept: 'text/csv, text/plain;q=0.9, */*;q=0.1' } });
      if (REDIRECT.has(r.status)) {
        try { await r.body?.cancel(); } catch { /* nothing to drop */ }
        if (hops >= maxRedirects) throw new Error(`more than ${maxRedirects} redirects`);
        const loc = r.headers.get('location');
        if (!loc) throw new Error(`HTTP ${r.status} without a new address`);
        let next; try { next = new URL(loc, u); } catch { throw new Error('it redirected to a bad address'); }
        const no = refuse(next, false);
        if (no) throw new Error(no);
        u = next; continue;
      }
      if (!r.ok) { try { await r.body?.cancel(); } catch { /* nothing to drop */ } throw new Error(`HTTP ${r.status}`); }
      return await readCapped(r, maxBytes, signal);
    }
  } catch (e) {
    if (signal.aborted || e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  }
}

module.exports = { sheetText, refuse, MAX_REDIRECTS, MAX_BYTES, TIMEOUT_MS };
