import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQuery } from '../server/query.js';

test('each word matches the start of a word', () => {
  assert.equal(parseQuery('king steph').match, '"king"* AND "steph"*');
});

test('quoted phrases are exact and minus excludes', () => {
  const q = parseQuery('"the stand" king -abridged');
  assert.equal(q.match, '("the stand" AND "king"*) NOT ("abridged"*)');
  assert.deepEqual(q.highlight, ['the stand', 'king']);
});

test('punctuation-only input and empty input give no query', () => {
  assert.equal(parseQuery(''), null);
  assert.equal(parseQuery('   '), null);
  assert.equal(parseQuery('--- !!! ""'), null);
  assert.equal(parseQuery('-onlyexcluded'), null);
});

test('quotes inside words cannot break out of the query', () => {
  assert.equal(parseQuery("o'callaghan").match, '"o\'callaghan"*');
  assert.equal(parseQuery('a"b').match, '"a b"*');
  assert.equal(parseQuery('"unclosed phrase').match, '"unclosed phrase"');
});
