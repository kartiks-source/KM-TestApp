/* Stock-out Watch — the store picker (multi-store, ADR-0015). Loads first, before roles.js and app.js.
 *  - Which store this page shows: ?store=<id> in the address, else the one last chosen on this browser
 *    (localStorage + the sw_store cookie), else the server's default (the first store).
 *  - SW_STORES.url(path) adds ?store=<id> to every page call, so two tabs on two stores never cross.
 *  - The store pill in the top bar is the picker: a menu of stores with a dot (ok / stale / error); on phones a
 *    store bar under the top bar does the same. Choosing one remembers it and reloads. One store: just its name
 *    (phones: the store bar shows it, no menu). The list (dots, "Synced N min ago") is read again every minute.
 * Rules: LOGIC.md §18. Server: GET /api/stores (server.js). */
(function (root) {
  'use strict';
  const KEY = 'sw-store', COOKIE = 'sw_store';
  const ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{0,60})$/;
  const valid = (x) => typeof x === 'string' && ID.test(x);
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const readLs = () => { try { const v = localStorage.getItem(KEY) || ''; return valid(v) ? v : ''; } catch { return ''; } };
  const readCookie = () => { const m = document.cookie.match(/(?:^|;\s*)sw_store=([^;]+)/); const v = m ? decodeURIComponent(m[1]) : ''; return valid(v) ? v : ''; };
  function remember(id) {
    try { localStorage.setItem(KEY, id); } catch { /* private window: this page only */ }
    document.cookie = `${COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  }

  const fromUrl = (new URLSearchParams(location.search).get('store') || '').toLowerCase();
  let id = valid(fromUrl) ? fromUrl : readLs() || readCookie() || '';
  let list = [];

  /** path + ?store=<id> (or &store=), before any #hash. */
  function url(path) {
    if (!id) return path;
    const i = path.indexOf('#'), p = i < 0 ? path : path.slice(0, i), h = i < 0 ? '' : path.slice(i);
    return `${p}${p.includes('?') ? '&' : '?'}store=${encodeURIComponent(id)}${h}`;
  }
  /** The address with ?store=<id> (other params and the #page kept). */
  function addressFor(storeId) {
    const qs = new URLSearchParams(location.search);
    qs.set('store', storeId);
    return `${location.pathname}?${qs}${location.hash}`;
  }

  /* how long ago, so stores in different time zones read the same */
  const ago = (t) => { const m = Math.max(0, (Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 90 ? `${Math.round(m)} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const STATE_WORD = { ok: 'Up to date', stale: 'Data is old', error: 'Sync problem' };
  /** One line under a store's name: what its dot means right now. */
  function statusLine(s) {
    const st = s.status || {};
    if (st.state === 'error') return `Sync problem: ${st.lastError || 'last pull failed'}`;
    if (st.source === 'demo') return 'Demo data';
    if (st.state === 'stale') return st.lastSync ? `Last good pull ${ago(st.lastSync)}` : 'No good pull yet';
    if (st.running) return 'Pulling now…';
    return st.lastSync ? `Synced ${ago(st.lastSync)}` : st.source === 'live' ? 'Live data' : 'No data yet';
  }
  const dot = (s) => { const k = (s.status && s.status.state) || 'ok'; return `<i class="sdot s-${k}" aria-hidden="true"></i><span class="sr">${STATE_WORD[k]}: </span>`; };
  const current = () => list.find((s) => s.id === id) || null;

  function items() {
    return list.map((s) => `<button class="linkbtn store-opt${s.id === id ? ' on' : ''}" data-store="${esc(s.id)}" aria-current="${s.id === id}" title="${esc(statusLine(s))}">`
      + `<b>${dot(s)}${esc(s.name)}</b><small>${esc(statusLine(s))}</small></button>`).join('');
  }
  function render() {
    const c = current(), many = list.length > 1;
    const nm = document.getElementById('store-name');
    if (nm && c) nm.innerHTML = `${many ? dot(c) : ''}${esc(c.name)}`;
    const pill = nm && nm.closest('.store-pill');
    if (pill && c) pill.title = `${c.name}${many ? ` · ${statusLine(c)} · switch brand` : ''}`;
    const pd = pill && pill.closest('details'); if (pd) { pd.classList.toggle('one', !many); if (!many) pd.removeAttribute('open'); }   // one brand: nothing to pick
    if (c) document.title = `${c.name} · Stock-out Watch`;
    const menu = document.getElementById('store-menu');
    if (menu) menu.innerHTML = many ? `<p class="rp-h" id="store-h">Store</p><div role="group" aria-labelledby="store-h">${items()}</div>` : '';
    const bar = document.getElementById('storebar');
    if (bar) {
      bar.hidden = !c;
      /* phones (critic M1): the bar is the store and role picker, as the pill is on a laptop; the role is shown in it
         (#role-name-m) and chosen in its menu (#role-menu-m), both filled by roles.js */
      bar.innerHTML = !c ? '' : `<details class="colpick storepick"><summary class="store-m" aria-label="Store: ${esc(c.name)}${many ? '. Switch brand' : ''}">${many ? dot(c) : ''}<span class="sm-name">${esc(c.name)}</span>${many ? `<span class="sm-n">${list.length} stores</span>` : ''}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></summary>`
        + `<div class="menu">${many ? `<p class="rp-h" id="store-h-m">Store</p><div role="group" aria-labelledby="store-h-m">${items()}</div>` : ''}</div></details>`;
      if (root.SW_ROLES && root.SW_ROLES.paint) root.SW_ROLES.paint();
    }
    document.documentElement.classList.toggle('multi-store', many);
  }
  function choose(next) {
    if (!valid(next)) return;
    remember(next);
    if (next === id) { document.querySelectorAll('details.colpick[open]').forEach((d) => d.removeAttribute('open')); return; }
    location.assign(addressFor(next));
  }

  const load = () => fetch('/api/stores', { credentials: 'same-origin', cache: 'no-store' })
    .then((r) => { if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); } return r.json(); });
  /** Resolves with the store id once the list is in (app.js waits for it before its first call). */
  const ready = load()
    .then((j) => {
      list = Array.isArray(j.stores) ? j.stores : [];
      if (!list.some((s) => s.id === id)) id = j.current || (list[0] && list[0].id) || '';   // a store no longer listed: the default
      if (id && (new URLSearchParams(location.search).get('store') || '') !== id) history.replaceState(history.state, '', addressFor(id));   // shareable address
      render();
      return id;
    })
    .catch((e) => { if (e.message !== 'Signed out') console.warn('stores:', e.message); return id; });

  /* every minute: fresh dots and "Synced N min ago" (the stale banner re-checks on the same beat). Not while a menu
     is open (a redraw would close it and drop focus), not in a hidden tab; the current store stays chosen. */
  const REFRESH_MS = Number(root.SW_STORES_REFRESH_MS) || 60e3;   // tests set it shorter
  setInterval(() => {
    if (document.hidden || !list.length || document.querySelector('details.rolepick[open], details.storepick[open]')) return;
    load().then((j) => {
      if (!Array.isArray(j.stores) || document.querySelector('details.rolepick[open], details.storepick[open]')) return;
      list = j.stores;
      render();
    }).catch(() => { /* next minute */ });
  }, REFRESH_MS);

  /* choosing: click, Enter / Space on a menu item; arrows move between items; Escape closes and returns focus */
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-store]');
    if (b) { e.preventDefault(); choose(b.dataset.store); return; }
    if (!e.target.closest || !e.target.closest('details.colpick')) document.querySelectorAll('details.rolepick[open], details.storepick[open]').forEach((d) => d.removeAttribute('open'));   // click outside closes
  });
  document.addEventListener('keydown', (e) => {
    const open = e.target.closest && e.target.closest('details.rolepick[open], details.storepick[open]');
    if (!open) return;
    if (e.key === 'Escape') { open.removeAttribute('open'); open.querySelector('summary').focus(); e.preventDefault(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const all = [...open.querySelectorAll('.menu button')], i = all.indexOf(document.activeElement);
      const n = e.key === 'ArrowDown' ? (i + 1) % all.length : (i <= 0 ? all.length - 1 : i - 1);
      if (all[n]) { all[n].focus(); e.preventDefault(); }
    }
  });
  document.addEventListener('toggle', (e) => {   // opening a menu puts focus on the current store, so arrows and Enter work at once
    const d = e.target;
    if (!d.open || !(d.matches && d.matches('details.rolepick, details.storepick'))) return;
    const on = d.querySelector('.menu button.on') || d.querySelector('.menu button');
    if (on && d.contains(document.activeElement)) on.focus();
  }, true);

  /** app.js: the name changed under Data & settings → show it without a reload. */
  function rename(name) { const c = current(); if (c && name && c.name !== name) { c.name = name; render(); } }

  root.SW_STORES = { url, ready, current: () => id, name: () => (current() ? current().name : ''), list: () => list.slice(), rename, valid };
})(window);
