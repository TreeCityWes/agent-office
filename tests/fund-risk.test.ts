import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFill, emptyBook, valuePortfolio } from '../src/shared/fund/book.js';
import { assetTable } from '../src/shared/fund/assets.js';
import { DEFAULT_LIMITS, checkLimits, evaluateRisk, type RiskInput } from '../src/shared/fund/risk.js';
import type { Fill, NavMarks, PortfolioView, Quote, RiskLimits } from '../src/shared/fund/types.js';

const assets = assetTable();
const NOW = Date.UTC(2026, 9, 1, 15);
const by = { kind: 'user', id: 'u', name: 'Wes' } as const;
const q = (symbol: string, price: number, volumeUsd = 1e9, ageMin = 1): Quote => ({ symbol, price, volumeUsd, at: NOW - ageMin * 60_000, source: 'mock' });
const PRICES: Record<string, number> = { BTC: 100_000, ETH: 4_000, SOL: 200, SPY: 600, NVDA: 150, AAPL: 250, TLT: 90, GLD: 300 };

/** A $1M book holding `held` (symbol → signed USD value), valued at PRICES. */
function book(held: Record<string, number> = {}, marks?: NavMarks): PortfolioView {
  let b = emptyBook(1_000_000);
  for (const [symbol, value] of Object.entries(held)) {
    const f: Fill = { id: symbol, at: NOW, symbol, qty: value / PRICES[symbol], price: PRICES[symbol], fee: 0, reason: 'manual', venue: 'paper', by };
    b = applyFill(b, f);
  }
  const quotes = new Map(Object.entries(PRICES).map(([s, p]) => [s, q(s, p)]));
  return valuePortfolio(b, quotes, assets, marks, NOW);
}

function risk(over: Partial<RiskInput> & { limits?: Partial<RiskLimits> } = {}) {
  const symbol = over.symbol ?? 'BTC';
  const { limits, ...rest } = over;
  return evaluateRisk({
    symbol,
    side: 'long',
    sizeUsd: 50_000,
    stop: PRICES[symbol] * 0.95,
    portfolio: book(),
    asset: assets.get(symbol),
    quote: q(symbol, PRICES[symbol]),
    now: NOW,
    ...rest,
    limits: { ...DEFAULT_LIMITS, ...limits },
  });
}

const check = (v: ReturnType<typeof evaluateRisk>, id: string) => v.checks.find((c) => c.id === id)!;

test('a trade inside every limit is approved at its size, with every check shown', () => {
  const v = risk();
  assert.equal(v.decision, 'approved');
  assert.equal(v.approvedUsd, 50_000);
  assert.deepEqual(v.reasons, []);
  for (const id of ['size', 'nav', 'asset', 'price', 'stop', 'drawdown', 'daily', 'liquidity', 'allowed', 'position', 'class', 'group', 'leverage', 'participation', 'loss', 'top3'])
    assert.ok(check(v, id)?.pass, id);
  assert.equal(v.price, 100_000);
});

test('too big for the position limit: resized down to it, and says which limit bound', () => {
  const v = risk({ sizeUsd: 300_000 });
  assert.equal(v.decision, 'resized');
  assert.equal(v.approvedUsd, 100_000);
  assert.equal(check(v, 'position').capUsd, 100_000);
  assert.ok(v.reasons.some((r) => r.startsWith('Position size')));
});

test('a wide stop caps the size at what loses 1% of NAV there', () => {
  const v = risk({ sizeUsd: 100_000, stop: 80_000 });
  assert.equal(check(v, 'loss').capUsd, 50_000);
  assert.equal(v.decision, 'resized');
  assert.equal(v.approvedUsd, 50_000);
});

test('the hard checks reject: no stop, a stop on the wrong side, a stale price, an unknown asset, no shorts', () => {
  assert.equal(risk({ stop: undefined }).decision, 'rejected');
  assert.equal(risk({ stop: undefined, limits: { requireStop: false } }).decision, 'approved');
  assert.equal(risk({ stop: 105_000 }).decision, 'rejected');
  assert.equal(risk({ side: 'short', stop: 95_000 }).decision, 'rejected');
  assert.equal(risk({ side: 'short', stop: 105_000 }).decision, 'approved');
  const stale = risk({ quote: q('BTC', 100_000, 1e9, 45) });
  assert.equal(stale.decision, 'rejected');
  assert.match(stale.reasons.join(), /45 min old/);
  assert.equal(risk({ quote: undefined }).decision, 'rejected');
  assert.equal(risk({ symbol: 'BTC', asset: undefined }).decision, 'rejected');
  assert.equal(risk({ side: 'short', stop: 105_000, limits: { allowShorts: false } }).decision, 'rejected');
  assert.equal(risk({ limits: { allowedClasses: ['equity', 'etf'] } }).decision, 'rejected');
  assert.equal(risk({ target: 90_000 }).decision, 'rejected');
  assert.equal(risk({ target: 120_000 }).decision, 'approved');
  assert.equal(risk({ sizeUsd: 0 }).decision, 'rejected');
});

test('the drawdown and daily-loss halts stop all new risk', () => {
  const deep = book({}, { day: '2026-10-01', dayStartNav: 1_000_000, peakNav: 1_200_000 });
  const v = risk({ portfolio: deep });
  assert.equal(v.decision, 'rejected');
  assert.match(v.reasons.join(), /Drawdown halt/);
  const badDay = book({}, { day: '2026-10-01', dayStartNav: 1_040_000, peakNav: 1_040_000 });
  assert.ok(badDay.dayPnlPct < -3);
  assert.match(risk({ portfolio: badDay }).reasons.join(), /Daily loss halt/);
});

test('thin markets: under the liquidity floor is rejected; the participation cap resizes', () => {
  assert.equal(risk({ quote: q('BTC', 100_000, 1_000_000) }).decision, 'rejected');
  assert.equal(risk({ quote: { ...q('BTC', 100_000), volumeUsd: undefined } }).decision, 'rejected');
  const v = risk({ quote: q('BTC', 100_000, 6_000_000) });
  assert.equal(check(v, 'participation').capUsd, 60_000);
  assert.equal(risk({ sizeUsd: 80_000, quote: q('BTC', 100_000, 6_000_000) }).approvedUsd, 60_000);
});

test('cut below the minimum trade, it is rejected rather than sent as a crumb', () => {
  const v = risk({ portfolio: book({ BTC: 99_500 }), sizeUsd: 5_000 });
  assert.equal(check(v, 'position').capUsd, 500);
  assert.equal(v.decision, 'rejected');
  assert.match(v.reasons.at(-1)!, /under the \$1,000 minimum/);
});

test('taking risk off is always allowed back to flat, even past a limit', () => {
  const over = book({ BTC: 150_000 });
  const v = risk({ portfolio: over, side: 'short', sizeUsd: 150_000, stop: 105_000 });
  assert.equal(check(v, 'position').capUsd, 250_000);
  assert.equal(v.decision, 'approved');
});

test('correlation groups cap the net: long ETH crowds out long BTC, and a short ETH makes room', () => {
  const crowded = book({ ETH: 250_000 });
  const v = risk({ portfolio: crowded, sizeUsd: 100_000, limits: { maxTop3Pct: 100 } });
  assert.equal(check(v, 'group').capUsd, 50_000);
  assert.equal(v.approvedUsd, 50_000);
  const hedged = book({ ETH: 250_000, SOL: -100_000 });
  assert.equal(check(risk({ portfolio: hedged, sizeUsd: 100_000, limits: { maxTop3Pct: 100 } }), 'group').capUsd, 150_000);
});

test('asset-class gross and leverage caps', () => {
  const v = risk({ portfolio: book({ ETH: 100_000, SOL: 90_000 }), sizeUsd: 100_000, limits: { maxClassPct: { crypto: 25 } } });
  assert.equal(check(v, 'class').capUsd, 60_000);
  const lev = risk({ symbol: 'SPY', portfolio: book({ NVDA: 95_000, AAPL: 95_000, TLT: 90_000 }), sizeUsd: 50_000, limits: { maxLeverage: 0.3 } });
  assert.equal(check(lev, 'leverage').capUsd, 20_000);
  assert.equal(lev.approvedUsd, 20_000);
});

test('the top three positions together stay under their limit', () => {
  const p = book({ NVDA: 90_000, TLT: 90_000, GLD: 60_000 });
  const v = risk({ portfolio: p, sizeUsd: 80_000 });
  assert.ok(Math.abs(check(v, 'top3').capUsd! - 70_000) <= 1, String(check(v, 'top3').capUsd));
  assert.equal(v.decision, 'resized');
  // Already over: a small new position leaves the top three as they are, but adding to one doesn't.
  const over = book({ NVDA: 95_000, AAPL: 95_000, TLT: 90_000 });
  assert.equal(check(risk({ symbol: 'GLD', portfolio: over, sizeUsd: 20_000 }), 'top3').capUsd, 20_000);
  assert.equal(check(risk({ symbol: 'NVDA', portfolio: over, sizeUsd: 20_000 }), 'top3').capUsd, 0);
});

test('the same inputs always give the same verdict', () => {
  assert.deepEqual(risk({ sizeUsd: 123_456 }), risk({ sizeUsd: 123_456 }));
});

test('limits as sent are checked: out of range is refused, and what is left out keeps its value', () => {
  assert.deepEqual(checkLimits({ maxPositionPct: 0 }), { error: 'maxPositionPct must be a number from 0.1 to 100' });
  assert.ok('error' in checkLimits({ maxLeverage: '2' }));
  assert.ok('error' in checkLimits({ maxClassPct: { stocks: 10 } }));
  assert.ok('error' in checkLimits({ allowedClasses: ['crypto', 'nft'] }));
  assert.ok('error' in checkLimits({ requireStop: 'yes' }));
  const r = checkLimits({ maxPositionPct: 5, maxClassPct: { crypto: 20 }, allowShorts: false });
  assert.ok('limits' in r);
  assert.equal(r.limits.maxPositionPct, 5);
  assert.deepEqual(r.limits.maxClassPct, { crypto: 20 });
  assert.equal(r.limits.allowShorts, false);
  assert.equal(r.limits.maxLeverage, DEFAULT_LIMITS.maxLeverage);
});
