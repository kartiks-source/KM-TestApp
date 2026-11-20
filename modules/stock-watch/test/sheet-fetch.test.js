'use strict';
/* SW-052: Sheet sync follows redirects by hand (≤ 3), only to https docs.google.com / *.googleusercontent.com, caps the
 * body at 20 MB and gives up after 20 s. fetch is replaced by a fake that records every address it was asked for. */
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/sheet-fetch');

const LINK = 'https://docs.google.com/spreadsheets/d/e/abc/pub?gid=1&output=csv';
const CDN = 'https://doc-0s-1c-sheets.googleusercontent.com/pub/abc?gid=1';
const go = (to, status = 307) => new Response(null, { status, headers: { location: to } });
/** A fake fetch: answers[i] for the i-th call (a Response or a function of (url, opt)). */
function fake(...answers) {
  const calls = [];
  const f = async (url, opt) => { calls.push({ url, opt }); const a = answers[calls.length - 1]; if (!a) throw new Error('unexpected call'); return typeof a === 'function' ? a(url, opt) : a; };
  f.calls = calls;
  return f;
}

test('limits are the agreed ones', () => {
  assert.equal(F.MAX_REDIRECTS, 3); assert.equal(F.MAX_BYTES, 20 * 1024 * 1024); assert.equal(F.TIMEOUT_MS, 20000);
});

test('a plain link: one call, redirect manual, the text back', async () => {
  const f = fake(new Response('Time,Variant ID\n'));
  assert.equal(await F.sheetText(LINK, { fetchImpl: f }), 'Time,Variant ID\n');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opt.redirect, 'manual', 'redirects are never followed by fetch itself');
  assert.ok(f.calls[0].opt.signal, 'one time limit');
});

test('Google’s redirect to googleusercontent.com is followed (relative and absolute), up to 3', async () => {
  const f = fake(go(CDN, 302), go('/pub/abc?gid=1&x=1', 307), go('https://docs.google.com/again', 301), new Response('ok'));
  assert.equal(await F.sheetText(LINK, { fetchImpl: f }), 'ok');
  assert.deepEqual(f.calls.map((c) => c.url), [LINK, CDN, 'https://doc-0s-1c-sheets.googleusercontent.com/pub/abc?gid=1&x=1', 'https://docs.google.com/again']);
  assert.ok(f.calls.every((c) => c.opt.signal === f.calls[0].opt.signal), 'the same 20 s budget across every hop');
});

test('a 4th redirect is refused', async () => {
  const f = fake(go(CDN), go(CDN), go(CDN), go(CDN), new Response('never'));
  await assert.rejects(F.sheetText(LINK, { fetchImpl: f }), /more than 3 redirects/);
  assert.equal(f.calls.length, 4);
});

test('redirects off Google, to http, to a look-alike host, with a password or a port are refused before any call', async () => {
  for (const [to, why] of [
    ['https://evil.example.com/x.csv', /redirected to evil\.example\.com, which isn’t Google/],
    ['http://doc-0s.googleusercontent.com/x', /only https/],
    ['https://googleusercontent.com.evil.io/x', /isn’t Google/],
    ['https://evilgoogleusercontent.com/x', /isn’t Google/],
    ['https://.googleusercontent.com/x', /bad address|isn’t Google/],
    ['https://user:pw@docs.google.com/x', /user name or password/],
    ['https://docs.google.com:8443/x', /port/],
    ['https://169.254.169.254/latest/meta-data', /isn’t Google/],
    ['file:///etc/passwd', /only https/],
  ]) {
    const f = fake(go(to));
    await assert.rejects(F.sheetText(LINK, { fetchImpl: f }), why, to);
    assert.equal(f.calls.length, 1, `${to}: never fetched`);
  }
});

test('a redirect without a Location, and a 404, are plain errors', async () => {
  await assert.rejects(F.sheetText(LINK, { fetchImpl: fake(new Response(null, { status: 302 })) }), /HTTP 302 without a new address/);
  await assert.rejects(F.sheetText(LINK, { fetchImpl: fake(new Response('no', { status: 404 })) }), /^Error: HTTP 404$/);
});

test('the typed link must be https://docs.google.com (googleusercontent only as a redirect)', async () => {
  for (const bad of ['http://docs.google.com/x', CDN, 'https://example.com/x.csv', 'not a link', '', 'https://docs.google.com.evil.io/x']) {
    const f = fake(new Response('x'));
    await assert.rejects(F.sheetText(bad, { fetchImpl: f }), /Publish to web|only https/, bad);
    assert.equal(f.calls.length, 0);
  }
});

test('body cap: Content-Length over the cap is refused before reading; a streamed body is cut at the cap', async () => {
  let pulled = 0;
  const big = new Response('x'.repeat(50), { headers: { 'content-length': '50' } });
  await assert.rejects(F.sheetText(LINK, { fetchImpl: fake(big), maxBytes: 40 }), /over 0 MB|over/);
  const stream = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(16).fill(65)); if (pulled > 100) c.close(); } });
  await assert.rejects(F.sheetText(LINK, { fetchImpl: fake(new Response(stream)), maxBytes: 40 }), /over/);
  assert.ok(pulled <= 5, `stopped reading early (${pulled} chunks)`);
  assert.equal(await F.sheetText(LINK, { fetchImpl: fake(new Response('y'.repeat(40))), maxBytes: 40 }), 'y'.repeat(40), 'exactly the cap is fine');
});

test('timeout: no answer within the limit → plain error', async () => {
  const hang = (url, opt) => new Promise((_, reject) => opt.signal.addEventListener('abort', () => reject(opt.signal.reason)));
  const t0 = Date.now();
  await assert.rejects(F.sheetText(LINK, { fetchImpl: fake(hang), timeoutMs: 80 }), /no answer within 0 s|no answer within/);
  assert.ok(Date.now() - t0 < 2000);
  const slowBody = () => new Response(new ReadableStream({ start() { /* never sends */ } }));
  await assert.rejects(F.sheetText(LINK, { fetchImpl: fake(slowBody), timeoutMs: 80 }), /no answer within/, 'a body that never ends times out too');
});

test('errors never carry the link (it is a read key to the Sheet)', async () => {
  const errs = [];
  for (const f of [fake(go('https://evil.example.com/' + 'k'.repeat(10))), fake(new Response('', { status: 500 }))]) {
    try { await F.sheetText(LINK, { fetchImpl: f }); } catch (e) { errs.push(e.message); }
  }
  assert.equal(errs.length, 2);
  for (const m of errs) assert.ok(!m.includes('abc') && !m.includes('kkkk'), m);
});
