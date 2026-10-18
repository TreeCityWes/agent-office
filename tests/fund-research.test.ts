import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp } from '../bin/office-workers.js';
import { gatherResearch } from '../src/server/fund/research.js';
import type { Client } from '../src/server/office/client.js';
import type { Ctx } from '../src/server/office/context.js';
import { fundResearchHandlers } from '../src/server/ws/handlers/fund-research.js';
import { dailyPnl, pnlReport } from '../src/shared/fund/pnl.js';
import { calibration, callsOf, coverage, currentThesis, type ResearchNote } from '../src/shared/fund/research.js';
import type { NavPoint } from '../src/shared/fund/state.js';
import type { Actor, PositionView, Proposal } from '../src/shared/fund/types.js';
import type { ServerMsg } from '../src/shared/protocol.js';
import { fundOffice, PEOPLE, toolServer, trade } from './fund-office.js';

const ada: Actor = { kind: 'agent', id: 'w1', name: 'Ada', role: 'crypto-trader' };
const max: Actor = { kind: 'agent', id: 'w2', name: 'Max', role: 'macro' };

/** A proposal with what these tests look at; the rest of it doesn't matter here. */
function proposal(p: Partial<Proposal> & Pick<Proposal, 'id' | 'stage'>): Proposal {
  return { symbol: 'BTC', side: 'long', sizeUsd: 10_000, thesis: 't', confidence: 60, horizon: '1w', evidence: [], author: ada, createdAt: 0, updatedAt: 0, history: [], ...p } as Proposal;
}

test('a desk’s thesis now carries the confidence it had before, and how many it has written', () => {
  assert.equal(currentThesis('macro', []), undefined);
  const t = currentThesis('macro', [
    { at: 1, by: max, thesis: 'Risk-on', confidence: 65 },
    { at: 2, by: max, thesis: 'Still risk-on, no number' },
    { at: 3, by: max, thesis: 'Fade the rally', confidence: 40, why: 'Core services ran hot' },
  ]);
  assert.deepEqual(t, { role: 'macro', at: 3, by: max, thesis: 'Fade the rally', confidence: 40, was: 65, why: 'Core services ran hot', versions: 3 });
});

test('closed calls are scored against the confidence given: hit rate, Brier and what they made', () => {
  const ps = [
    proposal({ id: 'P-1', stage: 'reviewed', confidence: 80, pnl: 500, qty: 0.1, entryPrice: 100_000, history: [{ at: 10, stage: 'exited', by: ada }] }),
    proposal({ id: 'P-2', stage: 'exited', confidence: 60, pnl: -200, qty: 0.1, entryPrice: 100_000, history: [{ at: 20, stage: 'exited', by: ada }] }),
    proposal({ id: 'P-3', stage: 'monitoring', confidence: 90 }),
    proposal({ id: 'P-4', stage: 'exited', confidence: 90, pnl: 100, author: PEOPLE }),
    proposal({ id: 'P-5', stage: 'exited', confidence: 50, pnl: 50, author: max, updatedAt: 5 }),
    proposal({ id: 'P-6', stage: 'exited', side: 'short', confidence: 50, pnl: 400, qty: -1, entryPrice: 4_000, author: max, updatedAt: 4 }),
  ];
  const calls = callsOf(ps);
  assert.deepEqual(calls.map((c) => c.id), ['P-2', 'P-1', 'P-5', 'P-6'], 'newest first; open trades and a person’s trades aren’t calls');
  assert.equal(calls[3].returnPct, 10, 'a short’s return, on what it put up');
  assert.equal(calls[1].returnPct, 5);
  assert.equal(calls[1].won, true);
  const [crypto, macro] = calibration(calls);
  assert.equal(crypto.role, 'crypto-trader');
  assert.equal(crypto.calls, 2);
  assert.equal(crypto.hitRatePct, 50);
  assert.equal(crypto.avgConfidence, 70);
  // (0.8 − 1)² = 0.04 and (0.6 − 0)² = 0.36: 0.2 on average.
  assert.ok(Math.abs(crypto.brier - 0.2) < 1e-9);
  assert.equal(crypto.realizedPnl, 300);
  assert.equal(macro.brier, 0.25, 'saying 50% scores a quarter, win or lose');
  assert.equal(macro.avgReturnPct, 10, 'averaged over the calls with a return');
});

test('coverage puts what the fund holds first, then what is talked about most', () => {
  const note = (role: string, symbol: string, at: number): ResearchNote => ({ role, symbol, at, by: max, text: `${symbol} note` });
  const position = { symbol: 'SOL', side: 'long', value: 20_000, unrealizedPnl: 400, weightPct: 2 } as PositionView;
  const rows = coverage(
    ['BTC', 'ETH', 'SPY'],
    [note('macro', 'SPY', 1), note('crypto-analyst', 'ETH', 2), note('macro', 'ETH', 3)],
    [proposal({ id: 'P-1', stage: 'idea', symbol: 'ETH', side: 'short' }), proposal({ id: 'P-2', stage: 'rejected', symbol: 'SPY' })],
    [position],
    [{ id: 's', kind: 'funding', symbol: 'BTC', label: 'Funding', at: 1, source: 'test' }],
  );
  assert.deepEqual(rows.map((r) => r.symbol), ['SOL', 'ETH', 'BTC', 'SPY']);
  const eth = rows[1];
  assert.deepEqual([eth.notes, eth.desks, eth.ideas, eth.short, eth.live, eth.latest?.at], [2, ['crypto-analyst', 'macro'], 1, 1, 0, 3]);
  assert.equal(rows[0].position?.unrealizedPnl, 400);
  assert.equal(rows[3].live, 0, 'a rejected proposal isn’t live');
});

test('P&L by day, asset, desk and strategy, reconciled to the book', () => {
  const nav: NavPoint[] = [
    { at: 1, day: '2026-10-01', nav: 1_000_000, dayStartNav: 1_000_000 },
    { at: 2, day: '2026-10-01', nav: 1_002_000, dayStartNav: 1_000_000 },
    { at: 3, day: '2026-10-02', nav: 999_000, dayStartNav: 1_002_000 },
  ] as NavPoint[];
  assert.deepEqual(dailyPnl(nav).map((d) => [d.day, d.pnl]), [['2026-10-01', 2_000], ['2026-10-02', -3_000]]);

  const ps = [
    proposal({ id: 'P-1', stage: 'reviewed', pnl: 1_000, qty: 0.1, entryPrice: 100_000, exitPrice: 110_000, strategyId: 'S-1', history: [{ at: 5, stage: 'exited', by: ada }] }),
    proposal({ id: 'P-2', stage: 'exited', symbol: 'SPY', pnl: -300, qty: 10, entryPrice: 600, author: max, history: [{ at: 9, stage: 'exited', by: max }] }),
    proposal({ id: 'P-3', stage: 'monitoring', qty: 0.2, entryPrice: 100_000, entryFill: 'F-1', strategyId: 'S-1' }),
    proposal({ id: 'P-4', stage: 'user_approval' }),
    proposal({ id: 'P-5', stage: 'monitoring', symbol: 'ETH', side: 'short', qty: -10, entryPrice: 4_000, entryFill: 'F-2' }),
  ];
  const r = pnlReport(ps, [{ symbol: 'BTC', price: 101_000 }, { symbol: 'ETH', price: 3_900 }] as PositionView[], nav, { realizedPnl: 950, fees: 50 });
  assert.equal(r.byAsset.find((l) => l.key === 'ETH')!.unrealized, 1_000, 'a short is up when the price falls, though its qty is negative');
  const btc = r.byAsset.find((l) => l.key === 'BTC')!;
  assert.deepEqual([btc.realized, btc.unrealized, btc.closed, btc.wins, btc.open], [1_000, 200, 1, 1, 1]);
  assert.deepEqual(r.byDesk.map((l) => [l.key, l.realized + l.unrealized]), [['crypto-trader', 2_200], ['macro', -300]]);
  assert.deepEqual(r.byStrategy.map((l) => [l.key, l.realized, l.unrealized]), [['S-1', 1_000, 200]]);
  assert.deepEqual(r.trades.map((t) => t.id), ['P-2', 'P-1']);
  assert.equal(r.trades[1].returnPct, 10);
  assert.equal(r.unattributed, 200, 'the book realized 900 after fees, the trades account for 700');
});

test('the desks’ research reaches the window and the agents: theses, notes, coverage and calls', async (t) => {
  // A clock a second on each time it's read, so what's written later is newer.
  let clock = Date.UTC(2026, 9, 1, 15);
  const { fund, hire, as, workers } = fundOffice({ now: () => (clock += 1000) });
  await fund.market.refreshAll();
  fund.desks.staff(hire('m', 'Max'), 'macro', PEOPLE);
  fund.desks.staff(hire('c', 'Cora'), 'crypto-analyst', PEOPLE);
  fund.desks.staff(hire('t', 'Tex'), 'crypto-trader', PEOPLE);
  fund.desks.thesis(as('m'), { thesis: 'Disinflation keeps risk-on alive.', confidence: 65 });
  fund.desks.thesis(as('m'), { thesis: 'Sticky services: fade the rally.', confidence: 40, why: 'Core services ran hot' });
  fund.desks.observe(as('m'), { text: 'Core services +0.5% m/m', sources: ['https://bls.gov'], symbol: 'spy' });
  fund.desks.observe(as('c'), { text: 'ETF inflows five days running', symbol: 'BTC' });

  // Tex's BTC long fills and is closed by hand: a losing call, given at 70%.
  const p = await fund.propose(trade, as('t'));
  assert.ok('proposal' in p);
  assert.ok('proposal' in (await fund.approve(p.proposal.id, 'Go', PEOPLE)));
  const out = await fund.exit(p.proposal.id, PEOPLE);
  assert.ok('proposal' in out && out.proposal.stage === 'exited');

  const r = gatherResearch((role) => fund.desks.memoryDir(role), fund.proposals.list(), 42);
  assert.deepEqual(r.theses.map((x) => [x.role, x.confidence, x.was]), [['macro', 40, 65]]);
  assert.deepEqual(r.notes.map((n) => [n.role, n.symbol]), [['crypto-analyst', 'BTC'], ['macro', 'SPY']]);
  assert.deepEqual(r.calls.map((c) => [c.id, c.role, c.confidence, c.won]), [['P-1', 'crypto-trader', 70, false]]);
  assert.ok(Math.abs(r.calibration[0].brier - 0.49) < 1e-9, '(0.7 − 0)²');
  assert.deepEqual(gatherResearch((role) => fund.desks.memoryDir(role), [], 0, { symbol: 'SPY' }).notes.map((n) => n.role), ['macro']);
  assert.deepEqual(gatherResearch((role) => fund.desks.memoryDir(role), [], 0, { role: 'crypto-analyst' }).theses, []);

  // The fund's own P&L has Tex's trade by desk, and nothing it can't account for.
  const pnl = fund.state().pnl;
  assert.equal(pnl.trades[0].by, 'crypto-trader');
  assert.equal(pnl.byDesk[0].key, 'crypto-trader');
  assert.ok(pnl.byDesk[0].realized < 0);
  assert.equal(pnl.unattributed, 0);

  // An agent reads it with fund_research, narrowed to an asset.
  const { server, env } = await toolServer(fund, workers, { m: 'max-token' });
  t.after(() => server.close());
  const listed = (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { env: env('m'), fetch })).result.tools as { name: string }[];
  assert.ok(listed.some((x) => x.name === 'fund_research'));
  const call = async (args: object) => {
    const res = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fund_research', arguments: args } }, { env: env('m'), fetch });
    return { error: res.result.isError, body: res.result.content[0].text as string };
  };
  const btc = JSON.parse((await call({ symbol: 'btc' })).body);
  assert.deepEqual(btc.notes.map((n: { desk: string }) => n.desk), ['Crypto Analyst']);
  assert.equal(btc.coverage[0].symbol, 'BTC');
  assert.deepEqual(btc.calibration[0], { desk: 'Crypto Trader', role: 'crypto-trader', calls: 1, wins: 0, hitRatePct: 0, avgConfidence: 70, brier: 0.49, avgReturnPct: btc.calibration[0].avgReturnPct, realizedPnl: btc.calibration[0].realizedPnl });
  assert.equal(btc.theses[0].desk, 'Macro Analyst');
  const bad = await call({ role: 'janitor' });
  assert.equal(bad.error, true);
  assert.match(bad.body, /no role called janitor/);

  // And the window asks for it over the socket.
  const sent: ServerMsg[] = [];
  const ctx = { fund, sendTo: (_c: Client, m: ServerMsg) => sent.push(m) } as unknown as Ctx;
  fundResearchHandlers['fund.research'](ctx, {} as Client, { t: 'fund.research' });
  const msg = sent[0] as Extract<ServerMsg, { t: 'fund.research' }>;
  assert.equal(msg.t, 'fund.research');
  assert.equal(msg.research.theses[0].thesis, 'Sticky services: fade the rally.');
  assert.equal(msg.research.calls.length, 1);
  fund.stop();
});
