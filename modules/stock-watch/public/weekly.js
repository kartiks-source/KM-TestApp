/* Stock-out Watch — weekly review on the Overview (SW-043, LOGIC.md §5b). Loads before app.js.
 * One compact panel: this week vs last week for the headline numbers (from the daily snapshots, GET /api/review), each
 * with its change and an arrow, and the 5 products whose ₹ lost changed most (a click opens the product, app.js).
 * app.js calls SW_WEEKLY.panel() inside overview(); the numbers arrive once and are filled in place. */
(function () {
  'use strict';
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const money = (x) => { const v = Math.round(+x || 0), a = Math.abs(v); return a >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `₹${(v / 1e5).toFixed(2)} L` : `₹${inr.format(v)}`; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (k) => { const [, m, d] = String(k).split('-'); return `${+d} ${MON[+m - 1]}`; };
  const span = (a, b) => (a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8)}–${day(b)}` : `${day(a)} – ${day(b)}`);
  const url = (p) => (window.SW_STORES ? SW_STORES.url(p) : p);

  /* label, money?, what it means (tooltip) */
  const LABEL = {
    lost: ['Sales lost', true, 'Sales lost to stock-outs, added up over the 7 days'],
    lostProfit: ['Profit lost', true, 'Profit on those lost sales (needs unit costs), added up over the 7 days'],
    ranOut: ['Stock-outs', false, 'Times a product ran out of stock during the 7 days'],
    stillOut: ['Still out', false, 'Products out of stock at the end of the week'],
    excessValue: ['Overstock', true, 'Cash stuck in overstock at the end of the week'],
    toReorder: ['To reorder', false, 'Products to order today or this week, at the end of the week'],
    orderTodayValue: ['Order today', true, 'Cash for the Order today list at the end of the week'],
  };

  let data = null, key = '', at = 0, loading = null;
  const want = () => `${window.SW_STORES && SW_STORES.current ? SW_STORES.current() : ''}`;
  function fetchIt() {
    if (loading) return loading;
    const k = want();
    loading = fetch(url('/api/review'), { headers: {} }).then((r) => r.json()).then((j) => {
      if (j && j.ok) { data = j; key = k; at = Date.now(); fill(); }
    }).catch(() => { /* the panel stays hidden; the next Overview tries again */ }).finally(() => { loading = null; });
    return loading;
  }

  function delta(m, a, b) {
    if (b == null || a == null) return '<small class="wk-d muted">–</small>';
    const d = a - b;
    if (!d) return '<small class="wk-d muted">same</small>';
    const cls = !m.better ? 'n' : (m.better === 'down') === (d < 0) ? 'good' : 'bad';
    const pct = b ? `<span class="wk-p"> · ${d > 0 ? '+' : '−'}${inr.format(Math.round(Math.abs(d) / b * 100))}%</span>` : '';
    return `<small class="wk-d ${cls}"><span aria-hidden="true">${d > 0 ? '▲' : '▼'}</span> ${LABEL[m.k][1] ? money(Math.abs(d)) : inr.format(Math.abs(d))}${pct}</small>`;
  }
  function html(s) {
    if (!s || !s.ready) return '';
    const a = s.thisWeek, b = s.lastWeek;
    const shown = s.metrics.filter((m) => a[m.k] != null);
    const cells = shown.map((m) => {
      const [label, isMoney, tip] = LABEL[m.k], v = a[m.k], w = b ? b[m.k] : null;
      const pct = v != null && w ? ` (${v >= w ? '+' : '−'}${inr.format(Math.round(Math.abs(v - w) / w * 100))}%)` : '';
      return `<div class="wk-c" title="${esc(`${tip}. Last week: ${w == null ? 'no data' : isMoney ? money(w) : inr.format(w)}${pct}`)}"><span>${label}</span><b class="${m.k === 'lost' || m.k === 'lostProfit' ? 'lostv' : ''}">${isMoney ? money(v) : inr.format(v)}</b>${delta(m, v, w)}</div>`;
    }).join('');
    const movers = s.movers.length ? `<div class="wk-mv"><h3 class="mv-h">Sales lost changed most</h3>${s.movers.map((x) => `<div class="wk-row" data-product="${esc(x.id)}" tabindex="0" role="button" title="${esc(`${x.name}: ${money(x.now)} lost this week, ${money(x.before)} last week`)}"><span class="name">${esc(x.name)}</span><span class="num">${money(x.now)}</span><span class="wk-d ${x.change > 0 ? 'bad' : 'good'}"><span aria-hidden="true">${x.change > 0 ? '▲' : '▼'}</span> ${money(Math.abs(x.change))}</span></div>`).join('')}</div>` : '';
    const sub = b ? `${span(s.from, s.upTo)} vs ${span(s.prevFrom, s.prevTo)}` : `${span(s.from, s.upTo)} · last week: not enough history yet`;
    const part = s.days < 7 ? ` · ${s.days} of 7 days` : b && s.prevDays < 7 ? ` · last week ${s.prevDays} of 7 days` : '';
    return `<div class="panel-head"><h2>This week vs last week</h2><span class="muted small" title="Saved once a day, at store midnight: the 7 days up to yesterday vs the 7 before. ▲▼ = change; green = better, rose = worse">${esc(sub + part)}</span></div>
      <div class="wk-b"><div class="wk-g" style="--n:${shown.length}">${cells}</div>${movers}</div>`;
  }
  function fill() {
    const el = document.getElementById('weekly'); if (!el) return;
    const h = html(data);
    el.innerHTML = h; el.hidden = !h;
  }
  /** The panel for app.js overview(): the last numbers at once (same store, under 10 minutes old), else filled when they arrive. */
  function panel() {
    const fresh = data && key === want() && Date.now() - at < 10 * 60e3;
    if (!fresh) setTimeout(fetchIt, 0);
    const h = fresh || (data && key === want()) ? html(data) : '';
    return `<section class="panel weekly" id="weekly"${h ? '' : ' hidden'}>${h}</section>`;
  }

  window.SW_WEEKLY = { panel, html };
})();
