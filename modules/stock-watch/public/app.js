/* Stock-out Watch — browser app. No framework: state → HTML strings → #view. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    days: 30, view: 'overview', report: null, settings: null, source: null,
    filter: { reorder: 'today', stockouts: 'all', products: 'all', type: '' }, q: { reorder: '', stockouts: '', products: '' },
    sort: { reorder: null, stockouts: null, products: null },
    what: {},                                   // trial values for the planning assumptions (not saved)
    limit: {},                                  // rows shown per table (pages of 50)
    colW: (() => { try { return JSON.parse(localStorage.getItem('sw-colw') || '{}'); } catch { return {}; } })(),
  };
  const PAGE = 50;
  const ASSUME = [
    ['leadDays', 'Lead time (days)', '', 1, 'Days from placing a supplier order until the stock can be sold'],
    ['coverDays', 'Stock should last (days after delivery)', '', 5, 'How long each reorder should last once it arrives'],
    ['safetyDays', 'Extra buffer (days)', '', 1, 'Spare days of stock for busy days or a late supplier'],
    ['demandWindowDays', 'Sales history to use (days)', '', 7, 'Days of sales used to work out each product’s daily rate'],
    ['minPerDay', 'Ignore products selling under (per day)', '', 0.1, 'Slower products stay off the reorder list (best sellers never do)'],
    ['smallTopUpDays', 'Flag refills under (days of sales)', '', 1, 'A refill smaller than this many days of sales is flagged “refilled too little”'],
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
    render._animate = true; render();
  }

  function header() {
    const r = state.report, s = state.settings;
    $('#store-name').textContent = s.storeName || 'Store';
    $('#n-reorder').textContent = r.totals.orderToday || '';
    $('#n-stockouts').textContent = r.totals.stillOut || '';
    $('#n-stockouts').title = `${r.totals.stillOut} products still out of stock`;
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
    const fields = ASSUME.slice(0, 3).map(([k, label, unit, step, tip]) => `<div class="pf" title="${esc(tip)}"><label for="w-${k}">${label}</label>
        <span class="pin"><button class="pm" data-step="${k}|-${step}" aria-label="Less ${label}">−</button><input id="w-${k}" data-what="${k}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="${esc(label)}" value="${esc(R[k])}" class="${state.what[k] != null && +state.what[k] !== +S[k] ? 'changed' : ''}"><button class="pm" data-step="${k}|${step}" aria-label="More ${label}">+</button></span></div>`).join('');
    return `<details class="plan" ${(state.planOpen ?? false) || trial ? 'open' : ''}><summary>Plan settings <span class="muted">lead time ${R.leadDays} d · lasts ${R.coverDays} d · buffer ${R.safetyDays} d</span>${trial ? ' <span class="badge demo">trying new values</span><span class="pact"><button class="btn" id="what-save">Save as default</button><button class="btn ghost" id="what-reset">Reset</button></span>' : ''}</summary>
      <div class="pbody">${fields}</div></details>`;
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
    if (p.trendPct == null) return p.trendNew ? '<span class="tr new" title="In stock but no sales in the 14 days before; 3 or more sold since">New</span>' : '<span class="tr low" title="Not enough sales yet to call a trend">–</span>';
    const v = p.trendPct, cls = v >= 10 ? 'up' : v <= -10 ? 'down' : 'flat';
    const base = state.report.totals.storeTrendPct;
    return `<span class="tr ${cls}" title="Sales per in-stock day, last 14 days vs the 14 before. Out-of-stock days are left out, so a stock-out doesn't look like falling demand.${base != null ? ` Typical product over the same days: ${base > 0 ? '+' : ''}${n1(base)}%.` : ''}">${cls === 'up' ? '▲' : cls === 'down' ? '▼' : '▬'} ${v > 0 ? '+' : ''}${n1(v)}%</span>`;
  }

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
    const total = rows.length, limit = state.limit[id] || PAGE;
    rows = rows.slice(0, limit);
    const more = total > rows.length ? `<div class="more"><button class="btn ghost" data-more="${id}">Show ${Math.min(PAGE, total - rows.length)} more</button><span class="muted">${inr.format(rows.length)} of ${inr.format(total)}</span><button class="btn ghost" data-more="${id}" data-all="1">Show all</button></div>` : '';
    cols = cols.filter(colVisible);
    const W = state.colW[colKey(id)], fixed = W && cols.every((c) => W[c.k]);
    if (fixed) { const sum = cols.reduce((a, c) => a + W[c.k], 0), room = tableRoom(); if (sum > room) cols.forEach((c) => { W[c.k] = Math.max(40, Math.floor((W[c.k] * room) / sum)); }); }
    const desk = `<div class="tbl desk"><table data-table="${id}" class="${fixed ? 'fixed' : ''}" ${fixed ? `style="width:${cols.reduce((a, c) => a + W[c.k], 0)}px"` : ''}><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}${c.pr ? ' p' + c.pr : ''}" data-k="${c.k}" tabindex="0" aria-sort="${s && s.k === c.k ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}"${c.tip ? ` title="${esc(c.tip)}"` : ''}${fixed ? ` style="width:${W[c.k]}px"` : ''}>${esc(c.label)}${s && s.k === c.k ? (s.dir > 0 ? ' ↑' : ' ↓') : ''}<span class="rz" title="Drag to resize · double-click to reset all columns"></span></th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-id="${esc(r.id)}" tabindex="0">${cols.map((c) => `<td class="${c.r ? 'r' : ''}${c.nw ? ' nw' : ''}${c.pr ? ' p' + c.pr : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    if (!card) return desk + more;
    const cur = s ? `${s.k}|${s.dir}` : '';
    const opts = cols.filter((c) => (c.r || c.val) && !['status', 'name', 'type', 'start', 'end'].includes(c.k))
      .flatMap((c) => (c.k === 'daysLeft' ? [[`${c.k}|1`, 'Days left: fewest first']] : [[`${c.k}|-1`, `${c.label}: highest first`]]));
    const phone = `<div class="phone">
        <label class="msort"><span>Sort by</span><select data-msort="${id}"><option value="">${({ reorder: 'Most urgent first', stockouts: 'Biggest loss first', products: 'Biggest loss first' })[id] || 'Default'}</option>${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div class="mcards">${rows.map((r) => `<article class="mcard" data-id="${esc(r.id)}" tabindex="0">${card(r)}</article>`).join('')}</div>
      </div>`;
    return desk + phone + more;
  }
  const kv = (label, value, cls = '') => `<div class="${cls}"><span>${label}</span><b>${value}</b></div>`;

  /* ---------- charts (SVG, to scale) ---------- */
  function dailyChart(daily) {
    const W = narrow() ? 360 : Math.max(1000, Math.round(innerWidth * 0.62)), H = narrow() ? 230 : 365, L = narrow() ? 50 : 64, R = 10, T = 12, B = 34;
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

  /* ---------- views ----------
     Default view = the decision; detail on demand (Columns picker, More, the product drawer).
     User-facing statuses are three: Order today (out / critical / order now), This week, OK. */
  const TODAY = ['Out now', 'Critical', 'Order now'];
  const group = (s) => (TODAY.includes(s) ? 'today' : s === 'Order this week' ? 'week' : s === 'OK' ? 'ok' : s === 'Slow seller' ? 'slow' : 'none');
  const GROUP_LABEL = { today: 'Order today', week: 'This week', ok: 'OK', slow: 'Slow seller', none: 'No stock data' };
  const status = (p) => { const g = group(p.status); return `<span class="st g-${g}" title="${esc(p.status === 'Critical' ? 'Order today: 3 days or less left' : p.status)}">${GROUP_LABEL[g]}</span>`; };
  const outDot = (p) => (p.stock != null && p.stock <= 0 ? '<span class="dot" title="Out of stock now"></span>' : '');
  const bestTag = (p) => (p.abc === 'A' ? '<span class="best" title="Best seller: among the products making the top 80% of sales">Best seller</span>' : '');
  const nameCell = (p, tag = true) => `${outDot(p)}<span class="pname" title="${esc(p.name)}">${esc(p.name)}</span>${tag ? bestTag(p) : ''}`;

  /* columns picker: optional columns stay hidden until chosen; the choice is remembered */
  const colsOn = (() => { try { return JSON.parse(localStorage.getItem('sw-cols') || '{}'); } catch { return {}; } })();
  const showCol = (id, c) => !c.opt || (colsOn[id] || []).includes(c.k);
  function colPicker(id, cols) {
    const opt = cols.filter((c) => c.opt); if (!opt.length) return '';
    return `<details class="colpick"><summary class="btn ghost">Columns</summary><div class="menu">${opt.map((c) => `<label><input type="checkbox" data-col="${id}|${c.k}" ${showCol(id, c) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}</div></details>`;
  }
  const dlMenu = (id, href) => `<details class="colpick"><summary class="btn ghost" aria-label="More actions" title="More actions">⋯</summary><div class="menu">${href ? `<a href="${href}">Download CSV</a>` : `<button class="linkbtn" id="csv-${id}">Download CSV</button>`}</div></details>`;

  function daysCell(p) {
    if (p.daysLeft == null) return p.stock != null && p.stock <= 0 ? '<span class="lostv">0</span>' : '–';
    const S = state.report.settings, warn = S.leadDays + S.safetyDays;
    const color = p.daysLeft <= 3 ? '#C8344F' : p.daysLeft <= warn ? '#C27416' : '#0978BE';
    return `<span class="days"><span class="num ${p.daysLeft <= 3 ? 'lostv' : ''}">${n1(p.daysLeft)}</span><span class="meter"><i style="width:${Math.min(100, (p.daysLeft / (warn + 7)) * 100)}%;background:${color}"></i></span></span>`;
  }
  /* SW-024: one plain sentence (LOGIC.md §13a), the same text the drawer and the digest use */
  const whyCell = (p) => (p.why ? `<span class="why${p.stock != null && p.stock <= 0 ? ' out' : p.daysLeft != null && p.daysLeft <= 3 ? ' crit' : ''}" title="${esc(p.why)}">${esc(p.why)}</span>` : '–');
  const trendOnly = (p) => (p.trendPct == null && !p.trendNew ? '<span class="muted" title="Not enough sales yet to call a trend">–</span>' : trendChip(p));

  function summaryText() {
    const r = state.report, t = r.totals;
    const prods = new Set(r.stockouts.map((s) => s.id)).size;
    return t.stockouts
      ? `In the last ${r.days} days, ${prods} products ran out of stock ${t.stockouts} times. That cost about ${moneyFull(t.lost)} in sales (${t.lostPct}% of demand)${t.hasCost ? ` and ${moneyFull(t.lostProfit)} in profit` : ''}. ${t.orderToday} products need ordering today (${moneyFull(t.orderValueNow)} at cost)${t.excessValue ? `, and ${moneyFull(t.excessValue)} sits in overstock` : ''}.`
      : `No product ran out of stock in the last ${r.days} days.`;
  }

  function overview() {
    const r = state.report, t = r.totals;
    const today = r.reorder.filter((p) => TODAY.includes(p.status));
    const top = r.products.filter((p) => p.lost > 0).slice(0, 5), maxLost = Math.max(1, ...top.map((p) => p.lost));
    return `
      <section class="headline">
        <h1>Order <span class="amberv">${money(t.orderValueNow)}</span> today · stock-outs cost <span class="lost">${money(t.lost)}</span> in ${r.days} days</h1>
        <button class="btn ghost hbtn" id="copy-summary" title="Copy a plain-language summary for the client">Copy summary</button>
      </section>
      <section class="tiles t4">
        <button class="tile lost" data-go="stockouts" data-filter="all" title="Sales lost while products were out of stock (${n1(t.lostPct)}% of demand)"><b>${money(t.lost)}</b><span>sales lost${t.hasCost ? ` · ${money(t.lostProfit)} profit${t.costed < t.active ? ` (${t.costed}/${t.active} costed)` : ''}` : ''}</span></button>
        <button class="tile amber" data-go="reorder" data-filter="today" title="Cash to commit at unit cost for everything that needs ordering today"><b>${money(t.orderValueNow)}</b><span>to order today · ${t.orderToday} products</span></button>
        <button class="tile ${t.bestAtRisk ? 'lost' : 'sold'}" data-go="products" data-filter="bestrisk" title="Best sellers (top 80% of sales) that need ordering today"><b>${t.bestAtRisk}<small> of ${t.bestsellers}</small></b><span>best sellers at risk</span></button>
        <button class="tile plum" data-go="products" data-filter="over" title="Cash in stock beyond what lead time + days to last + buffer need, for overstocked products: discount, bundle, or stop reordering"><b>${money(t.excessValue)}</b><span>stuck in overstock · ${t.overstocked} products</span></button>
      </section>
      <section class="grid2">
        <div class="panel"><div class="panel-head"><h2>Order today</h2><a href="#reorder" data-go="reorder" data-filter="today">All ${t.orderToday}</a></div>
          ${today.length ? `<div class="bars">${today.slice(0, 10).map((p) => `<div class="bar-row" data-product="${esc(p.id)}" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="name">${outDot(p)}${esc(p.name)}</span><span class="muted num" title="Days of stock left">${p.stock <= 0 ? 'out' : `${n1(p.daysLeft)} d`}</span><span class="num" style="font-weight:700">${inr.format(p.orderQty)} pcs</span></div>`).join('')}</div>` : '<p class="muted">Nothing needs ordering today.</p>'}
        </div>
        <div class="panel"><div class="panel-head"><h2>Biggest losses</h2><a href="#products" data-go="products" data-filter="lost">All</a></div>
          ${top.length ? `<div class="bars">${top.map((p) => `<div class="bar-row" data-product="${esc(p.id)}"><span class="name">${outDot(p)}${esc(p.name)}</span><span class="val">${money(p.lost)}</span><span class="track"><i style="width:${(p.lost / maxLost) * 100}%"></i></span></div>`).join('')}</div>` : '<p class="muted">Nothing lost in this period.</p>'}
        </div>
      </section>
      <section class="panel chart">
        <div class="panel-head"><h2>Sold vs lost, per day</h2><div class="legend"><span><i style="background:#0978BE"></i>Sold ${money(t.sold)}</span><span><i style="background:#C8344F"></i>Lost ${money(t.lost)}</span></div></div>
        ${dailyChart(r.daily)}
      </section>`;
  }

  function reorder() {
    const r = state.report, t = r.totals, f = state.filter.reorder, q = state.q.reorder.toLowerCase();
    const week = r.reorder.filter((p) => p.status === 'Order this week').length;
    const groups = [['today', 'Order today', t.orderToday], ['week', 'This week', week], ['all', 'All', r.reorder.length]];
    const rows = r.reorder.filter((p) => (f === 'all' || group(p.status) === f) && (!q || `${p.name} ${p.sku}`.toLowerCase().includes(q)));
    const cols = [
      { k: 'name', label: 'Product', f: (p) => nameCell(p) },
      ...(f === 'all' ? [{ k: 'status', label: 'Status', f: status, val: (p) => -['Out now', 'Critical', 'Order now', 'Order this week'].indexOf(p.status) }] : []),   // SW-024: a tab of one status needs no Status column
      { k: 'why', label: 'Why', tip: 'Out: how long, and the sales lost in this stock-out so far (Sales lost = the whole period). Otherwise: when it runs out, the last day to order so it lands in time (lead time + buffer before), and the supplier lead time', f: whyCell, val: (p) => (p.stock <= 0 ? -1e15 + (p.outSince || 0) : p.orderBy ?? 1e15) },
      { k: 'orderQty', label: 'Order (pcs)', r: 1, f: (p) => `<b>${inr.format(p.orderQty)}</b>` },
      { k: 'orderValue', label: 'Order cost', r: 1, tip: 'Order quantity × unit cost (× average price paid if cost is unknown)', f: (p) => money(p.orderValue) },
      { k: 'daysLeft', label: 'Days left', f: daysCell, val: (p) => p.daysLeft ?? -1 },
      { k: 'lost', label: 'Sales lost', r: 1, tip: `Sales lost to stock-outs in the last ${state.days} days`, f: (p) => (p.lost ? `<span class="lostv">${money(p.lost)}</span>` : '–') },
      { k: 'stock', label: 'In stock', r: 1, opt: 1, f: (p) => inr.format(p.stock) },
      { k: 'perDay', label: 'Sells / day', r: 1, opt: 1, tip: 'Units sold per in-stock day', f: (p) => n1(p.perDay) },
      { k: 'trendPct', label: 'Trend', opt: 1, tip: 'Sales per in-stock day, last 14 days vs the 14 before', f: trendOnly, val: (p) => p.trendPct ?? -999 },
      { k: 'outs', label: 'Times out', r: 1, opt: 1 },
    ];
    return `
      <section class="headline"><h1>Order <span class="amberv">${money(t.orderValueNow)}</span> today across ${t.orderToday} products</h1>
        <p class="exp">Each order covers lead time + days the stock should last + buffer, at the product’s in-stock sales rate.</p></section>
      ${planBar()}
      <div class="toolbar"><div class="chips">${groups.map(([k, l, c]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-reorder="${k}">${l}<span class="c">${c}</span></button>`).join('')}</div>
        <input class="search" id="q-reorder" placeholder="Search…" title="Search product or SKU" value="${esc(state.q.reorder)}">${colPicker('reorder', cols)}${dlMenu('reorder', `/api/export/reorder.csv?days=${state.days}${whatQs()}&filter=${f}&q=${encodeURIComponent(state.q.reorder)}`)}</div>
      ${table('reorder', cols.filter((c) => showCol('reorder', c)), rows, 'Nothing to order in this view.', (p) => `
        <header><h3>${nameCell(p, false)}</h3><div class="mq"><b>${inr.format(p.orderQty)} pcs</b><small>${money(p.orderValue)}</small></div></header>
        <div class="mfacts">${f === 'all' ? status(p) : ''}${whyCell(p)}${bestTag(p)}</div>`)}`;
  }

  /* stock-outs, one row per product (the individual stock-outs are in the product drawer) */
  function outsByProduct() {
    const m = new Map();
    for (const s of state.report.stockouts) {
      const a = m.get(s.id) || { id: s.id, name: s.name, sku: s.sku, times: 0, days: 0, lost: 0, open: false, small: 0, repeat: 0, last: 0 };
      a.times++; a.days += (s.hoursInPeriod ?? s.hours) / 24; a.lost += s.lost; a.open = a.open || s.open; a.small += s.small ? 1 : 0; a.repeat += s.repeat ? 1 : 0; a.last = Math.max(a.last, s.start);
      m.set(s.id, a);
    }
    return [...m.values()].sort((a, b) => b.lost - a.lost);
  }
  function stockouts() {
    const r = state.report, t = r.totals, f = state.filter.stockouts, q = state.q.stockouts.toLowerCase();
    const all = outsByProduct();
    const groups = [['all', 'All', all.length], ['open', 'Still out', all.filter((a) => a.open).length], ['small', 'Refilled too little', all.filter((a) => a.small).length], ['again', 'Ran out again', all.filter((a) => a.repeat).length]];
    const rows = all.filter((a) => (f === 'all' || (f === 'open' ? a.open : f === 'small' ? a.small : a.repeat)) && (!q || `${a.name} ${a.sku}`.toLowerCase().includes(q)));
    const pattern = (a) => [a.small ? `<span class="st small" title="Refilled with less than ${state.report.settings.smallTopUpDays} days of sales, ${a.small}×">Refilled too little</span>` : '', a.repeat ? `<span class="st again" title="Ran out again within a week, ${a.repeat}×">Ran out again</span>` : ''].join(' ') || '–';
    const cols = [
      { k: 'name', label: 'Product', f: (a) => `<span class="pname" title="${esc(a.name)}">${esc(a.name)}</span>` },
      { k: 'lost', label: 'Sales lost', r: 1, f: (a) => `<b class="lostv">${money(a.lost)}</b>` },
      { k: 'times', label: 'Times out', r: 1 },
      { k: 'days', label: 'Days out', r: 1, tip: `Total days out of stock inside the last ${state.days} days`, f: (a) => n1(a.days) },
      { k: 'open', label: 'Now', f: (a) => (a.open ? '<span class="st g-today">Still out</span>' : '<span class="muted">Back in stock</span>'), val: (a) => (a.open ? 1 : 0) },
      { k: 'pattern', label: 'Pattern', f: pattern, val: (a) => a.small + a.repeat },
    ];
    return `
      <section class="headline"><h1>${all.length} products ran out ${t.stockouts} times · <span class="lost">${money(t.lost)}</span> in sales${t.hasCost ? ` · ${money(t.lostProfit)} profit` : ''}${t.stillOut && t.stillOutPerDay ? ` · ${t.stillOut} still out, costing <span class="lost">${money(t.stillOutPerDay)}/day</span>` : ''}</h1>
        <details class="how exp"><summary>How we estimate this</summary><p>Hours out of stock, weighted by when this store usually sells, × the product’s normal sales per hour × the average price paid. Open a product for each stock-out.</p></details></section>
      <div class="toolbar"><div class="chips">${groups.map(([k, l, c]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-stockouts="${k}">${l}<span class="c">${c}</span></button>`).join('')}</div>
        <input class="search" id="q-stockouts" placeholder="Search…" title="Search product or SKU" value="${esc(state.q.stockouts)}"></div>
      ${table('stockouts', cols, rows, 'No stock-outs in this view.', (a) => `
        <header><h3>${esc(a.name)}</h3><div class="mq"><b class="lostv">${money(a.lost)}</b><small>sales lost</small></div></header>
        <div class="mfacts">${a.open ? '<span class="st g-today">Still out</span>' : ''}<span><b>${a.times}</b>× out</span><span><b>${n1(a.days)}</b> days out</span>${a.small ? '<span class="st small">Refilled too little</span>' : ''}${a.repeat ? '<span class="st again">Ran out again</span>' : ''}</div>`)}`;
  }

  /* Products */
  /* SW-026: Pause / Push for marketing replace the Overstock chip (Push = the overstock list by ₹ stuck); Overstock moves to More… */
  const PRODUCT_TABS = [['all', 'All'], ['bestrisk', 'Best sellers at risk'], ['today', 'Order today'], ['pause', 'Pause promotion'], ['push', 'Push these'], ['lost', 'Losing sales']];
  const PRODUCT_MORE = [['best', 'Best sellers'], ['week', 'Order this week'], ['ok', 'OK'], ['over', 'Overstock'], ['slow', 'Slow sellers'], ['decide', 'Slow sellers to decide'], ['rising', 'Selling faster'], ['falling', 'Selling slower']];
  const MKT_TIP = { pause: 'Out of stock now, or fewer days left than the supplier lead time: pause ads and promotions until it’s back', push: 'Overstocked, most cash stuck first: promote, bundle or discount' };
  const decideOf = () => (decideOf.r === state.report ? decideOf.m : (decideOf.r = state.report, decideOf.m = new Map((state.report.decide || []).map((x) => [x.id, x]))));
  const productMatch = (p, f) => f === 'all' || (f === 'pause' || f === 'push' ? p.mkt === f : f === 'decide' ? decideOf().has(p.id) : f === 'lost' ? p.lost > 0 : f === 'best' ? p.abc === 'A' : f === 'bestrisk' ? p.abc === 'A' && TODAY.includes(p.status)
    : f === 'over' ? p.overstock : f === 'rising' ? p.trendPct >= 10 || p.trendNew : f === 'falling' ? p.trendPct <= -10 : group(p.status) === f);
  function productRows() {
    const r = state.report, q = state.q.products.toLowerCase(), f = state.filter.products, ty = state.filter.type;
    const dm = f === 'decide' ? decideOf() : null;
    const list = r.products.filter((p) => (dm ? dm.has(p.id) : productMatch(p, f)) && (!ty || p.type === ty) && (!q || `${p.name} ${p.sku} ${p.type}`.toLowerCase().includes(q)));
    if (f === 'pause' || f === 'push') return mktSort(list, f);
    if (dm) return list.sort((a, b) => dm.get(b.id).value - dm.get(a.id).value);
    return list;
  }
  /* same order as src/helpers.js mktSort (LOGIC.md §13c) */
  const mktSort = (rows, kind) => rows.slice().sort(kind === 'push' ? (a, b) => (b.excessValue || 0) - (a.excessValue || 0)
    : (a, b) => (a.stock <= 0 ? -1 : a.daysLeft ?? 1e9) - (b.stock <= 0 ? -1 : b.daysLeft ?? 1e9) || b.perDay * b.price - a.perDay * a.price);
  /* SW-032: the decision cell and its buttons */
  const DECIDE_LABEL = { drop: 'Don’t reorder?', clear: 'Clear' };
  const decideCell = (p) => { const x = decideOf().get(p.id); if (!x) return '–'; return `<span class="dec ${x.kind}" title="${x.kind === 'drop' ? 'Sells slowly and is out of stock: sales lost in the period' : 'Sells slowly and has stock: stock × unit cost (price when no cost)'}">${DECIDE_LABEL[x.kind]} <b>${money(x.value)}</b>${x.kind === 'drop' ? ' lost' : ' at cost'}</span>`; };
  const decideBtns = (p) => { const x = decideOf().get(p.id); if (!x) return ''; return `<span class="decb">${['keep', x.kind === 'drop' ? 'drop' : 'clear', ...(x.kind === 'clear' ? ['drop'] : [])].map((d) => `<button class="btn ghost xs" data-decide="${esc(p.id)}|${d}" title="${esc(DECIDE_TIP[d])}">${d[0].toUpperCase() + d.slice(1)}</button>`).join('')}</span>`; };
  const DECIDE_TIP = { keep: 'Keep selling and reordering as now', drop: 'Stop reordering it', clear: 'Sell off the stock (discount, bundle)' };
  /* SW-026: the Pause / Push action bar: counts, copy SKUs, CSV */
  function mktBar(rows, f) {
    if (f !== 'pause' && f !== 'push') return '';
    const n = f === 'pause' ? `${inr.format(rows.filter((p) => p.orderQty > 0).length)} to reorder · ${inr.format(rows.filter((p) => p.status === 'Slow seller').length)} slow` : `${money(rows.reduce((a, p) => a + (p.excessValue || 0), 0))} stuck`;
    return `<div class="mktbar"><span title="${esc(MKT_TIP[f])}">${n}</span>${rows.length ? `<button class="btn ghost xs" id="copy-skus">Copy ${inr.format(rows.length)} SKUs</button><button class="btn ghost xs" id="csv-mkt">CSV</button>` : ''}</div>`;
  }
  function downloadMktCsv(f) {
    const head = f === 'pause' ? ['Product', 'SKU', 'Variant ID', 'Why', 'Back in stock', 'In stock', 'Days left'] : ['Product', 'SKU', 'Variant ID', 'Overstock ₹', 'In stock', 'Days left'];
    const body = productRows().map((p) => (f === 'pause' ? [p.name, p.sku, p.id, p.why, p.backIn, p.stock, p.daysLeft ?? ''] : [p.name, p.sku, p.id, p.excessValue, p.stock, p.daysLeft ?? '']));
    saveCsv(`${f === 'pause' ? 'pause-promotion' : 'push-these'}-${isoToday()}.csv`, [head, ...body]);
  }
  const isoToday = () => local(Date.now()).toISOString().slice(0, 10);
  function saveCsv(name, lines) {
    const q = (x) => { const v = String(x ?? ''); return `"${(typeof x === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`; };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.map((l) => l.map(q).join(',')).join('\n')], { type: 'text/csv' }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  const PRODUCT_COLS = () => [
    { k: 'name', label: 'Product', f: (p) => nameCell(p), csv: (p) => p.name },
    { k: 'sku', label: 'SKU', hide: 1 },
    { k: 'abc', label: 'Rank (A = best seller)', hide: 1 },
    { k: 'status', label: 'Status', f: status, val: (p) => -['Out now', 'Critical', 'Order now', 'Order this week', 'OK', 'Slow seller', 'No stock data'].indexOf(p.status), csv: (p) => GROUP_LABEL[group(p.status)] },
    { k: 'stock', label: 'In stock', r: 1, f: (p) => (p.stock == null ? '–' : inr.format(p.stock)) },
    { k: 'daysLeft', label: 'Days left', f: daysCell, val: (p) => p.daysLeft ?? -1, csv: (p) => p.daysLeft ?? '' },
    { k: 'sold', label: 'Sold', r: 1, tip: `₹ sold in the last ${state.days} days`, f: (p) => money(p.sold) },
    { k: 'lost', label: 'Sales lost', r: 1, tip: `Sales lost to stock-outs in the last ${state.days} days`, f: (p) => (p.lost ? `<span class="lostv">${money(p.lost)}</span>` : '–') },
    { k: 'orderQty', label: 'Order', r: 1, tip: 'Units to order (only when an order is due)', f: (p) => (p.orderQty ? `<b>${inr.format(p.orderQty)}</b>` : '–') },
    { k: 'type', label: 'Category', opt: 1, f: (p) => `<span class="muted cat" title="${esc(p.type)}">${esc(p.type || '–')}</span>` },
    { k: 'trendPct', label: 'Trend', opt: 1, tip: 'Sales per in-stock day, last 14 days vs the 14 before (stock-out days left out)', f: trendOnly, val: (p) => (p.trendPct ?? (p.trendNew ? 999 : -999)), csv: (p) => p.trendPct ?? '' },
    { k: 'perDay', label: 'Sells / day', r: 1, opt: 1, tip: 'Units sold per in-stock day', f: (p) => n1(p.perDay) },
    { k: 'unitsSold', label: 'Units sold', r: 1, opt: 1, f: (p) => inr.format(p.unitsSold || 0) },
    { k: 'lostPct', label: 'Share of demand lost', r: 1, opt: 1, tip: 'Sales lost ÷ (sold + lost)', f: (p) => (p.lostPct ? `${n1(p.lostPct)}%` : '–') },
    { k: 'outs', label: 'Times out', r: 1, opt: 1 },
    { k: 'excessValue', label: 'Overstock ₹', r: 1, opt: 1, tip: 'Cash in stock beyond what lead time + days to last + buffer need (at unit cost when known)', f: (p) => (p.excessValue ? `<span class="${p.overstock ? 'plumv' : 'muted'}">${money(p.excessValue)}</span>` : '–') },
    ...(state.report.totals.hasCost ? [
      { k: 'lostProfit', label: 'Profit lost', r: 1, opt: 1, tip: 'Units lost × (price paid − unit cost)', f: (p) => (p.lostProfit ? `<span class="lostv">${money(p.lostProfit)}</span>` : '–') },
      { k: 'margin', label: 'Margin', r: 1, opt: 1, tip: '(price paid − unit cost) ÷ price paid', f: (p) => (p.margin == null ? '–' : `${n1(p.margin)}%`) },
      { k: 'cost', label: 'Unit cost', hide: 1 },
    ] : []),
    { k: 'price', label: 'Avg price', hide: 1 },
  ];
  const countIn = (list, k) => inr.format(list.filter((p) => productMatch(p, k)).length);
  function products() {
    const r = state.report, f = state.filter.products, ty = state.filter.type;
    const rows = productRows();
    const types = [...new Set(r.products.map((p) => p.type).filter(Boolean))].sort();
    const inType = r.products.filter((p) => !ty || p.type === ty);
    const tot = rows.reduce((a, p) => ({ sold: a.sold + p.sold, lost: a.lost + p.lost, stock: a.stock + (p.stock > 0 ? p.stock : 0) }), { sold: 0, lost: 0, stock: 0 });
    let cols = PRODUCT_COLS().filter((c) => !c.hide);
    /* Pause: "Back in stock" in place of Order; Push: Overstock ₹ in place of Order; Decide: the decision in place of Status and Order */
    if (f === 'pause') cols = cols.map((c) => (c.k === 'orderQty' ? { k: 'backIn', label: 'Back in stock', tip: 'The marked order’s date, or the earliest an order placed today could land', f: (p) => `<span class="muted">${esc(p.backIn || '–')}</span>` } : c));
    if (f === 'push') cols = cols.map((c) => (c.k === 'orderQty' ? { ...PRODUCT_COLS().find((x) => x.k === 'excessValue'), opt: 0 } : c)).filter((c, i, a) => c.k !== 'excessValue' || a.findIndex((x) => x.k === 'excessValue') === i);
    if (f === 'decide') cols = cols.filter((c) => !['status', 'orderQty', 'daysLeft'].includes(c.k)).concat([{ k: 'decide', label: 'Decide', f: decideCell, val: (p) => decideOf().get(p.id)?.value || 0 }, { k: 'act', label: '', f: decideBtns }]);
    const moreOn = PRODUCT_MORE.some(([k]) => k === f);
    return `
      <section class="headline"><h1>Products</h1><p>${inr.format(rows.length)} shown · ${money(tot.sold)} sold · <span class="lostv">${money(tot.lost)} lost</span> · ${inr.format(tot.stock)} pcs in stock</p>
        <span class="hfind">${types.length ? `<select class="search sel" id="f-type" aria-label="Category"><option value="">All categories</option>${types.map((t) => `<option ${t === ty ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}<input class="search" id="q-products" placeholder="Search…" title="Search name, SKU or category" value="${esc(state.q.products)}"></span></section>
      <div class="toolbar"><div class="chips">${PRODUCT_TABS.map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-products="${k}"${MKT_TIP[k] ? ` title="${esc(MKT_TIP[k])}"` : ''}>${l}<span class="c">${countIn(inType, k)}</span></button>`).join('')}
        <select class="chip sel ${moreOn ? 'on' : ''}" id="f-more" aria-label="More filters"><option value="">More…</option>${PRODUCT_MORE.map(([k, l]) => `<option value="${k}" ${f === k ? 'selected' : ''}>${l} (${countIn(inType, k)})</option>`).join('')}</select></div>
        ${mktBar(rows, f)}${colPicker('products', cols)}${dlMenu('products')}</div>
      ${table('products', cols.filter((c) => showCol('products', c)), rows, 'No products match.', (p) => `
        <header><h3>${nameCell(p, false)}</h3>${status(p)}</header>
        <div class="mfacts"><span class="${p.stock != null && p.stock <= 0 ? 'bad' : ''}"><b>${p.stock == null ? '–' : inr.format(p.stock)}</b> in stock</span><span><b>${p.daysLeft == null ? '–' : n1(p.daysLeft)}</b> days left</span><span><b>${money(p.sold)}</b> sold</span>${p.lost ? `<span class="lostv">${money(p.lost)} lost</span>` : ''}${p.orderQty ? `<span>order <b>${inr.format(p.orderQty)}</b></span>` : ''}${bestTag(p)}</div>${f === 'pause' ? `<div class="mfacts"><span>${esc(p.backIn || '')}</span></div>` : ''}${f === 'decide' ? `<div class="mfacts">${decideCell(p)}${decideBtns(p)}</div>` : ''}`)}
      ${f === 'decide' ? decidedNote() : ''}`;
  }
  /* SW-032: decided items are hidden until their sales change by more than half; listed here so a decision can be undone */
  function decidedNote() {
    const d = state.report.decided || []; if (!d.length) return '';
    const byId = new Map(state.report.products.map((p) => [p.id, p]));
    return `<details class="panel fold decided"><summary><b>${d.length} decided</b> <span class="muted">hidden until their sales change by more than half</span></summary>
      <div class="bars">${d.map((x) => `<div class="bar-row" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="name">${esc(byId.get(x.id)?.name || x.id)}</span><span class="muted">${esc(x.decision[0].toUpperCase() + x.decision.slice(1))}</span><button class="btn ghost xs" data-decide="${esc(x.id)}|">Undo</button></div>`).join('')}</div></details>`;
  }
  function downloadProductsCsv() {
    const cols = PRODUCT_COLS();
    const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map((c) => c.label), ...productRows().map((p) => cols.map((c) => (c.csv ? c.csv(p) : p[c.k])))].map((l) => l.map(q).join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
    a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }

  const TZ = [[330, 'India (UTC+5:30)'], [345, 'Nepal (UTC+5:45)'], [240, 'UAE (UTC+4)'], [180, 'Saudi Arabia (UTC+3)'], [0, 'UK (UTC+0, no daylight saving)'], [480, 'Singapore (UTC+8)'], [-300, 'US Eastern (UTC−5, no daylight saving)'], [-480, 'US Pacific (UTC−8, no daylight saving)']];
  function dataView() {
    const s = state.settings, d = state.report.data, src = state.source, sh = state.shopify || {};
    const base = location.origin;
    const tzOpts = TZ.some(([v]) => v === +s.tzOffsetMin) ? TZ : [...TZ, [+s.tzOffsetMin, `Custom (${s.tzOffsetMin} min)`]];
    const status = src.kind === 'demo' ? 'Demo data: Sammsara’s public product list, with invented stock and sales'
      : sh.source ? (sh.lastError ? `Shopify: ${esc(sh.lastError)}` : sh.lastSync ? `Connected to Shopify · last read ${dt(sh.lastSync)}` : 'Connected to Shopify · first read pending')
        : src.kind === 'live' ? 'Live data' : 'No data yet';
    return `
      <section class="headline"><h1>Data &amp; settings</h1></section>
      <section class="panel"><div class="panel-head"><h2>${status}</h2>${sh.source ? '<button class="btn" id="shopify-sync">Pull from Shopify now</button>' : ''}</div>
        <p class="muted">${inr.format(d.stockRows)} stock changes${d.firstStock ? ` (${dt(d.firstStock)} → ${dt(d.lastStock)})` : ''} · ${inr.format(d.orderRows)} order lines${d.firstOrder ? ` (${dt(d.firstOrder)} → ${dt(d.lastOrder)})` : ''}</p></section>

      <h2 class="sect">Connect your data</h2>
      <details class="panel fold"><summary><b>Shopify</b> <span class="muted">read-only, recommended</span></summary>${shopifyPanel()}</details>
      <details class="panel fold"><summary><b>Google Sheet</b> <span class="muted">from the Stock Watch sheet</span></summary>
        <p class="muted">If the store’s Shopify Flow writes into a Google Sheet: in that sheet, File → Share → Publish to web → pick the tab → CSV, and paste the two links. Synced every 15 minutes.</p>
        <div class="field"><label for="sheet-stock">“Stock log” CSV link</label><input id="sheet-stock" value="${esc(s.sheetStockCsv)}" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&output=csv"></div>
        <div class="field"><label for="sheet-order">“Order log” CSV link</label><input id="sheet-order" value="${esc(s.sheetOrderCsv)}" placeholder="https://docs.google.com/spreadsheets/d/e/…/pub?gid=…&output=csv"></div>
        <div class="toolbar"><button class="btn" id="sheet-save">Save and sync now</button></div></details>
      <details class="panel fold"><summary><b>Shopify Flow</b> <span class="muted">sends each change straight here</span></summary>
        <p class="muted">In Shopify Flow use the action <b>Send HTTP request</b> (POST), body = the same comma-separated line as the sheet, or JSON. One workflow per URL:</p>
        <div class="field"><label>Stock changes (trigger: Product variant inventory quantity changed)</label><div class="code" id="u-stock">${esc(base)}/ingest/stock?key=${esc(s.ingestKey)}</div></div>
        <div class="field"><label>Order lines (trigger: Order created → For each line item)</label><div class="code" id="u-order">${esc(base)}/ingest/order?key=${esc(s.ingestKey)}</div></div>
        <div class="toolbar"><button class="btn ghost" data-copy="u-stock">Copy stock URL</button><button class="btn ghost" data-copy="u-order">Copy order URL</button><button class="btn ghost" id="new-key">New key</button></div></details>
      <details class="panel fold"><summary><b>Upload a CSV</b> <span class="muted">one-off history</span></summary>
        <p class="muted">Columns, with a header row. Stock: <span class="mono">Time, Variant ID, SKU, Product, Variant, Stock before, Stock now, Price</span>. Orders: <span class="mono">Time, Order, Variant ID, SKU, Qty, Unit price</span>.</p>
        <div class="form"><div class="field"><label for="imp-kind">File holds</label><select id="imp-kind"><option value="stock">Stock changes</option><option value="order">Order lines</option></select></div>
          <div class="field"><label for="imp-file">CSV file</label><input type="file" id="imp-file" accept=".csv,text/csv"></div></div>
        <label class="muted"><input type="checkbox" id="imp-replace" ${src.kind === 'demo' ? 'checked' : ''}> Remove the demo data first</label>
        <div><button class="btn" id="imp-go">Upload</button></div></details>

      <h2 class="sect">Settings</h2>
      <section class="panel">
        <div class="form">
          ${field('storeName', 'Store name', s.storeName, 'Shown at the top', 'text')}
          <div class="field"><label for="f-tzOffsetMin">Time zone</label><select id="f-tzOffsetMin" data-setting="tzOffsetMin">${tzOpts.map(([v, l]) => `<option value="${v}" ${v === +s.tzOffsetMin ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><small>Days and the sales-by-hour pattern follow this</small></div>
        </div>
        <details class="fold-in"><summary>Advanced: planning rules</summary>
          <div class="form">${ASSUME.map(([k, label, , , tip]) => field(k, label, s[k], tip)).join('')}</div></details>
        <div><button class="btn" id="save-settings">Save settings</button></div>
      </section>
      <details class="panel fold danger"><summary><b>Danger zone</b></summary>
        <div class="toolbar">${sh.source ? '' : '<button class="btn ghost" id="load-demo">Reload demo data</button>'}<button class="btn ghost" id="clear-all">Clear all data</button></div>
        <div id="clear-confirm"></div></details>
      <p class="phone-only"><a class="btn ghost" href="/logout">Sign out</a></p>`;
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
        <div class="toolbar">${p ? status(p) + bestTag(p) : ''}<span class="mono muted">${esc(p?.sku || '')}</span></div>
        ${p?.why ? `<p class="dwhy">${whyCell(p)}</p>` : ''}
        <section class="tiles dtiles">
          <div class="tile amber"><b>${p?.orderQty ? `${inr.format(p.orderQty)} pcs` : '–'}</b><span>order now${p?.orderQty ? ` · ${money(p.orderValue)}` : ''}</span></div>
          <div class="tile ${p?.daysLeft != null && p.daysLeft <= 3 ? 'lost' : ''}"><b>${p?.daysLeft == null ? (p?.stock <= 0 ? '0' : '–') : n1(p.daysLeft)}</b><span>days left · ${p?.stock ?? '–'} in stock</span></div>
          <div class="tile"><b>${n1(p?.perDay)}</b><span>sells per in-stock day</span></div>
          <div class="tile lost"><b>${money(p?.lost)}</b><span>sales lost${p?.lostProfit != null ? ` · ${money(p.lostProfit)} profit` : ''}</span></div>
        </section>
        <div class="panel"><h2>Trend</h2><div class="trc big">${p ? spark(p, 240, 44) + trendChip(p) : ''}</div><p class="muted small">${p ? (p.weeks || []).map((w, i) => (w.units == null ? '' : `${WEEK_LABEL(i)}: ${w.units}${w.outDays ? ` (out ${n1(w.outDays)} d)` : ''}`)).filter(Boolean).reverse().slice(0, 4).join(' · ') : ''}</p></div>
        <div class="panel chart"><h2>Stock level</h2>${stockChart(d.timeline, from, now)}<span class="muted" style="font-size:13px">Shaded = out of stock.</span></div>
        <details class="panel fold"><summary><b>More</b> <span class="muted">units per day, every stock-out</span></summary>
        <div class="chart"><h2>Units sold per day</h2>${unitsChart(d.dailyUnits)}</div>
        <div><h2>Stock-outs</h2>${d.stockouts.length ? `<div>${d.stockouts.map((s) => `<div class="ep"><span>${dt(s.start)} → ${s.open ? '<span class="st open">still out</span>' : dt(s.end)}</span><span class="muted">${dur(s.hours)}</span><b style="color:#E0506E">${money(s.lost)}</b>${s.topUp != null ? `<span>refilled ${s.topUp} pcs</span>` : ''}${s.small ? '<span class="st small">Small top-up</span>' : ''}${s.repeat ? '<span class="st again">Out again</span>' : ''}</div>`).join('')}</div>` : '<p class="muted">None in this period.</p>'}</div></details>`;
      $('#drawer-close').focus();
    } catch (e) { body.innerHTML = `<p>Couldn’t load this product: ${esc(e.message)}</p>`; }
  }
  let lastRow = null;
  const closeDrawer = () => { const was = !$('#drawer').hidden; $('#drawer').hidden = true; if (was && lastRow && document.contains(lastRow)) lastRow.focus(); };

  /* ---------- render + events ---------- */
  const VIEWS = { overview, reorder, stockouts, products, data: dataView };
  function render() {
    if (!state.report) return;
    $$('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.view === state.view));
    $('#view').classList.toggle('calm', !render._animate); render._animate = false;   // bars animate when a page opens, not on every filter or keystroke
    $('#view').innerHTML = (VIEWS[state.view] || overview)();
    const focusId = render._focus; render._focus = null;
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); const c = render._caret ?? el.value.length; try { el.setSelectionRange(c, c); } catch { /* not a text input */ } } }
    render._caret = null;
  }
  function route() { closeDrawer(); render._animate = true; state.view = (location.hash || '#overview').slice(1) in VIEWS ? (location.hash || '#overview').slice(1) : 'overview'; render(); window.scrollTo(0, 0); }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('.rz')) return;
    const sum = e.target.closest('.plan > summary'); if (sum) { state.planOpen = !sum.parentElement.open; return; }
    const t = e.target.closest('button, [data-product], tr[data-id], .mcard[data-id], th[data-k], [data-go]');
    if (!t) return;
    if (t.matches('.range button')) { state.days = +t.dataset.days; await load(); return; }
    if (t.dataset.go) { const v = t.dataset.go; state.filter[v] = t.dataset.filter; location.hash = v; return; }
    if (t.dataset.more) { const id = t.dataset.more; state.limit[id] = t.dataset.all ? 1e9 : (state.limit[id] || PAGE) + PAGE; render(); return; }
    if (t.dataset.filterReorder) { state.filter.reorder = t.dataset.filterReorder; state.limit.reorder = 0; render(); return; }
    if (t.dataset.filterStockouts) { state.filter.stockouts = t.dataset.filterStockouts; state.limit.stockouts = 0; render(); return; }
    if (t.dataset.filterProducts) { state.filter.products = t.dataset.filterProducts; state.limit.products = 0; render(); return; }
    if (t.id === 'csv-products') { downloadProductsCsv(); return; }
    if (t.id === 'csv-mkt') { downloadMktCsv(state.filter.products); return; }
    if (t.id === 'copy-skus') { copy(productRows().map((p) => p.sku || p.id).join('\n')); return; }
    if (t.dataset.decide != null) {
      const [id, d] = t.dataset.decide.split('|'); t.disabled = true;
      try { await api('/api/decide', { method: 'POST', body: JSON.stringify({ id, decision: d || null }) }); toast(d ? 'Decided: hidden until its sales change by more than half' : 'Back on the list'); await reloadReport(); } catch (err) { toast(err.message); t.disabled = false; }
      return;
    }
    if (t.id === 'copy-summary') { copy(summaryText()); return; }
    if (t.dataset.step) { const [k, d] = t.dataset.step.split('|'); const el = document.getElementById('w-' + k); const v = Math.max(0, Math.round((+el.value + +d) * 10) / 10); el.value = v; setWhat(k, v); return; }

    if (t.matches('th[data-k]')) {
      const id = t.closest('table').dataset.table, k = t.dataset.k, s = state.sort[id];
      state.sort[id] = s && s.k === k ? { k, dir: -s.dir } : { k, dir: -1 }; render(); return;
    }
    if (t.dataset.product) { openProduct(t.dataset.product); return; }
    if (t.matches('tr[data-id], .mcard[data-id]')) { lastRow = t; openProduct(t.dataset.id); return; }
    if (t.id === 'drawer-close') { closeDrawer(); return; }
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
    if (e.target.dataset && e.target.dataset.what) { render._focus = e.target.id; render._caret = e.target.selectionStart; setWhat(e.target.dataset.what, e.target.value.replace(',', '.')); return; }
    const m = e.target.id && e.target.id.match(/^q-(reorder|stockouts|products)$/);
    if (m) { state.q[m[1]] = e.target.value; state.limit[m[1]] = 0; render._focus = e.target.id; render._caret = e.target.selectionStart; render(); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-type') { state.filter.type = e.target.value; state.limit.products = 0; render(); return; }
    if (e.target.id === 'f-more') { state.filter.products = e.target.value || 'all'; state.limit.products = 0; render(); return; }
    if (e.target.dataset && e.target.dataset.col) {
      const [id, k] = e.target.dataset.col.split('|'); const on = new Set(colsOn[id] || []);
      if (e.target.checked) on.add(k); else on.delete(k);
      colsOn[id] = [...on]; try { localStorage.setItem('sw-cols', JSON.stringify(colsOn)); } catch { /* private window */ }
      render(); $(`.colpick`)?.setAttribute('open', ''); return;
    }
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
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.mcard[data-id], tr[data-id]')) { e.preventDefault(); lastRow = e.target; openProduct(e.target.dataset.id); }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('th[data-k]')) { e.preventDefault(); e.target.click(); }
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
