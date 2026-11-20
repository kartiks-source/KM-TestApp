'use strict';
/*
 * One-line JSON logs (SW-054): { time, level, msg, store, ...fields } per line, stdout for info, stderr for warn/error.
 * Every line is scrubbed of tokens (Shopify shpat_/shpca_/shppa_/shpss_, Bearer, X-Api-Key, password=) before it is
 * written, whatever wrote it: server.js calls captureConsole() at start, so console.* in any module lands here too.
 * Never log a query string, a cookie or a secret value; the boot line names which variables are set, not their values.
 */
const util = require('node:util');
const scope = require('./scope');

const RULES = [
  [/\b(shp(?:at|ca|pa|ss)_)[A-Za-z0-9]+/g, '$1***'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***'],
  [/(x-api-key\\?["']?\s*[:=]\s*\\?["']?\s*)[A-Za-z0-9._~+/%-]{4,}/gi, '$1***'],
  [/(\b(?:password|access_token|client_secret|api_key|ingestKey|key)=)[A-Za-z0-9._~+/%-]{4,}/gi, '$1***'],
];
/** The text with every token pattern replaced by ***. */
function scrub(s) { let out = String(s); for (const [re, to] of RULES) out = out.replace(re, to); return out; }

let sink = { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') };
const raw = { log: console.log, warn: console.warn, error: console.error };

/** One JSON line. store = the current store (scope.run) unless fields name one. */
function line(level, msg, fields = {}) {
  const rec = { time: new Date().toISOString(), level, msg: String(msg) };
  const store = fields.store !== undefined ? fields.store : scope.current();
  if (store) rec.store = store;
  for (const [k, v] of Object.entries(fields)) if (k !== 'store' && v !== undefined) rec[k] = v instanceof Error ? v.message : v;
  let text;
  try { text = JSON.stringify(rec); } catch { text = JSON.stringify({ time: rec.time, level, msg: rec.msg, store: rec.store }); }
  return scrub(text);
}
function write(level, msg, fields) {
  const l = line(level, msg, fields);
  (level === 'info' ? sink.out : sink.err)(l);
  return l;
}
const info = (msg, fields) => write('info', msg, fields);
const warn = (msg, fields) => write('warn', msg, fields);
const error = (msg, fields) => write('error', msg, fields);

/** console.log / warn / error → JSON lines (an Error argument adds its stack). */
function fromArgs(level, args) {
  const errs = args.filter((a) => a instanceof Error);
  const msg = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : util.inspect(a, { depth: 3, breakLength: Infinity }))).join(' ');
  return write(level, msg, errs.length ? { stack: errs[0].stack } : {});
}
function captureConsole() {
  console.log = (...a) => fromArgs('info', a);
  console.info = console.log;
  console.warn = (...a) => fromArgs('warn', a);
  console.error = (...a) => fromArgs('error', a);
}
function releaseConsole() { Object.assign(console, raw); console.info = raw.log; }

/** Tests: send lines to fn(level, line) instead of stdout/stderr. */
function useSink(fn) { sink = fn ? { out: (l) => fn('info', l), err: (l) => fn('err', l) } : { out: (l) => process.stdout.write(l + '\n'), err: (l) => process.stderr.write(l + '\n') }; }

/** Which of `names` are set (non-empty) in env: { NAME: true|false }. Never a value. */
function setVars(names, env = process.env) { return Object.fromEntries(names.map((n) => [n, !!(env[n] && String(env[n]).trim())])); }

module.exports = { scrub, line, info, warn, error, captureConsole, releaseConsole, useSink, setVars };
