/* Stock-out Watch — monthly targets on groups (SW-042, LOGIC.md §9c). Loads before app.js.
 * Products → View: Categories / Collections / Tags / Parent products gets a "Target this month" column (and a line on
 * phone cards): month-to-date sales against the group's target, a traffic light from the month-end forecast, and how
 * much of the gap stock-outs explain. Admin sets a target in the cell; view-only sees it. Data: GET/POST /api/targets.
 * app.js calls SW_TARGETS.col(lens, { canEdit, rerender }) inside GROUP_COLS and SW_TARGETS.card(g) on phone cards. */
(function () {
  'use strict';
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const money = (x) => { const v = Math.round(+x || 0), a = Math.abs(v); return a >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `₹${(v / 1e5).toFixed(2)} L` : `₹${inr.format(v)}`; };
  const url = (p) => (window.SW_STORES ? SW_STORES.url(p) : p);
  const storeKey = () => `${window.SW_STORES && SW_STORES.current ? SW_STORES.current() : ''}`;
  const LIGHT = { green: 'On track', amber: 'Within 10%', red: 'Behind' };

  const cache = new Map();   // store|lens → { at, data }
  let loading = null, ctx = { canEdit: false, rerender: () => {}, lens: '' }, editing = null;

  function load(lens, force) {
    const k = `${storeKey()}|${lens}`, c = cache.get(k);
    if (!force && (loading === k || (c && Date.now() - c.at < 5 * 60e3))) return;
    loading = k;
    fetch(url(`/api/targets?lens=${encodeURIComponent(lens)}`)).then((r) => r.json()).then((j) => {
      if (j && j.ok) { cache.set(k, { at: Date.now(), data: j }); ctx.rerender(); }
    }).catch(() => { /* the column shows "–" and tries again next time */ }).finally(() => { if (loading === k) loading = null; });
  }
  const data = () => { const c = cache.get(`${storeKey()}|${ctx.lens}`); return c ? c.data : null; };
  const rowOf = (key) => { const d = data(); return d && Object.hasOwn(d.rows, key) ? d.rows[key] : null; };

  function tip(t, d) {
    const parts = [`${LIGHT[t.light]}. Target ${money(t.target)} a month; sold ${money(t.sold)} so far (${d ? `day ${Math.floor(d.daysGone) + 1} of ${d.daysInMonth}` : 'this month'}).`,
      `At this pace: ${money(t.forecast)} by month end. With nothing out of stock: ${money(t.forecastFull)}.`];
    if (t.gap) parts.push(`Short by ${money(t.gap)}${t.gapStockouts ? `, of which ${money(t.gapStockouts)} is sales lost to stock-outs` : ''}.`);
    parts.push('Green = on track, amber = within 10%, red = behind.');
    return parts.join(' ');
  }
  function editor(key, t) {
    return `<span class="tg-ed" data-tg-key="${esc(key)}"><input class="tg-in" type="number" inputmode="numeric" min="0" step="1000" placeholder="₹ a month" aria-label="Monthly sales target in ₹" value="${t ? t.target : ''}"><button class="btn xs" data-tg-save="1">Save</button>${t ? '<button class="btn ghost xs" data-tg-del="1" title="Remove the target">Remove</button>' : ''}</span>`;
  }
  function cell(g) {
    const t = rowOf(g.key), d = data();
    if (editing === g.key && ctx.canEdit) return editor(g.key, t);
    if (!t) return ctx.canEdit ? `<button class="linkbtn tg-set" data-tg-edit="${esc(g.key)}" title="Set a monthly sales target for this group">Set target</button>` : '<span class="muted">–</span>';
    const gap = t.gapStockouts ? ` · <span class="lostv">${money(t.gapStockouts)}</span> is stock-outs` : '';
    return `<span class="tg" title="${esc(tip(t, d))}"><span class="tg-l"><i class="tg-dot ${t.light}" aria-label="${LIGHT[t.light]}"></i><b>${money(t.sold)}</b> <span class="muted">of ${money(t.target)}</span>${ctx.canEdit ? `<button class="linkbtn tg-e" data-tg-edit="${esc(g.key)}" aria-label="Change target">Edit</button>` : ''}</span><small class="tg-f">→ ${money(t.forecast)}${gap}</small></span>`;
  }

  /** The column for app.js GROUP_COLS. */
  function col(lens, opts = {}) {
    ctx = { canEdit: !!opts.canEdit, rerender: opts.rerender || (() => {}), lens };
    load(lens);
    return { k: 'target', label: 'Target this month', tip: 'Sales so far this month against the monthly target, and where the month ends at this pace (→). Green = on track, amber = within 10%, red = behind. "is stock-outs" = how much of the shortfall is sales lost to stock-outs', f: cell, val: (g) => { const t = rowOf(g.key); return t ? t.sold / t.target : -1; } };
  }
  /** One line on a phone card. */
  function card(g) {
    return rowOf(g.key) || ctx.canEdit ? `<div class="mfacts tg-m">${cell(g)}</div>` : '';
  }

  async function save(key, amount) {
    const r = await fetch(url('/api/targets'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lens: ctx.lens, key, amount }) });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    editing = null; load(ctx.lens, true);
  }
  function fail(e) { const t = document.getElementById('toast'); if (t) { t.textContent = e.message; t.hidden = false; setTimeout(() => { t.hidden = true; }, 2600); } }

  /* before app.js's listener (this file loads first): clicks inside the target cell never open the group */
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('.tg-ed, [data-tg-edit], .tg');
    if (!el) return;
    e.stopImmediatePropagation();
    const ed = e.target.closest('[data-tg-edit]');
    if (ed) { editing = ed.dataset.tgEdit; ctx.rerender(); setTimeout(() => { const i = document.querySelector('.tg-ed .tg-in'); if (i) i.focus(); }, 0); return; }
    const box = e.target.closest('.tg-ed'); if (!box) return;
    if (e.target.closest('[data-tg-save]')) save(box.dataset.tgKey, box.querySelector('.tg-in').value).catch(fail);
    else if (e.target.closest('[data-tg-del]')) save(box.dataset.tgKey, 0).catch(fail);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (!e.target.matches || !e.target.matches('.tg-in')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(e.target.closest('.tg-ed').dataset.tgKey, e.target.value).catch(fail); }
    if (e.key === 'Escape') { e.stopPropagation(); editing = null; ctx.rerender(); }
  }, true);

  window.SW_TARGETS = { col, card };
})();
