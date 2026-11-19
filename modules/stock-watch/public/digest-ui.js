/* Stock-out Watch — morning digest in the page (SW-028). Loads before app.js.
 *  - Overview "Share" menu: Copy summary (app.js), Copy digest, Send on WhatsApp (wa.me link, no account needed).
 *  - Data & settings → "Morning digest": hour, roles, pause, send now, last sends. Webhook URLs are env only
 *    (DIGEST_WEBHOOK_URL, DIGEST_WEBHOOK_URL_<ROLE>); the page sees their host, never the URL.
 * The digest is for the role chosen in the store menu (public/roles.js), or everyone. Server: src/digest-service.js. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const role = () => (window.SW_ROLES && SW_ROLES.current()) || '';
  function toast(msg) { const t = $('#toast'); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }
  async function api(path, opt = {}) {
    const r = await fetch(path, { ...opt, headers: opt.body ? { 'content-type': 'application/json' } : {} });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    toast('Copied');
  }
  const wa = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;

  /* ---------- Overview share menu ---------- */
  let cached = null;   // { role, text, at }
  async function digestText() {
    if (cached && cached.role === role() && Date.now() - cached.at < 60e3) return cached.text;
    const j = await api(`/api/digest?role=${encodeURIComponent(role())}`);
    cached = { role: role(), text: j.text, at: Date.now() };
    return j.text;
  }
  /** The Share menu (replaces the Copy summary button: same one control on the screen). */
  const shareMenu = () => `<details class="colpick hbtn share" id="share"><summary class="btn ghost" title="Copy or send a plain-language summary">Share</summary><div class="menu">
      <button class="linkbtn" id="copy-summary">Copy summary</button>
      <button class="linkbtn" id="copy-digest">Copy morning digest</button>
      <a class="linkbtn" id="wa-digest" href="https://wa.me/" target="_blank" rel="noopener noreferrer">Send digest on WhatsApp</a></div></details>`;

  document.addEventListener('toggle', (e) => {
    if (e.target.id === 'share' && e.target.open) {
      digestText().then((t) => { const a = $('#wa-digest'); if (a) a.href = wa(t); }).catch((err) => toast(err.message));
    }
    if (e.target.id === 'digest-fold' && e.target.open) loadPanel();
  }, true);

  /* ---------- Data & settings panel ---------- */
  const panel = () => `<details class="panel fold" id="digest-fold"><summary><b>Morning digest</b> <span class="muted">a few lines per role each morning, to a webhook or WhatsApp</span></summary><div id="digest-body"><p class="muted">Loading…</p></div></details>`;
  const pad = (h) => `${String(h).padStart(2, '0')}:00`;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const when = (t, off) => { const d = new Date(t + (off || 0) * 60e3); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };   // store time, like the rest of the page
  function body(c) {
    const names = Object.fromEntries((window.SW_ROLES ? SW_ROLES.ORDER : []).map((r) => [r, SW_ROLES.ROLES[r].name]));
    const hook = c.webhook.set ? `<p class="muted">${c.webhook.host ? `Sent to ${esc(c.webhook.host)}` : 'Sent only to roles with their own webhook'} (set on the server). Each digest is POSTed as JSON: role, title, lines, link, text.</p>`
      : '<p class="muted">No webhook yet: ask whoever runs the server to set <span class="mono">DIGEST_WEBHOOK_URL</span> (one per role: <span class="mono">DIGEST_WEBHOOK_URL_CEO</span> …).</p>';
    const log = c.log.length ? `<ul class="dg-log">${c.log.slice(0, 5).map((l) => `<li><span class="muted">${esc(when(l.at, c.tzOffsetMin))}</span> ${esc(names[l.role] || 'Everyone')} · ${l.trigger === 'manual' ? 'sent by hand' : 'scheduled'} · ${l.ok ? `<span class="okv">sent</span>` : `<span class="lostv">failed: ${esc(l.error)}</span>`}${l.note ? ` <span class="muted">(${esc(l.note)})</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Nothing sent yet.</p>';
    return `<p class="muted">At the hour below (store time), after a fresh data pull, each ticked role gets its digest: 6 lines at most, with a link that opens their view. CEO and Finance get theirs on Mondays. Without a webhook, use Share → Copy or WhatsApp on the Overview.</p>
      <div class="form">${hook}
        <div class="field"><label for="dg-hour">Send at</label><select id="dg-hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === c.hour ? 'selected' : ''}>${pad(h)}</option>`).join('')}</select><small>Store time; a missed send still goes within 3 hours</small></div></div>
      <div class="dg-roles" role="group" aria-label="Who gets a digest">${c.scheduled.map((s) => `<label><input type="checkbox" data-dg-role="${esc(s.role)}" ${c.roles.includes(s.role) ? 'checked' : ''}> ${esc(s.name)} <span class="muted">${s.cadence === 'monday' ? 'Mondays' : 'daily'}${s.own ? ` · ${esc(s.host || 'own webhook')}` : ''}</span></label>`).join('')}</div>
      <label class="muted"><input type="checkbox" id="dg-paused" ${c.paused ? 'checked' : ''}> Pause sending</label>
      <div class="toolbar"><button class="btn" id="dg-save">Save</button>${c.webhook.set ? '<button class="btn ghost" id="dg-send">Send now</button>' : ''}</div>
      <h3 class="dg-h">Last sends</h3>${log}`;
  }
  async function loadPanel() {
    const el = $('#digest-body'); if (!el) return;
    try { el.innerHTML = body(await api('/api/digest/settings')); } catch (e) { el.innerHTML = `<p>Couldn’t load: ${esc(e.message)}</p>`; }
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest && e.target.closest('#copy-summary, #copy-digest, #wa-digest, #dg-save, #dg-send');
    if (!t) return;
    if (t.id === 'copy-summary') { t.closest('details')?.removeAttribute('open'); return; }   // app.js copies; close the Share menu
    try {
      if (t.id === 'copy-digest') { await copy(await digestText()); t.closest('details')?.removeAttribute('open'); }
      if (t.id === 'wa-digest' && !(cached && cached.role === role())) { e.preventDefault(); window.open(wa(await digestText()), '_blank', 'noopener'); }
      if (t.id === 'dg-save') {
        const patch = { hour: +$('#dg-hour').value, paused: $('#dg-paused').checked, roles: [...document.querySelectorAll('[data-dg-role]')].filter((i) => i.checked).map((i) => i.dataset.dgRole) };
        t.disabled = true;
        $('#digest-body').innerHTML = body(await api('/api/digest/settings', { method: 'PUT', body: JSON.stringify(patch) }));
        toast('Digest settings saved');
      }
      if (t.id === 'dg-send') {
        t.disabled = true; t.textContent = 'Sending…';
        const j = await api('/api/digest/send', { method: 'POST' }).catch((err) => ({ error: err.message }));
        toast(j.error ? `Not sent: ${j.error}` : `Sent ${j.sent.length} digest${j.sent.length === 1 ? '' : 's'}`);
        await loadPanel();
      }
    } catch (err) { toast(err.message); t.disabled = false; }
  });

  window.SW_DIGEST = { shareMenu, panel };
})();
