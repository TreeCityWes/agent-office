import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simulate, type Bar } from '../src/shared/fund/backtest.js';
import { checkMove, checkRules, DEFAULT_BAR, offSignal, positionsFor, STRATEGY_KINDS, validate, type Backtest, type MoveContext, type Strategy } from '../src/shared/fund/strategy.js';
import { History, type HistorySource } from '../src/server/fund/history.js';
import { handleMcp } from '../bin/office-workers.js';
import { fundOffice, PEOPLE, toolServer, trade } from './fund-office.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);
const err = (r: unknown) => (r as { error: string }).error;
const strategy = (r: unknown) => (r as { strategy: Strategy }).strategy;
const backtest = (r: unknown) => (r as { backtest: Backtest }).backtest;
const ok = (r: unknown) => assert.ok(r && typeof r === 'object' && 'ok' in r, JSON.stringify(r));

/** A seeded random walk of daily closes. */
function walk(n: number, seed = 7): Bar[] {
  let s = seed;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let c = 100;
  return Array.from({ length: n }, (_, k) => ({ t: T0 + k * DAY, c: Math.round((c *= 1 + (rnd() - 0.5) * 0.05) * 100) / 100 }));
}
const bars = (closes: number[]) => closes.map((c, k) => ({ t: T0 + k * DAY, c }));

test('no look-ahead: every kind decides each day from the closes up to it and never a later one', () => {
  const series = walk(420);
  for (const kind of STRATEGY_KINDS) {
    for (const short of [false, true]) {
      for (const volTargetPct of [undefined, 20]) {
        const rules = { kind: kind.id, params: {}, short, ...(volTargetPct ? { volTargetPct } : {}) };
        const full = positionsFor(rules, series, 365);
        assert.equal(full.length, series.length);
        for (let k = 0; k < series.length; k += 7) assert.equal(positionsFor(rules, series.slice(0, k + 1), 365)[k], full[k], `${kind.id} short=${short} vol=${volTargetPct} at ${k}`);
        assert.ok(full.every((p) => p >= -1 && p <= 1 && (short || p >= 0)), `${kind.id} stays within its sides`);
      }
    }
  }
});

test('the engine keeps score: costs on every change, trades, drawdown and the in/out-of-sample split', () => {
  const up = bars(Array.from({ length: 11 }, (_, k) => 100 * 1.01 ** k));
  const free = simulate({ series: [{ symbol: 'X', bars: up, positions: up.map(() => 1) }], costBps: 0 });
  assert.equal(free.metrics.totalReturnPct, 10.46);
  assert.equal(free.metrics.totalReturnPct, free.benchmark.totalReturnPct, 'always long with no costs is buying and holding');
  const paid = simulate({ series: [{ symbol: 'X', bars: up, positions: up.map(() => 1) }], costBps: 100 });
  assert.equal(paid.metrics.totalReturnPct, 9.36, 'one entry at 1% costs 1% of the book');
  assert.deepEqual(paid.signals, { X: 1 });

  // Long for three days, flat, short for two, flat: a winner and a loser.
  const flips = simulate({ series: [{ symbol: 'X', bars: up, positions: [1, 1, 1, 0, 0, -1, -1, 0, 0, 0, 0] }], costBps: 0 });
  assert.deepEqual(
    flips.trades.map((t) => [t.side, t.returnPct, t.open]),
    [
      ['long', 3.03, undefined],
      ['short', -1.99, undefined],
    ],
  );
  assert.deepEqual([flips.metrics.trades, flips.metrics.winRatePct, flips.metrics.profitFactor], [2, 50, 1.52]);
  assert.equal(flips.metrics.turnover > 0, true);

  const crash = simulate({ series: [{ symbol: 'X', bars: bars([100, 200, 100, 100]), positions: [1, 1, 1, 1] }], costBps: 0 });
  assert.equal(crash.metrics.maxDrawdownPct, 50);
  assert.equal(crash.curve.at(-1)!.drawdownPct, -50);

  const long = simulate({ series: [{ symbol: 'X', bars: walk(500), positions: walk(500).map((_, k) => (k % 40 < 20 ? 1 : 0)) }], costBps: 10 });
  assert.equal(long.inSample.days + long.outOfSample.days, long.metrics.days);
  assert.equal(long.splitAt, T0 + 350 * DAY, 'the last 30% is held out');
  assert.ok(long.curve.length <= 130 && long.curve.at(-1)!.t === T0 + 499 * DAY);
  const again = simulate({ series: [{ symbol: 'X', bars: walk(500), positions: walk(500).map((_, k) => (k % 40 < 20 ? 1 : 0)) }], costBps: 10 });
  assert.deepEqual(again, long, 'the same positions on the same prices give the same result');
});

test('the gates: rules in bounds, the validation bar, one step at a time, four eyes, and a person to approve', () => {
  assert.deepEqual(checkRules({ kind: 'Trend', params: { fast: 10 } }), { rules: { kind: 'trend', params: { fast: 10, slow: 100 }, short: false } });
  assert.match(err(checkRules({ kind: 'trend', params: { fast: 100, slow: 50 } })), /fast must be shorter than slow/);
  assert.match(err(checkRules({ kind: 'trend', params: { fast: 2.5 } })), /whole number from 2 to 200/);
  assert.match(err(checkRules({ kind: 'momentum', params: { window: 5 } })), /momentum takes lookback, threshold, not window/);
  assert.match(err(checkRules({ kind: 'astrology' })), /kind is one of trend, momentum/);

  const YEAR = 365.25 * DAY;
  const result = (o: { years?: number; trades?: number; oos?: number; dd?: number; pf?: number; mock?: boolean } = {}) =>
    ({ id: 'B-1', years: o.years ?? 5, metrics: { from: 0, to: (o.years ?? 5) * YEAR, trades: o.trades ?? 30, maxDrawdownPct: o.dd ?? 20, profitFactor: o.pf ?? 1.4 }, outOfSample: { sharpe: o.oos ?? 0.9 }, mock: o.mock ?? false }) as unknown as Backtest;
  assert.equal(validate(result(), DEFAULT_BAR, true).passed, true);
  const v = validate(result({ trades: 4, dd: 45, mock: true }), DEFAULT_BAR, true);
  assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.label), ['Closed trades', 'Max drawdown', 'Real prices']);
  assert.equal(validate(result({ mock: true }), DEFAULT_BAR, false).passed, true, 'mock prices pass in the mock market');

  const quant = { kind: 'agent', id: 'q', name: 'Quinn', role: 'quant' } as const;
  const tester = { kind: 'agent', id: 'b', name: 'Bea', role: 'backtester' } as const;
  const s = { id: 'S-1', name: 'Trend', hypothesis: '', author: quant, owner: 'quant', universe: ['BTC'], rules: { kind: 'trend', params: { fast: 20, slow: 100 }, short: false }, stage: 'validation', history: [], createdAt: 0, updatedAt: 0 } as Strategy;
  const ctx = (o: Partial<MoveContext>): MoveContext => ({ by: tester, role: 'backtester', canStrategy: true, canRule: false, latest: result(), bar: DEFAULT_BAR, realMarket: true, paperDays: 14, now: 30 * DAY, ...o });
  assert.equal(checkMove(s, 'paper', ctx({})), undefined);
  assert.match(checkMove(s, 'paper', ctx({ by: quant, role: 'quant' }))!, /You wrote S-1: another desk \(or a person\) validates it/);
  assert.equal(checkMove(s, 'paper', ctx({ by: PEOPLE, role: undefined })), undefined, 'a person may');
  assert.match(checkMove(s, 'paper', ctx({ latest: result({ oos: 0.1 }) }))!, /doesn't clear the validation bar: out-of-sample sharpe 0.10 \(needs ≥ 0.5\)/);
  assert.match(checkMove(s, 'paper', ctx({ latest: undefined }))!, /rules changed since its last backtest/);
  assert.match(checkMove(s, 'approved', ctx({}))!, /goes to Paper trading next/);
  assert.match(checkMove(s, 'paper', ctx({ canStrategy: false }))!, /Only the quant lab/);
  const paper = { ...s, stage: 'paper', paperSince: 20 * DAY } as Strategy;
  assert.match(checkMove(paper, 'approved', ctx({}))!, /Only a person approves/);
  assert.match(checkMove(paper, 'approved', ctx({ by: PEOPLE }))!, /on paper 10.0 days: it needs 14/);
  assert.equal(checkMove(paper, 'approved', ctx({ by: PEOPLE, now: 40 * DAY })), undefined);
  assert.match(checkMove(paper, 'retired', ctx({ canStrategy: true, role: 'backtester' }))!, /Only S-1's owner, the CIO or PM, or a person retires it/);
  assert.equal(checkMove(paper, 'retired', ctx({ by: quant, role: 'quant' })), undefined);
  assert.match(checkMove({ ...s, stage: 'backtest' }, 'validation', ctx({ latest: result({ years: 1 }) }))!, /tested 1 years: validation needs at least 2/);

  const live = { ...paper, signal: { BTC: 0.6 } };
  assert.equal(offSignal(live, { symbol: 'BTC', side: 'long' }), undefined);
  assert.match(offSignal(live, { symbol: 'BTC', side: 'short' })!, /signal on BTC is long: it doesn't back a short/);
  assert.match(offSignal(live, { symbol: 'ETH', side: 'long' })!, /ETH isn't in S-1's universe/);
  assert.match(offSignal(s, { symbol: 'BTC', side: 'long' })!, /trades only once it's on paper/);
});

test('a strategy through the lab: registered, backtested, validated by another desk, traded on paper, approved by a person', async () => {
  let now = Date.UTC(2026, 5, 1);
  let shape = (i: number) => 100 * 1.002 ** i;
  const candles: HistorySource = {
    id: 'coinbase',
    label: 'Test candles',
    async daily(_feed, _cls, from, to) {
      const out: Bar[] = [];
      for (let t = Math.ceil(from / DAY) * DAY, i = 0; t <= to; t += DAY, i++) out.push({ t, c: shape(i) });
      return out;
    },
  };
  const { fund, dir, hire, as, last } = fundOffice({ now: () => now });
  fund.strategies.history = new History(dir, () => now, [candles]);
  await fund.market.refreshAll();
  fund.desks.staff(hire('q', 'Quinn'), 'quant', PEOPLE);
  fund.desks.staff(hire('b', 'Bea'), 'backtester', PEOPLE);
  fund.desks.staff(hire('t', 'Tex'), 'crypto-trader', PEOPLE);
  const lab = fund.strategies;
  const spec = { name: 'BTC momentum', hypothesis: 'Bitcoin trends: a rising week tends to be followed by more of the same.', universe: ['btc'], kind: 'momentum', params: { lookback: 5 }, short: true };

  assert.match(err(lab.save(as('t'), spec)), /A Crypto Trader doesn't register strategies/);
  assert.match(err(lab.save(as('q'), { ...spec, universe: ['BTC', 'NOPE'] })), /NOPE isn't in the fund's universe/);
  assert.match(err(lab.save(as('q'), { ...spec, params: { lookback: 2 } })), /from 5 to 365/);
  const s1 = strategy(lab.save(as('q'), spec));
  assert.deepEqual([s1.id, s1.stage, s1.owner, s1.universe, s1.rules.params], ['S-1', 'idea', 'quant', ['BTC'], { lookback: 5, threshold: 0 }]);

  assert.match(err(lab.move(as('q'), { id: 'S-1', stage: 'backtest' })), /goes to Research next/);
  ok(lab.move(as('q'), { id: 'S-1', stage: 'research' }));
  assert.match(err(lab.move(as('q'), { id: 'S-1', stage: 'backtest' })), /Backtest S-1's rules first/);
  assert.match(err(await lab.run(as('q'), { kind: 'trend', universe: ['SPY'] })), /couldn't get its prices: No source has SPY's history/);
  const b1 = backtest(await lab.run(as('q'), { strategyId: 'S-1', years: 3, costBps: 1 }));
  assert.deepEqual([b1.id, b1.strategyId, b1.mock, b1.data[0].source, b1.costBps, b1.signals], ['B-1', 'S-1', false, 'coinbase', 10, { BTC: 1 }], 'never cheaper than the venue');
  assert.equal(lab.get('S-1')!.backtestId, 'B-1');
  assert.match(fund.activity.list({ kind: 'backtest' })[0].text, /B-1: S-1 Time-series momentum 5\/0, long\/short on BTC over 3y/);

  ok(lab.move(as('q'), { id: 'S-1', stage: 'backtest' }));
  ok(lab.move(as('q'), { id: 'S-1', stage: 'validation' }));
  assert.match(err(lab.move(as('q'), { id: 'S-1', stage: 'paper' })), /You wrote S-1/);
  assert.match(err(lab.move(as('b'), { id: 'S-1', stage: 'paper' })), /B-1 doesn't clear the validation bar: closed trades 0 \(needs ≥ 10\)/);
  ok(await fund.setConfig({ validationBar: { trades: 0, oosSharpe: 0, profitFactor: 0 } }, PEOPLE));
  assert.deepEqual(fund.config.validationBar, { ...DEFAULT_BAR, trades: 0, oosSharpe: 0, profitFactor: 0 });
  ok(lab.move(as('b'), { id: 'S-1', stage: 'paper', note: 'Clears the bar on three years' }));
  assert.deepEqual([lab.get('S-1')!.stage, lab.get('S-1')!.signal, lab.get('S-1')!.paperSince], ['paper', { BTC: 1 }, now]);
  assert.match(last('q'), /S-1 \(BTC momentum\) moved to Paper trading by Bea: Clears the bar on three years\. Its signal: BTC long\./);
  assert.match(err(lab.save(as('q'), { id: 'S-1', params: { lookback: 10 } })), /its rules are frozen/);
  ok(lab.save(as('q'), { id: 'S-1', hypothesis: 'Bitcoin trends on a weekly horizon, and shorts pay in its slides.' }));

  // A trade under it must go its signal's way; risk and a person still decide it.
  assert.match(err(await fund.propose({ ...trade, side: 'short', stop: 105_000, target: 90_000, strategyId: 'S-1' }, as('t'))), /S-1's signal on BTC is long: it doesn't back a short/);
  assert.match(err(await fund.propose({ ...trade, strategyId: 'S-7' }, as('t'))), /There's no strategy S-7/);
  const p = await fund.propose({ ...trade, strategyId: 's-1' }, as('t'));
  assert.ok('proposal' in p, JSON.stringify(p));
  assert.equal(fund.state().strategies[0].record.proposals, 1);

  assert.match(err(lab.move(as('b'), { id: 'S-1', stage: 'approved' })), /Only a person approves/);
  assert.match(err(lab.move(PEOPLE, { id: 'S-1', stage: 'approved' })), /on paper 0.0 days: it needs 14/);

  // Two weeks on, the market has turned: the signal flips and its owner hears.
  shape = (i) => 100 * 0.998 ** i;
  now += 15 * DAY;
  await lab.refresh();
  assert.deepEqual(lab.get('S-1')!.signal, { BTC: -1 });
  assert.match(last('q'), /S-1 \(BTC momentum\)'s signal changed on today's closes: BTC short/);
  assert.match(fund.activity.list({ kind: 'strategy' }).at(-1)!.text, /S-1's signal changed: BTC short/);
  ok(lab.move(PEOPLE, { id: 'S-1', stage: 'approved' }));

  assert.match(err(lab.move(as('t'), { id: 'S-1', stage: 'retired' })), /Only S-1's owner, the CIO or PM, or a person retires it/);
  ok(lab.move(as('q'), { id: 'S-1', stage: 'retired', note: 'Edge gone' }));
  assert.equal(lab.get('S-1')!.signal, undefined);
  assert.deepEqual(
    lab.get('S-1')!.history.map((h) => h.stage),
    ['idea', 'research', 'backtest', 'validation', 'paper', 'approved', 'retired'],
  );

  // An edited strategy journal stops the fund trading, like any other.
  fund.stop();
  const file = path.join(dir, 'strategies.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Edge gone', 'Still great'));
  const edited = fundOffice({ dir, now: () => now });
  assert.match(edited.fund.halted() ?? '', /strategies journal doesn't check out/);
  assert.match(err(edited.fund.strategies.save(PEOPLE, spec)), /strategies\.jsonl/);
  edited.fund.stop();
});

test('in the mock market backtests run on simulated prices, which never clear the bar once the fund trades on real ones', async () => {
  const { fund, hire, as } = fundOffice({ now: () => Date.UTC(2026, 5, 1) });
  ok(await fund.setConfig({ market: 'mock', validationBar: { trades: 0, oosSharpe: -5, profitFactor: 0, maxDrawdownPct: 100 } }, PEOPLE));
  fund.desks.staff(hire('q', 'Quinn'), 'quant', PEOPLE);
  const lab = fund.strategies;
  const s = strategy(lab.save(as('q'), { name: 'Hold the basket', hypothesis: 'Owning crypto and stocks together beats holding cash over time.', universe: ['BTC', 'SPY'], kind: 'buy-hold' }));
  const b = backtest(await lab.run(as('q'), { strategyId: s.id }));
  assert.deepEqual([b.mock, b.years, b.data.map((d) => d.source), b.signals], [true, 5, ['mock', 'mock'], { BTC: 1, SPY: 1 }]);
  assert.ok(b.data[1].bars < b.data[0].bars, 'stocks skip weekends');
  const again = backtest(await lab.run(PEOPLE, { strategyId: s.id }));
  assert.deepEqual([again.metrics, again.data[0].hash], [b.metrics, b.data[0].hash], 'the same prices again, the same result');
  for (const stage of ['research', 'backtest', 'validation']) ok(lab.move(PEOPLE, { id: s.id, stage }));
  ok(await fund.setConfig({ market: 'public' }, PEOPLE));
  assert.match(err(lab.move(PEOPLE, { id: s.id, stage: 'paper' })), /real prices mock market \(needs not simulated\)/);
  ok(await fund.setConfig({ market: 'mock' }, PEOPLE));
  ok(lab.move(PEOPLE, { id: s.id, stage: 'paper' }));
  assert.equal(fund.state().backtests.length, 2);
  fund.stop();
});

test('the lab through office-fund: every desk reads it and backtests, the lab desks register and move strategies', async (t) => {
  const { fund, hire, workers } = fundOffice({ now: () => Date.UTC(2026, 5, 1) });
  ok(await fund.setConfig({ market: 'mock' }, PEOPLE));
  fund.desks.staff(hire('q', 'Quinn'), 'quant', PEOPLE);
  fund.desks.staff(hire('m', 'Max'), 'macro', PEOPLE);
  const { server, env, run } = await toolServer(fund, workers, { q: 'q-token', m: 'm-token' });
  t.after(() => server.close());
  const listed = async (id: string) => ((await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { env: env(id), fetch })).result.tools as { name: string }[]).map((x) => x.name);
  const macro = await listed('m');
  assert.ok(['fund_strategies', 'fund_backtests', 'fund_history', 'fund_backtest'].every((x) => macro.includes(x)) && !macro.includes('fund_strategy'));
  assert.ok((await listed('q')).includes('fund_strategy_stage'));

  const spec = { name: 'ETH trend', hypothesis: 'Ether trends for weeks at a time once a move starts.', universe: ['ETH'], kind: 'trend', params: { fast: 10, slow: 50 } };
  assert.equal(JSON.parse((await run('q', 'fund_strategy', JSON.stringify(spec))).out).strategy.id, 'S-1');
  assert.match((await run('m', 'fund_strategy', JSON.stringify(spec))).err, /A Macro Analyst doesn't register strategies/);
  const ran = JSON.parse((await run('m', 'fund_backtest', '{"strategyId":"S-1","years":2}')).out);
  assert.deepEqual([ran.backtest.id, ran.backtest.rules, ran.backtest.period.endsWith('(2y)')], ['B-1', 'Trend 10/50, long only', true]);
  assert.match(ran.backtest.mock, /Simulated/);
  const one = JSON.parse((await run('m', 'fund_backtests', '{"id":"B-1"}')).out).backtest;
  assert.ok(one.curve.length > 50 && one.data[0].source === 'mock' && Array.isArray(one.trades));
  const list = JSON.parse((await run('m', 'fund_strategies', '{}')).out);
  assert.deepEqual([list.strategies[0].backtest.id, list.kinds.length, list.validationBar], ['B-1', 5, DEFAULT_BAR]);
  assert.equal(JSON.parse((await run('q', 'fund_strategy_stage', '{"id":"S-1","stage":"research"}')).out).strategy.stage, 'Research');
  const hist = JSON.parse((await run('m', 'fund_history', '{"symbol":"ETH","years":0.5}')).out);
  assert.deepEqual([hist.source, hist.closes.length > 150, hist.closes[0].length], ['mock', true, 2]);
  assert.match((await run('m', 'fund_history', '{"symbol":"NOPE"}')).err, /one the fund knows/);
  const kinds = (role: string) => {
    const m = fund.desks.memory(role);
    return 'error' in m ? [] : m.decisions.map((d) => d.kind);
  };
  assert.deepEqual(kinds('quant'), ['strategy', 'strategy']);
  assert.deepEqual(kinds('macro'), ['backtested']);
  fund.stop();
});
