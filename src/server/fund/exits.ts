// Taking trades off: one trade at its stop or target, or by a person's hand, and a whole position at
// once. Exits only ever reduce: never more than the trade put on, nor more than the position still
// holds, so an exit can't open anything.
import { price, signedUsd } from '../../shared/fund/format.js';
import { STAGE_LABEL } from '../../shared/fund/proposals.js';
import type { ActivityEvent, Actor, Fill, Proposal, ProposalStage } from '../../shared/fund/types.js';
import type { MarketData } from './market/index.js';
import type { Ledger, ProposalRecords } from './records.js';
import type { ExecutionVenue } from './venue.js';

type Result<T extends object> = ({ ok: true } & T) | { error: string };

/** What exits need of the fund (see Fund). */
export interface Trading {
  ledger: Ledger;
  proposals: ProposalRecords;
  market: MarketData;
  venue: ExecutionVenue;
  now: () => number;
  move(p: Proposal, to: ProposalStage, by: Actor, note?: string): Proposal;
  log(kind: ActivityEvent['kind'], by: Actor, text: string, extra?: Pick<ActivityEvent, 'proposalId' | 'symbol' | 'level'>): void;
  notedFill(): void;
}

const VERB = { stop: 'Stopped out of', target: 'Took profit on', exit: 'Closed' } as const;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How old a price is, in words, when it's older than risk would trade on. */
function stale(f: Trading, at: number): string {
  const min = Math.round((f.now() - at) / 60_000);
  return min > f.ledger.limits.maxQuoteAgeMin ? `, on a price ${min} min old` : '';
}

/** One open trade taken off at the market: at its stop, its target, or by hand. */
export async function exitProposal(f: Trading, p: Proposal, reason: keyof typeof VERB, by: Actor): Promise<Result<{ proposal: Proposal }>> {
  if (p.stage !== 'monitoring') return { error: `${p.id} is ${STAGE_LABEL[p.stage]}: only an open trade is exited` };
  const quote = f.market.quote(p.symbol);
  if (!quote) return { error: `There's no price for ${p.symbol} to exit at` };
  const held = f.ledger.book.positions[p.symbol]?.qty ?? 0;
  const mine = p.qty ?? 0;
  const closing = Math.sign(held) === Math.sign(mine) ? Math.sign(mine) * Math.min(Math.abs(mine), Math.abs(held)) : 0;
  let fill: Fill | undefined;
  if (closing !== 0) {
    try {
      fill = await f.venue.execute({ symbol: p.symbol, qty: -closing, reason, proposalId: p.id, by }, quote, f.now());
    } catch (err) {
      f.log('exit', by, `Couldn't exit ${p.id}: ${message(err)}`, { proposalId: p.id, symbol: p.symbol, level: 'bad' });
      return { error: `Couldn't exit ${p.id}: ${message(err)}` };
    }
    f.ledger.append({ kind: 'fill', ...fill });
  }
  const exitPrice = fill?.price ?? quote.price;
  const fees = (p.fees ?? 0) + (fill?.fee ?? 0);
  // On what it closed; when the position had already gone flat (another trade netted it), on what it put on.
  const pnl = (exitPrice - (p.entryPrice ?? exitPrice)) * (closing || mine) - fees;
  const note = reason === 'stop' ? `Stop ${price(p.stop ?? exitPrice)} hit` : reason === 'target' ? `Target ${price(p.target ?? exitPrice)} hit` : undefined;
  const next: Proposal = { ...f.move(p, 'exited', by, note), exitPrice, ...(fill ? { exitFill: fill.id } : {}), fees, pnl };
  f.proposals.put(next);
  if (fill) f.notedFill();
  const flat = fill ? '' : ' (the position was already flat, so nothing filled)';
  f.log('exit', by, `${VERB[reason]} ${p.symbol} ${p.side} (${p.id}) at ${price(exitPrice)}${stale(f, quote.at)}: ${signedUsd(pnl)}${flat}`, { proposalId: p.id, symbol: p.symbol, level: pnl >= 0 ? 'good' : 'bad' });
  return { ok: true, proposal: next };
}

/** A whole position closed at the market, and every open trade in it marked exited at that fill. */
export async function closePosition(f: Trading, symbol: string, by: Actor): Promise<Result<{ symbol: string }>> {
  const pos = f.ledger.book.positions[symbol];
  if (!pos) return { error: `The fund holds no ${symbol}` };
  const quote = f.market.quote(symbol);
  if (!quote) return { error: `There's no price for ${symbol} to close at` };
  const before = f.ledger.book.realizedPnl;
  let fill: Fill;
  try {
    fill = await f.venue.execute({ symbol, qty: -pos.qty, reason: 'manual', by }, quote, f.now());
  } catch (err) {
    return { error: `Couldn't close ${symbol}: ${message(err)}` };
  }
  f.ledger.append({ kind: 'fill', ...fill });
  for (const p of f.proposals.list()) {
    if (p.stage !== 'monitoring' || p.symbol !== symbol || Math.sign(p.qty ?? 0) !== Math.sign(pos.qty)) continue;
    const share = Math.min(1, Math.abs(p.qty ?? 0) / Math.abs(pos.qty));
    const fees = (p.fees ?? 0) + fill.fee * share;
    const pnl = (fill.price - (p.entryPrice ?? fill.price)) * (p.qty ?? 0) - fees;
    f.proposals.put({ ...f.move(p, 'exited', by, `The whole ${symbol} position was closed`), exitPrice: fill.price, exitFill: fill.id, fees, pnl });
  }
  f.notedFill();
  const realized = f.ledger.book.realizedPnl - before - fill.fee;
  f.log('exit', by, `Closed the whole ${symbol} ${pos.qty > 0 ? 'long' : 'short'} (${Math.abs(pos.qty).toPrecision(6)}) at ${price(fill.price)}${stale(f, quote.at)}: ${signedUsd(realized)} after fees`, { symbol, level: realized >= 0 ? 'good' : 'bad' });
  return { ok: true, symbol };
}
