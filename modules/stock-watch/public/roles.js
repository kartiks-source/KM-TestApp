/* Stock-out Watch — role home views (SW-020). docs/RACI.md says what each role sees first; ADR-0006 says a
 * role view only REMOVES things from today's default screen, never adds. No role chosen = today's view.
 *
 * Runs in the browser (before app.js) and in Node (src/digest.js reads the names and digest cadence).
 * How it removes: one <style> built from the role's `hide` list, plus app.js asking hidesCol() for
 * table columns. The choice is remembered per browser (localStorage), set from the store menu, the
 * "Show me" field on Data & settings, or a link: /?role=ceo (or ?role=all to go back to everything).
 */
(function (root) {
  'use strict';

  /* What each hide key removes. Rail keys apply on every page; the rest on one page. */
  const PARTS = {
    'rail:overview': ['*', '#tabs a[data-view="overview"]'],
    'rail:reorder': ['*', '#tabs a[data-view="reorder"]'],
    'rail:stockouts': ['*', '#tabs a[data-view="stockouts"]'],
    'rail:products': ['*', '#tabs a[data-view="products"]'],
    range: ['*', '.top .range, .top .rlabel'],
    'head:order': ['overview', '#view > .headline h1 .h-order'],             /* RACI: the A's number leads the headline */
    'tile:lost': ['overview', '#view > .tiles.t4 > .tile[data-go="stockouts"]'],
    'tile:order': ['overview', '#view > .tiles.t4 > .tile[data-go="reorder"]'],
    'tile:bestrisk': ['overview', '#view > .tiles.t4 > .tile[data-filter="bestrisk"]'],
    'tile:over': ['overview', '#view > .tiles.t4 > .tile[data-filter="push"]'],   /* overstock tile → Products → Push these (critic r2 S1) */
    'list:today': ['overview', '#view > .grid2 > .panel:has(a[data-filter="today"])'],
    'list:losses': ['overview', '#view > .grid2 > .panel:has(a[data-filter="lost"])'],
    chart: ['overview', '#view > .panel.chart'],
    explain: ['reorder', '#view > .headline .exp'],
    plan: ['reorder', '#view > .plan'],
    'col:reorder:status': ['reorder', null],
    'col:reorder:orderValue': ['reorder', '#view .mcard .mq small'],          /* columns go via hidesCol(); the selector */
    'col:reorder:lost': ['reorder', '#view .mcard .mfacts .lostv'],          /* hides the same fact on phone cards     */
    /* Sprint 1 + Sprint 2 controls, removed per docs/RACI.md (integration) */
    mark: ['reorder', '#view .pick, #view .pick-sp, #view .mpick, #pick-all, #view > .bulk, #drawer .poform:not(.has-order), #drawer .poform .porow'],   /* Mark ordered (SW-012): ticks, bulk bar, drawer form; on-order facts stay */
    'tab:ordered': ['reorder', '#view [data-filter-reorder="ordered"]'],
    'chip:pause': ['products', '#view [data-filter-products="pause"]'],   /* SW-026 */
    'chip:push': ['products', '#view [data-filter-products="push"]'],
    'col:products:orderQty': ['products', null],
    'col:products:sold': ['products', null],
  };
  const TILES = ['tile:lost', 'tile:order', 'tile:bestrisk', 'tile:over'];

  /* Per docs/RACI.md "What each role sees first". home/filter = where the role lands; digest = how often
   * the morning digest goes to them (SW-028): 'daily', 'monday' or null (not pushed). */
  const ROLES = {
    ceo: {
      name: 'CEO', lands: 'Overview: sales lost, cash in overstock, daily chart', home: 'overview', digest: 'monday',
      hide: ['rail:reorder', 'head:order', 'tile:order', 'tile:bestrisk', 'list:today', 'list:losses', 'mark', 'tab:ordered'],   // Place the PO: –
    },
    founder: {
      name: 'Founder / COO', lands: 'Overview: order today, losses, best sellers, overstock', home: 'overview', digest: 'daily',
      hide: ['chart'],
    },
    ops: {
      name: 'Ops / inventory', lands: 'Reorder → Order today', home: 'reorder', filter: 'today', digest: 'daily',
      hide: ['rail:stockouts', 'explain', 'chart'],
    },
    buyer: {
      name: 'Buyer', lands: 'Reorder → Order today: quantities and order cost', home: 'reorder', filter: 'today', digest: null,
      hide: ['rail:overview', 'rail:stockouts', 'explain', 'plan', 'col:reorder:lost', 'chip:pause', 'chip:push'],   // Pause / push ads: –
    },
    marketing: {
      name: 'Marketing', lands: 'Products → Pause promotion: what not to promote', home: 'products', filter: 'pause', digest: 'daily',
      hide: ['rail:reorder', 'rail:stockouts', 'head:order', 'tile:order', 'list:today', 'col:products:orderQty', 'mark', 'tab:ordered'],   // Place the PO: I
    },
    finance: {
      name: 'Finance', lands: 'Overview: cash to order today, cash in overstock', home: 'overview', digest: 'monday',
      hide: ['rail:stockouts', 'tile:lost', 'tile:bestrisk', 'list:losses', 'chart', 'mark', 'chip:pause'],   // Place the PO: C (sees what's ordered, doesn't mark); ads: –
    },
    warehouse: {
      name: 'Warehouse', lands: 'Reorder → Ordered: what is due to land', home: 'reorder', filter: 'ordered', digest: null,
      hide: ['rail:overview', 'rail:stockouts', 'rail:products', 'range', 'explain', 'plan', 'col:reorder:orderValue', 'col:reorder:lost', 'mark'],   // receives; Place the PO: I
    },
  };
  const ORDER = Object.keys(ROLES);
  const KEY = 'sw-role';

  const valid = (r) => Object.prototype.hasOwnProperty.call(ROLES, r);
  const hides = (role, key) => valid(role) && ROLES[role].hide.includes(key);

  /** The CSS that removes a role's parts (empty for no role). Pure, so it can be tested. */
  function css(role) {
    if (!valid(role)) return '';
    const R = ROLES[role], sel = R.hide.map((k) => PARTS[k] && PARTS[k][1]).filter(Boolean);
    let out = sel.length ? `${sel.join(',\n')} { display: none !important; }\n` : '';
    const tiles = TILES.filter((k) => !R.hide.includes(k)).length;
    if (tiles < TILES.length) {
      out += `#view > .tiles.t4 { grid-template-columns: repeat(${tiles}, minmax(0, 1fr)); }\n`;
      out += `@media (max-width: 760px) { #view > .tiles.t4 { grid-template-columns: repeat(${Math.min(2, tiles)}, minmax(0, 1fr)); } }\n`;
      const kept = TILES.filter((k) => !R.hide.includes(k));
      if (kept.length > 1 && kept.length % 2) out += `@media (max-width: 760px) { ${PARTS[kept[kept.length - 1]][1]} { grid-column: 1 / -1; } }\n`;   // M7: no half-empty row on phones
    }
    if (R.hide.includes('head:order')) out += '#view > .headline h1 .h-lost { display: inline-block; }\n#view > .headline h1 .h-lost::first-letter { text-transform: uppercase; }\n';   // "Stock-outs cost …" leads
    const lists = ['list:today', 'list:losses'].filter((k) => R.hide.includes(k)).length;
    if (lists === 2) out += '#view > .grid2 { display: none; }\n';
    else if (lists === 1) out += '#view > .grid2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }\n#view > .grid2 > :last-child { grid-column: auto; }\n@media (max-width: 900px) { #view > .grid2 { grid-template-columns: minmax(0, 1fr); } }\n';   // one list + Moving (SW-021) side by side
    return out;
  }

  /** Where a role lands on first load. hash = location.hash without '#'. With no #page, or #<the role's home>
   *  (digest links: /?role=marketing#products), → { view, filter, setHash }; any other #page opens as asked → null. */
  function landing(role, hash) {
    if (!valid(role)) return null;
    const R = ROLES[role];
    if (hash && hash !== R.home) return null;
    return { view: R.home, filter: R.filter || null, setHash: !hash };
  }

  const API = { ROLES, ORDER, PARTS, valid, hides, css, landing };
  if (typeof module === 'object' && module.exports) module.exports = API;
  if (typeof document === 'undefined') return;

  /* ---------- browser ---------- */
  const read = () => { try { const r = localStorage.getItem(KEY) || ''; return valid(r) ? r : ''; } catch { return ''; } };
  const write = (r) => { try { if (valid(r)) localStorage.setItem(KEY, r); else localStorage.removeItem(KEY); } catch { /* private window: role lasts this page only */ } };
  let role = read();
  /* ?role=ceo link: remember it, then drop it from the address bar */
  const qs = new URLSearchParams(location.search);
  if (qs.has('role')) {
    role = valid(qs.get('role')) ? qs.get('role') : '';
    write(role);
    qs.delete('role');
    history.replaceState(null, '', location.pathname + (qs.toString() ? `?${qs}` : '') + location.hash);
  }
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function apply() {
    document.documentElement.dataset.role = role;
    let st = document.getElementById('role-css');
    if (!st) { st = document.createElement('style'); st.id = 'role-css'; document.head.appendChild(st); }
    st.textContent = css(role);
    const nm = document.getElementById('role-name');
    if (nm) nm.textContent = role ? ROLES[role].name : '';
    const menu = document.getElementById('role-menu');
    if (menu) {
      menu.innerHTML = '<p class="rp-h">Show me</p>' + ['', ...ORDER].map((r) => `<button class="linkbtn${r === role ? ' on' : ''}" data-role="${r}" aria-pressed="${r === role}"><b>${r ? esc(ROLES[r].name) : 'Everything'}</b><small>${r ? esc(ROLES[r].lands) : 'Every page, every number (default)'}</small></button>`).join('');
    }
  }
  function choose(r) {
    role = valid(r) ? r : '';
    write(role);
    location.replace(location.pathname + location.search);   // reload with no #page: start() lands on the role's home
  }

  Object.assign(API, {
    current: () => role,
    /** app.js: is this table column removed for the current role? */
    hidesCol: (table, k) => hides(role, `col:${table}:${k}`),
    /** app.js on start: land on the role's home page and tab (see landing()). */
    start(state) {
      const L = landing(role, location.hash.slice(1));
      if (!L) return;
      state.view = L.view;
      if (L.filter) state.filter[L.view] = L.filter;
      if (L.setHash) history.replaceState(null, '', '#' + L.view);
    },
    /** The "Show me" field on Data & settings (the store menu is hidden on phones). */
    field: () => `<div class="field"><label for="f-role">Show me</label><select id="f-role">${['', ...ORDER].map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${r ? esc(ROLES[r].name) : 'Everything (default)'}</option>`).join('')}</select><small>Remembered on this browser. Link for a role: /?role=ceo</small></div>`,
  });
  root.SW_ROLES = API;

  apply();
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('#role-menu [data-role]');
    if (b) { e.preventDefault(); choose(b.dataset.role); }
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'f-role') choose(e.target.value); });
})(typeof window !== 'undefined' ? window : globalThis);
