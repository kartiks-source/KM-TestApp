/* Stock-out Watch — paste-a-list lookup + saved lists on Products (SW-044, LOGIC.md §9d). Loads before app.js.
 * The Products search box takes a pasted list of SKUs / names / variant IDs (new lines, commas, tabs, semicolons):
 * the table shows those products and a bar says how many were found and which weren't. A list can be saved by name for
 * the whole team (admin saves and deletes, view-only picks): GET/POST /api/lists.
 * app.js: productRows() filters by SW_LISTS.match(q, products); products() shows SW_LISTS.pick() beside the search and
 * SW_LISTS.bar() under the toolbar. match() is pure and also runs in node (test/lists.test.js). */
(function (root) {
  'use strict';
  const SEP = /[\n\r\t,;]+/;
  /** A pasted list → its entries: trimmed, blanks and repeats (any case) dropped. Same split as src/lists.js. */
  function split(text) {
    const seen = new Set(), out = [];
    for (const x of String(text ?? '').split(SEP)) { const v = x.trim(), k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } }
    return out;
  }
  /**
   * Which products a list names. null when q is not a list (no separator), so the plain search applies.
   * Each entry matches, in order: SKU, variant ID or full product name exactly (any case); else, 3 characters or more,
   * every product whose name or SKU contains it. → { ids: Set, entries, notFound: [entry] }
   */
  function match(q, products) {
    if (!SEP.test(String(q || ''))) return null;
    const entries = split(q);
    if (!entries.length) return null;
    const idx = new Map();
    const put = (k, id) => { if (!k) return; k = String(k).toLowerCase(); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(id); };
    for (const p of products) { put(p.sku, p.id); put(p.id, p.id); put(p.name, p.id); }
    const ids = new Set(), notFound = [];
    for (const e of entries) {
      const k = e.toLowerCase();
      let hit = idx.get(k) || [];
      if (!hit.length && k.length >= 3) hit = products.filter((p) => `${p.name}\n${p.sku || ''}`.toLowerCase().includes(k)).map((p) => p.id);
      if (hit.length) hit.forEach((id) => ids.add(id)); else notFound.push(e);
    }
    return { ids, entries, notFound };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { split, match }; return; }

  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const url = (p) => (root.SW_STORES ? SW_STORES.url(p) : p);
  const storeKey = () => `${root.SW_STORES && SW_STORES.current ? SW_STORES.current() : ''}`;
  let lists = null, listsFor = '', at = 0, loading = false, ctx = { canEdit: false, rerender: () => {} };

  function load(force) {
    const k = storeKey();
    if (loading || (!force && listsFor === k && Date.now() - at < 2 * 60e3)) return;
    loading = true;
    fetch(url('/api/lists')).then((r) => r.json()).then((j) => { if (j && j.ok) { lists = j.lists; listsFor = k; at = Date.now(); ctx.rerender(); } })
      .catch(() => { /* no menu; tries again on the next render */ }).finally(() => { loading = false; });
  }
  const mine = () => (listsFor === storeKey() && lists) || [];
  const textOf = (l) => l.items.join(', ');
  const active = (q) => mine().find((l) => textOf(l) === q) || null;

  /** The saved-lists menu beside the search box (only when the store has any). */
  function pick(q, opts = {}) {
    ctx = { canEdit: !!opts.canEdit, rerender: opts.rerender || (() => {}) };
    load();
    const L = mine(); if (!L.length) return '';
    const a = active(q);
    return `<select class="search sel ls-pick" id="ls-pick" aria-label="Saved lists"><option value="">Saved lists (${L.length})</option>${L.map((l) => `<option value="${esc(l.id)}" ${a && a.id === l.id ? 'selected' : ''}>${esc(l.name)} · ${inr.format(l.items.length)}</option>`).join('')}</select>`;
  }
  /** The bar under the toolbar while a list is in the search box: found / not found, Save (admin), Delete (admin, saved list), Clear. */
  function bar(q, products) {
    const m = match(q, products); if (!m) return '';
    const a = active(q), nf = m.notFound;
    const miss = nf.length ? `<span class="ls-nf" title="${esc(nf.join('\n'))}"><b>${inr.format(nf.length)} not found:</b> ${esc(nf.slice(0, 6).join(', '))}${nf.length > 6 ? ` +${inr.format(nf.length - 6)} more` : ''}</span>` : '';
    const save = ctx.canEdit ? `<span class="ls-save"><input id="ls-name" maxlength="60" placeholder="Name this list" aria-label="List name" value="${esc(a ? a.name : '')}"><button class="btn xs" id="ls-save">${a ? 'Save' : 'Save list'}</button>${a ? `<button class="btn ghost xs" id="ls-del" data-id="${esc(a.id)}">Delete</button>` : ''}</span>` : '';
    return `<div class="lsbar"><span>List: <b>${inr.format(m.entries.length - nf.length)}</b> of ${inr.format(m.entries.length)} found${a ? ` · <b>${esc(a.name)}</b>` : ''}</span>${miss}${save}<button class="linkbtn" id="ls-clear">Clear</button></div>`;
  }

  function setQ(v) {
    const i = document.getElementById('q-products'); if (!i) return;
    i.value = v; i.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function toast(msg) { const t = document.getElementById('toast'); if (t) { t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); } }
  async function post(body) {
    const r = await fetch(url('/api/lists'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    lists = j.lists; listsFor = storeKey(); at = Date.now();
    return j;
  }

  /* a pasted list keeps its line breaks and tabs as ", " (a one-line search box would drop them) */
  document.addEventListener('paste', (e) => {
    if (e.target.id !== 'q-products') return;
    const t = (e.clipboardData || root.clipboardData)?.getData('text') || '';
    if (!/[\n\r\t]/.test(t)) return;
    e.preventDefault();
    const i = e.target, v = i.value, s = i.selectionStart ?? v.length, en = i.selectionEnd ?? v.length;
    const before = v.slice(0, s).replace(/[\s,;]+$/, ''), after = v.slice(en).replace(/^[\s,;]+/, '');
    setQ([before, split(t).join(', '), after].filter(Boolean).join(', '));
  });
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'ls-pick') return;
    const l = mine().find((x) => x.id === e.target.value);
    setQ(l ? textOf(l) : '');
  });
  document.addEventListener('click', (e) => {
    const id = e.target.id;
    if (id === 'ls-clear') { e.stopImmediatePropagation(); setQ(''); return; }
    if (id === 'ls-save') {
      e.stopImmediatePropagation();
      const q = document.getElementById('q-products')?.value || '', name = document.getElementById('ls-name')?.value || '';
      post({ name, items: split(q) }).then(() => { toast(`List “${name.trim()}” saved for the team`); ctx.rerender(); }).catch((err) => toast(err.message));
      return;
    }
    if (id === 'ls-del') {
      e.stopImmediatePropagation();
      if (!root.confirm('Delete this saved list for everyone?')) return;
      post({ id: e.target.dataset.id, delete: true }).then(() => { toast('List deleted'); ctx.rerender(); }).catch((err) => toast(err.message));
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'ls-name' && e.key === 'Enter') { e.preventDefault(); document.getElementById('ls-save')?.click(); }
  }, true);

  root.SW_LISTS = { split, match, pick, bar };
})(typeof window !== 'undefined' ? window : globalThis);
