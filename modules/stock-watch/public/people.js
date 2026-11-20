/* Stock-out Watch — Data → People (SW-062, ADR-0016). Loads before app.js.
 * Only the owner (main admin password) sees it: GET /api/people answers 403 to everyone else, and the panel stays hidden.
 * The owner gives a person their own password for one or more stores, as Admin (changes that store) or Viewer (sees only).
 * A password is shown once, right after it is made; the server keeps only a hash. Server: src/people.js. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let owner = null;   // null = not asked yet; true / false after GET /api/people
  let data = { people: [], stores: [], signIn: true };
  let editing = null;  // person id in the form, or null for a new one
  let shown = null;    // { name, password } just made: shown once
  let sure = null;     // person id whose Remove was clicked once

  function toast(msg) { const t = $('#toast'); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }
  async function api(path, opt = {}) {
    const r = await fetch(path, { ...opt, credentials: 'same-origin', headers: opt.body ? { 'content-type': 'application/json' } : {} });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || j.ok === false) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
    return j;
  }
  async function refresh() {
    try { data = await api('/api/people'); owner = true; } catch (e) { owner = e.status === 403 ? false : owner; if (owner !== false) toast(e.message); }
    draw();
  }

  const storeName = (id) => (data.stores.find((s) => s.id === id) || { name: id }).name;
  const ROLE = { admin: 'Admin', view: 'Viewer' };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (t) => { const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]}`; };

  function row(p) {
    return `<li data-person="${esc(p.id)}"><div class="pp-who"><b>${esc(p.name)}</b> <span class="pp-role">${ROLE[p.role]}</span>
        <span class="muted">${p.stores.map((s) => esc(storeName(s))).join(', ')} · ${p.lastSignInAt ? `last in ${day(p.lastSignInAt)}` : 'not signed in yet'}</span></div>
      <div class="pp-act"><button class="btn ghost xs" data-pp-edit="${esc(p.id)}">Edit</button><button class="btn ghost xs" data-pp-reset="${esc(p.id)}" title="Make a new password; the old one and its sign-ins stop working">New password</button><button class="btn ghost xs" data-pp-remove="${esc(p.id)}" title="Signs them out everywhere">${sure === p.id ? 'Sure? Remove' : 'Remove'}</button></div></li>`;
  }
  function form() {
    const p = editing ? data.people.find((x) => x.id === editing) : null;
    const st = p ? p.stores : data.stores.length === 1 ? [data.stores[0].id] : [];
    return `<div class="pp-form"><div class="form">
        <div class="field"><label for="pp-name">Name</label><input id="pp-name" maxlength="60" autocomplete="off" value="${esc(p ? p.name : '')}" placeholder="e.g. Asha (warehouse)"></div>
        <div class="field"><label for="pp-role">Can</label><select id="pp-role"><option value="view" ${!p || p.role === 'view' ? 'selected' : ''}>See only (Viewer)</option><option value="admin" ${p && p.role === 'admin' ? 'selected' : ''}>See and change settings (Admin)</option></select></div></div>
      <div class="pp-stores" role="group" aria-label="Stores">${data.stores.map((s) => `<label><input type="checkbox" data-pp-store="${esc(s.id)}" ${st.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')}</div>
      <div class="toolbar"><button class="btn" id="pp-save">${p ? 'Save' : 'Create password'}</button>${p ? '<button class="btn ghost" id="pp-cancel">Cancel</button>' : ''}</div></div>`;
  }
  function body() {
    if (!data.signIn) return '<p class="muted">Set <span class="mono">ADMIN_PASSWORD</span> on the server first: without it nobody signs in, so personal passwords would do nothing.</p>';
    const pw = shown ? `<div class="pp-pw" role="status"><p><b>Password for ${esc(shown.name)}</b> <span class="muted">shown once: copy it now and send it to them privately</span></p>
        <div class="toolbar"><span class="code mono" id="pp-pw">${esc(shown.password)}</span><button class="btn" id="pp-copy">Copy</button><button class="btn ghost" id="pp-done">Done</button></div></div>` : '';
    const list = data.people.length ? `<ul class="pp-list">${data.people.map(row).join('')}</ul>` : '<p class="muted">Nobody yet.</p>';
    return `<p class="muted">Give someone their own password for just their stores. The main passwords still open every store.</p>${pw}${list}
      <h3 class="dg-h">${editing ? 'Change access' : 'Add a person'}</h3>${form()}`;
  }
  function draw() {
    const el = $('#people-fold'); if (!el) return;
    el.hidden = owner !== true;
    const b = $('#people-body'); if (b && owner) b.innerHTML = body();
  }

  /** The Data page panel (app.js). Hidden until the server says this sign-in is the owner. */
  function panel() {
    if (owner === null) setTimeout(refresh, 0);
    else setTimeout(draw, 0);
    return `<details class="panel fold" id="people-fold" ${owner === true ? '' : 'hidden'}><summary><b>People</b> <span class="muted">who can open which store</span></summary><div id="people-body"><p class="muted">Loading…</p></div></details>`;
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest && e.target.closest('#pp-save, #pp-cancel, #pp-copy, #pp-done, [data-pp-edit], [data-pp-reset], [data-pp-remove]');
    if (!t) return;
    try {
      if (t.id === 'pp-copy') { const v = $('#pp-pw').textContent; try { await navigator.clipboard.writeText(v); } catch { const r = document.createRange(); r.selectNodeContents($('#pp-pw')); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); } toast('Copied'); return; }
      if (t.id === 'pp-done') { shown = null; return draw(); }
      if (t.id === 'pp-cancel') { editing = null; return draw(); }
      if (t.dataset.ppEdit) { editing = t.dataset.ppEdit; sure = null; draw(); $('#pp-name')?.focus(); return; }
      if (t.dataset.ppRemove) {
        const id = t.dataset.ppRemove;
        if (sure !== id) { sure = id; return draw(); }
        sure = null; t.disabled = true;
        await api(`/api/people/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (editing === id) editing = null;
        toast('Removed: they are signed out'); return refresh();
      }
      if (t.dataset.ppReset) {
        t.disabled = true;
        const j = await api(`/api/people/${encodeURIComponent(t.dataset.ppReset)}/reset`, { method: 'POST' });
        shown = { name: j.person.name, password: j.password }; return refresh();
      }
      if (t.id === 'pp-save') {
        const b = { name: $('#pp-name').value, role: $('#pp-role').value, stores: [...document.querySelectorAll('[data-pp-store]')].filter((i) => i.checked).map((i) => i.dataset.ppStore) };
        t.disabled = true;
        if (editing) { await api(`/api/people/${encodeURIComponent(editing)}`, { method: 'PUT', body: JSON.stringify(b) }); editing = null; toast('Saved'); }
        else { const j = await api('/api/people', { method: 'POST', body: JSON.stringify(b) }); shown = { name: j.person.name, password: j.password }; }
        return refresh();
      }
    } catch (err) { toast(err.message); t.disabled = false; }
  });

  window.SW_PEOPLE = { panel };
})();
