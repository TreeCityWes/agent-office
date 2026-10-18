// What each fill did to its position: opened it, added to it, cut it, closed it or flipped it through
// flat, and where that left it. Pure, from the book before and after the fill, so the position history
// the dashboard and the agents read is the ledger's own arithmetic (book.ts), not a second count.
import type { Actor, BookState, Fill, FillReason } from './types.js';

export const POSITION_ACTIONS = ['open', 'add', 'reduce', 'close', 'flip'] as const;
export type PositionAction = (typeof POSITION_ACTIONS)[number];

export interface PositionEvent {
  /** The fill's id. */
  id: string;
  at: number;
  symbol: string;
  action: PositionAction;
  /** Signed, as the fill: bought is positive. */
  qty: number;
  price: number;
  fee: number;
  reason: FillReason;
  proposalId?: string;
  by: Actor;
  /** The position after: its signed quantity (0 once closed) and average cost (none once closed). */
  qtyAfter: number;
  avgCostAfter?: number;
  /** Realized by this fill, and over the position's life so far (from when it opened). */
  realized: number;
  realizedOnPosition: number;
}

/** What `fill` did to its position, given the book before it and after it. */
export function positionEvent(before: BookState, after: BookState, fill: Fill): PositionEvent {
  const was = before.positions[fill.symbol];
  const now = after.positions[fill.symbol];
  const held = was?.qty ?? 0;
  const qtyAfter = now?.qty ?? 0;
  const action: PositionAction = !held ? 'open' : !qtyAfter ? 'close' : Math.sign(qtyAfter) !== Math.sign(held) ? 'flip' : Math.abs(qtyAfter) > Math.abs(held) ? 'add' : 'reduce';
  const realized = after.realizedPnl - before.realizedPnl;
  return {
    id: fill.id,
    at: fill.at,
    symbol: fill.symbol,
    action,
    qty: fill.qty,
    price: fill.price,
    fee: fill.fee,
    reason: fill.reason,
    ...(fill.proposalId ? { proposalId: fill.proposalId } : {}),
    by: fill.by,
    qtyAfter,
    ...(now ? { avgCostAfter: now.avgCost } : {}),
    realized,
    // A flip opens the new side with what the old one realized; a close takes it with it.
    realizedOnPosition: now?.realizedPnl ?? (was?.realizedPnl ?? 0) + realized,
  };
}

/** Newest first, for one symbol or all, at most `limit`. */
export function positionHistory(events: readonly PositionEvent[], opts: { symbol?: string; limit?: number } = {}): PositionEvent[] {
  const out: PositionEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < (opts.limit ?? 100); i--) if (!opts.symbol || events[i].symbol === opts.symbol) out.push(events[i]);
  return out;
}
