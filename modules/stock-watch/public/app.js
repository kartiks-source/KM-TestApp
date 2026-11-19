/* Stock-out Watch — browser app. No framework: state → HTML strings → #view. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    days: 30, view: 'overview', report: null, settings: null, source: null,
    filter: { reorder: 'all', stockouts: 'all', products: 'all', type: '' }, q: { reorder: '', stockouts: '', products: '' },
    sort: { reorder: null, stockouts: null, products: null },
    what: {},                                   // trial values for the planning assumptions (not saved)
    colW: (() => { try { return JSON.parse(localStorage.getItem('sw-colw') || '{}'); } catch { return {}; } })(),
  };
  const ASSUME = [
    ['leadDays', 'Lead time (d)', '', 1, 'Supplier order → stock sellable'],
    ['coverDays', 'Cover (d)', '', 5, 'How long a reorder should last after it lands'],
    ['safetyDays', 'Safety (d)', '', 1, 'Buffer for busy days or a late supplier'],
    ['demandWindowDays', 'History (d)', '', 7, 'Days of sales used for each product’s daily rate'],
    ['minPerDay', 'Slow below (/d)', '', 0.1, 'Products selling less than this stay off the reorder list'],
    ['smallTopUpDays', 'Small top-up (d)', '', 1, 'Refills smaller than this many days of sales are flagged'],
  ];
  const whatQs = () => Object.entries(state.what).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');

  /* ---------- formatting ---------- */
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const money = (x) => {
    const v = Math.round(+x || 0), a = Math.abs(v);
    if (a >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
    if (a >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
    return `₹${inr.format(v)}`;
  };
  const moneyFull = (x) => `₹${inr.format(Math.round(+x || 0))}`;
  const n1 = (x) => (x == null ? '–' : (Math.round(x * 10) / 10).toLocaleString('en-IN'));
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const off = () => (state.settings?.tzOffsetMin ?? 330) * 60e3;
  const local = (t) => new Date(t + off());
  const dt = (t) => { if (!t) return '–'; const d = local(t); return `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
  const dayLabel = (k) => { const [, m, d] = k.split('-'); return `${+d} ${MON[+m - 1]}`; };
  const dur = (h) => (h >= 48 ? `${n1(h / 24)} days` : `${n1(h)} h`);

  const STATUS_CLS = { 'Out now': 'out', Critical: 'crit', 'Order now': 'now', 'Order this week': 'week', OK: 'ok', 'Slow seller': 'idle', 'No stock data': 'idle' };
  const narrow = () => window.innerWidth < 760;
  const SHORT = { 'Order this week': 'This week', 'No stock data': 'No stock' };
  const pill = (s) => `<span class="st ${STATUS_CLS[s] || 'ok'}" title="${esc(s)}">${esc(SHORT[s] || s)}</span>`;

  /* ---------- server ---------- */
  async function api(path, opt = {}) {
    const r = await fetch(path, { ...opt, headers: { ...(opt.body && typeof opt.body === 'string' && opt.json !== false ? { 'content-type': 'application/json' } : {}), ...(opt.headers || {}) } });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }

  async function reloadReport() {
    state.report = await api(`/api/report?days=${state.days}${whatQs()}`);
    header(); render();
  }
  async function load() {
    const [rep, set] = await Promise.all([api(`/api/report?days=${state.days}${whatQs()}`), api('/api/settings')]);
    state.report = rep; state.settings = set.settings; state.source = { kind: rep.source, lastSync: rep.lastSync, err: rep.lastSyncError }; state.shopify = set.shopify || {};
    header();
    render();
  }

  function header() {
    const r = state.report, s = state.settings;
    $('#store-name').textContent = s.storeName || 'Store';
    $('#n-reorder').textContent = r.totals.outNow + r.totals.orderNow || '';
    $('#n-stockouts').textContent = r.totals.stockouts || '';
    const src = state.source, d = r.data, sh = state.shopify || {};
    const err = sh.lastError || src.err;
    const pill = $('#sync-pill');
    pill.className = 'sync-pill ' + (err ? 'err' : src.kind === 'demo' ? 'demo' : src.kind === 'live' ? 'ok' : '');
    pill.querySelector('span').textContent = err ? 'Sync issue' : src.kind === 'demo' ? 'Demo data' : sh.running ? 'Syncing…' : 'Data Sync';
    pill.title = err || (src.kind === 'demo' ? 'Showing demo data' : 'Data is syncing');
    const badge = src.kind === 'demo' ? '<span class="badge demo">Demo data</span>' : src.kind === 'live' ? '<span class="badge live">Live data</span>' : '<span class="badge empty">No data yet</span>';
    $('#source').innerHTML = `${badge}<span>${inr.format(d.stockRows)} stock changes · ${inr.format(d.orderRows)} order lines</span>`
      + (d.lastStock ? `<span>Last stock change: ${dt(d.lastStock)}</span>` : '')
      + (src.err ? `<span class="badge err">Sheet sync: ${esc(src.err)}</span>` : src.lastSync ? `<span>Sheet synced: ${dt(src.lastSync)}</span>` : '')
      + shopifyBadge();
    $$('.range button').forEach((b) => b.classList.toggle('on', +b.dataset.days === state.days));
  }

  function shopifyBadge() {
    const sh = state.shopify || {};
    if (!sh.source) return '';
    if (sh.running) return '<span>Shopify: pulling now…</span>';
    if (sh.lastError) return `<span class="badge err">Shopify: ${esc(sh.lastError)}</span>`;
    return sh.lastSync ? `<span>Shopify synced: ${dt(sh.lastSync)}</span>` : '<span>Shopify: first pull pending</span>';
  }
  function shopifyPanel() {
    const sh = state.shopify || {};
    const scopes = (sh.scopes || []).map((x) => `<span class="mono">${esc(x)}</span>`).join(', ');
    if (!sh.source) {
      return `<div class="panel" style="grid-column:1/-1"><h2>Shopify (read-only) · not connected</h2>
        <p class="muted">Connect a store and the app reads stock every 15 minutes and new orders since the last read, straight from Shopify. It only ever reads: every call is checked, and anything that could change the store is refused. Read permissions needed: ${scopes}.</p>
        <p class="muted">Set these as Railway variables (the key is never typed into this page):</p>
        <dl class="kv"><dt>What Shopify gives</dt><dd>The app’s <b>client ID + client secret</b> (Shopify Dev Dashboard). We swap them for a 24-hour token and renew it automatically. The app must be in the <b>same Shopify organisation</b> as the store, so the brand creates and installs it and shares the ID + secret.</dd>
          <dt>Azure Key Vault (preferred)</dt><dd><span class="mono">AZURE_KEY_VAULT_URL, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, SHOPIFY_STORE</span>. Reads secrets <span class="mono">shopify-&lt;store&gt;-client-id</span> and <span class="mono">shopify-&lt;store&gt;-client-secret</span>.</dd>
          <dt>Stop-gap</dt><dd><span class="mono">SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET</span></dd></dl></div>`;
    }
    const where = sh.source === 'vault' ? `Azure Key Vault, <span class="mono">${esc(sh.secretName)}</span>` : `Railway variables (stop-gap) · ${esc(sh.kind || '')}`;
    return `<div class="panel" style="grid-column:1/-1"><h2>Shopify (read-only) · ${esc(sh.store || '')}</h2>
      <dl class="kv"><dt>Key from</dt><dd>${where}</dd>
        <dt>Status</dt><dd>${!sh.ready ? `<span style="color:#E0506E">Missing: ${esc(sh.missing.join(', '))}</span>` : sh.running ? 'Pulling now…' : sh.lastError ? `<span style="color:#E0506E">${esc(sh.lastError)}</span>${sh.lastTry ? ` · tried ${dt(sh.lastTry)}` : ''}` : sh.lastSync ? `OK · last read ${dt(sh.lastSync)}` : 'First pull pending'}</dd>
        <dt>Order history</dt><dd>${sh.backfilled ? 'Last 60 days loaded, new orders added every 15 minutes' : 'Loads the last 60 days on the first pull'}</dd>
        <dt>Reads only</dt><dd>${scopes} · API ${esc(sh.apiVersion || '')}</dd></dl>
      <div class="toolbar"><button class="btn" id="shopify-sync">Pull from Shopify now</button></div></div>`;
  }

  /* ---------- planning assumptions: change a number, every figure updates; save when happy ---------- */
  function planBar() {
    const S = state.settings, R = state.report.settings, t = state.report.totals;
    const trial = Object.keys(state.what).length > 0;
    const fields = ASSUME.map(([k, label, unit, step, tip]) => `<div class="pf" title="${esc(tip)}"><label for="w-${k}">${label}</label>
        <span class="pin"><button class="pm" data-step="${k}|-${step}" aria-label="Less ${label}">−</button><input id="w-${k}" data-what="${k}" type="number" inputmode="decimal" min="0" step="${step}" value="${esc(R[k])}" class="${state.what[k] != null && +state.what[k] !== +S[k] ? 'changed' : ''}"><button class="pm" data-step="${k}|${step}" aria-label="More ${label}">+</button></span></div>`).join('');
    const impact = `<div class="pimpact"><span title="Cash to commit (at unit cost) for everything Out now, Critical or Order now">Order now <b>${money(t.orderValueNow)}</b></span><span title="Order value of the whole reorder list">Full list <b>${money(t.orderValueAll)}</b></span><span title="Overstocked products (stock over twice what lead + cover + safety days need): the cash in stock beyond that need">Overstock <b>${money(t.excessValue)}</b></span></div>`;
    return `<details class="plan" ${(state.planOpen ?? !narrow()) ? 'open' : ''}><summary>Assumptions${trial ? ' <span class="badge demo">trying new values</span>' : ''}${impact}</summary>
      <div class="pbody">${fields}
        ${trial ? '<span class="pact"><button class="btn" id="what-save">Save as default</button><button class="btn ghost" id="what-reset">Reset</button></span>' : ''}</div></details>`;
  }
  let whatTimer = null;
  function setWhat(k, v) {
    if (v === '' || !Number.isFinite(+v)) return;
    if (+v === +state.settings[k]) delete state.what[k]; else state.what[k] = +v;
    clearTimeout(whatTimer); whatTimer = setTimeout(() => reloadReport().catch((e) => toast(e.message)), 220);
  }

  /* ---------- trend: 8 weekly bars (units), rose base where the product was out of stock that week ---------- */
  const WEEK_LABEL = (i) => (i === 7 ? 'last 7 days' : `${7 - i} week${7 - i > 1 ? 's' : ''} before`);
  function spark(p, w = 64, h = 20) {
    const wk = p.weeks || []; if (!wk.length) return '';
    const max = Math.max(1, ...wk.map((x) => x.units || 0)), bw = w / wk.length;
    const bars = wk.map((x, i) => {
      if (x.units == null) return `<g><title>${WEEK_LABEL(i)}: no data yet</title><rect class="nd" x="${i * bw + 1}" y="${h - 3}" width="${bw - 2}" height="1"/></g>`;
      const bh = x.units ? Math.max(2, (x.units / max) * (h - 4)) : 0;
      const out = x.outDays > 0 ? `<rect class="so" x="${i * bw + 1}" y="${h - 2}" width="${bw - 2}" height="2"/>` : '';
      return `<g><title>${WEEK_LABEL(i)}: ${inr.format(x.units)} sold${x.outDays ? `, out of stock ${n1(x.outDays)} d` : ''}</title>`
        + `<rect class="sb${i === wk.length - 1 ? ' last' : ''}" style="animation-delay:${i * 35}ms" x="${i * bw + 1}" y="${h - 3 - bh}" width="${bw - 2}" height="${bh}" rx="1"/>${out}</g>`;
    }).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Weekly units, last 8 weeks">${bars}</svg>`;
  }
  function trendChip(p) {
    if (p.trendPct == null) return p.trendNew ? '<span class="tr new" title="In stock but no sales in the 14 days before; 3 or more sold since">New</span>' : '<span class="tr low" title="Too few sales or too little history to call a trend">·</span>';
    const v = p.trendPct, cls = v >= 10 ? 'up' : v <= -10 ? 'down' : 'flat';
    const base = state.report.totals.storeTrendPct;
    return `<span class="tr ${cls}" title="Sales per in-stock day, last 14 days vs the 14 before. Out-of-stock days are left out, so a stock-out doesn't look like falling demand.${base != null ? ` Typical product over the same days: ${base > 0 ? '+' : ''}${n1(base)}%.` : ''}">${cls === 'up' ? '▲' : cls === 'down' ? '▼' : '▬'} ${v > 0 ? '+' : ''}${n1(v)}%</span>`;
  }
  const trendCell = (p) => `<span class="trc">${spark(p)}${trendChip(p)}</span>`;
  const trendCol = { k: 'trendPct', label: 'Trend', tip: '8 weekly bars of units sold (rose base = out of stock that week) and the change in sales per in-stock day: last 14 days vs the 14 before', f: trendCell, val: (p) => (p.trendPct ?? (p.trendNew ? 999 : -999)), csv: (p) => p.trendPct ?? '' };

  /* which priority columns the CSS shows at this width (mirrors the @media rules in styles.css) */
  const colVisible = (c) => !(c.pr === 4 && innerWidth <= 1700) && !(c.pr === 3 && innerWidth <= 1400) && !(c.pr === 2 && innerWidth <= 1180);
  const tier = () => (innerWidth > 1700 ? 'xl' : innerWidth > 1400 ? 'l' : innerWidth > 1180 ? 'm' : 's');
  const colKey = (id) => `${id}@${tier()}`;                 // widths are remembered per screen size
  const tableRoom = () => (document.querySelector('.wrap')?.clientWidth || innerWidth) - 46;
  /* ---------- generic sortable table ---------- */
  /* A sortable table on wide screens; on phones the same rows as cards (card(r) → html) with a sort picker. */
  function table(id, cols, rows, empty, card) {
    const s = state.sort[id];
    if (s) {
      const col = cols.find((c) => c.k === s.k);
      const v = col?.val || ((r) => r[s.k]);
      rows = rows.slice().sort((a, b) => { const x = v(a), y = v(b); return (x > y ? 1 : x < y ? -1 : 0) * s.dir; });
    }
    if (!rows.length) return `<div class="tbl"><div class="empty">${esc(empty)}</div></div>`;
    cols = cols.filter(colVisible);
    const W = state.colW[colKey(id)], fixed = W && cols.every((c) => W[c.k]);
    if (fixed) { const sum = cols.reduce((a, c) => a + W[c.k], 0), room = tableRoom(); if (sum > room) cols.forEach((c) => { W[c.k] = Math.max(40, Math.floor((W[c.k] * room) / sum)); }); }
    const desk = `<div class="tbl desk"><table data-table="${id}" class="${fixed ? 'fixed' : ''}" ${fixed ? `style="width:${cols.reduce((a, c) => a + W[c.k], 0)}px"` : ''}><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}${c.pr ? ' p' + c.pr : ''}" data-k="${c.k}"${c.tip ? ` title="${esc(c.tip)}"` : ''}${fixed ? ` style="width:${W[c.k]}px"` : ''}>${esc(c.label)}${s && s.k === c.k ? (s.dir > 0 ? ' ↑' : ' ↓') : ''}<span class="rz" title="Drag to resize · double-click to reset all columns"></span></th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-id="${esc(r.id)}">${cols.map((c) => `<td class="${c.r ? 'r' : ''}${c.nw ? ' nw' : ''}${c.pr ? ' p' + c.pr : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    if (!card) return desk;
    const cur = s ? `${s.k}|${s.dir}` : '';
    const opts = cols.filter((c) => c.sortable !== false).flatMap((c) => [[`${c.k}|-1`, `${c.label}: high → low`], [`${c.k}|1`, `${c.label}: low → high`]]);
    const phone = `<div class="phone">
        <label class="msort"><span>Sort by</span><select data-msort="${id}"><option value="">${({ reorder: 'Most urgent first', stockouts: 'Biggest loss first', products: 'Biggest loss first' })[id] || 'Default'}</option>${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div class="mcards">${rows.map((r) => `<article class="mcard" data-id="${esc(r.id)}" tabindex="0">${card(r)}</article>`).join('')}</div>
      </div>`;
    return desk + phone;
  }
  const kv = (label, value, cls = '') => `<div class="${cls}"><span>${label}</span><b>${value}</b></div>`;

  /* ---------- charts (SVG, to scale) ---------- */
  function dailyChart(daily) {
    const W = narrow() ? 360 : 1000, H = narrow() ? 230 : 365, L = narrow() ? 50 : 64, R = 10, T = 12, B = 34;
    const max = Math.max(1, ...daily.map((d) => d.sold + d.lost));
    const step = niceStep(max / 4); const top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const bw = (W - L - R) / daily.length;
    const every = Math.ceil(daily.length / (narrow() ? 4 : 10));
    let g = '';
    for (let v = 0; v <= top + 1; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E7EBF2" stroke-width="1"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(money(v))}</text>`;
    daily.forEach((d, i) => {
      const x = L + i * bw + bw * 0.14, w = bw * 0.72;
      const ys = y(d.sold), yl = y(d.sold + d.lost);
      g += `<g><title>${dayLabel(d.day)}: sold ${moneyFull(d.sold)}, lost ${moneyFull(d.lost)}${d.outSkus ? ` · ${d.outSkus} product(s) out` : ''}</title>`
        + `<rect x="${x}" y="${ys}" width="${w}" height="${Math.max(0, y(0) - ys)}" rx="2" fill="#0978BE"/>`
        + (d.lost > 0 ? `<rect x="${x}" y="${yl}" width="${w}" height="${Math.max(1, ys - yl)}" rx="2" fill="#E0506E"/>` : '') + '</g>';
      if (i % every === 0 || i === daily.length - 1) g += `<text x="${x + w / 2}" y="${H - 12}" text-anchor="middle">${dayLabel(d.day)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily sales and sales lost to stock-outs">${g}</svg>`;
  }
  function niceStep(x) { const p = 10 ** Math.floor(Math.log10(Math.max(1, x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  function stockChart(tl, from, to) {
    if (tl.length < 2) return '<p class="muted">No stock changes recorded in this period.</p>';
    const W = narrow() ? 340 : 680, H = narrow() ? 200 : 220, L = 40, R = narrow() ? 16 : 26, T = 10, B = 28;
    const max = Math.max(1, ...tl.map((p) => p.stock));
    const top = Math.ceil(max / niceStep(max / 4)) * niceStep(max / 4);
    const x = (t) => L + (W - L - R) * ((t - from) / (to - from));
    const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
    let path = `M${x(tl[0].t)},${y(tl[0].stock)}`, bands = '';
    for (let i = 1; i < tl.length; i++) {
      path += ` H${x(tl[i].t)} V${y(tl[i].stock)}`;
      if (tl[i - 1].stock <= 0) bands += `<rect x="${x(tl[i - 1].t)}" y="${T}" width="${Math.max(1, x(tl[i].t) - x(tl[i - 1].t))}" height="${H - T - B}" fill="#FCE9ED"/>`;
    }
    let ticks = '';
    for (let v = 0; v <= top; v += niceStep(max / 4)) ticks += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E7EBF2"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    const days = Math.round((to - from) / 864e5); let xl = '';
    for (let i = 0; i <= days; i += Math.max(1, Math.ceil(days / (narrow() ? 3 : 6)))) { const t = from + i * 864e5; const d = local(t); xl += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${d.getUTCDate()} ${MON[d.getUTCMonth()]}</text>`; }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stock over time; shaded = out of stock">${bands}${ticks}<path d="${path}" fill="none" stroke="#0978BE" stroke-width="2"/>${xl}</svg>`;
  }
  function unitsChart(rows) {
    const W = narrow() ? 340 : 680, H = narrow() ? 120 : 140, L = 32, R = 8, T = 8, B = 10;
    const max = Math.max(1, ...rows.map((r) => r.units));
    const bw = (W - L - R) / rows.length;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Units sold per day">${rows.map((r, i) => `<rect x="${L + i * bw + bw * 0.15}" y="${y(r.units)}" width="${bw * 0.7}" height="${Math.max(0, y(0) - y(r.units))}" rx="2" fill="#0978BE"><title>${dayLabel(r.day)}: ${r.units} sold</title></rect>`).join('')}
      <text x="${L - 6}" y="${y(max) + 4}" text-anchor="end">${max}</text><text x="${L - 6}" y="${y(0)}" text-anchor="end">0</text></svg>`;
  }

  /* ---------- views ---------- */
  function overview() {
    const r = state.report, t = r.totals, top = r.products.filter((p) => p.lost > 0).slice(0, 10);
    const maxLost = Math.max(1, ...top.map((p) => p.lost));
    const hours = r.stockouts.reduce((s, e) => s + e.hours, 0);
    const openNow = r.stockouts.filter((e) => e.open).sort((a, b) => b.lost - a.lost);
    const outProducts = new Set(r.stockouts.map((s) => s.id)).size;
    const note = t.stockouts
      ? `In the last ${r.days} days, ${outProducts} selling products ran out of stock ${t.stockouts} times, adding up to ${hours >= 48 ? `about ${inr.format(Math.round(hours / 24))} product-days` : `about ${Math.round(hours)} product-hours`} with an empty shelf. That cost an estimated ${moneyFull(t.lost)} in sales (${t.lostPct}% of demand), demand the ads had already brought in. ${t.smallTopUps} times the shelf was refilled with less than ${state.settings.smallTopUpDays} days of stock, and ${t.repeats} times a product sold out again within a week.`
      : `No selling product ran out of stock in the last ${r.days} days.`;
    return `
      <section class="headline">
        <h1>${t.lost ? `Stock-outs cost <span class="lost">${money(t.lost)}</span> in the last ${r.days} days` : `No sales lost to stock-outs in the last ${r.days} days`}</h1>
        <p>${t.lost ? `That’s ${t.lostPct}% of demand: shoppers came, the product wasn’t there. ` : ''}Sold ${money(t.sold)} in the same period.</p>
      </section>
      ${planBar()}
      <section class="tiles">
        <div class="tile sold" title="Sales in the period"><b>${money(t.sold)}</b><span>sold</span></div>
        <button class="tile lost" data-go="stockouts" data-filter="all" title="Sales lost while products were out of stock"><b>${money(t.lost)}</b><span>sales lost · ${n1(t.lostPct)}% of demand</span></button>
        ${t.hasCost ? `<div class="tile lost" title="Units lost × (price paid − unit cost), for products with a unit cost${t.costed < t.active ? `. Only ${t.costed} of ${t.active} products have a cost, so this is a minimum` : ''}"><b>${money(t.lostProfit)}</b><span>profit lost${t.costed < t.active ? ` · ${t.costed}/${t.active} costed` : ''}</span></div>` : ''}
        <button class="tile ${t.bestAtRisk ? 'lost' : 'sold'}" data-go="products" data-filter="bestrisk" title="Best sellers (top 80% of sales) that are out, critical or due to order now"><b>${t.bestAtRisk}<small> / ${t.bestsellers}</small></b><span>best sellers at risk</span></button>
        <button class="tile amber" data-go="reorder" data-filter="now" title="Cash to commit (at unit cost) for everything Out now, Critical or Order now"><b>${money(t.orderValueNow)}</b><span>to order now · ${t.orderNow + t.outNow} items</span></button>
        <button class="tile plum" data-go="products" data-filter="over" title="Overstocked products (stock over twice what lead + cover + safety days need): the cash in stock beyond that need. Discount it, bundle it, or stop reordering"><b>${money(t.excessValue)}</b><span>cash in overstock · ${t.overstocked} items</span></button>
      </section>
      <section class="ov">
      <div class="panel chart ov-chart">
        <div class="panel-head"><h2>Sold vs lost to stock-outs, per day</h2><div class="legend"><span><i style="background:#0978BE"></i>Sold</span><span><i style="background:#E0506E"></i>Lost to stock-outs</span></div></div>
        ${dailyChart(r.daily)}
      </div>
        <div class="panel ov-order"><div class="panel-head"><h2>Order today</h2><a href="#reorder">All ${r.reorder.length}</a></div>
          ${r.reorder.length ? `<div class="bars">${r.reorder.slice(0, 10).map((p) => `<div class="bar-row" data-product="${esc(p.id)}" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="name">${abcMark(p)}${esc(p.name)}</span>${pill(p.status)}<span class="num" style="font-weight:700">${inr.format(p.orderQty)} pcs</span></div>`).join('')}</div>` : '<p class="muted">Nothing needs ordering right now.</p>'}
        </div>
        <div class="panel ov-loss"><div class="panel-head"><h2>Biggest losses</h2><a href="#products">All products</a></div>
          ${top.length ? `<div class="bars">${top.map((p) => `<div class="bar-row" data-product="${esc(p.id)}"><span class="name">${esc(p.name)}</span><span class="val">${money(p.lost)}</span><span class="track"><i style="width:${(p.lost / maxLost) * 100}%"></i></span></div>`).join('')}</div>` : '<p class="muted">Nothing lost in this period.</p>'}
        </div>
      <div class="ov-side">
        <div class="panel"><div class="panel-head"><h2>Out of stock right now</h2><a href="#stockouts" data-go="stockouts" data-filter="open">All ${openNow.length}, incl. slow sellers</a></div>
          ${openNow.length ? `<div class="bars">${openNow.slice(0, 5).map((e) => `<div class="bar-row" data-product="${esc(e.id)}" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="name">${esc(e.name)}</span><span class="muted num">${dur(e.hours)}</span><span class="val">${money(e.lost)}</span></div>`).join('')}</div>` : '<p class="muted">Every selling product is in stock.</p>'}
        </div>
        <div class="note">
          <div class="panel-head"><h2>For the client</h2><button class="btn light" id="copy-note">Copy</button></div>
          <p>${esc(note)}</p>
        </div>
      </div>
      </section>`;
  }

  function daysCell(p) {
    if (p.daysLeft == null) return p.stock <= 0 ? '<span class="st out">0</span>' : '–';
    const S = state.report.settings, warn = S.leadDays + S.safetyDays;
    const color = p.daysLeft <= 3 ? '#E0506E' : p.daysLeft <= warn ? '#E8902A' : '#0978BE';
    return `<span class="days"><span class="num">${n1(p.daysLeft)}</span><span class="meter"><i style="width:${Math.min(100, (p.daysLeft / (warn + 7)) * 100)}%;background:${color}"></i></span></span>`;
  }

  function reorder() {
    const r = state.report, f = state.filter.reorder, q = state.q.reorder.toLowerCase();
    const groups = [['all', 'All', r.reorder.length], ['Out now', 'Out now', r.totals.outNow], ['now', 'Critical + order now', r.totals.orderNow], ['Order this week', 'This week', r.totals.orderWeek]];
    const rows = r.reorder.filter((p) => (f === 'all' || (f === 'now' ? ['Critical', 'Order now'].includes(p.status) : p.status === f)) && (!q || `${p.name} ${p.sku}`.toLowerCase().includes(q)));
    const S = state.report.settings;   // the values being tried, not only the saved ones
    return `
      <section class="headline ex"><h1>Reorder before they run out</h1>
        <p>Order quantity covers ${S.leadDays} days of lead time + ${S.coverDays} days after it lands + ${S.safetyDays} safety days, at each product’s in-stock sales rate. Try other values in Assumptions below.</p></section>
      ${planBar()}
      <div class="toolbar"><div class="chips">${groups.map(([k, l, c]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-reorder="${esc(k)}">${l}<span class="c">${c}</span></button>`).join('')}<a class="btn ghost" href="/api/export/reorder.csv?days=${state.days}${whatQs()}" title="Download the reorder list as CSV">CSV</a></div>
        <input class="search" id="q-reorder" placeholder="Search product or SKU" value="${esc(state.q.reorder)}"></div>
      ${table('reorder', [
        { k: 'name', label: 'Product', f: (p) => `${abcMark(p)}<span class="pname" title="${esc(p.name)}">${esc(p.name)}</span><span class="sku">${esc(p.sku)}</span>` },
        { k: 'status', label: 'Status', f: (p) => pill(p.status), val: (p) => -['Out now', 'Critical', 'Order now', 'Order this week'].indexOf(p.status) },
        { k: 'orderQty', label: 'Order', r: 1, tip: 'Units to order now', f: (p) => `<b>${inr.format(p.orderQty)}</b>` },
        { k: 'daysLeft', label: 'Days left', f: daysCell, val: (p) => p.daysLeft ?? -1 },
        { k: 'stock', label: 'Stock', r: 1, f: (p) => inr.format(p.stock) },
        { k: 'perDay', label: 'Per day', r: 1, tip: 'Units sold per in-stock day', f: (p) => n1(p.perDay) },
        trendCol,
        { k: 'orderValue', label: 'Value', r: 1, tip: 'Cash to commit: order quantity × unit cost (× average price paid if cost is unknown)', f: (p) => money(p.orderValue) },
        { k: 'lost', label: 'Lost', r: 1, tip: `₹ lost to stock-outs in the last ${state.days} days`, f: (p) => (p.lost ? `<span class="lostv">${money(p.lost)}</span>` : '–') },
        { k: 'outs', label: 'Outs', r: 1, pr: 3, tip: 'Stock-outs in the period' },
      ], rows, 'Nothing to order in this view.', (p) => `
        <header><h3>${abcMark(p)}${esc(p.name)}</h3><div class="mq"><b>${inr.format(p.orderQty)} pcs</b><small>${money(p.orderValue)}</small></div></header>
        <div class="mfacts">${pill(p.status)}${trendCell(p)}<span class="${p.daysLeft != null && p.daysLeft <= 3 ? 'bad' : ''}"><b>${p.daysLeft == null ? '–' : n1(p.daysLeft)}</b> days left</span><span><b>${inr.format(p.stock)}</b> in stock</span><span><b>${n1(p.perDay)}</b>/day</span>${p.lost ? `<span class="lostv">${money(p.lost)} lost</span>` : ''}<span class="sku">${esc(p.sku)}</span></div>`)}`;
  }

  function stockouts() {
    const r = state.report, f = state.filter.stockouts, q = state.q.stockouts.toLowerCase();
    const groups = [['all', 'All', r.stockouts.length], ['open', 'Still out', r.stockouts.filter((s) => s.open).length], ['small', 'Small top-up', r.totals.smallTopUps], ['again', 'Out again within a week', r.totals.repeats]];
    const rows = r.stockouts.filter((s) => (f === 'all' || (f === 'open' ? s.open : f === 'small' ? s.small : s.repeat)) && (!q || `${s.name} ${s.sku}`.toLowerCase().includes(q)))
      .map((s, i) => ({ ...s, key: i }));
    return `
      <section class="headline ex"><h1>Every stock-out, and what it cost</h1>
        <p>₹ lost = selling hours out of stock × the product’s normal sales per hour × its average selling price. Hours are weighted by when this store actually sells, so a night-time stock-out counts for less.</p></section>
      <div class="toolbar"><div class="chips">${groups.map(([k, l, c]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-stockouts="${k}">${l}<span class="c">${c}</span></button>`).join('')}</div>
        <input class="search" id="q-stockouts" placeholder="Search product or SKU" value="${esc(state.q.stockouts)}"></div>
      ${table('stockouts', [
        { k: 'name', label: 'Product', f: (s) => `<span class="pname" title="${esc(s.name)}">${esc(s.name)}</span><span class="sku">${esc(s.sku)}</span>` },
        { k: 'lost', label: 'Lost', r: 1, f: (s) => `<b class="lostv">${money(s.lost)}</b>` },
        { k: 'hours', label: 'Out for', r: 1, nw: 1, f: (s) => dur(s.hours) },
        { k: 'start', label: 'Went out', nw: 1, f: (s) => dt(s.start) },
        { k: 'end', label: 'Back in', nw: 1, f: (s) => (s.open ? '<span class="st open">Still out</span>' : dt(s.end)), val: (s) => s.end || Infinity },
        { k: 'flags', label: 'Pattern', f: (s) => [s.small ? '<span class="st small" title="Refilled with less than a week of sales">Small top-up</span>' : '', s.repeat ? '<span class="st again" title="Out again within a week">Again &lt;7d</span>' : ''].join(' ') || '–', val: (s) => (s.small ? 2 : 0) + (s.repeat ? 1 : 0) },
        { k: 'topUp', label: 'Refill', r: 1, nw: 1, tip: 'Pieces added when it came back, and how many days of sales that covers', f: (s) => (s.topUp == null ? '–' : `${inr.format(s.topUp)} <span class="muted">· ${n1(s.topUpDays)} d</span>`), val: (s) => s.topUp ?? -1 },
        { k: 'unitsLost', label: 'Units lost', r: 1, pr: 3, f: (s) => n1(s.unitsLost) },
      ], rows.map((s) => ({ ...s, id: s.id })), 'No stock-outs in this view.', (s) => `
        <header><h3>${esc(s.name)}</h3><div class="mq"><b class="lostv">${money(s.lost)}</b><small>lost</small></div></header>
        <div class="mfacts"><span class="${s.open ? 'bad' : ''}">out <b>${dur(s.hours)}</b></span><span>${dt(s.start)} → ${s.open ? '<span class="st open">Still out</span>' : dt(s.end)}</span>${s.topUp == null ? '' : `<span>refilled <b>${inr.format(s.topUp)}</b> (${n1(s.topUpDays)} d)</span>`}${s.small ? '<span class="st small">Small top-up</span>' : ''}${s.repeat ? '<span class="st again">Out again</span>' : ''}</div>`)}`;
  }

  const PRODUCT_TABS = [['all', 'All'], ['best', 'Best sellers'], ['bestrisk', 'Best at risk'], ['Out now', 'Out now'], ['Critical', 'Critical'], ['Order now', 'Order now'], ['Order this week', 'This week'], ['rising', 'Rising'], ['falling', 'Falling'], ['over', 'Overstock'], ['Slow seller', 'Slow'], ['lost', 'Lost sales']];
  const productMatch = (p, f) => f === 'all' || (f === 'lost' ? p.lost > 0 : f === 'best' ? p.abc === 'A' : f === 'bestrisk' ? p.abc === 'A' && ['Out now', 'Critical', 'Order now'].includes(p.status) : f === 'over' ? p.overstock : f === 'rising' ? p.trendPct >= 10 || p.trendNew : f === 'falling' ? p.trendPct <= -10 : p.status === f);
  const abcMark = (p) => (p.abc === 'A' ? '<span class="abc" title="Best seller: in the products making the top 80% of sales">A</span>' : '');
  function productRows() {
    const r = state.report, q = state.q.products.toLowerCase(), f = state.filter.products, ty = state.filter.type;
    return r.products.filter((p) => productMatch(p, f) && (!ty || p.type === ty) && (!q || `${p.name} ${p.sku} ${p.type}`.toLowerCase().includes(q)));
  }
  const PRODUCT_COLS = () => [
    { k: 'name', label: 'Product', f: (p) => `${abcMark(p)}<span class="pname" title="${esc(p.name)}">${esc(p.name)}</span><span class="sku">${esc(p.sku)}</span>`, csv: (p) => p.name },
    { k: 'abc', label: 'Rank', hide: 1 },
    { k: 'sku', label: 'SKU', hide: 1 },
    { k: 'type', label: 'Category', pr: 2, f: (p) => `<span class="muted cat" title="${esc(p.type)}">${esc(p.type || '–')}</span>` },
    { k: 'status', label: 'Status', f: (p) => pill(p.status), val: (p) => -['Out now', 'Critical', 'Order now', 'Order this week', 'OK', 'Slow seller', 'No stock data'].indexOf(p.status), csv: (p) => p.status },
    { k: 'stock', label: 'Stock', r: 1, f: (p) => (p.stock == null ? '–' : inr.format(p.stock)) },
    { k: 'daysLeft', label: 'Days left', f: daysCell, val: (p) => p.daysLeft ?? -1, csv: (p) => p.daysLeft ?? '' },
    { k: 'perDay', label: 'Per day', r: 1, tip: 'Units sold per in-stock day', f: (p) => n1(p.perDay) },
    trendCol,
    { k: 'unitsSold', label: 'Units', r: 1, pr: 3, tip: `Units sold in the last ${state.days} days`, f: (p) => inr.format(p.unitsSold || 0) },
    { k: 'price', label: 'Avg price', hide: 1 },
    { k: 'sold', label: 'Sold', r: 1, tip: `₹ sold in the last ${state.days} days`, f: (p) => money(p.sold) },
    { k: 'lost', label: 'Lost', r: 1, tip: `₹ lost to stock-outs in the last ${state.days} days`, f: (p) => (p.lost ? `<span class="lostv">${money(p.lost)}</span>` : '–') },
    { k: 'lostPct', label: '% lost', r: 1, pr: 3, tip: 'Lost ÷ (sold + lost)', f: (p) => (p.lostPct ? `<span class="${p.lostPct >= 10 ? 'lostv' : ''}">${n1(p.lostPct)}%</span>` : '–') },
    { k: 'outs', label: 'Outs', r: 1, pr: 3, tip: 'Stock-outs in the period' },
    { k: 'orderQty', label: 'Order', r: 1, tip: 'Units to order now', f: (p) => (p.orderQty ? `<b>${inr.format(p.orderQty)}</b>` : '–') },
    { k: 'excessValue', label: 'Excess', r: 1, pr: 2, tip: 'Cash in stock beyond what the next lead + cover + safety days need (at unit cost when known)', f: (p) => (p.excessValue ? `<span class="${p.overstock ? 'plumv' : 'muted'}">${money(p.excessValue)}</span>` : '–') },
    ...(state.report.totals.hasCost ? [
      { k: 'lostProfit', label: 'Profit lost', r: 1, tip: 'Units lost × (price paid − unit cost)', f: (p) => (p.lostProfit ? `<span class="lostv">${money(p.lostProfit)}</span>` : '–') },
      { k: 'margin', label: 'Margin', r: 1, pr: 4, tip: '(price paid − unit cost) ÷ price paid', f: (p) => (p.margin == null ? '–' : `${n1(p.margin)}%`) },
      { k: 'cost', label: 'Unit cost', hide: 1 },
    ] : []),
  ];
  function products() {
    const r = state.report, f = state.filter.products, ty = state.filter.type;
    const rows = productRows();
    const types = [...new Set(r.products.map((p) => p.type).filter(Boolean))].sort();
    const inType = r.products.filter((p) => !ty || p.type === ty);
    const tot = rows.reduce((a, p) => ({ sold: a.sold + p.sold, lost: a.lost + p.lost, stock: a.stock + (p.stock > 0 ? p.stock : 0) }), { sold: 0, lost: 0, stock: 0 });
    return `
      <section class="headline ex"><h1>Products</h1><p>${inr.format(rows.length)} shown · ${money(tot.sold)} sold · <span class="lostv">${money(tot.lost)} lost</span> · ${inr.format(tot.stock)} pcs in stock</p>
        <span class="hfind">${types.length ? `<select class="search sel" id="f-type" aria-label="Category"><option value="">All categories</option>${types.map((t) => `<option ${t === ty ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}<input class="search" id="q-products" placeholder="Search…" title="Search name, SKU or category" value="${esc(state.q.products)}"></span></section>
      ${planBar()}
      <div class="toolbar"><div class="chips">${r.totals.storeTrendPct != null ? `<span class="base" title="Typical product: the median trend across all products with enough sales, measured the same way (sales per in-stock day, last 14 days vs the 14 before). A product falling about as much is following the season, not losing ground.">Typical ${r.totals.storeTrendPct >= 0 ? '▲' : '▼'} ${r.totals.storeTrendPct > 0 ? '+' : ''}${n1(r.totals.storeTrendPct)}%</span>` : ''}${PRODUCT_TABS.map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-products="${esc(k)}">${l}<span class="c">${inShape(inType, k)}</span></button>`).join('')}<button class="btn ghost" id="csv-products" title="Download what's shown as CSV">CSV</button></div>
</div>
      ${table('products', PRODUCT_COLS().filter((c) => !c.hide), rows, 'No products match.', (p) => `
        <header><h3>${abcMark(p)}${esc(p.name)}</h3>${pill(p.status)}</header>
        <div class="mfacts">${trendCell(p)}<span class="${p.stock != null && p.stock <= 0 ? 'bad' : ''}"><b>${p.stock == null ? '–' : inr.format(p.stock)}</b> in stock</span><span><b>${p.daysLeft == null ? '–' : n1(p.daysLeft)}</b> days left</span>${p.overstock ? `<span class="plumv">${money(p.excessValue)} excess</span>` : ''}<span><b>${n1(p.perDay)}</b>/day</span><span><b>${money(p.sold)}</b> sold</span>${p.lost ? `<span class="lostv">${money(p.lost)} lost (${n1(p.lostPct)}%)</span>` : ''}${p.orderQty ? `<span>order <b>${inr.format(p.orderQty)}</b></span>` : ''}${p.type ? `<span class="sku">${esc(p.type)}</span>` : ''}</div>`)}`;
  }
  const inShape = (list, k) => inr.format(list.filter((p) => productMatch(p, k)).length);
  function downloadProductsCsv() {
    const cols = PRODUCT_COLS();
    const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map((c) => c.label), ...productRows().map((p) => cols.map((c) => (c.csv ? c.csv(p) : p[c.k])))].map((l) => l.map(q).join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
    a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }

  function dataView() {
    const s = state.settings, d = state.report.data, src = state.source;
    const base = location.origin;
    return `
      <section class="headline ex"><h1>Data &amp; settings</h1><p>Stock-out Watch needs two things from the store: every stock change and every order line. It reads them from Shopify (read-only), or from Shopify Flow, a Google Sheet or a CSV, with no Shopify key at all.</p></section>
      <section class="cards">
        ${shopifyPanel()}
        <div class="panel"><h2>Data now</h2>
          <dl class="kv"><dt>Source</dt><dd>${src.kind === 'demo' ? 'Demo data: Sammsara’s public product list, with invented stock and sales' : src.kind === 'live' ? 'Live store data' : 'Nothing yet'}</dd>
            <dt>Stock changes</dt><dd>${inr.format(d.stockRows)} ${d.firstStock ? `· ${dt(d.firstStock)} → ${dt(d.lastStock)}` : ''}</dd>
            <dt>Order lines</dt><dd>${inr.format(d.orderRows)} ${d.firstOrder ? `· ${dt(d.firstOrder)} → ${dt(d.lastOrder)}` : ''}</dd>
            <dt>Sheet sync</dt><dd>${src.err ? `<span style="color:#E0506E">${esc(src.err)}</span>` : src.lastSync ? dt(src.lastSync) : 'not set up'}</dd></dl>
          <div class="toolbar">${state.shopify?.source ? '' : '<button class="btn ghost" id="load-demo">Reload demo data</button>'}<button class="btn ghost" id="clear-all">Clear all data</button><a class="btn ghost" href="/logout">Sign out</a></div>
          <div id="clear-confirm"></div>
        </div>
        <div class="panel"><h2>Upload CSV</h2>
          <p class="muted">Columns, with a header row. Stock: <span class="mono">Time, Variant ID, SKU, Product, Variant, Stock before, Stock now, Price</span>. Orders: <span class="mono">Time, Order, Variant ID, SKU, Qty, Unit price</span>.</p>
          <div class="form"><div class="field"><label for="imp-kind">File holds</label><select id="imp-kind"><option value="stock">Stock changes</option><option value="order">Order lines</option></select></div>
            <div class="field"><label for="imp-file">CSV file</label><input type="file" id="imp-file" accept=".csv,text/csv"></div></div>
          <label class="muted"><input type="checkbox" id="imp-replace" ${src.kind === 'demo' ? 'checked' : ''}> Remove the demo data first</label>
          <div><button class="btn" id="imp-go">Upload</button></div>
        </div>
        <div class="panel"><h2>Google Sheet (Stock Watch sheet)</h2>
          <p class="muted">If the store’s Shopify Flow writes into a Google Sheet: in that sheet, File → Share → Publish to web → pick the tab → CSV, and paste the two links. Synced every 15 minutes.</p>
          <div class="field"><label for="sheet-stock">“Stock log” CSV link</label><input id="sheet-stock" value="${esc(s.sheetStockCsv)}" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&output=csv"></div>
          <div class="field"><label for="sheet-order">“Order log” CSV link</label><input id="sheet-order" value="${esc(s.sheetOrderCsv)}" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&output=csv"></div>
          <div class="toolbar"><button class="btn" id="sheet-save">Save and sync now</button></div>
        </div>
        <div class="panel"><h2>Shopify Flow, straight to this app</h2>
          <p class="muted">In Shopify Flow use the action <b>Send HTTP request</b> (POST), body = the same comma-separated line as the sheet, or JSON. One workflow per URL:</p>
          <div class="field"><label>Stock changes (trigger: Product variant inventory quantity changed)</label><div class="code" id="u-stock">${esc(base)}/ingest/stock?key=${esc(s.ingestKey)}</div></div>
          <div class="field"><label>Order lines (trigger: Order created → For each line item)</label><div class="code" id="u-order">${esc(base)}/ingest/order?key=${esc(s.ingestKey)}</div></div>
          <div class="toolbar"><button class="btn ghost" data-copy="u-stock">Copy stock URL</button><button class="btn ghost" data-copy="u-order">Copy order URL</button><button class="btn ghost" id="new-key">New key</button></div>
        </div>
        <div class="panel" style="grid-column:1/-1"><h2>Settings</h2>
          <div class="form">
            ${field('storeName', 'Store name', s.storeName, 'Shown at the top', 'text')}
            ${field('leadDays', 'Lead time (days)', s.leadDays, 'Supplier order → stock sellable')}
            ${field('coverDays', 'Cover after a reorder (days)', s.coverDays, 'How long a reorder should last')}
            ${field('safetyDays', 'Safety stock (days)', s.safetyDays, 'Buffer for busy days')}
            ${field('demandWindowDays', 'Sales history used (days)', s.demandWindowDays, 'For each product’s daily rate')}
            ${field('smallTopUpDays', 'Small top-up (days of sales)', s.smallTopUpDays, 'Refills smaller than this are flagged')}
            ${field('minPerDay', 'Ignore below (units / day)', s.minPerDay, 'Slow sellers stay out of alerts')}
            ${field('tzOffsetMin', 'Time zone offset (minutes)', s.tzOffsetMin, 'India = 330')}
          </div>
          <div><button class="btn" id="save-settings">Save settings</button></div>
        </div>
      </section>`;
  }
  const field = (k, label, v, hint, type = 'number') => `<div class="field"><label for="f-${k}">${esc(label)}</label><input id="f-${k}" data-setting="${k}" type="${type}" step="any" value="${esc(v)}"><small>${esc(hint)}</small></div>`;

  /* ---------- product drawer ---------- */
  async function openProduct(id) {
    const dr = $('#drawer'), body = $('#drawer-body');
    body.innerHTML = '<p class="muted">Loading…</p>'; dr.hidden = false;
    try {
      const d = await api(`/api/product/${encodeURIComponent(id)}?days=${state.days}${whatQs()}`);
      const p = d.product, now = state.report.generatedAt, from = now - state.days * 864e5;
      body.innerHTML = `
        <h2 id="drawer-title">${esc(p?.name || id)}</h2>
        <div class="toolbar">${p ? pill(p.status) : ''}<span class="mono muted">${esc(p?.sku || '')}</span></div>
        <section class="tiles" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="tile"><b>${p?.stock ?? '–'}</b><span>in stock now</span></div>
          <div class="tile"><b>${n1(p?.perDay)}</b><span>sells per day (in stock)</span></div>
          <div class="tile lost"><b>${money(p?.lost)}</b><span>lost in ${state.days} days</span></div>
        </section>
        <div class="panel chart"><h2>Stock level</h2>${stockChart(d.timeline, from, now)}<span class="muted" style="font-size:13px">Shaded = out of stock.</span></div>
        <div class="panel chart"><h2>Units sold per day</h2>${unitsChart(d.dailyUnits)}</div>
        <div class="panel"><h2>Stock-outs</h2>${d.stockouts.length ? `<div>${d.stockouts.map((s) => `<div class="ep"><span>${dt(s.start)} → ${s.open ? '<span class="st open">still out</span>' : dt(s.end)}</span><span class="muted">${dur(s.hours)}</span><b style="color:#E0506E">${money(s.lost)}</b>${s.topUp != null ? `<span>refilled ${s.topUp} pcs</span>` : ''}${s.small ? '<span class="st small">Small top-up</span>' : ''}${s.repeat ? '<span class="st again">Out again within a week</span>' : ''}</div>`).join('')}</div>` : '<p class="muted">None in this period.</p>'}</div>`;
    } catch (e) { body.innerHTML = `<p>Couldn’t load this product: ${esc(e.message)}</p>`; }
  }
  const closeDrawer = () => { $('#drawer').hidden = true; };

  /* ---------- render + events ---------- */
  const VIEWS = { overview, reorder, stockouts, products, data: dataView };
  function render() {
    if (!state.report) return;
    $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === state.view));
    $('#view').innerHTML = (VIEWS[state.view] || overview)();
    const focusId = render._focus; render._focus = null;
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* number inputs */ } } }
  }
  function route() { closeDrawer(); state.view = (location.hash || '#overview').slice(1) in VIEWS ? (location.hash || '#overview').slice(1) : 'overview'; render(); window.scrollTo(0, 0); }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('.rz')) return;
    const sum = e.target.closest('.plan > summary'); if (sum) { state.planOpen = !sum.parentElement.open; return; }
    const t = e.target.closest('button, [data-product], tr[data-id], .mcard[data-id], th[data-k], [data-go]');
    if (!t) return;
    if (t.matches('.range button')) { state.days = +t.dataset.days; await load(); return; }
    if (t.dataset.go) { const v = t.dataset.go; state.filter[v] = t.dataset.filter; location.hash = v; return; }
    if (t.dataset.filterReorder) { state.filter.reorder = t.dataset.filterReorder; render(); return; }
    if (t.dataset.filterStockouts) { state.filter.stockouts = t.dataset.filterStockouts; render(); return; }
    if (t.dataset.filterProducts) { state.filter.products = t.dataset.filterProducts; render(); return; }
    if (t.id === 'csv-products') { downloadProductsCsv(); return; }
    if (t.dataset.step) { const [k, d] = t.dataset.step.split('|'); const el = document.getElementById('w-' + k); const v = Math.max(0, Math.round((+el.value + +d) * 10) / 10); el.value = v; setWhat(k, v); return; }

    if (t.matches('th[data-k]')) {
      const id = t.closest('table').dataset.table, k = t.dataset.k, s = state.sort[id];
      state.sort[id] = s && s.k === k ? { k, dir: -s.dir } : { k, dir: -1 }; render(); return;
    }
    if (t.dataset.product) { openProduct(t.dataset.product); return; }
    if (t.matches('tr[data-id], .mcard[data-id]')) { openProduct(t.dataset.id); return; }
    if (t.id === 'drawer-close') { closeDrawer(); return; }
    if (t.id === 'copy-note') { copy($('.note p').textContent); return; }
    if (t.dataset.copy) { copy($(`#${t.dataset.copy}`).textContent); return; }
    try {
      if (t.id === 'what-reset') { state.what = {}; await reloadReport(); return; }
      if (t.id === 'what-save') { t.disabled = true; await api('/api/settings', { method: 'PUT', body: JSON.stringify(state.what) }); state.what = {}; toast('Saved as the default'); await load(); return; }
      if (t.id === 'load-demo') { t.disabled = true; await api('/api/demo', { method: 'POST' }); toast('Demo data loaded'); await load(); }
      if (t.id === 'clear-all') { $('#clear-confirm').innerHTML = '<div class="confirm">Delete every stock change and order line? <button class="btn danger" id="clear-yes">Delete all</button><button class="btn ghost" id="clear-no">Keep</button></div>'; }
      if (t.id === 'clear-no') { $('#clear-confirm').innerHTML = ''; }
      if (t.id === 'clear-yes') { await api('/api/clear', { method: 'POST' }); toast('All data deleted'); await load(); }
      if (t.id === 'imp-go') {
        const f = $('#imp-file').files[0]; if (!f) { toast('Choose a CSV file first'); return; }
        t.disabled = true;
        const j = await api(`/api/import?kind=${$('#imp-kind').value}${$('#imp-replace').checked ? '&replaceDemo=1' : ''}`, { method: 'POST', body: await f.text(), json: false, headers: { 'content-type': 'text/csv' } });
        toast(`Read ${j.read} rows, ${j.added} new${j.skipped ? `, ${j.skipped} skipped` : ''}`); await load();
      }
      if (t.id === 'sheet-save') {
        t.disabled = true;
        await api('/api/settings', { method: 'PUT', body: JSON.stringify({ sheetStockCsv: $('#sheet-stock').value, sheetOrderCsv: $('#sheet-order').value }) });
        const j = await api('/api/sync', { method: 'POST' }).catch((err) => ({ error: err.message }));
        toast(j.error ? `Saved. Sync failed: ${j.error}` : `Synced: ${j.stock || 0} stock changes, ${j.orders || 0} order lines new`); await load();
      }
      if (t.id === 'shopify-sync') {
        t.disabled = true; t.textContent = 'Pulling…';
        const j = await api('/api/shopify/sync', { method: 'POST' });
        toast(j.running ? 'Still pulling in the background (the first pull can take a while)' : `Read from Shopify: ${j.stock} stock changes, ${j.orders} order lines new`); await load();
      }
      if (t.id === 'new-key') { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ newIngestKey: true }) }); toast('New key made: update the Flow URLs'); await load(); }
      if (t.id === 'save-settings') {
        const patch = {}; $$('[data-setting]').forEach((i) => { patch[i.dataset.setting] = i.value; });
        await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }); toast('Settings saved'); await load();
      }
    } catch (err) { toast(err.message); t.disabled = false; }
  });
  document.addEventListener('input', (e) => {
    if (e.target.dataset && e.target.dataset.what) { render._focus = e.target.id; setWhat(e.target.dataset.what, e.target.value); return; }
    const m = e.target.id && e.target.id.match(/^q-(reorder|stockouts|products)$/);
    if (m) { state.q[m[1]] = e.target.value; render._focus = e.target.id; render(); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-type') { state.filter.type = e.target.value; render(); return; }
    const id = e.target.dataset && e.target.dataset.msort;
    if (!id) return;
    const [k, dir] = e.target.value.split('|');
    state.sort[id] = k ? { k, dir: +dir } : null; render();
  });
  /* drag a header edge to resize, like a spreadsheet; double-click to reset that table */
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.rz'); if (!h) return;
    e.preventDefault(); h.setPointerCapture && h.setPointerCapture(e.pointerId);
    const th = h.closest('th'), table = th.closest('table'), id = table.dataset.table;
    const ths = [...table.querySelectorAll('th')].filter((x) => x.getBoundingClientRect().width > 0);
    const W = {}; ths.forEach((x) => { W[x.dataset.k] = Math.round(x.getBoundingClientRect().width); });
    table.classList.add('fixed'); ths.forEach((x) => { x.style.width = W[x.dataset.k] + 'px'; });
    table.style.width = Object.values(W).reduce((a, b) => a + b, 0) + 'px';
    const k = th.dataset.k, x0 = e.clientX, w0 = W[k];
    document.body.classList.add('resizing');
    const move = (ev) => { W[k] = Math.max(40, w0 + ev.clientX - x0); th.style.width = W[k] + 'px'; table.style.width = Object.values(W).reduce((a, b) => a + b, 0) + 'px'; };
    const up = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.classList.remove('resizing');
      state.colW[colKey(id)] = W; try { localStorage.setItem('sw-colw', JSON.stringify(state.colW)); } catch { /* private window */ }
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  });
  document.addEventListener('dblclick', (e) => {
    const h = e.target.closest('.rz'); if (!h) return;
    const id = h.closest('table').dataset.table; Object.keys(state.colW).filter((k) => k === id || k.startsWith(id + '@')).forEach((k) => delete state.colW[k]);
    try { localStorage.setItem('sw-colw', JSON.stringify(state.colW)); } catch { /* private window */ }
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (e.key === 'Enter' && e.target.matches && e.target.matches('.mcard[data-id]')) openProduct(e.target.dataset.id);
  });
  $('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
  window.addEventListener('hashchange', route);
  let wasNarrow = narrow();
  let wasTier = tier();
  window.addEventListener('resize', () => { if (narrow() !== wasNarrow || tier() !== wasTier) { wasNarrow = narrow(); wasTier = tier(); render(); } });

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); }
  }

  state.view = (location.hash || '#overview').slice(1);
  load().catch((e) => { $('#view').innerHTML = `<p class="pad">Couldn’t load: ${esc(e.message)}</p>`; });
})();
