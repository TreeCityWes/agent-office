import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Fund } from '../src/server/fund/fund.js';
import type { PriceAdapter } from '../src/server/fund/market/types.js';
import type { Actor, Proposal } from '../src/shared/fund/types.js';

const START = Date.UTC(2026, 9, 1, 15);
const wes: Actor = { kind: 'user', id: 'wes', name: 'Wes' };
const ada: Actor = { kind: 'agent', id: 'w1', name: 'Ada', role: 'crypto-trader' };
const cio: Actor = { kind: 'agent', id: 'w2', name: 'Grace', role: 'cio' };
const bob: Actor = { kind: 'agent', id: 'w3', name: 'Bob', role: 'backtester' };
const idea = { symbol: 'BTC', side: 'long', sizeUsd: 50_000, stop: 95_000, target: 120_000, thesis: 'ETF inflows and a funding reset point higher.', confidence: 70, horizon: '2w', evidence: ['ETF inflows 5 days running'] };

/** A fund in a fresh folder, on a test price source whose prices and clock the test sets. */
function setup(opts: { hasRuler?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? path.join(mkdtempSync(path.join(os.tmpdir(), 'fund-')), 'fund');
  const prices = new Map<string, number>([['BTC', 100_000], ['ETH', 4_000], ['NVDA', 150]]);
  const clock = { now: START };
  const source: PriceAdapter = {
    id: 'mock',
    label: 'Test prices',
    everyMs: 60_000,
    mock: true,
    quotes: async (ls) => ls.filter((l) => prices.has(l.symbol)).map((l) => ({ symbol: l.symbol, price: prices.get(l.symbol)!, volumeUsd: 1e10, at: clock.now, source: 'test' })),
  };
  const fund = new Fund({ dir, now: () => clock.now, hasRuler: () => !!opts.hasRuler, marketAdapters: () => ({ prices: [source], signals: [] }) });
  /** New prices, as if the source had just been asked; stops and targets are checked on them. */
  const tick = async (set: Record<string, number> = {}) => {
    for (const [s, p] of Object.entries(set)) prices.set(s, p);
    await fund.market.refreshAll();
    await fund.serial(() => {});
  };
  return { fund, dir, prices, clock, tick };
}

const ok = <T extends object>(r: ({ ok: true } & T) | { error: string }): T => {
  if ('error' in r) assert.fail(r.error);
  return r;
};

test('an unused fund leaves nothing on disk and asks nobody for prices', async () => {
  const { fund, dir } = setup();
  fund.tick();
  assert.equal(existsSync(dir), false);
  assert.equal(fund.market.polling(), false);
  assert.equal(fund.state().portfolio.nav, 1_000_000);
  assert.equal(fund.state().paper, true);
});

test('a proposal goes through risk to a person, fills on paper when approved, and stops out on its own', async () => {
  const { fund, dir, tick } = setup();
  await tick();
  const { proposal } = ok(await fund.propose(idea, ada));
  assert.equal(proposal.id, 'P-1');
  assert.equal(proposal.stage, 'user_approval');
  assert.equal(proposal.risk!.decision, 'approved');
  assert.deepEqual(proposal.history.map((h) => h.stage), ['proposed', 'risk_review', 'user_approval']);

  // Only a person approves.
  assert.match((await fund.approve('P-1', undefined, ada) as { error: string }).error, /Only a person/);
  const filled = ok(await fund.approve('p-1', 'go', wes)).proposal;
  assert.equal(filled.stage, 'monitoring');
  // Slippage of 5 bp against the buy, sized so the fill is the $50,000 risk allowed, and a 5 bp fee.
  assert.equal(filled.entryPrice, 100_050);
  assert.ok(Math.abs(filled.qty! * filled.entryPrice! - 50_000) < 1e-4);
  assert.ok(Math.abs(filled.fees! - 25) < 1e-4);
  const p = fund.portfolio();
  assert.equal(p.positions[0].qty, filled.qty);
  assert.ok(Math.abs(p.cash - (1_000_000 - 50_000 - 25)) < 1e-3);

  await tick({ BTC: 94_000 });
  const out = fund.proposals.get('P-1')!;
  assert.equal(out.stage, 'exited');
  assert.equal(out.history.at(-1)!.note, 'Stop 95,000.00 hit');
  assert.ok(out.pnl! < -2_900 && out.pnl! > -3_100, String(out.pnl));
  assert.equal(fund.portfolio().positions.length, 0);
  // Reviewed afterwards.
  ok(await fund.review('P-1', { thesisHeld: false, lessons: 'Funding was still too hot to buy into.' }, ada));
  assert.equal(fund.proposals.get('P-1')!.stage, 'reviewed');

  // The records replay to the same book.
  const again = new Fund({ dir, marketAdapters: () => ({ prices: [], signals: [] }) });
  assert.equal(again.ledger.book.cash, fund.ledger.book.cash);
  assert.equal(again.proposals.get('P-1')!.stage, 'reviewed');
  assert.deepEqual(readdirSync(dir).sort(), ['activity.jsonl', 'ledger.jsonl', 'nav.jsonl', 'proposals.jsonl']);
  const kinds = fund.activity.list().map((e) => e.kind);
  for (const k of ['proposal', 'risk', 'ruling', 'fill', 'exit', 'review']) assert.ok(kinds.includes(k as never), k);
});

test('risk rejects what breaks a hard rule, and resizes what is too big, before anyone sees it', async () => {
  const { fund, tick } = setup();
  await tick();
  const noStop = ok(await fund.propose({ ...idea, stop: undefined }, ada)).proposal;
  assert.equal(noStop.stage, 'rejected');
  assert.match(noStop.history.at(-1)!.note!, /stop/i);
  const big = ok(await fund.propose({ ...idea, sizeUsd: 400_000 }, ada)).proposal;
  assert.equal(big.risk!.decision, 'resized');
  assert.equal(big.stage, 'user_approval');
  const filled = ok(await fund.approve(big.id, undefined, wes)).proposal;
  assert.ok(Math.abs(filled.qty! * filled.entryPrice! - big.risk!.approvedUsd) < 1, 'filled at the size risk allowed, not the size asked');
});

test('risk runs again at approval: a proposal that no longer fits is rejected, not filled', async () => {
  const { fund, tick } = setup();
  await tick();
  const first = ok(await fund.propose(idea, ada)).proposal;
  const second = ok(await fund.propose(idea, ada)).proposal;
  ok(await fund.setLimits({ maxPositionPct: 5 }, wes));
  ok(await fund.approve(first.id, undefined, wes));
  const r = await fund.approve(second.id, undefined, wes);
  assert.ok('error' in r);
  assert.equal(fund.proposals.get(second.id)!.stage, 'rejected');
  assert.equal(fund.ledger.fills.length, 1);
});

test('with a CIO at a desk, proposals go to them first; they rule, but never on their own, and never approve', async () => {
  const { fund, tick } = setup({ hasRuler: true });
  await tick();
  const p = ok(await fund.propose(idea, ada)).proposal;
  assert.equal(p.stage, 'cio_review');
  assert.match((await fund.rule(p.id, 'approve', undefined, bob) as { error: string }).error, /Backtester doesn't rule/);
  const own = ok(await fund.propose(idea, cio)).proposal;
  assert.match((await fund.rule(own.id, 'approve', undefined, cio) as { error: string }).error, /someone else rules/);
  const backed = ok(await fund.rule(p.id, 'approve', 'Fits the house view', cio)).proposal;
  assert.equal(backed.stage, 'user_approval');
  assert.equal(backed.cio!.by.id, 'w2');
  assert.ok('error' in (await fund.approve(p.id, undefined, cio)));
  // A person may go ahead without waiting for the CIO, and it's on the record.
  const skipped = ok(await fund.approve(own.id, undefined, wes)).proposal;
  assert.ok(skipped.history.some((h) => h.note === 'Approved without waiting for the CIO'));
});

test('who may do what: roles without the say are refused; only people change limits, settings or capital', async () => {
  const { fund, tick } = setup();
  await tick();
  assert.match((await fund.propose(idea, bob) as { error: string }).error, /Backtester doesn't propose/);
  assert.match((await fund.propose(idea, { kind: 'agent', id: 'x', name: 'X' }) as { error: string }).error, /fund role/);
  assert.ok('error' in (await fund.setLimits({ maxPositionPct: 50 }, ada)));
  assert.ok('error' in (await fund.setConfig({ market: 'mock' }, ada)));
  assert.ok('error' in (await fund.adjustCash(1e6, undefined, ada)));
  const p = ok(await fund.propose(idea, ada)).proposal;
  assert.match((await fund.withdraw(p.id, undefined, { ...ada, id: 'w9' }) as { error: string }).error, /Ada's to withdraw/);
  ok(await fund.withdraw(p.id, 'changed my mind', ada));
});

test('capital paid in moves the NAV but is not profit, and does not hide a drawdown', async () => {
  const { fund, tick } = setup();
  await tick();
  ok(await fund.adjustCash(500_000, 'Second close', wes));
  const p = fund.portfolio();
  assert.equal(p.nav, 1_500_000);
  assert.equal(p.totalPnl, 0);
  assert.equal(p.dayPnl, 0);
  assert.equal(p.drawdownPct, 0);
  assert.ok('error' in (await fund.adjustCash(-2_000_000, undefined, wes)));
});

test('an edited ledger halts trading, and starting over moves the old records aside', async () => {
  const { fund, dir, tick } = setup();
  await tick();
  ok(await fund.approve(ok(await fund.propose(idea, ada)).proposal.id, undefined, wes));
  const file = path.join(dir, 'ledger.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"amount":1000000', '"amount":9000000'));
  const tampered = setup({ dir });
  await tampered.tick();
  assert.match(tampered.fund.halted()!, /ledger journal doesn't check out/);
  assert.match((await tampered.fund.propose(idea, ada) as { error: string }).error, /trading has stopped/);
  assert.ok(tampered.fund.state().halted);
  const { archived } = ok(await tampered.fund.reset(wes));
  assert.ok(existsSync(archived));
  assert.equal(tampered.fund.halted(), undefined);
  assert.equal(tampered.fund.portfolio().nav, 1_000_000);
});

test('a manual close takes the whole position off and closes every trade in it', async () => {
  const { fund, tick } = setup();
  await tick();
  for (let i = 0; i < 2; i++) ok(await fund.approve(ok(await fund.propose({ ...idea, sizeUsd: 20_000 }, ada)).proposal.id, undefined, wes));
  await tick({ BTC: 110_000 });
  ok(await fund.close('btc', wes));
  assert.equal(fund.portfolio().positions.length, 0);
  const trades = fund.proposals.list().filter((p: Proposal) => p.stage === 'exited');
  assert.equal(trades.length, 2);
  for (const t of trades) assert.ok(t.pnl! > 1_900 && t.pnl! < 2_000, String(t.pnl));
});

test('proposals nobody decides on expire', async () => {
  const { fund, clock, tick } = setup();
  await tick();
  const p = ok(await fund.propose(idea, ada)).proposal;
  clock.now += 25 * 3_600_000;
  await tick();
  assert.equal(fund.proposals.get(p.id)!.stage, 'expired');
});

test('the fund will not run on a live venue', () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'fund-')), 'fund');
  assert.throws(() => new Fund({ dir, venue: { id: 'broker', label: 'Broker', live: true, execute: async () => assert.fail() } }), /paper only/);
});
