import test from 'node:test';
import assert from 'node:assert/strict';
import { assetTable } from '../src/shared/fund/assets.js';
import { MarketData } from '../src/server/fund/market/index.js';
import { MockMarket } from '../src/server/fund/market/mock.js';
import { coinbase, okx, yahoo } from '../src/server/fund/market/public.js';
import type { Listing, PriceAdapter } from '../src/server/fund/market/types.js';

const listings: Listing[] = [
  { symbol: 'BTC', feed: 'BTC', class: 'crypto' },
  { symbol: 'SPY', feed: 'SPY', class: 'etf' },
];

test('the mock market: the same seed gives the same prices, it walks, and all it makes says mock', () => {
  let now = 1_000_000;
  const a = new MockMarket(7, () => now);
  const b = new MockMarket(7, () => now);
  assert.deepEqual(a.quotes(listings), b.quotes(listings));
  const first = a.quotes(listings)[0].price;
  now += 60_000;
  assert.notEqual(a.quotes(listings)[0].price, first);
  for (const q of a.quotes(listings)) assert.equal(q.source, 'mock');
  const signals = a.signals(listings);
  assert.ok(signals.length > 5);
  for (const s of signals) {
    assert.equal(s.mock, true);
    if (s.text) assert.match(s.text, /simulated/);
  }
  assert.deepEqual(new Set(signals.map((s) => s.kind)), new Set(['funding', 'open_interest', 'liquidations', 'etf_flows', 'macro', 'news', 'onchain', 'filings', 'sentiment']));
  // ETF flows for each asset that has US spot ETFs, not bitcoin's alone.
  const crypto = ['BTC', 'ETH', 'SOL', 'DOGE'].map((symbol): Listing => ({ symbol, feed: symbol, class: 'crypto' }));
  assert.deepEqual(a.signals(crypto).filter((s) => s.kind === 'etf_flows').map((s) => [s.id, s.symbol]), [['etf_flows:BTC:mock', 'BTC'], ['etf_flows:ETH:mock', 'ETH'], ['etf_flows:SOL:mock', 'SOL']]);
});

test('market data asks its sources only while something wants prices, and a new mode drops the old prices', async () => {
  let asked = 0;
  let now = 0;
  let held = false;
  const source = (id: string, price: number): PriceAdapter => ({
    id,
    label: id,
    everyMs: 1_000,
    mock: true,
    quotes: async (ls) => {
      asked++;
      return ls.map((l) => ({ symbol: l.symbol, price, at: now, source: id }));
    },
  });
  const md = new MarketData({
    mode: 'public',
    assets: () => assetTable(),
    mustWatch: () => held,
    onQuotes: () => {},
    adapters: (mode) => ({ prices: [source(mode, mode === 'mock' ? 1 : 2)], signals: [] }),
    now: () => now,
  });
  assert.equal(md.polling(), false);
  md.touch();
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1);
  assert.equal(md.quote('BTC')!.price, 2);
  assert.equal(md.state().sources[0].ok, true);
  now += 11 * 60_000;
  assert.equal(md.polling(), false, 'ten minutes after anyone looked, it stops');
  held = true;
  assert.equal(md.polling(), true, 'but not while the fund holds something');
  md.setMode('mock');
  assert.equal(md.quote('BTC'), undefined, 'no price from the other mode lingers');
  await md.refreshAll();
  assert.equal(md.quote('BTC')!.price, 1);
});

test('a source that fails says why, and keeps what it had', async () => {
  let fail = false;
  const md = new MarketData({
    mode: 'public',
    assets: () => assetTable(),
    mustWatch: () => true,
    onQuotes: () => {},
    adapters: () => ({
      prices: [{ id: 'mock', label: 'flaky', everyMs: 1_000, mock: true, quotes: async (ls) => {
        if (fail) throw new Error('down');
        return ls.map((l) => ({ symbol: l.symbol, price: 5, at: 0, source: 'x' }));
      } }],
      signals: [],
    }),
  });
  await md.refreshAll();
  fail = true;
  await md.refreshAll();
  assert.equal(md.state().sources[0].ok, false);
  assert.equal(md.state().sources[0].error, 'down');
  assert.equal(md.quote('BTC')!.price, 5);
});

test('the public sources read what Coinbase, Yahoo and OKX send', async (t) => {
  const bodies: Record<string, unknown> = {
    'api.exchange.coinbase.com': { open: '100000', last: '102000', volume: '20000' },
    'query1.finance.yahoo.com': {
      chart: { result: [{ meta: { regularMarketPrice: 763.25, regularMarketTime: 1792180800, chartPreviousClose: 778.57 }, indicators: { quote: [{ volume: [18_685_000, 25_848_000, 64_035_200], close: [778.1, 771.79, 763.25] }] } }] },
    },
    'www.okx.com': { code: '0', data: [{ fundingRate: '0.0001', oiUsd: '5000000000', ts: '1792310400000' }] },
  };
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(JSON.stringify(bodies[new URL(url).host]), { status: 200 }));
  const signal = AbortSignal.timeout(1_000);
  const [btc] = await coinbase.quotes([{ symbol: 'BTC', feed: 'BTC-USD', class: 'crypto' }], signal);
  assert.equal(btc.price, 102_000);
  assert.equal(btc.changePct, 2);
  assert.equal(btc.volumeUsd, 20_000 * 102_000);
  const [spy] = await yahoo.quotes([{ symbol: 'SPY', feed: 'SPY', class: 'etf' }], signal);
  assert.equal(spy.price, 763.25);
  assert.equal(spy.at, 1792180800_000);
  assert.ok(Math.abs(spy.changePct! - ((763.25 - 771.79) / 771.79) * 100) < 1e-9, 'the change is from the last close, not the window’s start');
  assert.equal(spy.volumeUsd, ((18_685_000 + 25_848_000) / 2) * 763.25, 'today’s half-day volume is left out of the average');
  const sigs = await okx.signals([{ symbol: 'BTC', feed: 'BTC-USDT-SWAP', class: 'crypto' }], signal);
  assert.deepEqual(sigs.map((s) => [s.kind, s.value]), [['funding', 0.01], ['open_interest', 5e9]]);
});
