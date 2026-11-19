/* Stock-out Watch — browser app. No framework: state → HTML strings → #view. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    days: 30, view: 'overview', report: null, settings: null, source: null,
    filter: { reorder: 'all', stockouts: 'all' }, q: { reorder: '', stockouts: '', products: '' },
    sort: { reorder: null, stockouts: null, products: null },
  };

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

  const STATUS_CLS = { 'Out now': 'out', Critical: 'crit', 'Order now': 'now', 'Order this week': 'week', OK: 'ok', 'Not selling': 'ok', 'No stock data': 'ok' };
  const pill = (s) => `<span class="st ${STATUS_CLS[s] || 'ok'}">${esc(s)}</span>`;

  /* ---------- server ---------- */
  async function api(path, opt = {}) {
    const r = await fetch(path, { ...opt, headers: { ...(opt.body && typeof opt.body === 'string' && opt.json !== false ? { 'content-type': 'application/json' } : {}), ...(opt.headers || {}) } });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }

  async function load() {
    const [rep, set] = await Promise.all([api(`/api/report?days=${state.days}`), api('/api/settings')]);
    state.report = rep; state.settings = set.settings; state.source = { kind: rep.source, lastSync: rep.lastSync, err: rep.lastSyncError }; state.shopify = set.shopify || {};
    header();
    render();
  }

  function header() {
    const r = state.report, s = state.settings;
    $('#store-name').textContent = s.storeName || 'Store';
    $('#n-reorder').textContent = r.totals.outNow + r.totals.orderNow || '';
    $('#n-stockouts').textContent = r.totals.stockouts || '';
    const src = state.source, d = r.data;
    const badge = src.kind === 'demo' ? '<span class="badge demo">Demo data</span>' : src.kind === 'live' ? '<span class="badge live">● Live data</span>' : '<span class="badge empty">No data yet</span>';
    $('#source').innerHTML = `${badge}<span>${inr.format(d.stockRows)} stock changes · ${inr.format(d.orderRows)} order lines</span>`
      + (d.lastStock ? `<span>last stock change ${dt(d.lastStock)}</span>` : '')
      + (src.err ? `<span class="badge err">Sheet sync: ${esc(src.err)}</span>` : src.lastSync ? `<span>sheet synced ${dt(src.lastSync)}</span>` : '')
      + shopifyBadge();
    $$('.range button').forEach((b) => b.classList.toggle('on', +b.dataset.days === state.days));
  }

  function shopifyBadge() {
    const sh = state.shopify || {};
    if (!sh.source) return '';
    if (sh.running) return '<span>Shopify: pulling now…</span>';
    if (sh.lastError) return `<span class="badge err">Shopify: ${esc(sh.lastError)}</span>`;
    return sh.lastSync ? `<span>Shopify read ${dt(sh.lastSync)}</span>` : '<span>Shopify: first pull pending</span>';
  }
  function shopifyPanel() {
    const sh = state.shopify || {};
    const scopes = (sh.scopes || []).map((x) => `<span class="mono">${esc(x)}</span>`).join(', ');
    if (!sh.source) {
      return `<div class="panel" style="grid-column:1/-1"><h2>Shopify (read-only) · not connected</h2>
        <p class="muted">Connect a store and the app reads stock every 15 minutes and new orders since the last read, straight from Shopify. It only ever reads: every call is checked, and anything that could change the store is refused. Read permissions needed: ${scopes}.</p>
        <p class="muted">Set these as Railway variables (the key is never typed into this page):</p>
        <dl class="kv"><dt>Azure Key Vault (preferred)</dt><dd><span class="mono">AZURE_KEY_VAULT_URL, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, SHOPIFY_STORE</span>. Reads the secret <span class="mono">shopify-&lt;store&gt;</span>.</dd>
          <dt>Stop-gap</dt><dd><span class="mono">SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN</span></dd></dl></div>`;
    }
    const where = sh.source === 'vault' ? `Azure Key Vault, secret <span class="mono">${esc(sh.secretName)}</span>` : 'Railway variables (stop-gap)';
    return `<div class="panel" style="grid-column:1/-1"><h2>Shopify (read-only) · ${esc(sh.store || '')}</h2>
      <dl class="kv"><dt>Key from</dt><dd>${where}</dd>
        <dt>Status</dt><dd>${!sh.ready ? `<span style="color:#D9623B">Missing: ${esc(sh.missing.join(', '))}</span>` : sh.running ? 'Pulling now…' : sh.lastError ? `<span style="color:#D9623B">${esc(sh.lastError)}</span>${sh.lastTry ? ` · tried ${dt(sh.lastTry)}` : ''}` : sh.lastSync ? `OK · last read ${dt(sh.lastSync)}` : 'First pull pending'}</dd>
        <dt>Order history</dt><dd>${sh.backfilled ? 'Last 60 days loaded, new orders added every 15 minutes' : 'Loads the last 60 days on the first pull'}</dd>
        <dt>Reads only</dt><dd>${scopes} · API ${esc(sh.apiVersion || '')}</dd></dl>
      <div class="toolbar"><button class="btn" id="shopify-sync">Pull from Shopify now</button></div></div>`;
  }

  /* ---------- generic sortable table ---------- */
  function table(id, cols, rows, empty) {
    const s = state.sort[id];
    if (s) {
      const col = cols.find((c) => c.k === s.k);
      const v = col?.val || ((r) => r[s.k]);
      rows = rows.slice().sort((a, b) => { const x = v(a), y = v(b); return (x > y ? 1 : x < y ? -1 : 0) * s.dir; });
    }
    if (!rows.length) return `<div class="tbl"><div class="empty">${esc(empty)}</div></div>`;
    return `<div class="tbl"><table data-table="${id}"><thead><tr>${cols.map((c) => `<th class="${c.r ? 'r' : ''}" data-k="${c.k}">${esc(c.label)}${s && s.k === c.k ? (s.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-id="${esc(r.id)}">${cols.map((c) => `<td class="${c.r ? 'r' : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  /* ---------- charts (SVG, to scale) ---------- */
  function dailyChart(daily) {
    const W = 1000, H = 280, L = 64, R = 10, T = 12, B = 34;
    const max = Math.max(1, ...daily.map((d) => d.sold + d.lost));
    const step = niceStep(max / 4); const top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const bw = (W - L - R) / daily.length;
    const every = Math.ceil(daily.length / 10);
    let g = '';
    for (let v = 0; v <= top + 1; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E4DCCD" stroke-width="1"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(money(v))}</text>`;
    daily.forEach((d, i) => {
      const x = L + i * bw + bw * 0.14, w = bw * 0.72;
      const ys = y(d.sold), yl = y(d.sold + d.lost);
      g += `<g><title>${dayLabel(d.day)}: sold ${moneyFull(d.sold)}, lost ${moneyFull(d.lost)}${d.outSkus ? ` · ${d.outSkus} product(s) out` : ''}</title>`
        + `<rect x="${x}" y="${ys}" width="${w}" height="${Math.max(0, y(0) - ys)}" rx="2" fill="#3E7C59"/>`
        + (d.lost > 0 ? `<rect x="${x}" y="${yl}" width="${w}" height="${Math.max(1, ys - yl)}" rx="2" fill="#D9623B"/>` : '') + '</g>';
      if (i % every === 0 || i === daily.length - 1) g += `<text x="${x + w / 2}" y="${H - 12}" text-anchor="middle">${dayLabel(d.day)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily sales and sales lost to stock-outs">${g}</svg>`;
  }
  function niceStep(x) { const p = 10 ** Math.floor(Math.log10(Math.max(1, x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  function stockChart(tl, from, to) {
    if (tl.length < 2) return '<p class="muted">No stock changes recorded in this period.</p>';
    const W = 680, H = 220, L = 46, R = 26, T = 10, B = 28;
    const max = Math.max(1, ...tl.map((p) => p.stock));
    const top = Math.ceil(max / niceStep(max / 4)) * niceStep(max / 4);
    const x = (t) => L + (W - L - R) * ((t - from) / (to - from));
    const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
    let path = `M${x(tl[0].t)},${y(tl[0].stock)}`, bands = '';
    for (let i = 1; i < tl.length; i++) {
      path += ` H${x(tl[i].t)} V${y(tl[i].stock)}`;
      if (tl[i - 1].stock <= 0) bands += `<rect x="${x(tl[i - 1].t)}" y="${T}" width="${Math.max(1, x(tl[i].t) - x(tl[i - 1].t))}" height="${H - T - B}" fill="#FBE7DD"/>`;
    }
    let ticks = '';
    for (let v = 0; v <= top; v += niceStep(max / 4)) ticks += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E4DCCD"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    const days = Math.round((to - from) / 864e5); let xl = '';
    for (let i = 0; i <= days; i += Math.max(1, Math.ceil(days / 6))) { const t = from + i * 864e5; const d = local(t); xl += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${d.getUTCDate()} ${MON[d.getUTCMonth()]}</text>`; }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stock over time; shaded = out of stock">${bands}${ticks}<path d="${path}" fill="none" stroke="#2B2A6B" stroke-width="2"/>${xl}</svg>`;
  }
  function unitsChart(rows) {
    const W = 680, H = 140, L = 46, R = 8, T = 8, B = 24;
    const max = Math.max(1, ...rows.map((r) => r.units));
    const bw = (W - L - R) / rows.length;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Units sold per day">${rows.map((r, i) => `<rect x="${L + i * bw + bw * 0.15}" y="${y(r.units)}" width="${bw * 0.7}" height="${Math.max(0, y(0) - y(r.units))}" rx="2" fill="#3E7C59"><title>${dayLabel(r.day)}: ${r.units} sold</title></rect>`).join('')}
      <text x="${L - 6}" y="${y(max) + 4}" text-anchor="end">${max}</text><text x="${L - 6}" y="${y(0)}" text-anchor="end">0</text></svg>`;
  }

  /* ---------- views ---------- */
  function overview() {
    const r = state.report, t = r.totals, top = r.products.filter((p) => p.lost > 0).slice(0, 7);
    const maxLost = Math.max(1, ...top.map((p) => p.lost));
    const hours = r.stockouts.reduce((s, e) => s + e.hours, 0);
    const outProducts = new Set(r.stockouts.map((s) => s.id)).size;
    const note = t.stockouts
      ? `In the last ${r.days} days, ${outProducts} selling products ran out of stock ${t.stockouts} times, for about ${Math.round(hours)} hours in total. That cost an estimated ${moneyFull(t.lost)} in sales (${t.lostPct}% of demand), demand the ads had already brought in. ${t.smallTopUps} times the shelf was refilled with less than ${state.settings.smallTopUpDays} days of stock, and ${t.repeats} times a product sold out again within a week.`
      : `No selling product ran out of stock in the last ${r.days} days.`;
    return `
      <section class="headline">
        <h1>${t.lost ? `Stock-outs cost <span class="lost">${money(t.lost)}</span> in the last ${r.days} days` : `No sales lost to stock-outs in the last ${r.days} days`}</h1>
        <p>${t.lost ? `That’s ${t.lostPct}% of demand: shoppers came, the product wasn’t there. ` : ''}Sold ${money(t.sold)} in the same period.</p>
      </section>
      <section class="tiles">
        <div class="tile sold"><b>${money(t.sold)}</b><span>sold</span></div>
        <div class="tile lost"><b>${money(t.lost)}</b><span>lost to stock-outs</span></div>
        <button class="tile lost" data-go="reorder" data-filter="Out now"><b>${t.outNow}</b><span>out of stock now</span></button>
        <button class="tile amber" data-go="reorder" data-filter="now"><b>${t.orderNow}</b><span>to order now</span></button>
        <button class="tile plum" data-go="stockouts" data-filter="small"><b>${t.smallTopUps}</b><span>small top-ups</span></button>
        <button class="tile plum" data-go="stockouts" data-filter="again"><b>${t.repeats}</b><span>out again within a week</span></button>
      </section>
      <section class="panel chart">
        <div class="panel-head"><h2>Sold vs lost to stock-outs, per day</h2><div class="legend"><span><i style="background:#3E7C59"></i>Sold</span><span><i style="background:#D9623B"></i>Lost to stock-outs</span></div></div>
        ${dailyChart(r.daily)}
      </section>
      <section class="grid2">
        <div class="panel"><div class="panel-head"><h2>Biggest losses</h2><a href="#products">All products</a></div>
          ${top.length ? `<div class="bars">${top.map((p) => `<div class="bar-row" data-product="${esc(p.id)}"><span class="name">${esc(p.name)}</span><span class="val">${money(p.lost)}</span><span class="track"><i style="width:${(p.lost / maxLost) * 100}%"></i></span></div>`).join('')}</div>` : '<p class="muted">Nothing lost in this period.</p>'}
        </div>
        <div class="panel"><div class="panel-head"><h2>Order today</h2><a href="#reorder">Full list</a></div>
          ${r.reorder.length ? `<div class="bars">${r.reorder.slice(0, 7).map((p) => `<div class="bar-row" data-product="${esc(p.id)}" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="name">${esc(p.name)}</span>${pill(p.status)}<span class="num" style="font-weight:700">${inr.format(p.orderQty)} pcs</span></div>`).join('')}</div>` : '<p class="muted">Nothing needs ordering right now.</p>'}
        </div>
      </section>
      <section class="note">
        <p>${esc(note)}</p>
        <div class="actions"><button class="btn light" id="copy-note">Copy for the client</button></div>
      </section>`;
  }

  function daysCell(p) {
    if (p.daysLeft == null) return p.stock <= 0 ? '<span class="st out">0</span>' : '–';
    const S = state.settings, warn = S.leadDays + S.safetyDays;
    const color = p.daysLeft <= 3 ? '#D9623B' : p.daysLeft <= warn ? '#B7791F' : '#2B2A6B';
    return `<span class="days"><span class="num">${n1(p.daysLeft)}</span><span class="meter"><i style="width:${Math.min(100, (p.daysLeft / (warn + 7)) * 100)}%;background:${color}"></i></span></span>`;
  }

  function reorder() {
    const r = state.report, f = state.filter.reorder, q = state.q.reorder.toLowerCase();
    const groups = [['all', 'All', r.reorder.length], ['Out now', 'Out now', r.totals.outNow], ['now', 'Critical + order now', r.totals.orderNow], ['Order this week', 'This week', r.totals.orderWeek]];
    const rows = r.reorder.filter((p) => (f === 'all' || (f === 'now' ? ['Critical', 'Order now'].includes(p.status) : p.status === f)) && (!q || `${p.name} ${p.sku}`.toLowerCase().includes(q)));
    const S = state.settings;
    return `
      <section class="headline"><h1>Reorder before they run out</h1>
        <p>Order quantity covers ${S.leadDays} days of lead time + ${S.coverDays} days after it lands + ${S.safetyDays} safety days, at each product’s in-stock sales rate. Change these in Data &amp; settings.</p></section>
      <div class="toolbar">${groups.map(([k, l, c]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-reorder="${esc(k)}">${l}<span class="c">${c}</span></button>`).join('')}
        <input class="search" id="q-reorder" placeholder="Search product or SKU" value="${esc(state.q.reorder)}">
        <a class="btn ghost" href="/api/export/reorder.csv?days=${state.days}">Download CSV</a></div>
      ${table('reorder', [
        { k: 'status', label: 'Status', f: (p) => pill(p.status), val: (p) => ['Out now', 'Critical', 'Order now', 'Order this week'].indexOf(p.status) },
        { k: 'name', label: 'Product', f: (p) => `${esc(p.name)}<span class="sub mono">${esc(p.sku)}</span>` },
        { k: 'stock', label: 'Stock', r: 1, f: (p) => inr.format(p.stock) },
        { k: 'perDay', label: 'Sells / day', r: 1, f: (p) => n1(p.perDay) },
        { k: 'daysLeft', label: 'Days left', f: daysCell, val: (p) => p.daysLeft ?? -1 },
        { k: 'orderQty', label: 'Order qty', r: 1, f: (p) => `<b>${inr.format(p.orderQty)}</b>` },
        { k: 'orderValue', label: 'Order value', r: 1, f: (p) => money(p.orderValue) },
        { k: 'lost', label: `Lost (${state.days} d)`, r: 1, f: (p) => (p.lost ? `<span style="color:#D9623B;font-weight:700">${money(p.lost)}</span>` : '–') },
        { k: 'outs', label: 'Stock-outs', r: 1 },
      ], rows, 'Nothing to order in this view.')}`;
  }

  function stockouts() {
    const r = state.report, f = state.filter.stockouts, q = state.q.stockouts.toLowerCase();
    const groups = [['all', 'All', r.stockouts.length], ['open', 'Still out', r.stockouts.filter((s) => s.open).length], ['small', 'Small top-up', r.totals.smallTopUps], ['again', 'Out again within a week', r.totals.repeats]];
    const rows = r.stockouts.filter((s) => (f === 'all' || (f === 'open' ? s.open : f === 'small' ? s.small : s.repeat)) && (!q || `${s.name} ${s.sku}`.toLowerCase().includes(q)))
      .map((s, i) => ({ ...s, key: i }));
    return `
      <section class="headline"><h1>Every stock-out, and what it cost</h1>
        <p>₹ lost = selling hours out of stock × the product’s normal sales per hour × its average selling price. Hours are weighted by when this store actually sells, so a night-time stock-out counts for less.</p></section>
      <div class="toolbar">${groups.map(([k, l, c]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter-stockouts="${k}">${l}<span class="c">${c}</span></button>`).join('')}
        <input class="search" id="q-stockouts" placeholder="Search product or SKU" value="${esc(state.q.stockouts)}"></div>
      ${table('stockouts', [
        { k: 'name', label: 'Product', f: (s) => `${esc(s.name)}<span class="sub mono">${esc(s.sku)}</span>` },
        { k: 'start', label: 'Went out', f: (s) => dt(s.start) },
        { k: 'end', label: 'Back in', f: (s) => (s.open ? '<span class="st open">Still out</span>' : dt(s.end)), val: (s) => s.end || Infinity },
        { k: 'hours', label: 'Out for', r: 1, f: (s) => dur(s.hours) },
        { k: 'unitsLost', label: 'Units lost', r: 1, f: (s) => n1(s.unitsLost) },
        { k: 'lost', label: '₹ lost', r: 1, f: (s) => `<b style="color:#D9623B">${money(s.lost)}</b>` },
        { k: 'topUp', label: 'Refilled with', r: 1, f: (s) => (s.topUp == null ? '–' : `${inr.format(s.topUp)} pcs<span class="sub">${n1(s.topUpDays)} days of sales</span>`), val: (s) => s.topUp ?? -1 },
        { k: 'flags', label: 'Pattern', f: (s) => [s.small ? '<span class="st small">Small top-up</span>' : '', s.repeat ? '<span class="st again">Out again within a week</span>' : ''].join(' ') || '–', val: (s) => (s.small ? 2 : 0) + (s.repeat ? 1 : 0) },
      ], rows.map((s) => ({ ...s, id: s.id })), 'No stock-outs in this view.')}`;
  }

  function products() {
    const r = state.report, q = state.q.products.toLowerCase();
    const rows = r.products.filter((p) => !q || `${p.name} ${p.sku}`.toLowerCase().includes(q));
    return `
      <section class="headline"><h1>Products</h1><p>Every product seen in stock changes or orders. Click one for its stock history.</p></section>
      <div class="toolbar"><input class="search" id="q-products" placeholder="Search product or SKU" value="${esc(state.q.products)}"></div>
      ${table('products', [
        { k: 'name', label: 'Product', f: (p) => `${esc(p.name)}<span class="sub mono">${esc(p.sku)}</span>` },
        { k: 'status', label: 'Status', f: (p) => pill(p.status) },
        { k: 'stock', label: 'Stock', r: 1, f: (p) => (p.stock == null ? '–' : inr.format(p.stock)) },
        { k: 'perDay', label: 'Sells / day', r: 1, f: (p) => n1(p.perDay) },
        { k: 'price', label: 'Avg price', r: 1, f: (p) => moneyFull(p.price) },
        { k: 'sold', label: `Sold (${state.days} d)`, r: 1, f: (p) => money(p.sold) },
        { k: 'lost', label: `Lost (${state.days} d)`, r: 1, f: (p) => (p.lost ? `<span style="color:#D9623B;font-weight:700">${money(p.lost)}</span>` : '–') },
        { k: 'outs', label: 'Stock-outs', r: 1 },
      ], rows, 'No products yet.')}`;
  }

  function dataView() {
    const s = state.settings, d = state.report.data, src = state.source;
    const base = location.origin;
    return `
      <section class="headline"><h1>Data &amp; settings</h1><p>Stock-out Watch needs two things from the store: every stock change and every order line. It reads them from Shopify (read-only), or from Shopify Flow, a Google Sheet or a CSV, with no Shopify key at all.</p></section>
      <section class="cards">
        ${shopifyPanel()}
        <div class="panel"><h2>Data now</h2>
          <dl class="kv"><dt>Source</dt><dd>${src.kind === 'demo' ? 'Demo data: Sammsara’s public product list, with invented stock and sales' : src.kind === 'live' ? 'Live store data' : 'Nothing yet'}</dd>
            <dt>Stock changes</dt><dd>${inr.format(d.stockRows)} ${d.firstStock ? `· ${dt(d.firstStock)} → ${dt(d.lastStock)}` : ''}</dd>
            <dt>Order lines</dt><dd>${inr.format(d.orderRows)} ${d.firstOrder ? `· ${dt(d.firstOrder)} → ${dt(d.lastOrder)}` : ''}</dd>
            <dt>Sheet sync</dt><dd>${src.err ? `<span style="color:#D9623B">${esc(src.err)}</span>` : src.lastSync ? dt(src.lastSync) : 'not set up'}</dd></dl>
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
      const d = await api(`/api/product/${encodeURIComponent(id)}?days=${state.days}`);
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
        <div class="panel"><h2>Stock-outs</h2>${d.stockouts.length ? `<div>${d.stockouts.map((s) => `<div class="ep"><span>${dt(s.start)} → ${s.open ? '<span class="st open">still out</span>' : dt(s.end)}</span><span class="muted">${dur(s.hours)}</span><b style="color:#D9623B">${money(s.lost)}</b>${s.topUp != null ? `<span>refilled ${s.topUp} pcs</span>` : ''}${s.small ? '<span class="st small">Small top-up</span>' : ''}${s.repeat ? '<span class="st again">Out again within a week</span>' : ''}</div>`).join('')}</div>` : '<p class="muted">None in this period.</p>'}</div>`;
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
    if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  }
  function route() { state.view = (location.hash || '#overview').slice(1) in VIEWS ? (location.hash || '#overview').slice(1) : 'overview'; render(); window.scrollTo(0, 0); }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-product], tr[data-id], th[data-k], [data-go]');
    if (!t) return;
    if (t.matches('.range button')) { state.days = +t.dataset.days; await load(); return; }
    if (t.dataset.go) { const v = t.dataset.go; state.filter[v] = t.dataset.filter; location.hash = v; return; }
    if (t.dataset.filterReorder) { state.filter.reorder = t.dataset.filterReorder; render(); return; }
    if (t.dataset.filterStockouts) { state.filter.stockouts = t.dataset.filterStockouts; render(); return; }
    if (t.matches('th[data-k]')) {
      const id = t.closest('table').dataset.table, k = t.dataset.k, s = state.sort[id];
      state.sort[id] = s && s.k === k ? { k, dir: -s.dir } : { k, dir: -1 }; render(); return;
    }
    if (t.dataset.product) { openProduct(t.dataset.product); return; }
    if (t.matches('tr[data-id]')) { openProduct(t.dataset.id); return; }
    if (t.id === 'drawer-close') { closeDrawer(); return; }
    if (t.id === 'copy-note') { copy($('.note p').textContent); return; }
    if (t.dataset.copy) { copy($(`#${t.dataset.copy}`).textContent); return; }
    try {
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
    const m = e.target.id && e.target.id.match(/^q-(reorder|stockouts|products)$/);
    if (m) { state.q[m[1]] = e.target.value; render._focus = e.target.id; render(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
  window.addEventListener('hashchange', route);

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); }
  }

  state.view = (location.hash || '#overview').slice(1);
  load().catch((e) => { $('#view').innerHTML = `<p class="pad">Couldn’t load: ${esc(e.message)}</p>`; });
})();
