/* Stock-out Watch — Data page notices from the server (SW-055): capacity warnings (store size, rows, disk) and
 * "this copy only reads" when another copy holds the data folder. Nothing shows when all is well. */
(function (root) {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function banner(ops) {
    if (!ops) return '';
    const lines = [...(ops.readOnly ? [ops.readOnly] : []), ...(ops.warnings || []).map((w) => w.text)];
    if (!lines.length) return '';
    return `<section class="ops-warn" role="status"><b>${ops.readOnly ? 'Read-only' : 'Running out of room'}</b>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</section>`;
  }
  root.SW_OPS = { banner };
})(window);
