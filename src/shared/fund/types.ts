// The fund's domain: assets and quotes, the paper book, proposals, risk and the activity log (see
// docs/fund.md). Types only; the code that works on them is beside this file, with no I/O and no
// clock of its own, so the browser shows the same numbers the server enforces.

export const ASSET_CLASSES = ['crypto', 'equity', 'etf', 'index', 'fx', 'commodity', 'rates'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** Something the fund can hold. `symbol` is the fund's own name for it, whatever each source calls it. */
export interface Asset {
  symbol: string;
  name: string;
  class: AssetClass;
  /** What it is, for exposure by sector: "Layer 1", "Semiconductors", "Treasuries". */
  sector: string;
  /** Its correlation bucket: assets that move together share one, and risk caps the net in each. */
  group: string;
  /** What each price source calls it, by adapter id: `{ coinbase: 'BTC-USD' }`, `{ yahoo: 'SPY' }`. */
  feeds: Record<string, string>;
}

/** A price for an asset, from one source. */
export interface Quote {
  symbol: string;
  price: number;
  /** % change over the source's day: 24 hours for crypto, since the last close for equities. */
  changePct?: number;
  /** Value traded over that day, in USD, which liquidity checks size against. */
  volumeUsd?: number;
  /** When the source priced it (ms). */
  at: number;
  /** The adapter it came from: 'coinbase', 'yahoo', 'mock'. */
  source: string;
  /** The source runs behind the market (Yahoo's free quotes). */
  delayed?: boolean;
}

export type Side = 'long' | 'short';

/** Who did something: an agent at a desk (by worker id), a person (by name), or the office itself. */
export interface Actor {
  kind: 'agent' | 'user' | 'system';
  id: string;
  name: string;
  /** The agent's role (see roles.ts). */
  role?: string;
}

export type FillReason = 'entry' | 'exit' | 'stop' | 'target' | 'manual';

/** A trade that happened (on paper): the only thing that changes cash or positions. */
export interface Fill {
  id: string;
  at: number;
  symbol: string;
  /** Signed: bought is positive, sold negative. */
  qty: number;
  /** What it filled at, slippage included. */
  price: number;
  /** In USD. */
  fee: number;
  reason: FillReason;
  /** The venue that filled it: 'paper'. */
  venue: string;
  proposalId?: string;
  by: Actor;
}

/** One holding, as the fills left it. */
export interface Position {
  symbol: string;
  /** Signed: short is negative. */
  qty: number;
  /** What the open quantity cost on average (the price, fees aside). */
  avgCost: number;
  /** Realized on this symbol since the fund began. */
  realizedPnl: number;
  openedAt: number;
  updatedAt: number;
}

/** The book: the starting capital with every fill applied (see book.ts). */
export interface BookState {
  startingCapital: number;
  cash: number;
  positions: Record<string, Position>;
  realizedPnl: number;
  fees: number;
  fills: number;
}

/** The marks a portfolio is measured from: the NAV the day started at, and the highest it's been. */
export interface NavMarks {
  /** The UTC day (YYYY-MM-DD) dayStartNav is for. */
  day: string;
  dayStartNav: number;
  peakNav: number;
}

/** A holding, valued. */
export interface PositionView extends Position {
  name: string;
  class: AssetClass;
  sector: string;
  group: string;
  side: Side;
  /** The price it's valued at, and where from; avgCost when there's no quote. */
  price: number;
  priceAt?: number;
  source?: string;
  /** Signed market value. */
  value: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  /** |value| as a % of NAV. */
  weightPct: number;
}

/** Exposure in one bucket (an asset class, a sector, a correlation group), in USD and as % of NAV. */
export interface Exposure {
  long: number;
  short: number;
  gross: number;
  net: number;
  grossPct: number;
  netPct: number;
}

/** The portfolio, valued at the latest quotes (see valuePortfolio). */
export interface PortfolioView {
  at: number;
  startingCapital: number;
  nav: number;
  cash: number;
  cashPct: number;
  gross: number;
  net: number;
  /** Gross exposure over NAV. */
  leverage: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  /** Since the NAV the day started at. */
  dayPnl: number;
  dayPnlPct: number;
  /** Since the fund began. */
  totalPnl: number;
  totalPnlPct: number;
  peakNav: number;
  /** How far under the high-water mark, as a positive %. */
  drawdownPct: number;
  positions: PositionView[];
  byClass: Record<string, Exposure>;
  bySector: Record<string, Exposure>;
  byGroup: Record<string, Exposure>;
  /** Positions valued without a quote (at their cost). */
  unpriced: string[];
}

// ---- Risk ------------------------------------------------------------------------------------

/** The fund's risk limits, enforced by risk.ts. Percentages are of NAV unless they say otherwise. */
export interface RiskLimits {
  /** The largest single position, |value| as % of NAV. */
  maxPositionPct: number;
  /** Gross exposure per asset class, % of NAV; classes not listed take defaultClassPct. */
  maxClassPct: Partial<Record<AssetClass, number>>;
  defaultClassPct: number;
  /** Net exposure per correlation group, % of NAV. */
  maxGroupPct: number;
  /** The top three positions together, % of NAV. */
  maxTop3Pct: number;
  /** Gross exposure over NAV. */
  maxLeverage: number;
  /** At this drawdown from the high-water mark, nothing new is opened. */
  maxDrawdownPct: number;
  /** At this loss on the day, % of the NAV it started at, nothing new is opened. */
  maxDailyLossPct: number;
  /** The least an asset must trade in a day (USD) to be opened. */
  minLiquidityUsd: number;
  /** The most a trade may be of the day's traded value, %. */
  maxParticipationPct: number;
  /** The most a trade may lose at its stop, % of NAV. */
  maxLossPerTradePct: number;
  /** Every proposal needs a stop. */
  requireStop: boolean;
  allowShorts: boolean;
  allowedClasses: AssetClass[];
  /** Trades smaller than this (USD), after any resizing, are rejected. */
  minTradeUsd: number;
  /** A quote older than this (minutes) is no price at all. */
  maxQuoteAgeMin: number;
}

export type RiskDecision = 'approved' | 'resized' | 'rejected';

/** One check the risk engine ran. A cap says how big the trade may be; a hard check passes or fails. */
export interface RiskCheck {
  id: string;
  label: string;
  pass: boolean;
  /** For a cap: the most the trade may be, in USD. */
  capUsd?: number;
  /** What was measured and against what, in words: "BTC would be 12.0% of NAV; the limit is 10%". */
  detail: string;
}

export interface RiskVerdict {
  decision: RiskDecision;
  requestedUsd: number;
  /** What it may go ahead at: 0 when rejected. */
  approvedUsd: number;
  checks: RiskCheck[];
  /** Why it was resized or rejected, one line each. */
  reasons: string[];
  /** The price it was checked at. */
  price?: number;
  at: number;
}

// ---- Proposals -------------------------------------------------------------------------------

export const PROPOSAL_STAGES = [
  'idea',
  'research',
  'proposed',
  'risk_review',
  'cio_review',
  'user_approval',
  'executing',
  'monitoring',
  'exited',
  'reviewed',
  'rejected',
  'withdrawn',
  'expired',
  'failed',
] as const;
export type ProposalStage = (typeof PROPOSAL_STAGES)[number];

/** What an agent submits. */
export interface ProposalInput {
  symbol: string;
  side: Side;
  /** How big, in USD. */
  sizeUsd: number;
  /** The price it's meant to go in at; at the market when there's none. */
  entry?: number;
  /** Where it's wrong: it's exited there. */
  stop?: number;
  target?: number;
  thesis: string;
  catalyst?: string;
  /** 0–100. */
  confidence: number;
  /** How long it's meant to be held: "3d", "2w", "3m". */
  horizon: string;
  evidence: string[];
  /** The strongest case against. */
  dissent?: string;
  strategyId?: string;
}

export interface StageChange {
  at: number;
  stage: ProposalStage;
  by: Actor;
  note?: string;
}

/** A decision on a proposal by someone who may make it: the CIO or PM, or a person. */
export interface Ruling {
  by: Actor;
  decision: 'approve' | 'reject';
  note?: string;
  at: number;
}

export interface PostTradeReview {
  by: Actor;
  at: number;
  /** Whether the thesis played out, whatever the P&L did. */
  thesisHeld: boolean;
  lessons: string;
}

export interface Proposal extends ProposalInput {
  id: string;
  author: Actor;
  createdAt: number;
  updatedAt: number;
  stage: ProposalStage;
  history: StageChange[];
  /** The risk engine's latest verdict on it. */
  risk?: RiskVerdict;
  cio?: Ruling;
  user?: Ruling;
  /** Filled: signed quantity, at what, and the fills. */
  qty?: number;
  entryPrice?: number;
  entryFill?: string;
  exitPrice?: number;
  exitFill?: string;
  /** Fees paid on its fills so far. */
  fees?: number;
  /** Realized on exit, fees included. */
  pnl?: number;
  review?: PostTradeReview;
}

// ---- Activity --------------------------------------------------------------------------------

export type ActivityKind =
  | 'proposal'
  | 'risk'
  | 'ruling'
  | 'fill'
  | 'exit'
  | 'limits'
  | 'thesis'
  | 'observation'
  | 'status'
  | 'assignment'
  | 'message'
  | 'escalation'
  | 'request'
  | 'routine'
  | 'committee'
  | 'strategy'
  | 'backtest'
  | 'review'
  | 'system';

/** One line of the fund's activity log: what happened, who did it, and what it was about. */
export interface ActivityEvent {
  id: string;
  at: number;
  kind: ActivityKind;
  actor: Actor;
  text: string;
  proposalId?: string;
  symbol?: string;
  /** Something to tell apart at a glance: a risk event, a fill. */
  level?: 'info' | 'good' | 'warn' | 'bad';
}
