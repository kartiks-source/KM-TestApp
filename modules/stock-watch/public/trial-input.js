/* Stock-out Watch — number inputs that keep what you type (SW-057): Plan settings what-ifs on Reorder (data-what) and
 * Advanced planning rules on Data (data-setting). Typing never reformats the box or moves the caret; the value is read
 * when you leave the box or press Enter. Anything that isn't a number in range shows a hint under the box and changes
 * nothing. Valid → a 'sw:trial' event { key, value, el } that app.js turns into a what-if. Ranges = server.js LIMITS. */
(function (root) {
  'use strict';
  const LIM = { leadDays: [0, 180], coverDays: [1, 365], safetyDays: [0, 60], demandWindowDays: [7, 90], smallTopUpDays: [1, 60], minPerDay: [0, 100] };
  const raw = {};   // input id → the text as typed, until it is read (survives a re-render)

  /** "1,5" / " 7 " → { ok, value } or { ok: false, hint }. */
  function parse(text, key) {
    const s = String(text ?? '').trim().replace(',', '.');
    const [lo, hi] = LIM[key] || [-Infinity, Infinity];
    const range = `Enter a number from ${lo} to ${hi}`;
    if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) return { ok: false, hint: range };
    const v = Number(s);
    if (!Number.isFinite(v) || v < lo || v > hi) return { ok: false, hint: range };
    return { ok: true, value: v };
  }
  function showHint(el, msg) {
    const id = `${el.id}-hint`;
    let h = document.getElementById(id);
    if (!msg) { el.removeAttribute('aria-invalid'); if (h) h.remove(); return; }
    el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', id);
    if (!h) { h = document.createElement('small'); h.id = id; h.className = 'trial-hint'; h.setAttribute('role', 'alert'); (el.closest('.pf, .field') || el.parentElement).appendChild(h); }
    h.textContent = msg;
  }
  const isTrial = (el) => !!(el && el.matches && el.matches('input[data-trial]'));
  function commit(el) {
    if (!(el.id in raw)) return;   // not typed in since the last read
    const p = parse(el.value, el.dataset.trial);
    if (!p.ok) { showHint(el, p.hint); return; }
    delete raw[el.id]; showHint(el, '');
    el.dispatchEvent(new CustomEvent('sw:trial', { bubbles: true, detail: { key: el.dataset.trial, value: p.value, el } }));
  }
  document.addEventListener('input', (e) => { if (isTrial(e.target)) { raw[e.target.id] = e.target.value; if (e.target.hasAttribute('aria-invalid')) showHint(e.target, ''); } });
  document.addEventListener('focusout', (e) => { if (isTrial(e.target)) commit(e.target); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && isTrial(e.target)) { e.preventDefault(); commit(e.target); } });

  /** The typed text for an input id while it hasn't been read yet (app.js renders it instead of the saved value). */
  const typed = (id) => (Object.hasOwn(raw, id) ? raw[id] : undefined);
  const forget = (id) => { delete raw[id]; };
  root.SW_TRIAL = { parse, typed, forget, LIM };
})(window);
