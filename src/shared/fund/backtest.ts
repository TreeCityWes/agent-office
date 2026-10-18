// The backtest engine (docs/fund.md#strategies-and-backtests): positions decided at each daily close
// and held to the next, costs charged on every change, no look-ahead. Pure and deterministic: the
// same positions on the same bars give the same result to the last digit, which is how a stored run
// is checked. The strategy's rules make the positions (strategy.ts); this only keeps score.

const DAY_MS = 86_400_000;

/** One day's close. `t` is any time that day, in ms. */
export interface Bar {
  t: number;
  c: number;
}

export interface Metrics {
  from: number;
  to: number;
  /** Trading days in the period. */
  days: number;
  totalReturnPct: number;
  cagrPct: number;
  /** Annualized volatility of daily returns. */
  volPct: number;
  /** Annualized, against a zero risk-free rate. */
  sharpe: number;
  sortino: number;
  /** The worst fall from a high, as a positive %. */
  maxDrawdownPct: number;
  /** The longest time spent below a high, in calendar days. */
  maxDrawdownDays: number;
  calmar: number;
  /** Closed trades. */
  trades: number;
  winRatePct: number;
  /** Gross gains over gross losses of closed trades (99 when nothing lost). */
  profitFactor: number;
  avgTradePct: number;
  /** How many times a year the book turns over. */
  turnover: number;
  /** The average share of capital at work. */
  exposurePct: number;
}

/** What buying and holding the same assets, equally weighted, did over the same days. */
export type BenchmarkMetrics = Pick<Metrics, 'totalReturnPct' | 'cagrPct' | 'volPct' | 'sharpe' | 'maxDrawdownPct'>;

export interface Trade {
  symbol: string;
  side: 'long' | 'short';
  from: number;
  to: number;
  returnPct: number;
  /** Still on at the last bar: marked to it, and left out of the win rate and profit factor. */
  open?: boolean;
}

export interface CurvePoint {
  t: number;
  /** Growth of 1. */
  equity: number;
  benchmark: number;
  /** ≤ 0, as a %. */
  drawdownPct: number;
}

export interface SimInput {
  /** Each asset's daily closes, oldest first, with the position (-1 to 1) its rules hold after each close. */
  series: { symbol: string; bars: Bar[]; positions: number[] }[];
  /** Fee and slippage, in basis points of what's traded. */
  costBps: number;
  /** Where in-sample ends and out-of-sample begins, as a share of the days. */
  split?: number;
}

export interface SimResult {
  metrics: Metrics;
  benchmark: BenchmarkMetrics;
  inSample: Metrics;
  outOfSample: Metrics;
  splitAt: number;
  curve: CurvePoint[];
  /** The latest trades, newest last. */
  trades: Trade[];
  /** The position the rules hold now, per asset. */
  signals: Record<string, number>;
}

const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);
const dayOf = (t: number) => Math.floor(t / DAY_MS);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** Return, volatility, Sharpe, drawdown and the rest, from daily returns on `days` (day numbers). */
function score(days: number[], rets: number[], turns: number[], exposure: number[], trades: Trade[]): Metrics {
  const n = rets.length;
  const years = n > 1 ? (days[n - 1] - days[0]) / 365.25 : 0;
  const perYear = years > 0 ? (n - 1) / years : 252;
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let peakDay = days[0] ?? 0;
  let longest = 0;
  for (let i = 0; i < n; i++) {
    equity *= 1 + rets[i];
    if (equity >= peak) {
      peak = equity;
      peakDay = days[i];
    } else {
      maxDd = Math.max(maxDd, 1 - equity / peak);
      longest = Math.max(longest, days[i] - peakDay);
    }
  }
  const body = rets.slice(1);
  const m = mean(body);
  const s = sd(body);
  const down = Math.sqrt(mean(body.map((r) => Math.min(0, r) ** 2)));
  const cagr = years > 0 && equity > 0 ? equity ** (1 / years) - 1 : 0;
  const closed = trades.filter((t) => !t.open);
  const gains = closed.filter((t) => t.returnPct > 0).reduce((a, t) => a + t.returnPct, 0);
  const losses = -closed.filter((t) => t.returnPct < 0).reduce((a, t) => a + t.returnPct, 0);
  return {
    from: (days[0] ?? 0) * DAY_MS,
    to: (days[n - 1] ?? 0) * DAY_MS,
    days: n,
    totalReturnPct: r2((equity - 1) * 100),
    cagrPct: r2(cagr * 100),
    volPct: r2(s * Math.sqrt(perYear) * 100),
    sharpe: r2(s > 0 ? (m / s) * Math.sqrt(perYear) : 0),
    sortino: r2(down > 0 ? (m / down) * Math.sqrt(perYear) : 0),
    maxDrawdownPct: r2(maxDd * 100),
    maxDrawdownDays: longest,
    calmar: r2(maxDd > 0 ? cagr / maxDd : 0),
    trades: closed.length,
    winRatePct: r2(closed.length ? (closed.filter((t) => t.returnPct > 0).length / closed.length) * 100 : 0),
    profitFactor: r2(losses > 0 ? Math.min(99, gains / losses) : gains > 0 ? 99 : 0),
    avgTradePct: r2(closed.length ? mean(closed.map((t) => t.returnPct)) : 0),
    turnover: r2(years > 0 ? turns.reduce((a, b) => a + b, 0) / years : 0),
    exposurePct: r2(mean(exposure) * 100),
  };
}

/** One asset's trades: each run of positions on the same side, entered and left at a close. */
function tradesOf(symbol: string, bars: Bar[], pos: number[], cost: number): Trade[] {
  const out: Trade[] = [];
  let a = -1;
  for (let k = 0; k <= bars.length; k++) {
    const side = k < bars.length ? Math.sign(pos[k]) : 0;
    const was = a >= 0 ? Math.sign(pos[a]) : 0;
    if (a >= 0 && side !== was) {
      let g = 1 - Math.abs(pos[a]) * cost;
      for (let j = a + 1; j < Math.min(k + 1, bars.length); j++) g *= 1 + pos[j - 1] * (bars[j].c / bars[j - 1].c - 1);
      const open = k >= bars.length;
      if (!open) g *= 1 - Math.abs(pos[k - 1]) * cost;
      out.push({ symbol, side: was > 0 ? 'long' : 'short', from: bars[a].t, to: bars[Math.min(k, bars.length - 1)].t, returnPct: r2((g - 1) * 100), ...(open ? { open: true } : {}) });
      a = -1;
    }
    if (a < 0 && side !== 0) a = k;
  }
  return out;
}

/**
 * Runs the positions over the bars. Assets are equally weighted; an asset with no bar on a day (a
 * weekend for a stock, or before its history starts) earns nothing that day and holds its position.
 * The return on day k is the position after close k-1 times the move to close k, less the cost of
 * changing position at close k.
 */
export function simulate(input: SimInput): SimResult {
  const cost = Math.max(0, input.costBps) / 10_000;
  const series = input.series.filter((s) => s.bars.length > 1);
  const n = series.length || 1;
  const allDays = [...new Set(series.flatMap((s) => s.bars.map((b) => dayOf(b.t))))].sort((a, b) => a - b);
  const index = new Map(allDays.map((d, i) => [d, i]));
  const rets = new Array<number>(allDays.length).fill(0);
  const bench = new Array<number>(allDays.length).fill(0);
  const turns = new Array<number>(allDays.length).fill(0);
  const held = new Array<number>(allDays.length).fill(0);
  const trades: Trade[] = [];
  const signals: Record<string, number> = {};
  for (const s of series) {
    const pos = s.bars.map((_, k) => Math.max(-1, Math.min(1, Number.isFinite(s.positions[k]) ? s.positions[k] : 0)));
    let last = -1;
    for (let k = 0; k < s.bars.length; k++) {
      const i = index.get(dayOf(s.bars[k].t))!;
      const prev = k ? pos[k - 1] : 0;
      const move = k ? s.bars[k].c / s.bars[k - 1].c - 1 : 0;
      rets[i] += (prev * move - Math.abs(pos[k] - prev) * cost) / n;
      bench[i] += move / n;
      turns[i] += Math.abs(pos[k] - prev) / n;
      // Exposure on the days between this bar and the next is this bar's position.
      for (let j = last + 1; j <= i; j++) held[j] += Math.abs(k ? prev : 0) / n;
      last = i;
    }
    for (let j = last + 1; j < allDays.length; j++) held[j] += Math.abs(pos[pos.length - 1]) / n;
    trades.push(...tradesOf(s.symbol, s.bars, pos, cost));
    signals[s.symbol] = r2(pos[pos.length - 1]);
  }
  trades.sort((a, b) => a.from - b.from);
  const cut = Math.max(1, Math.min(allDays.length - 1, Math.round(allDays.length * (input.split ?? 0.7))));
  const splitAt = (allDays[cut] ?? 0) * DAY_MS;
  const part = (lo: number, hi: number) =>
    score(allDays.slice(lo, hi), [0, ...rets.slice(lo + 1, hi)], turns.slice(lo, hi), held.slice(lo, hi), trades.filter((t) => t.from >= allDays[lo] * DAY_MS && t.from < (allDays[hi - 1] + 1) * DAY_MS));
  const full = score(allDays, rets, turns, held, trades);
  const b = score(allDays, bench, [], [], []);

  const curve: CurvePoint[] = [];
  const every = Math.max(1, Math.ceil(allDays.length / 120));
  let eq = 1;
  let be = 1;
  let peak = 1;
  for (let i = 0; i < allDays.length; i++) {
    eq *= 1 + rets[i];
    be *= 1 + bench[i];
    peak = Math.max(peak, eq);
    if (i % every === 0 || i === allDays.length - 1) curve.push({ t: allDays[i] * DAY_MS, equity: Math.round(eq * 10_000) / 10_000, benchmark: Math.round(be * 10_000) / 10_000, drawdownPct: r2((eq / peak - 1) * 100) });
  }
  return {
    metrics: full,
    benchmark: { totalReturnPct: b.totalReturnPct, cagrPct: b.cagrPct, volPct: b.volPct, sharpe: b.sharpe, maxDrawdownPct: b.maxDrawdownPct },
    inSample: part(0, cut),
    outOfSample: part(cut, allDays.length),
    splitAt,
    curve,
    trades: trades.slice(-100),
    signals,
  };
}
