// The quant lab's tools for the agents at the fund's desks (docs/fund.md#strategies-and-backtests):
// the strategies and backtests to read, price history, running a backtest, and registering and moving
// strategies. hooks/fund.ts serves them with the rest of the fund's tools; the lab decides who may.
import { STRATEGY_KINDS } from '../../shared/fund/strategy.js';
import { cleanSymbol } from '../../shared/fund/assets.js';
import { backtestLine } from '../fund/strategies.js';
import type { Answer, Ask } from './fund.js';

const MAX_BARS = 2600;

export const LAB_READS: Record<string, (a: Ask) => Answer> = {
  strategies({ ctx, q }) {
    const lab = ctx.fund.strategies;
    const id = q.get('id');
    if (id) {
      const s = lab.get(id);
      return s ? { strategy: lab.view(s), backtests: lab.backtests(s.id).slice(0, 20).map(backtestLine) } : { error: `There's no strategy ${id}` };
    }
    const stage = q.get('stage')?.trim().toLowerCase();
    const c = ctx.fund.config;
    return {
      strategies: lab
        .list()
        .filter((s) => !stage || s.stage === stage)
        .slice(0, 60)
        .map((s) => {
          const v = lab.view(s);
          return { id: v.id, name: v.name, stage: v.stage, owner: v.owner, universe: v.universe, rules: v.rules.label, backtest: typeof v.backtest === 'string' ? v.backtest : { id: v.backtest.id, sharpe: v.backtest.metrics.sharpe, oosSharpe: v.backtest.outOfSample.sharpe, maxDrawdownPct: v.backtest.metrics.maxDrawdownPct, trades: v.backtest.metrics.trades }, ...(v.validation ? { passes: v.validation.passed } : {}), ...(v.signal ? { signal: v.signal } : {}), record: v.record };
        }),
      kinds: STRATEGY_KINDS.map((k) => ({ id: k.id, label: k.label, blurb: k.blurb, params: k.params })),
      validationBar: c.validationBar,
      paperDays: c.strategyPaperDays,
      paperTrades: c.strategyPaperTrades,
      paperProfitFactor: c.strategyPaperProfitFactor,
      lifecycle: 'idea → research → backtest → validation → paper → approved, or retired. Each step has a gate in code: research needs rules, backtest a backtest of them, validation enough history, paper a backtest that clears the validation bar (moved there by a desk that didn’t write it), approved a person, after the paper days, once enough of its paper trades have closed at a profit factor that clears paperProfitFactor.',
    };
  },
  backtests({ ctx, q }) {
    const lab = ctx.fund.strategies;
    const id = q.get('id');
    if (id) {
      const b = lab.backtest(id);
      return b ? { backtest: { ...backtestLine(b), rules: b.rules, data: b.data, curve: b.curve, trades: b.trades } } : { error: `There's no backtest ${id}` };
    }
    const strategyId = q.get('strategyId')?.trim().toUpperCase() || undefined;
    return { backtests: lab.backtests(strategyId).slice(0, 30).map(backtestLine) };
  },
  async history({ ctx, q }) {
    const symbol = cleanSymbol(q.get('symbol'));
    const asset = symbol && ctx.fund.assets().get(symbol);
    if (!asset) return { error: 'symbol: one the fund knows, like BTC or SPY' };
    const years = Math.min(10, Math.max(0.25, Number(q.get('years')) || 1));
    try {
      const s = await ctx.fund.strategies.history.series(asset, ctx.fund.config.market, years);
      return { symbol, source: s.source, ...(s.mock ? { mock: 'Simulated by the mock market' } : {}), hash: s.hash, closes: s.bars.slice(-MAX_BARS).map((b) => [new Date(b.t).toISOString().slice(0, 10), b.c]) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const LAB_ACTIONS: Record<string, (a: Ask) => Answer> = {
  strategy({ ctx, by, body }) {
    const r = ctx.fund.strategies.save(by, body);
    if ('strategy' in r) ctx.fund.desks.decided(by, 'strategy', `${body.id ? 'Changed' : 'Registered'} ${r.strategy.id}, ${r.strategy.name}: ${r.strategy.hypothesis}`);
    return 'strategy' in r ? { ok: true, strategy: ctx.fund.strategies.view(r.strategy) } : r;
  },
  'strategy-stage'({ ctx, by, body }) {
    const r = ctx.fund.strategies.move(by, body);
    if ('strategy' in r) ctx.fund.desks.decided(by, 'strategy', `Moved ${r.strategy.id} to ${r.strategy.stage}${typeof body.note === 'string' ? `: ${body.note}` : ''}`);
    return 'strategy' in r ? { ok: true, strategy: ctx.fund.strategies.view(r.strategy) } : r;
  },
  async backtest({ ctx, by, body }) {
    const r = await ctx.fund.strategies.run(by, body);
    if (!('backtest' in r)) return r;
    const b = backtestLine(r.backtest);
    ctx.fund.desks.decided(by, 'backtested', `${b.id}${b.strategyId ? ` of ${b.strategyId}` : ''}: ${b.rules} on ${b.universe.join(', ')}, Sharpe ${b.metrics.sharpe} (out of sample ${b.outOfSample.sharpe}), max drawdown ${b.metrics.maxDrawdownPct}%`);
    return { ok: true, backtest: b, note: `The full curve and trades: fund_backtests {"id":"${b.id}"}` };
  },
};
