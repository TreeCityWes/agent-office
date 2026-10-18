import { randomUUID } from 'node:crypto';
import type { Actor, Fill, FillReason, Quote } from '../../shared/fund/types.js';

/** An order for a venue: a signed quantity of one asset, and why. */
export interface Order {
  symbol: string;
  /** Signed: buy positive, sell negative. */
  qty: number;
  reason: FillReason;
  proposalId?: string;
  by: Actor;
}

/**
 * Where orders go to be filled. Brokers plug in here later, behind the same risk checks and
 * approvals; this version of the fund refuses any venue that says it's live (see Fund).
 */
export interface ExecutionVenue {
  id: string;
  label: string;
  /** Real money. Never true in this version: the fund won't start on such a venue. */
  live: boolean;
  execute(order: Order, quote: Quote, now: number): Promise<Fill>;
}

/**
 * Fills on paper at the latest quote, a little worse by the slippage and less the fee, both in basis
 * points from the fund's settings. Nothing leaves the machine.
 */
export class PaperVenue implements ExecutionVenue {
  readonly id = 'paper';
  readonly label = 'Paper';
  readonly live = false;

  constructor(private costs: () => { feeBps: number; slippageBps: number }) {}

  async execute(order: Order, quote: Quote, now: number): Promise<Fill> {
    if (!(quote.price > 0) || !Number.isFinite(order.qty) || order.qty === 0) throw new Error(`Can't fill ${order.qty} ${order.symbol} at ${quote.price}`);
    const { feeBps, slippageBps } = this.costs();
    const price = quote.price * (1 + (Math.sign(order.qty) * slippageBps) / 10_000);
    const fee = Math.round(Math.abs(order.qty) * price * feeBps) / 10_000;
    return {
      id: randomUUID(),
      at: now,
      symbol: order.symbol,
      qty: order.qty,
      price,
      fee,
      reason: order.reason,
      venue: this.id,
      ...(order.proposalId ? { proposalId: order.proposalId } : {}),
      by: order.by,
    };
  }
}
