// The quant lab's strategies (docs/fund.md#strategies-and-backtests): systematic rules a desk writes
// down, backtests and walks through a fixed lifecycle, from an idea to a strategy a person approved.
// Every rule here is code: the kinds of strategy and how each turns prices into positions, what a
// backtest must show before a strategy may trade on paper, and who may move it along. No model's
// judgment opens a gate. Pure: the server keeps strategies (server/fund/strategies.ts).
import type { Bar, Metrics, SimResult } from './backtest.js';
import type { Actor, Proposal } from './types.js';

export type StrategyStage = 'idea' | 'research' | 'backtest' | 'validation' | 'paper' | 'approved' | 'retired';
export const STRATEGY_STAGES: readonly StrategyStage[] = ['idea', 'research', 'backtest', 'validation', 'paper', 'approved', 'retired'];
export const STRATEGY_STAGE_LABEL: Record<StrategyStage, string> = {
  idea: 'Idea',
  research: 'Research',
  backtest: 'Backtest',
  validation: 'Validation',
  paper: 'Paper trading',
  approved: 'Approved',
  retired: 'Retired',
};

// ---- Kinds of strategy -------------------------------------------------------------------------

export interface ParamDef {
  label: string;
  def: number;
  min: number;
  max: number;
  /** Whole numbers only (a window in days). */
  int?: boolean;
}

export interface StrategyKind {
  id: string;
  label: string;
  blurb: string;
  params: Record<string, ParamDef>;
  /** Why these params can't work together, if they can't. */
  check?(p: Record<string, number>): string | undefined;
  /**
   * The position (-1, 0 or 1) after each close, from the closes up to that one and never a later
   * one: position k depends on closes[0..k] alone. `short` lets it go short where it would sell.
   */
  positions(closes: readonly number[], p: Record<string, number>, short: boolean): number[];
}

/** The average of the `n` closes up to and including k, or NaN before there are n. */
function sma(xs: readonly number[], n: number): number[] {
  const out = new Array<number>(xs.length).fill(NaN);
  let sum = 0;
  for (let k = 0; k < xs.length; k++) {
    sum += xs[k];
    if (k >= n) sum -= xs[k - n];
    if (k >= n - 1) out[k] = sum / n;
  }
  return out;
}

const side = (up: boolean, down: boolean, short: boolean) => (up ? 1 : down && short ? -1 : 0);

export const STRATEGY_KINDS: readonly StrategyKind[] = [
  {
    id: 'trend',
    label: 'Trend (moving-average cross)',
    blurb: 'Long while the fast average is above the slow one; short below it, if shorts are allowed.',
    params: { fast: { label: 'Fast average, days', def: 20, min: 2, max: 200, int: true }, slow: { label: 'Slow average, days', def: 100, min: 5, max: 400, int: true } },
    check: (p) => (p.fast >= p.slow ? 'fast must be shorter than slow' : undefined),
    positions(c, p, short) {
      const f = sma(c, p.fast);
      const s = sma(c, p.slow);
      return c.map((_, k) => (Number.isNaN(s[k]) ? 0 : side(f[k] > s[k], f[k] < s[k], short)));
    },
  },
  {
    id: 'momentum',
    label: 'Time-series momentum',
    blurb: 'Long when the return over the lookback beats the threshold; short when it falls below minus the threshold.',
    params: { lookback: { label: 'Lookback, days', def: 90, min: 5, max: 365, int: true }, threshold: { label: 'Threshold, %', def: 0, min: 0, max: 100 } },
    positions(c, p, short) {
      return c.map((x, k) => {
        if (k < p.lookback) return 0;
        const r = (x / c[k - p.lookback] - 1) * 100;
        return side(r > p.threshold, r < -p.threshold, short);
      });
    },
  },
  {
    id: 'mean-reversion',
    label: 'Mean reversion (z-score)',
    blurb: 'Buys a close stretched below its average and sells it back near the average; the mirror image short.',
    params: {
      window: { label: 'Window, days', def: 20, min: 5, max: 200, int: true },
      entry: { label: 'Enter at z', def: 2, min: 0.5, max: 4 },
      exit: { label: 'Exit at z', def: 0.5, min: 0, max: 2 },
    },
    check: (p) => (p.exit >= p.entry ? 'exit must be below entry' : undefined),
    positions(c, p, short) {
      const out: number[] = [];
      let pos = 0;
      for (let k = 0; k < c.length; k++) {
        if (k >= p.window - 1) {
          const w = c.slice(k - p.window + 1, k + 1);
          const m = w.reduce((a, b) => a + b, 0) / w.length;
          const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
          const z = sd > 0 ? (c[k] - m) / sd : 0;
          if (pos > 0 && z >= -p.exit) pos = 0;
          else if (pos < 0 && z <= p.exit) pos = 0;
          if (pos === 0) pos = z <= -p.entry ? 1 : z >= p.entry && short ? -1 : 0;
        }
        out.push(pos);
      }
      return out;
    },
  },
  {
    id: 'breakout',
    label: 'Breakout (Donchian channel)',
    blurb: 'Long on a close above the highest close of the entry window, out on one below the lowest of the exit window; the mirror image short.',
    params: { entry: { label: 'Entry window, days', def: 55, min: 5, max: 250, int: true }, exit: { label: 'Exit window, days', def: 20, min: 2, max: 250, int: true } },
    positions(c, p, short) {
      const out: number[] = [];
      let pos = 0;
      const hi = (k: number, n: number) => Math.max(...c.slice(Math.max(0, k - n), k));
      const lo = (k: number, n: number) => Math.min(...c.slice(Math.max(0, k - n), k));
      for (let k = 0; k < c.length; k++) {
        if (k >= p.entry) {
          if (pos > 0 && c[k] < lo(k, p.exit)) pos = 0;
          else if (pos < 0 && c[k] > hi(k, p.exit)) pos = 0;
          if (pos === 0) pos = c[k] > hi(k, p.entry) ? 1 : c[k] < lo(k, p.entry) && short ? -1 : 0;
        }
        out.push(pos);
      }
      return out;
    },
  },
  {
    id: 'buy-hold',
    label: 'Buy and hold',
    blurb: 'Always long, equally weighted: the yardstick the others have to beat.',
    params: {},
    positions: (c) => c.map(() => 1),
  },
];

export const KIND_BY_ID: ReadonlyMap<string, StrategyKind> = new Map(STRATEGY_KINDS.map((k) => [k.id, k]));

export interface StrategyRules {
  kind: string;
  params: Record<string, number>;
  /** May it go short? Long-only when not. */
  short: boolean;
  /** Sizes each position to this annualized volatility (%), never above full size. */
  volTargetPct?: number;
}

const VOL_WINDOW = 20;

/**
 * The positions `rules` hold on one asset's daily closes, sized for the volatility target when it has
 * one: still from nothing later than each close. `perYear` is the bars in its year (365 for crypto).
 */
export function positionsFor(rules: StrategyRules, bars: readonly Bar[], perYear: number): number[] {
  const kind = KIND_BY_ID.get(rules.kind);
  if (!kind) return bars.map(() => 0);
  const closes = bars.map((b) => b.c);
  const raw = kind.positions(closes, { ...defaults(kind), ...rules.params }, rules.short);
  if (!rules.volTargetPct) return raw;
  const target = rules.volTargetPct / 100;
  return raw.map((pos, k) => {
    // No position until there's enough history to measure its volatility.
    if (!pos || k < VOL_WINDOW) return 0;
    let sum = 0;
    let sq = 0;
    for (let j = k - VOL_WINDOW + 1; j <= k; j++) {
      const r = Math.log(closes[j] / closes[j - 1]);
      sum += r;
      sq += r * r;
    }
    const m = sum / VOL_WINDOW;
    const vol = Math.sqrt(Math.max(0, sq / VOL_WINDOW - m * m) * perYear);
    return vol > 0 ? pos * Math.min(1, target / vol) : pos;
  });
}

const defaults = (k: StrategyKind) => Object.fromEntries(Object.entries(k.params).map(([id, d]) => [id, d.def]));

/** "Trend 20/100, long/short, vol 15%". */
export function rulesLabel(r: StrategyRules): string {
  const kind = KIND_BY_ID.get(r.kind);
  const params = Object.values(r.params).join('/');
  return `${kind?.label.replace(/ \(.*\)$/, '') ?? r.kind}${params ? ` ${params}` : ''}, ${r.short ? 'long/short' : 'long only'}${r.volTargetPct ? `, vol ${r.volTargetPct}%` : ''}`;
}

/** The rules and universe as one string: two backtests of the same fingerprint tested the same thing. */
export function fingerprint(r: StrategyRules, universe: readonly string[]): string {
  const params = Object.fromEntries(Object.entries(r.params).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ kind: r.kind, params, short: r.short, vol: r.volTargetPct ?? 0, universe: [...universe].sort() });
}

// ---- What the lab keeps ------------------------------------------------------------------------

export interface StrategyStep {
  at: number;
  stage: StrategyStage;
  by: Actor;
  note?: string;
}

export interface Strategy {
  /** S-1, S-2… */
  id: string;
  name: string;
  /** What it bets on, and why that should pay. */
  hypothesis: string;
  author: Actor;
  /** The role that looks after it: whoever holds that desk is told when its signal changes. */
  owner?: string;
  universe: string[];
  rules: StrategyRules;
  stage: StrategyStage;
  history: StrategyStep[];
  /** Its latest backtest of the rules as they are now. */
  backtestId?: string;
  /** When it went on paper. */
  paperSince?: number;
  /** The position its rules hold now on each asset, while it's on paper or approved. */
  signal?: Record<string, number>;
  signalAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Where a backtest's prices came from: enough to fetch them again and check they're the same. */
export interface DataUsed {
  symbol: string;
  source: string;
  bars: number;
  from: number;
  to: number;
  /** sha256 of the closes. */
  hash: string;
  mock?: boolean;
}

export interface Backtest extends SimResult {
  /** B-1, B-2… */
  id: string;
  strategyId?: string;
  rules: StrategyRules;
  universe: string[];
  fingerprint: string;
  years: number;
  costBps: number;
  data: DataUsed[];
  /** Any of its prices came from the mock market. */
  mock: boolean;
  by: Actor;
  at: number;
}

// ---- The validation bar ------------------------------------------------------------------------

/** What a backtest must show before its strategy may trade on paper. A person sets it in ⚙️ Settings. */
export interface ValidationBar {
  /** Years of history it was tested on. */
  years: number;
  trades: number;
  oosSharpe: number;
  maxDrawdownPct: number;
  profitFactor: number;
}

export const DEFAULT_BAR: ValidationBar = { years: 2, trades: 10, oosSharpe: 0.5, maxDrawdownPct: 30, profitFactor: 1.1 };

const BAR_RANGE: Record<keyof ValidationBar, [number, number]> = { years: [0.5, 20], trades: [0, 1000], oosSharpe: [-5, 10], maxDrawdownPct: [1, 100], profitFactor: [0, 20] };

export function checkBar(raw: unknown, base: ValidationBar = DEFAULT_BAR): { bar: ValidationBar } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'The validation bar is an object' };
  const out = { ...base };
  for (const [k, [lo, hi]] of Object.entries(BAR_RANGE) as [keyof ValidationBar, [number, number]][]) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return { error: `validationBar.${k} is from ${lo} to ${hi}` };
    out[k] = v;
  }
  return { bar: out };
}

export interface Check {
  label: string;
  ok: boolean;
  value: string;
  need: string;
}

const years = (m: Metrics) => (m.to - m.from) / (365.25 * 86_400_000);

/** The bar's checks against a backtest: it passes only if every one does. Mock prices never pass when the fund trades on real ones. */
export function validate(b: Pick<Backtest, 'metrics' | 'outOfSample' | 'mock'>, bar: ValidationBar, realMarket: boolean): { passed: boolean; checks: Check[] } {
  const checks: Check[] = [
    { label: 'History tested', ok: years(b.metrics) >= bar.years - 0.02, value: `${years(b.metrics).toFixed(1)} years`, need: `≥ ${bar.years}` },
    { label: 'Closed trades', ok: b.metrics.trades >= bar.trades, value: String(b.metrics.trades), need: `≥ ${bar.trades}` },
    { label: 'Out-of-sample Sharpe', ok: b.outOfSample.sharpe >= bar.oosSharpe, value: b.outOfSample.sharpe.toFixed(2), need: `≥ ${bar.oosSharpe}` },
    { label: 'Max drawdown', ok: b.metrics.maxDrawdownPct <= bar.maxDrawdownPct, value: `${b.metrics.maxDrawdownPct.toFixed(1)}%`, need: `≤ ${bar.maxDrawdownPct}%` },
    { label: 'Profit factor', ok: b.metrics.profitFactor >= bar.profitFactor, value: b.metrics.profitFactor.toFixed(2), need: `≥ ${bar.profitFactor}` },
  ];
  if (realMarket) checks.push({ label: 'Real prices', ok: !b.mock, value: b.mock ? 'mock market' : 'public sources', need: 'not simulated' });
  return { passed: checks.every((c) => c.ok), checks };
}

// ---- Moving along ------------------------------------------------------------------------------

/** Who's asking to move a strategy, and what the lab knows about it. */
export interface MoveContext {
  by: Actor;
  /** The role of the agent asking, and whether that role may work on strategies. */
  role?: string;
  canStrategy: boolean;
  /** CIO or PM. */
  canRule: boolean;
  /** Its latest backtest of the current rules. */
  latest?: Backtest;
  bar: ValidationBar;
  realMarket: boolean;
  paperDays: number;
  /** How its trades on paper have done, and what they must show before a person may approve it. */
  paper: PaperRecord;
  paperTrades: number;
  paperProfitFactor: number;
  now: number;
}

/** The stage after each, on the way to approved. */
export const NEXT_STAGE: Partial<Record<StrategyStage, StrategyStage>> = { idea: 'research', research: 'backtest', backtest: 'validation', validation: 'paper', paper: 'approved' };
const DAY_MS = 86_400_000;

/** Why `s` can't go to `to` for whoever's asking, or undefined when it can. */
export function checkMove(s: Strategy, to: StrategyStage, c: MoveContext): string | undefined {
  const person = c.by.kind === 'user';
  const owns = !!c.role && (c.role === s.owner || c.by.id === s.author.id);
  const here = STRATEGY_STAGE_LABEL[s.stage];
  if (s.stage === 'retired') return `${s.id} is retired: register it again as a new strategy`;
  if (to === s.stage) return `${s.id} is at ${here} already`;
  if (to === 'retired') return person || owns || c.canRule ? undefined : `Only ${s.id}'s owner, the CIO or PM, or a person retires it`;
  if (to === 'research' && s.stage !== 'idea') return person || c.canStrategy ? undefined : 'Only the quant lab (or the CIO or PM) sends a strategy back to research';
  if (NEXT_STAGE[s.stage] !== to) return `${s.id} is at ${here}: it goes to ${STRATEGY_STAGE_LABEL[NEXT_STAGE[s.stage]!]} next, back to Research, or to Retired`;
  if (to === 'approved') {
    if (!person) return 'Only a person approves a strategy';
    const days = s.paperSince ? (c.now - s.paperSince) / DAY_MS : 0;
    if (days < c.paperDays) return `${s.id} has been on paper ${days.toFixed(1)} days: it needs ${c.paperDays} before it's approved`;
    if (c.paper.closed < c.paperTrades) return `${s.id} has closed ${c.paper.closed} trade${c.paper.closed === 1 ? '' : 's'} on paper: it needs ${c.paperTrades} before it's approved`;
    const pf = paperProfitFactor(c.paper);
    if (pf !== undefined && pf < c.paperProfitFactor) return `${s.id}'s profit factor on paper is ${pf.toFixed(2)}: it needs ${c.paperProfitFactor} before it's approved`;
    return undefined;
  }
  if (!person && !c.canStrategy) return 'Only the quant lab (Quant, Strategy, Backtester) or the CIO or PM moves a strategy along';
  if (to === 'backtest' && !c.latest) return `Backtest ${s.id}'s rules first (fund_backtest with strategyId ${s.id})`;
  if (to === 'validation') {
    if (!c.latest) return `${s.id}'s rules changed since its last backtest: backtest them again`;
    if (c.latest.years < c.bar.years) return `${c.latest.id} tested ${c.latest.years} years: validation needs at least ${c.bar.years}`;
  }
  if (to === 'paper') {
    if (!person && (c.role === s.owner || c.by.id === s.author.id)) return `You wrote ${s.id}: another desk (or a person) validates it`;
    if (!c.latest) return `${s.id}'s rules changed since its last backtest: backtest them again`;
    const v = validate(c.latest, c.bar, c.realMarket);
    if (!v.passed)
      return `${c.latest.id} doesn't clear the validation bar: ${v.checks
        .filter((x) => !x.ok)
        .map((x) => `${x.label.toLowerCase()} ${x.value} (needs ${x.need})`)
        .join('; ')}`;
  }
  return undefined;
}

/** Can a strategy's rules still change here? Validation sends it back to Backtest; Paper and later freeze them. */
export const rulesOpen = (stage: StrategyStage) => stage === 'idea' || stage === 'research' || stage === 'backtest' || stage === 'validation';

// ---- What the tools take -----------------------------------------------------------------------

/** A strategy as sent to register it, or to edit one (with its id). */
export interface StrategyInput {
  id?: string;
  name?: string;
  hypothesis?: string;
  universe?: string[];
  kind?: string;
  params?: Record<string, number>;
  short?: boolean;
  volTargetPct?: number;
  owner?: string;
}

/** A backtest asked for: of a strategy's rules, or of rules and a universe given here. */
export interface BacktestRequest {
  strategyId?: string;
  kind?: string;
  params?: Record<string, number>;
  universe?: string[];
  short?: boolean;
  volTargetPct?: number;
  years?: number;
  costBps?: number;
}

type Raw = Record<string, unknown>;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const MAX_UNIVERSE = 12;

/** A universe as sent: a list of symbols (or "BTC, ETH"), each one the fund knows. */
export function checkUniverse(v: unknown, known: (s: string) => boolean): { universe: string[] } | { error: string } {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  const universe = [...new Set(raw.map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (!universe.length) return { error: 'universe: the symbols it trades, like ["BTC","ETH"]' };
  if (universe.length > MAX_UNIVERSE) return { error: `universe: at most ${MAX_UNIVERSE} symbols` };
  const unknown = universe.filter((s) => !known(s));
  if (unknown.length) return { error: `${unknown.join(', ')} ${unknown.length > 1 ? "aren't" : "isn't"} in the fund's universe` };
  return { universe };
}

/** Rules as sent: a kind, its params (each within its bounds, the rest its defaults), shorts and a vol target. */
export function checkRules(raw: unknown): { rules: StrategyRules } | { error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  const kind = KIND_BY_ID.get(text(r.kind, 40).toLowerCase());
  if (!kind) return { error: `kind is one of ${STRATEGY_KINDS.map((k) => k.id).join(', ')}` };
  const given = (r.params && typeof r.params === 'object' ? r.params : {}) as Raw;
  const params: Record<string, number> = {};
  for (const [id, d] of Object.entries(kind.params)) {
    const v = given[id] ?? d.def;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < d.min || v > d.max || (d.int && !Number.isInteger(v))) return { error: `params.${id} (${d.label}) is ${d.int ? 'a whole number ' : ''}from ${d.min} to ${d.max}` };
    params[id] = v;
  }
  const extra = Object.keys(given).filter((k) => !(k in kind.params));
  if (extra.length) return { error: `${kind.id} takes ${Object.keys(kind.params).join(', ') || 'no params'}, not ${extra.join(', ')}` };
  const bad = kind.check?.(params);
  if (bad) return { error: bad };
  let volTargetPct: number | undefined;
  if (r.volTargetPct !== undefined && r.volTargetPct !== null && r.volTargetPct !== 0) {
    if (typeof r.volTargetPct !== 'number' || !Number.isFinite(r.volTargetPct) || r.volTargetPct < 1 || r.volTargetPct > 100) return { error: 'volTargetPct is from 1 to 100, or left out' };
    volTargetPct = r.volTargetPct;
  }
  return { rules: { kind: kind.id, params, short: r.short === true, ...(volTargetPct ? { volTargetPct } : {}) } };
}

/** A strategy as a desk or a person registers or edits it: what's left out of an edit stays as it was. */
export function checkStrategyInput(
  raw: unknown,
  known: (s: string) => boolean,
  base?: Strategy,
): { name: string; hypothesis: string; universe: string[]; rules: StrategyRules; owner?: string } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Send the strategy: name, hypothesis, universe, kind and params' };
  const r = raw as Raw;
  const name = text(r.name, 80) || base?.name || '';
  if (name.length < 3) return { error: 'name: what to call it' };
  const hypothesis = text(r.hypothesis, 2000) || base?.hypothesis || '';
  if (hypothesis.length < 20) return { error: 'hypothesis: what it bets on and why that should pay, in a sentence or more' };
  const u = r.universe === undefined && base ? { universe: base.universe } : checkUniverse(r.universe, known);
  if ('error' in u) return u;
  // An edit keeps the params it doesn't mention, unless it changes the kind.
  const sameKind = !!base && (r.kind === undefined || text(r.kind, 40).toLowerCase() === base.rules.kind);
  const rules = checkRules({
    kind: r.kind ?? base?.rules.kind,
    params: { ...(sameKind ? base?.rules.params : {}), ...(r.params && typeof r.params === 'object' ? r.params : {}) },
    short: r.short ?? base?.rules.short,
    volTargetPct: r.volTargetPct !== undefined ? r.volTargetPct : base?.rules.volTargetPct,
  });
  if ('error' in rules) return rules;
  const owner = text(r.owner, 64).toLowerCase() || undefined;
  return { name, hypothesis, universe: u.universe, rules: rules.rules, ...(owner ? { owner } : {}) };
}

/** A strategy as the window shows it: with how the trades proposed under it have done. */
export type StrategyView = Strategy & { record: PaperRecord };

// ---- Its record on paper -----------------------------------------------------------------------

export interface PaperRecord {
  proposals: number;
  filled: number;
  open: number;
  closed: number;
  wins: number;
  /** Fees included, as every figure here. */
  realizedPnl: number;
  /** What its winners made, and its losers lost (as a positive number). */
  grossProfit: number;
  grossLoss: number;
  /** Realized P&L over what its closed trades put to work at entry, %. */
  returnPct: number;
  /** The deepest its realized P&L fell from its high, closed trade by closed trade, in USD. */
  maxDrawdown: number;
}

/** Gross profit over gross loss on its closed paper trades: Infinity with no losers, undefined with none closed. */
export function paperProfitFactor(r: PaperRecord): number | undefined {
  if (!r.closed) return undefined;
  return r.grossLoss > 0 ? r.grossProfit / r.grossLoss : Infinity;
}

/** How the trades proposed under strategy `id` have done. */
export function paperRecord(proposals: readonly Proposal[], id: string): PaperRecord {
  const r: PaperRecord = { proposals: 0, filled: 0, open: 0, closed: 0, wins: 0, realizedPnl: 0, grossProfit: 0, grossLoss: 0, returnPct: 0, maxDrawdown: 0 };
  const closed: { at: number; pnl: number; put: number }[] = [];
  for (const p of proposals) {
    if (p.strategyId !== id) continue;
    r.proposals++;
    if (p.entryFill) r.filled++;
    if (p.stage === 'executing' || p.stage === 'monitoring') r.open++;
    if ((p.stage === 'exited' || p.stage === 'reviewed') && p.pnl !== undefined)
      closed.push({ at: p.history.find((h) => h.stage === 'exited')?.at ?? p.updatedAt, pnl: p.pnl, put: Math.abs((p.qty ?? 0) * (p.entryPrice ?? 0)) });
  }
  let put = 0;
  let high = 0;
  for (const t of closed.sort((a, b) => a.at - b.at)) {
    r.closed++;
    r.realizedPnl += t.pnl;
    if (t.pnl > 0) {
      r.wins++;
      r.grossProfit += t.pnl;
    } else r.grossLoss -= t.pnl;
    put += t.put;
    high = Math.max(high, r.realizedPnl);
    r.maxDrawdown = Math.max(r.maxDrawdown, high - r.realizedPnl);
  }
  r.returnPct = put > 0 ? (r.realizedPnl / put) * 100 : 0;
  return r;
}

/** Why a proposal under a strategy can't go ahead: the strategy isn't trading, or its signal says otherwise. */
export function offSignal(s: Strategy | undefined, p: { strategyId?: string; symbol: string; side: 'long' | 'short' }): string | undefined {
  if (!s) return `There's no strategy ${p.strategyId}`;
  if (s.stage !== 'paper' && s.stage !== 'approved') return `${s.id} is at ${STRATEGY_STAGE_LABEL[s.stage]}: a strategy trades only once it's on paper`;
  if (!s.universe.includes(p.symbol)) return `${p.symbol} isn't in ${s.id}'s universe (${s.universe.join(', ')})`;
  const pos = s.signal?.[p.symbol] ?? 0;
  const want = p.side === 'long' ? 1 : -1;
  if (Math.sign(pos) !== want) return `${s.id}'s signal on ${p.symbol} is ${pos > 0 ? 'long' : pos < 0 ? 'short' : 'flat'}: it doesn't back a ${p.side}`;
  return undefined;
}
