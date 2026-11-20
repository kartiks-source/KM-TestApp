'use strict';
/*
 * The read-only guard (SW-051, AGENTS.md rule 8): a GraphQL document may only read.
 *
 * A small tokeniser, not a regex: comments, strings and block strings are read as whole tokens, so a "#" or a
 * "mutation" inside a string, or a quote inside a comment, can't hide or fake anything. Then the document is
 * walked definition by definition. At the top level each definition must start with
 *   {          a shorthand query,
 *   query      a named or anonymous query,
 *   fragment   a fragment (only alongside at least one query);
 * anything else (mutation, subscription, schema / type definitions, a stray token) is refused, as is a document
 * that doesn't tokenise (unknown character, unclosed string, unbalanced brackets).
 * Reference: GraphQL spec, "Language" (lexical tokens, ignored tokens, document).
 */

const BLOCKED = 'Blocked: this app only reads from Shopify';
const blocked = (why) => Object.assign(new Error(`${BLOCKED} (${why})`), { readOnly: true });

const NAME_START = /[_A-Za-z]/;
const NAME_CHAR = /[_0-9A-Za-z]/;
const PUNCT = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

/** The document as tokens [{ t: 'name'|'punct'|'string'|'number', v }]. Comments, white space and commas are skipped. Throws on bad input. */
function tokens(doc) {
  const s = String(doc);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '﻿' || c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '"') {
      if (s.startsWith('"""', i)) {   // block string: ends at the first """ not escaped as \"""
        let j = i + 3;
        for (;;) {
          if (j >= s.length) throw blocked('unclosed block string');
          if (s.startsWith('\\"""', j)) { j += 4; continue; }
          if (s.startsWith('"""', j)) break;
          j++;
        }
        out.push({ t: 'string', v: s.slice(i + 3, j) }); i = j + 3; continue;
      }
      let j = i + 1;   // ordinary string: one line, \ escapes the next character
      for (;;) {
        if (j >= s.length || s[j] === '\n' || s[j] === '\r') throw blocked('unclosed string');
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '"') break;
        j++;
      }
      out.push({ t: 'string', v: s.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (s.startsWith('...', i)) { out.push({ t: 'punct', v: '...' }); i += 3; continue; }
    if (PUNCT.has(c)) { out.push({ t: 'punct', v: c }); i++; continue; }
    if (NAME_START.test(c)) { let j = i + 1; while (j < s.length && NAME_CHAR.test(s[j])) j++; out.push({ t: 'name', v: s.slice(i, j) }); i = j; continue; }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i, i + 64));
      if (!m) throw blocked('bad number');
      out.push({ t: 'number', v: m[0] }); i += m[0].length; continue;
    }
    throw blocked(`unexpected character ${JSON.stringify(c)}`);
  }
  return out;
}

const OPEN = { '{': '}', '(': ')', '[': ']' };
const CLOSE = new Set(['}', ')', ']']);

/**
 * The definitions in a document, as [{ kind: 'query'|'fragment'|<other keyword>, shorthand }]. The header of each
 * query and fragment is checked too (query: name? (variables)? @directives*; fragment: name on Type @directives*),
 * so nothing can sit between the keyword and the selection set. Throws when the brackets don't balance or a
 * definition has no selection set.
 */
function definitions(doc) {
  const tk = tokens(doc);
  const defs = [];
  let i = 0;
  const is = (t, v) => tk[i] && tk[i].t === t && (v === undefined || tk[i].v === v);
  /** From an opening bracket at tk[i], past its matching close. */
  function skipGroup() {
    const stack = [];
    for (; i < tk.length; i++) {
      const x = tk[i];
      if (x.t !== 'punct') continue;
      if (OPEN[x.v]) stack.push(OPEN[x.v]);
      else if (CLOSE.has(x.v)) {
        if (stack.pop() !== x.v) throw blocked('unbalanced brackets');
        if (!stack.length) { i++; return; }
      }
    }
    throw blocked('unbalanced brackets');
  }
  function directives() {
    while (is('punct', '@')) {
      i++;
      if (!is('name')) throw blocked('bad directive');
      i++;
      if (is('punct', '(')) skipGroup();
    }
  }
  while (i < tk.length) {
    const head = tk[i];
    if (head.t === 'punct' && head.v === '{') { defs.push({ kind: 'query', shorthand: true }); skipGroup(); continue; }
    if (head.t !== 'name') throw blocked(`a definition can't start with ${JSON.stringify(head.v)}`);
    defs.push({ kind: head.v, shorthand: false });
    if (head.v !== 'query' && head.v !== 'fragment') return defs;   // refused by the caller; no need to read further
    i++;
    if (head.v === 'query') {
      if (is('name')) i++;
      if (is('punct', '(')) skipGroup();
    } else {
      if (!is('name')) throw blocked('bad fragment');
      i++;
      if (!is('name', 'on')) throw blocked('bad fragment');
      i++;
      if (!is('name')) throw blocked('bad fragment');
      i++;
    }
    directives();
    if (!is('punct', '{')) throw blocked(`${head.v} without a selection set`);
    skipGroup();
  }
  return defs;
}

/** The read-only guard: throws unless every operation in `doc` is a query (keyword `query`, or none: shorthand). */
function assertReadOnly(doc) {
  const defs = definitions(doc);
  const bad = defs.find((d) => d.kind !== 'query' && d.kind !== 'fragment');
  if (bad) throw blocked(`${bad.kind} refused`);
  if (!defs.some((d) => d.kind === 'query')) throw blocked('no query in the document');
}

module.exports = { assertReadOnly, tokens, definitions, BLOCKED };
