import path from 'node:path';
import { simulate } from '../../shared/fund/backtest.js';
import { ROLE_BY_ID, type Permission } from '../../shared/fund/roles.js';
import type { FundConfig } from '../../shared/fund/state.js';
import {
  checkMove,
  checkRules,
  checkStrategyInput,
  checkUniverse,
  fingerprint,
  offSignal,
  paperRecord,
  positionsFor,
  rulesLabel,
  rulesOpen,
  STRATEGY_STAGE_LABEL,
  STRATEGY_STAGES,
  validate,
  type Backtest,
  type Strategy,
  type StrategyRules,
  type StrategyStage,
  type StrategyView,
} from '../../shared/fund/strategy.js';
import type { ActivityEvent, Actor, Asset, AssetClass, Proposal, Side } from '../../shared/fund/types.js';
import type { Desks } from './desks.js';
import { History, type Series } from './history.js';
import { Journal } from './journal.js';

/** What the lab needs of the fund. */
export interface LabFund {
  readonly now: () => number;
  readonly config: FundConfig;
  readonly desks: Desks;
  readonly proposals: { list(): Proposal[] };
  assets(): Map<string, Asset>;
  log(kind: ActivityEvent['kind'], by: Actor, text: string, extra?: Pick<ActivityEvent, 'proposalId' | 'symbol' | 'level'>): void;
  changed(): void;
}

type Result<T extends object = object> = ({ ok: true } & T) | { error: string };

const LAB: Actor = { kind: 'system', id: 'lab', name: 'Quant lab' };
const MAX_STRATEGIES = 200;
const SHOWN_BACKTESTS = 20;
const SHOWN_TRADES = 20;
const MAX_RUNNING = 2;
const TICK_MS = 30 * 60_000;
/** How stale a paper strategy's signal may get before it's worked out again on fresh closes. */
const SIGNAL_EVERY_MS = 20 * 3_600_000;
/** History behind a signal: enough for the longest window any kind takes. */
const SIGNAL_YEARS = 2;

const perYear = (cls: AssetClass) => (cls === 'crypto' ? 365 : 252);
const obj = (raw: unknown) => (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {});
const title = (role?: string) => (role ? (ROLE_BY_ID.get(role)?.title ?? role) : 'people');
const signalText = (sig: Record<string, number>) =>
  Object.entries(sig)
    .map(([s, p]) => `${s} ${p > 0 ? 'long' : p < 0 ? 'short' : 'flat'}${p && Math.abs(p) < 1 ? ` ${Math.round(Math.abs(p) * 100)}%` : ''}`)
    .join(', ');

/** A backtest as an agent reads it in a list: the numbers that matter, not the curve and trades. */
export function backtestLine(b: Backtest) {
  const m = b.metrics;
  return {
    id: b.id,
    ...(b.strategyId ? { strategyId: b.strategyId } : {}),
    rules: rulesLabel(b.rules),
    universe: b.universe,
    period: `${new Date(m.from).toISOString().slice(0, 10)} to ${new Date(m.to).toISOString().slice(0, 10)} (${b.years}y)`,
    costBps: b.costBps,
    ...(b.mock ? { mock: 'Simulated prices from the mock market: not evidence about the real one' } : {}),
    metrics: { sharpe: m.sharpe, sortino: m.sortino, cagrPct: m.cagrPct, totalReturnPct: m.totalReturnPct, volPct: m.volPct, maxDrawdownPct: m.maxDrawdownPct, maxDrawdownDays: m.maxDrawdownDays, winRatePct: m.winRatePct, profitFactor: m.profitFactor, trades: m.trades, turnover: m.turnover, exposurePct: m.exposurePct },
    inSample: { sharpe: b.inSample.sharpe, totalReturnPct: b.inSample.totalReturnPct, maxDrawdownPct: b.inSample.maxDrawdownPct },
    outOfSample: { from: new Date(b.splitAt).toISOString().slice(0, 10), sharpe: b.outOfSample.sharpe, totalReturnPct: b.outOfSample.totalReturnPct, maxDrawdownPct: b.outOfSample.maxDrawdownPct, trades: b.outOfSample.trades },
    benchmark: b.benchmark,
    signals: b.signals,
    by: b.by.name,
    at: new Date(b.at).toISOString(),
  };
}

/**
 * The quant lab (docs/fund.md#strategies-and-backtests): strategies registered by its desks or by
 * people, walked through idea → research → backtest → validation → paper → approved (or retired) by
 * the gates in shared/fund/strategy.ts, and the backtests that let them through. Strategies are kept
 * as their snapshots in strategies.jsonl and every backtest in backtests.jsonl, both hash-chained.
 * A strategy on paper has its signal worked out on each day's closes, and a trade proposed under it
 * must follow that signal; it still goes through risk and a person's approval like any other.
 */
export class Strategies {
  private strategies: Journal<Strategy>;
  private runs: Journal<Backtest>;
  private byId = new Map<string, Strategy>();
  private tests = new Map<string, Backtest>();
  private running = 0;
  private refreshing = false;
  private timer: NodeJS.Timeout;
  history: History;
  problem?: string;
  repaired?: string;

  constructor(
    private fund: LabFund,
    dir: string,
  ) {
    this.history = new History(dir, fund.now);
    this.strategies = new Journal(path.join(dir, 'strategies.jsonl'));
    this.runs = new Journal(path.join(dir, 'backtests.jsonl'));
    const a = this.strategies.read();
    const b = this.runs.read();
    for (const s of a.entries) this.byId.set(s.id, s);
    for (const t of b.entries) this.tests.set(t.id, t);
    this.problem = a.problem ? `strategies.jsonl: ${a.problem}` : b.problem ? `backtests.jsonl: ${b.problem}` : undefined;
    this.repaired = [a.repaired, b.repaired].filter(Boolean).join(' ') || undefined;
    this.timer = setInterval(() => void this.refresh(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  get(id: unknown): Strategy | undefined {
    return this.byId.get(String(id ?? '').trim().toUpperCase());
  }

  backtest(id: unknown): Backtest | undefined {
    return this.tests.get(String(id ?? '').trim().toUpperCase());
  }

  /** Newest first. */
  list(): Strategy[] {
    return [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  backtests(strategyId?: string): Backtest[] {
    return [...this.tests.values()].filter((b) => !strategyId || b.strategyId === strategyId).sort((a, b) => b.at - a.at);
  }

  /** Its latest backtest of the rules and universe it has now, if it has one. */
  latest(s: Strategy): Backtest | undefined {
    const b = s.backtestId ? this.tests.get(s.backtestId) : undefined;
    return b && b.fingerprint === fingerprint(s.rules, s.universe) ? b : undefined;
  }

  /** What the window shows: every strategy with its paper record, and the latest backtests (with every strategy's own). */
  state(): { strategies: StrategyView[]; backtests: Backtest[] } {
    const proposals = this.fund.proposals.list();
    const strategies = this.list().map((s) => ({ ...s, record: paperRecord(proposals, s.id) }));
    const recent = this.backtests().slice(0, SHOWN_BACKTESTS);
    for (const s of strategies) {
      const b = this.latest(s);
      if (b && !recent.includes(b)) recent.push(b);
    }
    return { strategies, backtests: recent.map((b) => ({ ...b, trades: b.trades.slice(-SHOWN_TRADES) })) };
  }

  /** A strategy as an agent reads it: where it is, what its latest backtest showed, and what stands in its way. */
  view(s: Strategy) {
    const b = this.latest(s);
    const c = this.fund.config;
    const v = b ? validate(b, c.validationBar, c.market === 'public') : undefined;
    return {
      ...s,
      stage: STRATEGY_STAGE_LABEL[s.stage],
      rules: { ...s.rules, label: rulesLabel(s.rules) },
      owner: s.owner ? `${title(s.owner)} (${s.owner})` : 'people',
      author: s.author.name,
      history: s.history.map((h) => ({ at: new Date(h.at).toISOString(), stage: h.stage, by: h.by.name, ...(h.note ? { note: h.note } : {}) })),
      backtest: b ? backtestLine(b) : `None of these rules yet: fund_backtest {"strategyId":"${s.id}"}`,
      ...(v ? { validation: v } : {}),
      ...(s.paperSince ? { daysOnPaper: Math.floor((this.fund.now() - s.paperSince) / 86_400_000) } : {}),
      record: paperRecord(this.fund.proposals.list(), s.id),
      createdAt: new Date(s.createdAt).toISOString(),
      updatedAt: new Date(s.updatedAt).toISOString(),
      ...(s.signalAt ? { signalAt: new Date(s.signalAt).toISOString() } : {}),
    };
  }

  /** Why a proposal under a strategy can't go ahead, or undefined when it can (or names none). */
  offSignal(p: { strategyId?: string; symbol: string; side: Side }): string | undefined {
    return p.strategyId ? offSignal(this.get(p.strategyId), p) : undefined;
  }

  private roleOf(by: Actor) {
    return by.kind === 'agent' ? this.fund.desks.profile(by.id)?.role : undefined;
  }

  private may(by: Actor, perm: Permission) {
    if (by.kind === 'user') return true;
    const role = this.roleOf(by);
    return !!role && !!ROLE_BY_ID.get(role)?.can.includes(perm);
  }

  private put(s: Strategy) {
    if (this.problem) throw new Error(this.problem);
    this.strategies.append(s);
    this.byId.set(s.id, s);
    this.fund.changed();
  }

  private step(s: Strategy, to: StrategyStage, by: Actor, note?: string): Strategy {
    const now = this.fund.now();
    return { ...s, stage: to, updatedAt: now, history: [...s.history, { at: now, stage: to, by, ...(note ? { note: note.slice(0, 500) } : {}) }] };
  }

  /** Tells the desk that owns `s`, unless it's the one who did it. */
  private tellOwner(s: Strategy, by: Actor, summary: string, text: string) {
    if (s.owner && this.roleOf(by) !== s.owner) this.fund.desks.notify(LAB, s.owner, `${s.id}: ${summary}`, text, 'message');
  }

  /** Registers a strategy (no id) or edits one: its description any time, its rules only before it's on paper. */
  save(by: Actor, raw: unknown): Result<{ strategy: Strategy }> {
    if (this.problem) return { error: this.problem };
    const r = obj(raw);
    const base = r.id !== undefined ? this.get(r.id) : undefined;
    if (r.id !== undefined && !base) return { error: `There's no strategy ${String(r.id)}` };
    const role = this.roleOf(by);
    if (by.kind === 'agent' && !role) return { error: 'You hold no desk at the fund' };
    if (!base && !this.may(by, 'strategy')) return { error: `A ${title(role)} doesn't register strategies: send the idea to the Quant or Strategy Researcher (fund_message)` };
    if (base?.stage === 'retired') return { error: `${base.id} is retired` };
    if (base && by.kind === 'agent' && role !== base.owner && by.id !== base.author.id && !this.may(by, 'strategy')) return { error: `${base.id} is the ${title(base.owner)}'s to change` };
    const c = checkStrategyInput(raw, (s) => this.fund.assets().has(s), base);
    if ('error' in c) return c;
    if (c.owner && !ROLE_BY_ID.has(c.owner)) return { error: `owner: a role id, like quant or strategy` };
    const now = this.fund.now();
    if (!base) {
      if (this.byId.size >= MAX_STRATEGIES) return { error: `The lab keeps at most ${MAX_STRATEGIES} strategies: retire some` };
      const s: Strategy = { id: `S-${this.byId.size + 1}`, name: c.name, hypothesis: c.hypothesis, author: by, ...((c.owner ?? role) ? { owner: c.owner ?? role } : {}), universe: c.universe, rules: c.rules, stage: 'idea', history: [{ at: now, stage: 'idea', by }], createdAt: now, updatedAt: now };
      this.put(s);
      this.fund.log('strategy', by, `Registered ${s.id}, ${s.name}: ${rulesLabel(s.rules)} on ${s.universe.join(', ')}`);
      return { ok: true, strategy: s };
    }
    const changed = fingerprint(c.rules, c.universe) !== fingerprint(base.rules, base.universe);
    if (changed && !rulesOpen(base.stage)) return { error: `${base.id} is at ${STRATEGY_STAGE_LABEL[base.stage]}, so its rules are frozen: send it back to Research (fund_strategy_stage) to change them` };
    const { backtestId: _, ...kept } = base;
    let next: Strategy = { ...(changed ? kept : base), name: c.name, hypothesis: c.hypothesis, universe: c.universe, rules: c.rules, ...(c.owner ? { owner: c.owner } : {}), updatedAt: now };
    const back = changed && base.stage === 'validation';
    if (back) next = this.step(next, 'backtest', by, 'Its rules changed');
    this.put(next);
    this.fund.log('strategy', by, `Changed ${base.id}: ${changed ? `${rulesLabel(c.rules)} on ${c.universe.join(', ')}` : 'its description'}${back ? '; back to Backtest' : ''}`);
    return { ok: true, strategy: next };
  }

  /** Moves a strategy to another stage, if its gate (strategy.ts's checkMove) lets whoever's asking. */
  move(by: Actor, raw: unknown): Result<{ strategy: Strategy }> {
    if (this.problem) return { error: this.problem };
    const r = obj(raw);
    const s = this.get(r.id);
    if (!s) return { error: 'id: the strategy (S-1…), as fund_strategies lists them' };
    const to = String(r.stage ?? '').trim().toLowerCase() as StrategyStage;
    if (!STRATEGY_STAGES.includes(to)) return { error: `stage is one of ${STRATEGY_STAGES.join(', ')}` };
    const c = this.fund.config;
    const latest = this.latest(s);
    const role = this.roleOf(by);
    if (by.kind === 'agent' && !role) return { error: 'You hold no desk at the fund' };
    const why = checkMove(s, to, { by, role, canStrategy: this.may(by, 'strategy'), canRule: by.kind === 'agent' && this.may(by, 'rule'), latest, bar: c.validationBar, realMarket: c.market === 'public', paperDays: c.strategyPaperDays, now: this.fund.now() });
    if (why) return { error: why };
    const note = typeof r.note === 'string' ? r.note.trim().slice(0, 500) : undefined;
    let next = this.step(s, to, by, note);
    if (to === 'paper') next = { ...next, paperSince: this.fund.now(), signal: latest!.signals, signalAt: latest!.at };
    if (to === 'research' || to === 'retired') {
      // Off paper there's no signal to follow, and back in research its time on paper starts again.
      const { signal: _s, signalAt: _a, paperSince, ...rest } = next;
      next = to === 'retired' && paperSince ? { ...rest, paperSince } : rest;
    }
    this.put(next);
    // Back to research is a step down; on from an idea to research isn't.
    const level = to === 'paper' || to === 'approved' ? 'good' : to === 'retired' || (to === 'research' && s.stage !== 'idea') ? 'warn' : undefined;
    const signal = to === 'paper' && next.signal ? ` Its signal: ${signalText(next.signal)}.` : '';
    this.fund.log('strategy', by, `Moved ${s.id} (${s.name}) from ${STRATEGY_STAGE_LABEL[s.stage]} to ${STRATEGY_STAGE_LABEL[to]}${note ? `: ${note}` : ''}.${signal}`, level ? { level } : {});
    this.tellOwner(next, by, `now ${STRATEGY_STAGE_LABEL[to]}`, `🧪 ${s.id} (${s.name}) moved to ${STRATEGY_STAGE_LABEL[to]} by ${by.name}${note ? `: ${note}` : ''}.${signal}${to === 'paper' ? ` Propose trades that follow it with fund_propose and strategyId "${s.id}".` : ''}`);
    return { ok: true, strategy: next };
  }

  /** Runs a backtest: of a strategy's rules (strategyId), or of rules and a universe given here. */
  async run(by: Actor, raw: unknown): Promise<Result<{ backtest: Backtest }>> {
    if (this.problem) return { error: this.problem };
    if (by.kind === 'agent' && !this.roleOf(by)) return { error: 'You hold no desk at the fund' };
    const r = obj(raw);
    const assets = this.fund.assets();
    let s: Strategy | undefined;
    let rules: StrategyRules;
    let universe: string[];
    if (r.strategyId !== undefined) {
      s = this.get(r.strategyId);
      if (!s) return { error: `There's no strategy ${String(r.strategyId)}` };
      ({ rules, universe } = s);
    } else {
      const ru = checkRules(r);
      if ('error' in ru) return { error: `${ru.error} (or give a strategyId)` };
      const u = checkUniverse(r.universe, (x) => assets.has(x));
      if ('error' in u) return u;
      ({ rules } = ru);
      ({ universe } = u);
    }
    const c = this.fund.config;
    const years = r.years === undefined ? Math.max(5, c.validationBar.years) : Number(r.years);
    if (!Number.isFinite(years) || years < 1 || years > 15) return { error: 'years is from 1 to 15' };
    // Never cheaper than the paper venue charges.
    const floor = c.feeBps + c.slippageBps;
    const asked = Number(r.costBps);
    const costBps = Number.isFinite(asked) && asked <= 500 ? Math.max(floor, asked) : floor;
    if (this.running >= MAX_RUNNING) return { error: `The lab is running ${MAX_RUNNING} backtests already: try again in a minute` };
    this.running++;
    let series: Series[];
    try {
      series = await Promise.all(universe.map((sym) => this.history.series(assets.get(sym)!, c.market, years)));
    } catch (err) {
      return { error: `The backtest couldn't get its prices: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.running--;
    }
    if (this.problem) return { error: this.problem };
    const sim = simulate({ series: series.map((x) => ({ symbol: x.symbol, bars: x.bars, positions: positionsFor(rules, x.bars, perYear(assets.get(x.symbol)!.class)) })), costBps });
    const b: Backtest = {
      id: `B-${this.tests.size + 1}`,
      ...(s ? { strategyId: s.id } : {}),
      rules,
      universe,
      fingerprint: fingerprint(rules, universe),
      years,
      costBps,
      data: series.map((x) => ({ symbol: x.symbol, source: x.source, bars: x.bars.length, from: x.bars[0].t, to: x.bars[x.bars.length - 1].t, hash: x.hash, ...(x.mock ? { mock: true } : {}) })),
      mock: series.some((x) => x.mock),
      by,
      at: this.fund.now(),
      ...sim,
    };
    this.runs.append(b);
    this.tests.set(b.id, b);
    const m = b.metrics;
    this.fund.log(
      'backtest',
      by,
      `${b.id}: ${s ? `${s.id} ` : ''}${rulesLabel(rules)} on ${universe.join(', ')} over ${years}y: Sharpe ${m.sharpe} (out of sample ${b.outOfSample.sharpe}), CAGR ${m.cagrPct}%, max drawdown ${m.maxDrawdownPct}%, profit factor ${m.profitFactor}, ${m.trades} trades${b.mock ? ' (MOCK prices)' : ''}`,
    );
    // The strategy may have changed while the prices came in: only a test of its rules as they are counts.
    const cur = s && this.get(s.id);
    if (cur && cur.stage !== 'retired' && fingerprint(cur.rules, cur.universe) === b.fingerprint) this.put({ ...cur, backtestId: b.id, updatedAt: b.at });
    else this.fund.changed();
    return { ok: true, backtest: b };
  }

  /** Each strategy on paper (or approved) has its signal worked out again on the latest closes, about once a day. */
  async refresh(force = false) {
    if (this.problem || this.refreshing) return;
    this.refreshing = true;
    try {
      const assets = this.fund.assets();
      for (const s of this.list()) {
        if ((s.stage !== 'paper' && s.stage !== 'approved') || (!force && s.signalAt && this.fund.now() - s.signalAt < SIGNAL_EVERY_MS)) continue;
        const signal: Record<string, number> = {};
        for (const sym of s.universe) {
          const a = assets.get(sym);
          if (!a) continue;
          const { bars } = await this.history.series(a, this.fund.config.market, SIGNAL_YEARS);
          const pos = positionsFor(s.rules, bars, perYear(a.class));
          signal[sym] = Math.round((pos[pos.length - 1] ?? 0) * 100) / 100;
        }
        const cur = this.get(s.id);
        if (!cur || (cur.stage !== 'paper' && cur.stage !== 'approved')) continue;
        const was = cur.signal ?? {};
        const moved = Object.keys(signal).filter((k) => Math.sign(signal[k]) !== Math.sign(was[k] ?? 0));
        this.put({ ...cur, signal, signalAt: this.fund.now() });
        if (!moved.length) continue;
        const open = this.fund.proposals.list().filter((p) => p.strategyId === s.id && p.stage === 'monitoring' && moved.includes(p.symbol));
        this.fund.log('strategy', LAB, `${s.id}'s signal changed: ${signalText(Object.fromEntries(moved.map((k) => [k, signal[k]])))}`, { symbol: moved[0], level: 'info' });
        this.tellOwner(
          cur,
          LAB,
          `signal changed: ${signalText(Object.fromEntries(moved.map((k) => [k, signal[k]])))}`,
          `🧪 ${s.id} (${s.name})'s signal changed on today's closes: ${signalText(signal)}.` +
            (open.length ? ` Open under it: ${open.map((p) => `${p.id} ${p.side} ${p.symbol}`).join(', ')}; ask a person to exit what it no longer backs (fund_escalate).` : '') +
            ` New trades it backs go in with fund_propose and strategyId "${s.id}".`,
        );
      }
    } catch (err) {
      console.error('agent-office: fund: refreshing strategy signals:', err);
    } finally {
      this.refreshing = false;
    }
  }
}
