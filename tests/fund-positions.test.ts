import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFill, emptyBook } from '../src/shared/fund/book.js';
import { positionEvent, positionHistory, type PositionEvent } from '../src/shared/fund/positions.js';
import type { Actor, BookState, Fill } from '../src/shared/fund/types.js';

const by: Actor = { kind: 'system', id: 'office', name: 'The office' };
let n = 0;
const fill = (symbol: string, qty: number, price: number, reason: Fill['reason'] = 'entry'): Fill => ({ id: `f${++n}`, at: n * 1000, symbol, qty, price, fee: 1, reason, venue: 'paper', proposalId: `P-${n}`, by });

/** Runs fills through the book as the ledger does, keeping what each did to its position. */
function replay(fills: Fill[]): { book: BookState; events: PositionEvent[] } {
  let book = emptyBook(100_000);
  const events: PositionEvent[] = [];
  for (const f of fills) {
    const before = book;
    book = applyFill(book, f);
    events.push(positionEvent(before, book, f));
  }
  return { book, events };
}

test('each fill says what it did to its position: open, add, reduce, flip and close, at average cost', () => {
  const { book, events } = replay([
    fill('BTC', 1, 100),
    fill('BTC', 1, 120),
    fill('BTC', -0.5, 130),
    fill('BTC', -2.5, 90),
    fill('BTC', 1, 80, 'target'),
    fill('ETH', -3, 10),
  ]);
  assert.deepEqual(events.map((e) => [e.symbol, e.action, e.qtyAfter, e.avgCostAfter]), [
    ['BTC', 'open', 1, 100],
    ['BTC', 'add', 2, 110],
    ['BTC', 'reduce', 1.5, 110],
    // Through flat: 1.5 closed at 90 (a 30 loss on 110), and 1 opened short at 90.
    ['BTC', 'flip', -1, 90],
    ['BTC', 'close', 0, undefined],
    ['ETH', 'open', -3, 10],
  ]);
  assert.deepEqual(events.map((e) => e.realized), [0, 0, 10, -30, 10, 0]);
  // Over the position's life: the long's +10 and -30 carry into the short it flipped into, then its +10.
  assert.deepEqual(events.map((e) => e.realizedOnPosition), [0, 0, 10, -20, -10, 0]);
  assert.equal(events[4].reason, 'target');
  assert.equal(events[4].proposalId, 'P-5');
  // The history agrees with the book.
  assert.equal(book.realizedPnl, events.reduce((s, e) => s + e.realized, 0));
  assert.equal(book.positions.BTC, undefined);
  assert.equal(book.positions.ETH.qty, -3);
});

test('position history reads newest first, for one symbol or all', () => {
  const { events } = replay([fill('BTC', 1, 100), fill('ETH', 1, 10), fill('BTC', -1, 110, 'exit')]);
  assert.deepEqual(positionHistory(events).map((e) => [e.symbol, e.action]), [['BTC', 'close'], ['ETH', 'open'], ['BTC', 'open']]);
  assert.deepEqual(positionHistory(events, { symbol: 'BTC', limit: 1 }).map((e) => e.action), ['close']);
  assert.deepEqual(positionHistory(events, { symbol: 'SOL' }), []);
});
