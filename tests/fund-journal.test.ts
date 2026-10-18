import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/server/fund/journal.js';

const tmp = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'fund-journal-')), 'sub', 'j.jsonl');

test('a journal reads back what was written, chained, and carries on from where it ended', () => {
  const file = tmp();
  const j = new Journal<{ n: number }>(file);
  assert.deepEqual(j.read(), { entries: [], ok: true });
  j.append({ n: 1 });
  j.append({ n: 2 });
  const again = new Journal<{ n: number }>(file);
  assert.deepEqual(again.read(), { entries: [{ n: 1 }, { n: 2 }], ok: true });
  again.append({ n: 3 });
  assert.deepEqual(new Journal<{ n: number }>(file).read().entries, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('an edit anywhere is caught, at the line it was made', () => {
  const file = tmp();
  const j = new Journal<{ cash: number }>(file);
  j.read();
  for (const cash of [100, 200, 300]) j.append({ cash });
  const lines = readFileSync(file, 'utf8').split('\n');
  writeFileSync(file, [lines[0], lines[1].replace('"cash":200', '"cash":2000000'), ...lines.slice(2)].join('\n'));
  const r = new Journal<{ cash: number }>(file).read();
  assert.equal(r.ok, false);
  assert.match(r.problem!, /line 2 .* doesn't match the chain/);
  assert.deepEqual(r.entries, [{ cash: 100 }], 'what came before the edit still reads');
});

test('a line taken out, or one added by hand, breaks the chain too', () => {
  const file = tmp();
  const j = new Journal<{ n: number }>(file);
  j.read();
  for (const n of [1, 2, 3]) j.append({ n });
  const lines = readFileSync(file, 'utf8').split('\n');
  writeFileSync(file, [lines[0], lines[2], ''].join('\n'));
  assert.equal(new Journal(file).read().ok, false);
  writeFileSync(file, lines.join('\n'));
  appendFileSync(file, `${JSON.stringify({ n: 4, prev: 'x', hash: 'y' })}\n`);
  assert.equal(new Journal(file).read().ok, false);
});

test('a last line cut short when the office stopped is dropped and said so; damage elsewhere is not', () => {
  const file = tmp();
  const j = new Journal<{ n: number }>(file);
  j.read();
  j.append({ n: 1 });
  appendFileSync(file, '{"n":2,"pr');
  const r = new Journal<{ n: number }>(file).read();
  assert.equal(r.ok, true);
  assert.match(r.repaired!, /dropped line 2/);
  assert.deepEqual(r.entries, [{ n: 1 }]);
  const after = new Journal<{ n: number }>(file);
  after.read();
  after.append({ n: 2 });
  assert.deepEqual(new Journal<{ n: number }>(file).read(), { entries: [{ n: 1 }, { n: 2 }], ok: true });
  writeFileSync(file, `not json\n${readFileSync(file, 'utf8')}`);
  assert.equal(new Journal(file).read().ok, false);
});
