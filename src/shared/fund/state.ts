// What the fund keeps and what it shows: its settings, the ledger journal's entries, market data
// beyond prices, and the state the dashboards draw (see docs/fund.md). Types and checks only.
import { checkAsset, cleanSymbol, DEFAULT_WATCHLIST } from './assets.js';
import type { Committee } from './committee.js';
import type { DesksState } from './desks.js';
import { checkBar, DEFAULT_BAR, type Backtest, type StrategyView, type ValidationBar } from './strategy.js';
import type { Actor, Asset, Fill, PortfolioView, Proposal, Quote, RiskLimits } from './types.js';

/** The fund's settings, changed only by a person (⚙️ in the 💼 Fund window). */
export interface FundConfig {
  name: string;
  /** What the paper venue charges, in basis points of what's traded. */
  feeBps: number;
  /** How far past the quote a paper order fills, in basis points, against the trade. */
  slippageBps: number;
  /** Real prices from public sources, or a simulated market (everything it makes says MOCK). */
  market: 'public' | 'mock';
  watchlist: string[];
  /** Assets beyond the defaults (see assets.ts). */
  assets: Asset[];
  /** Proposals go to the CIO (or PM) before a person, when one is at a desk. */
  requireCio: boolean;
  /** A proposal over this % of NAV needs an investment committee's decision before the CIO may back it (0: never). */
  committeeOverPct: number;
  /** A proposal nobody decides on in this long expires. */
  proposalTtlHours: number;
  /** What a strategy's backtest must show before it may trade on paper. */
  validationBar: ValidationBar;
  /** How long a strategy trades on paper before a person may approve it. */
  strategyPaperDays: number;
}

export const DEFAULT_CONFIG: FundConfig = {
  name: 'Agent Office Fund',
  feeBps: 5,
  slippageBps: 5,
  market: 'public',
  watchlist: [...DEFAULT_WATCHLIST],
  assets: [],
  requireCio: true,
  committeeOverPct: 8,
  proposalTtlHours: 24,
  validationBar: DEFAULT_BAR,
  strategyPaperDays: 14,
};

/** The capital a new fund starts with, paid in by the office when the ledger is first made. */
export const DEFAULT_CAPITAL = 1_000_000;

const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** Settings as sent, checked over `base`: what's left out keeps its value. */
export function checkConfig(raw: unknown, base: FundConfig = DEFAULT_CONFIG): { config: FundConfig } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'The settings are an object' };
  const r = raw as Record<string, unknown>;
  const out: FundConfig = { ...base, watchlist: [...base.watchlist], assets: [...base.assets] };
  if (r.name !== undefined) {
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '';
    if (!name) return { error: 'The fund needs a name' };
    out.name = name;
  }
  for (const [k, hi] of [['feeBps', 100], ['slippageBps', 100]] as const)
    if (r[k] !== undefined) {
      const v = num(r[k], 0, hi);
      if (v === undefined) return { error: `${k} is a number from 0 to ${hi}` };
      out[k] = v;
    }
  if (r.market !== undefined) {
    if (r.market !== 'public' && r.market !== 'mock') return { error: "market is 'public' or 'mock'" };
    out.market = r.market;
  }
  if (r.requireCio !== undefined) {
    if (typeof r.requireCio !== 'boolean') return { error: 'requireCio is true or false' };
    out.requireCio = r.requireCio;
  }
  if (r.committeeOverPct !== undefined) {
    const v = num(r.committeeOverPct, 0, 100);
    if (v === undefined) return { error: 'committeeOverPct is from 0 (never) to 100' };
    out.committeeOverPct = v;
  }
  if (r.proposalTtlHours !== undefined) {
    const v = num(r.proposalTtlHours, 1, 24 * 30);
    if (v === undefined) return { error: 'proposalTtlHours is from 1 to 720' };
    out.proposalTtlHours = v;
  }
  if (r.validationBar !== undefined) {
    const b = checkBar(r.validationBar, base.validationBar);
    if ('error' in b) return b;
    out.validationBar = b.bar;
  }
  if (r.strategyPaperDays !== undefined) {
    const v = num(r.strategyPaperDays, 0, 365);
    if (v === undefined) return { error: 'strategyPaperDays is from 0 to 365' };
    out.strategyPaperDays = v;
  }
  if (r.assets !== undefined) {
    if (!Array.isArray(r.assets) || r.assets.length > 200) return { error: 'assets is a list of up to 200' };
    const assets: Asset[] = [];
    for (const a of r.assets) {
      const c = checkAsset(a);
      if ('error' in c) return c;
      assets.push(c.asset);
    }
    out.assets = assets;
  }
  if (r.watchlist !== undefined) {
    if (!Array.isArray(r.watchlist) || r.watchlist.length > 40) return { error: 'watchlist is a list of up to 40 symbols' };
    const list: string[] = [];
    for (const s of r.watchlist) {
      const sym = cleanSymbol(s);
      if (!sym) return { error: `${String(s)} isn't a symbol` };
      if (!list.includes(sym)) list.push(sym);
    }
    out.watchlist = list;
  }
  return { config: out };
}

/**
 * One line of the fund's ledger journal: the only things that change the book (cash paid in or
 * out, fills), the risk limits or the settings. It's hash-chained like every fund journal, so the
 * book, the limits and the settings are all replayed from a record nobody can quietly edit.
 */
export type LedgerEntry =
  | { kind: 'cash'; id: string; at: number; amount: number; note?: string; by: Actor }
  | ({ kind: 'fill' } & Fill)
  | { kind: 'limits'; id: string; at: number; limits: RiskLimits; by: Actor }
  | { kind: 'config'; id: string; at: number; config: FundConfig; by: Actor };

export const SIGNAL_KINDS = ['funding', 'open_interest', 'liquidations', 'etf_flows', 'macro', 'news', 'onchain', 'filings', 'sentiment'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Market data that isn't a price: a funding rate, open interest, a headline, a macro print. */
export interface Signal {
  /** Stable for the same series (kind, symbol, source), so a newer reading replaces an older one. */
  id: string;
  kind: SignalKind;
  symbol?: string;
  label: string;
  value?: number;
  /** '%', 'USD', '%/8h'… */
  unit?: string;
  text?: string;
  url?: string;
  at: number;
  source: string;
  /** Made up by the mock market: never to be traded on as if it were real. */
  mock?: boolean;
}

/** One market data source and how it's doing. */
export interface SourceStatus {
  id: string;
  label: string;
  /** What it gives: 'prices', or the signal kinds. */
  provides: string[];
  ok: boolean;
  /** Its last good answer. */
  at?: number;
  error?: string;
  mock?: boolean;
  delayed?: boolean;
}

export interface MarketState {
  mode: FundConfig['market'];
  /** Whether it's being asked right now: only while the fund is in use or holds something. */
  polling: boolean;
  quotes: Quote[];
  signals: Signal[];
  sources: SourceStatus[];
}

/** The NAV at a moment, with the marks it's measured from: the NAV chart, and where drawdown starts. */
export interface NavPoint {
  at: number;
  nav: number;
  day: string;
  dayStartNav: number;
  peakNav: number;
}

/** Everything the 💼 Fund window and the trading floor's screens show, but the activity log. */
export interface FundState {
  /** Always: this version of the fund only ever trades on paper. */
  paper: true;
  venue: string;
  config: FundConfig;
  limits: RiskLimits;
  portfolio: PortfolioView;
  /** Live proposals, and the latest that finished. */
  proposals: Proposal[];
  market: MarketState;
  /** Recent NAV history. */
  nav: NavPoint[];
  /** The agents holding the fund's roles, each role's record, and the latest messages between desks. */
  desks: DesksState;
  /** Committees still sitting, then the latest finished. */
  committees: Committee[];
  /** The quant lab's strategies, newest first, each with its record on paper. */
  strategies: StrategyView[];
  /** The latest backtests, and each strategy's own (their trades cut to the latest). */
  backtests: Backtest[];
  /** Why the fund isn't trading: its journals don't check out. */
  halted?: string;
  /** What was put right when the journals were read. */
  notes: string[];
}
