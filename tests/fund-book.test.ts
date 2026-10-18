import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFill, emptyBook, rollMarks, utcDay, valuePortfolio } from '../src/shared/fund/book.js';
import { assetTable } from '../src/shared/fund/assets.js';
import type { BookState, Fill, Quote } from '../src/shared/fund/types.js';

const assets = assetTable();
const by = { kind: 'user', id: 'u', name: 'Wes' } as const;
let n = 0;
const fill = (symbol: string, qty: number, price: number, fee = 0, at = 1_000): Fill => ({ id: `f${++n}`, at, symbol, qty, price, fee, reason: 'manual', venue: 'paper', by });
const quote = (symbol: string, price: number, at = 1_000): Quote => ({ symbol, price, at, source: 'mock' });
const quotes = (...qs: Quote[]) => new Map(qs.map((q) => [q.symbol, q]));
const replay = (book: BookState, ...fills: Fill[]) => fills.reduce(applyFill, book);

test('buying opens a position at the fill price, and fees come out of cash apart from realized P&L', () => {
  const b = replay(emptyBook(1_000_000), fill('BTC', 1, 50_000, 25));
  assert.equal(b.cash, 1_000_000 - 50_000 - 25);
  assert.deepEqual({ qty: b.positions.BTC.qty, avg: b.positions.BTC.avgCost }, { qty: 1, avg: 50_000 });
  assert.equal(b.fees, 25);
  assert.equal(b.realizedPnl, 0);
  assert.equal(b.fills, 1);
});

test('adding blends the average cost; reducing realizes against it and keeps the average', () => {
  let b = replay(emptyBook(1_000_000), fill('BTC', 1, 50_000), fill('BTC', 1, 60_000));
  assert.equal(b.positions.BTC.avgCost, 55_000);
  b = applyFill(b, fill('BTC', -1, 70_000));
  assert.equal(b.realizedPnl, 15_000);
  assert.equal(b.positions.BTC.qty, 1);
  assert.equal(b.positions.BTC.avgCost, 55_000);
  assert.equal(b.positions.BTC.realizedPnl, 15_000);
});

test('selling through flat closes the long and opens a short at the fill price', () => {
  let b = replay(emptyBook(1_000_000), fill('ETH', 2, 3_000, 0, 1), fill('ETH', -5, 2_500, 0, 2));
  assert.equal(b.realizedPnl, -1_000);
  assert.equal(b.positions.ETH.qty, -3);
  assert.equal(b.positions.ETH.avgCost, 2_500);
  assert.equal(b.positions.ETH.openedAt, 2);
  // Covering the short at a lower price is a profit, and a flat position is gone.
  b = applyFill(b, fill('ETH', 3, 2_000));
  assert.equal(b.realizedPnl, -1_000 + 1_500);
  assert.equal(b.positions.ETH, undefined);
  assert.equal(b.cash, 1_000_000 + 500);
});

test('a round trip leaves cash at capital plus realized minus fees, without floating point crumbs', () => {
  const b = replay(emptyBook(100_000), fill('SOL', 0.1, 123.45, 0.01), fill('SOL', 0.2, 130.1, 0.01), fill('SOL', -0.3, 140.7, 0.01));
  assert.equal(b.positions.SOL, undefined);
  assert.ok(Math.abs(b.cash - (100_000 + b.realizedPnl - b.fees)) < 1e-6);
});

test('valuing the book: NAV, gross and net, leverage, weights and exposure by class, sector and group', () => {
  const b = replay(emptyBook(1_000_000), fill('BTC', 2, 50_000), fill('NVDA', -1_000, 100), fill('ETH', 10, 3_000));
  const p = valuePortfolio(b, quotes(quote('BTC', 60_000), quote('NVDA', 90), quote('ETH', 3_000)), assets, undefined, 1_000);
  // cash: 1,000,000 - 100,000 + 100,000 - 30,000 = 970,000; values: BTC 120,000, NVDA -90,000, ETH 30,000.
  assert.equal(p.cash, 970_000);
  assert.equal(p.nav, 970_000 + 120_000 - 90_000 + 30_000);
  assert.equal(p.gross, 240_000);
  assert.equal(p.net, 60_000);
  assert.ok(Math.abs(p.leverage - 240_000 / 1_030_000) < 1e-12);
  assert.equal(p.unrealizedPnl, 20_000 + 10_000);
  assert.deepEqual(p.positions.map((x) => x.symbol), ['BTC', 'NVDA', 'ETH']);
  const nvda = p.positions.find((x) => x.symbol === 'NVDA')!;
  assert.equal(nvda.side, 'short');
  assert.ok(Math.abs(nvda.unrealizedPct - 10) < 1e-9);
  assert.equal(p.byClass.crypto.gross, 150_000);
  assert.equal(p.byClass.equity.net, -90_000);
  assert.equal(p.byGroup['crypto-beta'].net, 150_000);
  assert.equal(p.bySector.Semiconductors.short, 90_000);
  assert.ok(Math.abs(p.byClass.crypto.grossPct - (150_000 / 1_030_000) * 100) < 1e-9);
  assert.equal(p.totalPnl, 30_000);
});

test('a position without a quote is valued at its cost and said to be unpriced', () => {
  const b = replay(emptyBook(1_000_000), fill('AAPL', 100, 200));
  const p = valuePortfolio(b, quotes(), assets, undefined, 1_000);
  assert.deepEqual(p.unpriced, ['AAPL']);
  assert.equal(p.nav, 1_000_000);
  assert.equal(p.unrealizedPnl, 0);
});

test('the marks: a new UTC day starts from the NAV seen, the peak only rises, and drawdown is measured from it', () => {
  const day1 = Date.UTC(2026, 9, 1, 12);
  const day2 = Date.UTC(2026, 9, 2, 0, 1);
  let m = rollMarks(undefined, 1_000_000, day1);
  assert.deepEqual(m, { day: utcDay(day1), dayStartNav: 1_000_000, peakNav: 1_000_000 });
  m = rollMarks(m, 1_100_000, day1);
  assert.equal(m.dayStartNav, 1_000_000);
  assert.equal(m.peakNav, 1_100_000);
  m = rollMarks(m, 990_000, day2);
  assert.deepEqual(m, { day: '2026-10-02', dayStartNav: 990_000, peakNav: 1_100_000 });
  const b = replay(emptyBook(1_000_000), fill('BTC', 1, 100_000));
  const p = valuePortfolio(b, quotes(quote('BTC', 80_000)), assets, { day: '2026-10-02', dayStartNav: 1_000_000, peakNav: 1_100_000 }, day2);
  assert.equal(p.nav, 980_000);
  assert.equal(p.dayPnl, -20_000);
  assert.ok(Math.abs(p.drawdownPct - (120_000 / 1_100_000) * 100) < 1e-9);
});
