import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The fund's six layers (docs/fund.md, "How it's built") and what each may import, read from the
// source: the 3D UI, the agent runtime, the hedge-fund services, market data, portfolio and risk, and
// persistence. A change that crosses a line fails here, not in review.

const ROOT = path.resolve(import.meta.dirname, '..');

function files(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(ROOT, rel)).isDirectory() ? files(rel) : /\.ts$/.test(name) ? [rel] : [];
  });
}

/** Every relative import (and re-export) of a file, as repo paths without an extension; and the node builtins it uses. */
function imports(file: string): { local: string[]; builtin: string[]; packages: string[] } {
  const src = readFileSync(path.join(ROOT, file), 'utf8');
  const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s(?:[^;'"]*?\sfrom\s)?'([^']+)'/g), ...src.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  const local: string[] = [];
  const builtin: string[] = [];
  const packages: string[] = [];
  for (const s of specs) {
    if (s.startsWith('.')) local.push(path.posix.join(path.posix.dirname(file), s).replace(/\.js$/, ''));
    else if (s.startsWith('node:')) builtin.push(s);
    else packages.push(s);
  }
  return { local, builtin, packages };
}

const under = (...prefixes: string[]) => (p: string) => prefixes.some((x) => p === x || p.startsWith(`${x}/`));
const named = (...names: string[]) => (p: string) => names.includes(p);

const LAYERS = {
  ui: files('src/client'),
  runtime: [...files('src/server/workers'), ...files('src/server/providers')],
  services: [
    ...['fund', 'desks', 'committee', 'strategies', 'research', 'office'].map((n) => `src/server/fund/${n}.ts`),
    ...files('src/server/hooks').filter((f) => /\/fund[^/]*\.ts$/.test(f)),
    ...files('src/server/ws/handlers').filter((f) => /\/fund[^/]*\.ts$/.test(f)),
  ],
  market: [...files('src/server/fund/market'), 'src/server/fund/history.ts'],
  portfolioRisk: [...files('src/shared/fund'), 'src/server/fund/venue.ts', 'src/server/fund/exits.ts'],
  persistence: ['src/server/fund/journal.ts', 'src/server/fund/records.ts'],
};
const noExt = (f: string) => f.replace(/\.ts$/, '');

/** Fails, naming each file and import, where a file in `group` imports something `allowed` doesn't. */
function only(group: string[], allowed: (p: string) => boolean, what: string) {
  const bad = group.flatMap((f) => imports(f).local.filter((p) => !allowed(p)).map((p) => `${f} → ${p}`));
  assert.deepEqual(bad, [], `${what}:\n${bad.join('\n')}`);
}

test('every fund file is in exactly one layer', () => {
  const all = Object.values(LAYERS).flat();
  for (const f of all) assert.ok(statSync(path.join(ROOT, f)).isFile(), f);
  assert.equal(new Set(all).size, all.length, 'no file is in two layers');
  const fund = [...files('src/server/fund'), ...files('src/shared/fund')];
  assert.deepEqual(fund.filter((f) => !all.includes(f)), [], 'a new fund file needs a layer here');
});

test('portfolio and risk: the shared domain is pure, and risk is deterministic code', () => {
  const shared = files('src/shared/fund');
  only(shared, under('src/shared'), 'shared/fund imports only shared code');
  for (const f of shared) {
    const i = imports(f);
    assert.deepEqual([...i.builtin, ...i.packages], [], `${f} needs no node builtins or packages: it runs in the browser too`);
  }
  // The arithmetic the book, the position history and the risk engine run on: no clock, no dice,
  // no network and no model, so the same book and the same trade always get the same answer.
  for (const f of ['book', 'risk', 'positions', 'proposals', 'committee'].map((n) => `src/shared/fund/${n}.ts`)) {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    for (const banned of [/Date\.now\(/, /new Date\(\)/, /Math\.random\(/, /\bfetch\(/, /anthropic|openai|claude/i]) assert.doesNotMatch(src, banned, `${f}: ${banned}`);
  }
  only(['src/server/fund/venue.ts'], under('src/shared/fund'), 'the paper venue fills from a quote, and knows nothing else');
  only(['src/server/fund/exits.ts'], (p) => under('src/shared/fund')(p) || named('src/server/fund/venue', 'src/server/fund/records', 'src/server/fund/market/index')(p), 'exits reach only the venue, the records and the prices');
});

test('market data: one layer every desk, the risk engine and every screen read, depending on nothing above it', () => {
  only(LAYERS.market, under('src/shared/fund', 'src/server/fund/market'), 'market data imports only the shared domain and itself');
});

test('persistence: the journals know nothing of the fund around them', () => {
  assert.deepEqual(imports('src/server/fund/journal.ts').local, [], 'the hash-chained journal is generic');
  only(['src/server/fund/records.ts'], (p) => under('src/shared/fund')(p) || p === 'src/server/fund/journal', 'records replay the journals through the shared book arithmetic, nothing more');
});

test('the services: the fund knows the office only through one seam, and never the agent runtime', () => {
  const serverFund = files('src/server/fund');
  only(serverFund.filter((f) => f !== 'src/server/fund/office.ts'), under('src/shared', 'src/server/fund'), 'server/fund imports only shared code and itself');
  only(['src/server/fund/office.ts'], (p) => under('src/shared', 'src/server/fund')(p) || p === 'src/server/office/context', 'office.ts is the one seam to the office');
  assert.match(readFileSync(path.join(ROOT, 'src/server/fund/office.ts'), 'utf8'), /import type \{ Ctx \} from '\.\.\/office\/context\.js'/, 'and it only needs the office’s type');
  // Only the fund's services write the ledger: the hooks agents call and the dashboards' handlers ask the fund, they never write money.
  const writers = files('src').filter((f) => /ledger\.append\(/.test(readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(writers.sort(), ['src/server/fund/exits.ts', 'src/server/fund/fund.ts']);
});

test('the agent runtime runs any agent and knows nothing of the fund; the 3D UI never reaches into the server', () => {
  const fundCode = (p: string) => under('src/server/fund', 'src/shared/fund')(p) || /^src\/server\/(hooks|ws\/handlers)\/fund/.test(p);
  const bad = LAYERS.runtime.flatMap((f) => imports(f).local.filter(fundCode).map((p) => `${f} → ${p}`));
  assert.deepEqual(bad, [], `the agent runtime imports no fund code:\n${bad.join('\n')}`);
  only(LAYERS.ui, (p) => !under('src/server')(p), 'the client imports nothing from the server');
  // And the fund's own screens read the fund's state: nothing in the client imports a fund service either.
  assert.ok(LAYERS.ui.some((f) => f.startsWith('src/client/features/fund/')));
  assert.ok(LAYERS.services.map(noExt).every((s) => !LAYERS.ui.some((f) => imports(f).local.includes(s))));
});
