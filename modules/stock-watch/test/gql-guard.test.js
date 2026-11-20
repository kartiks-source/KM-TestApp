'use strict';
/* SW-051: the read-only guard is a tokeniser. Comments, strings and block strings are whole tokens; every operation
 * must be a query (keyword `query` or the `{` shorthand). Tricky inputs below are ones a regex gets wrong. */
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/gql-guard');
const S = require('../src/shopify');

const ok = (doc, why) => assert.doesNotThrow(() => G.assertReadOnly(doc), why || doc);
const no = (doc, why) => assert.throws(() => G.assertReadOnly(doc), /only reads/, why || doc);

test('shopify.js uses the tokeniser guard', () => {
  assert.equal(S.assertReadOnly, G.assertReadOnly);
});

test('queries pass: named, anonymous, shorthand, variables with defaults, directives, fragments', () => {
  ok('query X { shop { name } }');
  ok('query { shop { name } }');
  ok('{ shop { name } }');
  ok('query X($q: String = "a", $n: Int = 5, $o: In = {a: [1, 2], b: "}"}) { orders(query: $q, first: $n) { nodes { id } } }');
  ok('query X @inContext(country: IN) { shop { name } }');
  ok('fragment F on Shop { name } query { shop { ...F } }');
  ok('query A { a } query B { b }', 'several queries');
  ok('﻿  query X { a }', 'byte order mark');
  ok('query X { a(n: -1.5e3, m: 0) }');
});

test('words inside strings, block strings and comments never count', () => {
  ok('query { a(q: "mutation { x }") }');
  ok('query { a(q: "tag:mutation subscription") }');
  ok('query { a } # mutation { x }');
  ok('# mutation M { x }\nquery { a }');
  ok('query { a(q: """ mutation { y } """) }');
  ok('query { a(q: """ x \\""" mutation { y } """) }', 'escaped triple quote inside a block string');
  ok('query { a(q: "escaped \\" quote mutation") }');
  ok('query { mutation subscription }', 'fields named like keywords');
});

test('mutations, subscriptions and anything else are refused', () => {
  no('mutation { productDelete(input:{id:"1"}) { deletedProductId } }');
  no('mutation{x}');
  no('# just reading\nmutation M { inventorySetQuantities(input:{}) { userErrors { message } } }');
  no('query A { shop { name } } mutation B { x }');
  no('query{a}mutation{b}', 'no white space');
  no('{ a } mutation { b }', 'after a shorthand');
  no('query { a }\n,mutation { b }', 'commas are ignored tokens');
  no('subscription { x }');
  no('fragment F on Shop { name }', 'a fragment alone has no query');
  no('fragment F on Shop { name } mutation { x }');
  no('schema { query: Q }'); no('extend type Shop { x: Int }'); no('type Q { a: Int }');
  no('MUTATION { x }', 'keywords are case-sensitive: anything not `query` is refused');
  no('garbage'); no(''); no('   # only a comment'); no('query X');
});

test('hiding tricks are refused: a # inside a string, unclosed strings, unbalanced brackets, stray tokens', () => {
  no('query { a(q: "#") } mutation { b }', 'the old regex dropped everything after a # inside a string');
  no('query { a(q: "x) } mutation { b }', 'unclosed string');
  no('query { a(q: """x) } mutation { b }', 'unclosed block string');
  no('query { a(q: "line\nbreak") }', 'a plain string can not span lines');
  no('query { a } }'); no('query { a'); no('query { a(b: [1) }');
  no('query Q mutation { x }', 'nothing may sit between the query header and its selection set');
  no('query Q ($a: Int) mutation { x }');
  no('fragment F Shop { a } query { a }', 'fragment without "on"');
  no('query { a } ; mutation { b }', 'unknown character');
  no('query { a } "mutation" { b }', 'a string can not start a definition');
});

test('tokens: strings and comments are single tokens', () => {
  assert.deepEqual(G.tokens('query { a(q: "x # y") } # c\n').map((t) => t.v), ['query', '{', 'a', '(', 'q', ':', 'x # y', ')', '}']);
  assert.deepEqual(G.tokens('{ ...F }').map((t) => t.v), ['{', '...', 'F', '}']);
});
