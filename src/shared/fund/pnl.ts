// Where the fund's P&L came from (docs/fund.md#the--fund-window): each day's, and what made and lost it by
// asset, by desk and by strategy, realized on closed trades and unrealized on open ones, reconciled to
// the book. Pure: the fund works it out over every proposal it has (server/fund/fund.ts) and the 💼 Fund
// window's Portfolio tab shows it.
import type { NavPoint } from './state.js';
import type { PositionView, Proposal, ProposalStage, Side } from './types.js';

/** P&L in one bucket: an asset, a desk or a strategy. */
export interface PnlLine {
  key: string;
  realized: number;
  unrealized: number;
  /** Closed trades, and how many made money. */
  closed: number;
  wins: number;
  /** Trades open now. */
  open: number;
}

export interface DayPnl {
  day: string;
  /** The day's NAV change, capital paid in or out left aside. */
  pnl: number;
  pct: number;
  nav: number;
}

/** A closed trade. */
export interface ClosedTrade {
  id: string;
  symbol: string;
  side: Side;
  /** Who proposed it: a role, or `people`. */
  by: string;
  strategyId?: string;
  /** How much, unsigned: `side` says which way. */
  qty: number;
  entry: number;
  exit?: number;
  pnl: number;
  returnPct?: number;
  openedAt?: number;
  closedAt: number;
}

export interface PnlReport {
  days: DayPnl[];
  byAsset: PnlLine[];
  byDesk: PnlLine[];
  byStrategy: PnlLine[];
  /** The latest closed trades, newest first. */
  trades: ClosedTrade[];
  /** The book's realized P&L, after fees, that no proposal accounts for (a position a person closed, a fee on a fill no trade owns…). */
  unattributed: number;
}

const OPEN: readonly ProposalStage[] = ['executing', 'monitoring'];
const CLOSED: readonly ProposalStage[] = ['exited', 'reviewed'];
const DAYS_SHOWN = 60;
const TRADES_SHOWN = 40;

/** What an open trade is up or down now, at its position's price. Its qty is signed: a short's is negative. */
function markOf(p: Proposal, prices: Map<string, number>): number | undefined {
  const px = prices.get(p.symbol);
  if (px === undefined || !p.qty || !p.entryPrice) return undefined;
  return (p.side === 'long' ? px - p.entryPrice : p.entryPrice - px) * Math.abs(p.qty);
}

/** `book` is the ledger's realized P&L (before fees) and every fee it has paid, to reconcile the trades against. */
export function pnlReport(proposals: readonly Proposal[], positions: readonly PositionView[], nav: readonly NavPoint[], book: { realizedPnl: number; fees: number }): PnlReport {
  const prices = new Map(positions.map((p) => [p.symbol, p.price]));
  const buckets = { byAsset: new Map<string, PnlLine>(), byDesk: new Map<string, PnlLine>(), byStrategy: new Map<string, PnlLine>() };
  const line = (m: Map<string, PnlLine>, key: string) => {
    let l = m.get(key);
    if (!l) m.set(key, (l = { key, realized: 0, unrealized: 0, closed: 0, wins: 0, open: 0 }));
    return l;
  };
  const trades: ClosedTrade[] = [];
  let attributed = 0;
  for (const p of proposals) {
    const closed = CLOSED.includes(p.stage) && p.pnl !== undefined;
    const open = OPEN.includes(p.stage) && !!p.entryFill;
    if (!closed && !open) continue;
    const by = p.author.kind === 'agent' && p.author.role ? p.author.role : 'people';
    const keys: [Map<string, PnlLine>, string][] = [
      [buckets.byAsset, p.symbol],
      [buckets.byDesk, by],
    ];
    if (p.strategyId) keys.push([buckets.byStrategy, p.strategyId]);
    if (closed) {
      attributed += p.pnl!;
      for (const [m, k] of keys) {
        const l = line(m, k);
        l.realized += p.pnl!;
        l.closed++;
        if (p.pnl! > 0) l.wins++;
      }
      const put = Math.abs(p.qty ?? 0) * (p.entryPrice ?? 0);
      trades.push({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        by,
        ...(p.strategyId ? { strategyId: p.strategyId } : {}),
        qty: Math.abs(p.qty ?? 0),
        entry: p.entryPrice ?? 0,
        ...(p.exitPrice !== undefined ? { exit: p.exitPrice } : {}),
        pnl: p.pnl!,
        ...(put > 0 ? { returnPct: (p.pnl! / put) * 100 } : {}),
        ...(p.history.find((h) => h.stage === 'monitoring') ? { openedAt: p.history.find((h) => h.stage === 'monitoring')!.at } : {}),
        closedAt: p.history.find((h) => h.stage === 'exited')?.at ?? p.updatedAt,
      });
    } else {
      // An open trade's entry fee is already paid: the book has it, and the trade's P&L will.
      attributed -= p.fees ?? 0;
      const m = markOf(p, prices) ?? 0;
      for (const [b, k] of keys) {
        const l = line(b, k);
        l.unrealized += m;
        l.open++;
      }
    }
  }
  const total = (l: PnlLine) => l.realized + l.unrealized;
  const sorted = (m: Map<string, PnlLine>) => [...m.values()].sort((a, b) => Math.abs(total(b)) - Math.abs(total(a)) || a.key.localeCompare(b.key));
  return {
    days: dailyPnl(nav).slice(-DAYS_SHOWN),
    byAsset: sorted(buckets.byAsset),
    byDesk: sorted(buckets.byDesk),
    byStrategy: sorted(buckets.byStrategy),
    trades: trades.sort((a, b) => b.closedAt - a.closedAt).slice(0, TRADES_SHOWN),
    unattributed: Math.round((book.realizedPnl - book.fees - attributed) * 100) / 100,
  };
}

/** Each day's P&L, from the NAV history: the day's last NAV against what it started at. */
export function dailyPnl(nav: readonly NavPoint[]): DayPnl[] {
  const last = new Map<string, NavPoint>();
  for (const p of nav) last.set(p.day, p);
  return [...last.values()].map((p) => ({ day: p.day, pnl: p.nav - p.dayStartNav, pct: p.dayStartNav > 0 ? ((p.nav - p.dayStartNav) / p.dayStartNav) * 100 : 0, nav: p.nav }));
}
