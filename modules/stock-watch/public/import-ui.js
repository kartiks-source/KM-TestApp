/* Stock-out Watch — CSV import preview with column mapping (SW-045). Loads before app.js.
 *  Data → Upload a CSV: choosing a file (or changing "File holds") asks POST /api/import/preview, which writes nothing,
 *  and shows what kind of file it is, our columns ← their headers as selects, and the first 5 rows as they'd be read.
 *  Changing a select previews again. Upload (app.js, #imp-go) then sends the chosen mapping as ?map= (SW_IMPORT.query()),
 *  and the server remembers it for this store and this set of headers. Rules: LOGIC.md §1b. Server: src/csvmap.js. */
(function (root) {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HEAD_BYTES = 256 * 1024;   // a preview reads the start of a big file only
  const SKIP = { badTime: 'bad or future time', badNumber: 'bad number', noId: 'no variant ID', tooOld: 'older than 120 days',
    cancelled: 'cancelled / refunded', untracked: 'stock not tracked', inactive: 'draft or archived' };
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  let pv = null, seq = 0;   // the last preview (null = none / stale), and a counter so a slow answer can't overwrite a newer one

  async function api(path, body) {
    const r = await fetch(root.SW_STORES ? SW_STORES.url(path) : path, { method: 'POST', body, headers: { 'content-type': 'text/csv' } });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const box = () => $('#imp-preview');
  const file = () => { const f = $('#imp-file'); return f && f.files && f.files[0]; };
  const when = (t, off) => { const d = new Date(t + (off || 0) * 60e3); return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

  /** What one read row shows, per our column. */
  function cell(key, r, off) {
    if (!r) return '';
    switch (key) {
      case 'time': return when(r.t, off);
      case 'variant id': return r.variantId;
      case 'stock now': return r.now;
      case 'stock before': return r.before ?? '';
      case 'price': case 'unit price': return r.price ? `₹${inr.format(r.price)}` : '';
      case 'cost': return r.cost ? `₹${inr.format(r.cost)}` : '';
      case 'line discount': return '';
      default: return r[key] ?? '';
    }
  }
  function select(c, v) {
    const opts = [`<option value="">${c.need ? '— choose —' : 'Not used'}</option>`]
      .concat(c.specials.map((s) => `<option value="${esc(s.value)}" ${v === s.value ? 'selected' : ''}>${esc(s.label)}</option>`))
      .concat(pv.headers.map((h) => `<option value="${esc(h)}" ${v === h ? 'selected' : ''}>${esc(h)}</option>`));
    return `<div class="field imp-col${c.need && !v ? ' imp-miss' : ''}"><label for="imp-m-${esc(c.key)}">${esc(c.label)}${c.need ? ' *' : ''}</label>
      <select id="imp-m-${esc(c.key)}" data-imp-col="${esc(c.key)}">${opts.join('')}</select></div>`;
  }
  function render() {
    const b = box(); if (!b) return;
    if (!pv) { b.innerHTML = ''; return; }
    const shown = pv.columns.filter((c) => pv.map[c.key] && c.key !== 'line discount');
    const rowsHtml = pv.sample.map((s) => `<tr class="${s.skip ? 'imp-skip' : ''}">${shown.map((c) => `<td>${esc(s.read ? cell(c.key, s.read, pv.tzOffsetMin) : s.raw[c.key])}</td>`).join('')}
      <td>${s.skip ? `<span class="st crit">${esc(SKIP[s.skip] || s.skip)}</span>` : s.read ? '<span class="st ok">OK</span>' : ''}</td></tr>`).join('');
    b.innerHTML = `<div class="imp-pv">
      <p class="imp-what"><b>${esc(pv.label)}</b> · ${pv.kind === 'order' ? 'order lines' : 'stock counts'} · ${pv.headers.length} columns${pv.remembered ? ' · <span class="okv">mapping from last time</span>' : ''}</p>
      ${pv.rules.length ? `<ul class="imp-rules muted small">${pv.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <p class="muted small">Our column ← the column in your file. * = needed.</p>
      <div class="imp-map">${pv.columns.map((c) => select(c, pv.map[c.key])).join('')}</div>
      ${pv.missing.length ? `<p class="lostv small" id="imp-missing">Choose a column for ${esc(pv.missing.join(', '))} to import.</p>` : ''}
      ${pv.sample.length ? `<p class="muted small">First ${pv.sample.length} rows as they will be read:</p>
      <div class="tbl scrollx imp-sample"><table><thead><tr>${shown.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : '<p class="muted small">No data rows.</p>'}
    </div>`;
  }
  /** Ask the server what the chosen file would read as. kind '' = the file says; map null = the remembered / detected one. */
  async function preview(kind, map) {
    const f = file(); const n = ++seq;
    if (!f) { pv = null; render(); return; }
    const kindSel = $('#imp-kind');
    const head = f.size > HEAD_BYTES;
    const text = await (head ? f.slice(0, HEAD_BYTES) : f).text();
    const qs = new URLSearchParams(); if (kind) qs.set('kind', kind); if (head) qs.set('head', '1'); if (map) qs.set('map', JSON.stringify(map));
    try {
      const j = await api(`/api/import/preview?${qs}`, text);
      if (n !== seq) return;
      pv = j; if (kindSel) kindSel.value = j.kind;
    } catch (e) {
      if (n !== seq) return;
      pv = null; const b = box(); if (b) b.innerHTML = `<p class="lostv small">${esc(e.message)}</p>`; return;
    }
    render();
  }
  const current = () => { const m = {}; document.querySelectorAll('[data-imp-col]').forEach((s) => { m[s.dataset.impCol] = s.value; }); return m; };

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'imp-file') preview('', null);
    else if (t.id === 'imp-kind' && file()) preview(t.value, null);
    else if (t.dataset && t.dataset.impCol && pv) preview(pv.kind, current());
  }, true);
  /* Upload with a required column unmapped: say so here instead of sending a file the server will refuse. */
  document.addEventListener('click', (e) => {
    if (e.target.id !== 'imp-go' || !pv || !pv.missing.length) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const m = $('#imp-missing'); if (m) m.scrollIntoView({ block: 'nearest' });
  }, true);

  root.SW_IMPORT = {
    /** '&map=…' for /api/import when a preview is shown (the mapping is remembered for this store), else ''. */
    query: () => (pv && file() ? `&map=${encodeURIComponent(JSON.stringify(pv.map))}` : ''),
    /** Forget the preview (after an import, the page is drawn again). */
    reset: () => { pv = null; seq++; },
    SKIP,
  };
})(window);
