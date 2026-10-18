// The mock market: prices that walk at random from where the real ones roughly are, and made-up
// signals of every kind the fund has no free source for yet. Everything it makes is marked mock and
// says so, so nobody mistakes a simulated headline for news. Time runs 60× fast here, so a demo has
// something happen in it: an hour of watching moves about as much as a real day.
import type { AssetClass, Quote } from '../../../shared/fund/types.js';
import type { Signal } from '../../../shared/fund/state.js';
import type { Listing, PriceAdapter, SignalAdapter } from './types.js';

const BASE: Record<string, number> = {
  BTC: 100_000, ETH: 4_000, SOL: 200, XRP: 2.5, DOGE: 0.25, LINK: 20, AVAX: 35,
  SPY: 600, QQQ: 520, IWM: 220, AAPL: 230, MSFT: 450, NVDA: 150, AMZN: 200, TSLA: 300, JPM: 240,
  XOM: 115, COIN: 280, MSTR: 350, TLT: 90, GLD: 280, USO: 75, IBIT: 55,
};
/** Yearly volatility by class. */
const VOL: Record<AssetClass, number> = { crypto: 0.6, equity: 0.35, etf: 0.18, index: 0.18, rates: 0.12, commodity: 0.25, fx: 0.08 };
/** Value traded per day, USD. */
const VOLUME: Record<AssetClass, number> = { crypto: 1e9, equity: 2e9, etf: 5e9, index: 5e9, rates: 1e9, commodity: 1e9, fx: 5e9 };
const SPEED = 60;
const YEAR_MS = 365 * 24 * 3600 * 1000;

/** A small seeded random number generator (mulberry32), so a seed gives the same market every time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Walk {
  price: number;
  open: number;
  day: number;
  at: number;
}

export class MockMarket {
  private rand: () => number;
  private walks = new Map<string, Walk>();
  readonly prices: PriceAdapter;
  readonly signalSource: SignalAdapter;

  constructor(
    seed = Date.now(),
    private now: () => number = Date.now,
  ) {
    this.rand = seeded(seed);
    this.prices = { id: 'mock', label: 'Mock market (simulated)', everyMs: 5_000, mock: true, quotes: async (l) => this.quotes(l) };
    this.signalSource = {
      id: 'mock-signals',
      label: 'Mock signals (simulated)',
      everyMs: 60_000,
      mock: true,
      provides: ['funding', 'open_interest', 'liquidations', 'etf_flows', 'macro', 'news', 'onchain', 'filings', 'sentiment'],
      signals: async (l) => this.signals(l),
    };
  }

  /** A normal draw (Box–Muller). */
  private gauss(): number {
    const u = Math.max(1e-12, this.rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  quotes(listings: Listing[]): Quote[] {
    const now = this.now();
    const day = Math.floor(now / 86_400_000);
    return listings.map((l) => {
      let w = this.walks.get(l.symbol);
      if (!w) {
        const start = (BASE[l.symbol] ?? 100) * (1 + (this.rand() - 0.5) * 0.04);
        w = { price: start, open: start, day, at: now };
        this.walks.set(l.symbol, w);
      } else {
        const dt = (Math.max(0, now - w.at) * SPEED) / YEAR_MS;
        const sigma = VOL[l.class] ?? 0.3;
        w.price *= Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * this.gauss());
        w.at = now;
        if (w.day !== day) Object.assign(w, { open: w.price, day });
      }
      return { symbol: l.symbol, price: w.price, changePct: ((w.price - w.open) / w.open) * 100, volumeUsd: VOLUME[l.class] ?? 1e9, at: now, source: 'mock' };
    });
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)];
  }

  signals(listings: Listing[]): Signal[] {
    const at = this.now();
    const out: Signal[] = [];
    const mk = (s: Omit<Signal, 'at' | 'source' | 'mock'>) => out.push({ ...s, at, source: 'mock', mock: true });
    const crypto = listings.filter((l) => l.class === 'crypto');
    const listed = listings.filter((l) => l.class !== 'crypto');
    for (const l of crypto) {
      mk({ id: `funding:${l.symbol}:mock`, kind: 'funding', symbol: l.symbol, label: `${l.symbol} funding`, value: round(0.01 + this.gauss() * 0.012, 4), unit: '%/8h' });
      mk({ id: `open_interest:${l.symbol}:mock`, kind: 'open_interest', symbol: l.symbol, label: `${l.symbol} open interest`, value: Math.round((BASE[l.symbol] ?? 100) * 2e5 * (1 + this.gauss() * 0.05)), unit: 'USD' });
    }
    const liq = this.pick(crypto.length ? crypto : listings);
    if (liq) {
      const longs = this.rand() < 0.5;
      const m = round(5 + this.rand() * 80, 1);
      mk({ id: 'liquidations:mock', kind: 'liquidations', symbol: liq.symbol, label: 'Liquidations, last hour', value: m * 1e6, unit: 'USD', text: `${longs ? 'Longs' : 'Shorts'} liquidated: $${m}M across ${liq.symbol} perps (simulated)` });
    }
    const flow = round(this.gauss() * 250, 0);
    mk({ id: 'etf_flows:mock', kind: 'etf_flows', symbol: 'BTC', label: 'Spot BTC ETF net flow', value: flow * 1e6, unit: 'USD', text: `Spot bitcoin ETFs saw ${flow >= 0 ? 'inflows' : 'outflows'} of $${Math.abs(flow)}M yesterday (simulated)` });
    const macro = this.pick(MACRO);
    const surprise = round(this.gauss() * 0.15, 2);
    mk({ id: 'macro:mock', kind: 'macro', label: macro.name, value: round(macro.base + surprise, 2), unit: macro.unit, text: `${macro.name} came in at ${round(macro.base + surprise, 2)}${macro.unit} vs ${macro.base}${macro.unit} expected (simulated)` });
    const subject = this.pick(listings);
    if (subject) {
      const up = this.rand() < 0.5;
      mk({ id: `news:${subject.symbol}:mock`, kind: 'news', symbol: subject.symbol, label: 'Headline', text: `${subject.symbol}: ${this.pick(up ? NEWS_UP : NEWS_DOWN)} (simulated)` });
    }
    const netflow = round(this.gauss() * 3000, 0);
    mk({ id: 'onchain:mock', kind: 'onchain', symbol: 'BTC', label: 'BTC exchange netflow, 24h', value: netflow, unit: 'BTC', text: `${Math.abs(netflow)} BTC ${netflow >= 0 ? 'moved onto' : 'left'} exchanges in 24h (simulated)` });
    const filer = this.pick(listed.length ? listed : listings);
    if (filer) mk({ id: `filings:${filer.symbol}:mock`, kind: 'filings', symbol: filer.symbol, label: 'Filing', text: `${filer.symbol}: ${this.pick(FILINGS)} (simulated)` });
    mk({ id: 'sentiment:mock', kind: 'sentiment', label: 'Fear & greed', value: Math.round(Math.min(100, Math.max(0, 50 + this.gauss() * 18))), unit: '/100' });
    return out;
  }
}

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

const MACRO = [
  { name: 'US CPI y/y', base: 2.9, unit: '%' },
  { name: 'Core PCE y/y', base: 2.7, unit: '%' },
  { name: 'Unemployment rate', base: 4.2, unit: '%' },
  { name: 'ISM manufacturing', base: 49.5, unit: '' },
  { name: '10y Treasury yield', base: 4.3, unit: '%' },
] as const;
const NEWS_UP = ['beats on earnings and raises guidance', 'upgraded to buy at a major broker', 'wins a large new contract', 'sees heavy call buying ahead of the event'];
const NEWS_DOWN = ['misses estimates as margins slip', 'downgraded on valuation', 'faces a regulatory probe', 'sees a large holder trim its stake'];
const FILINGS = ['10-Q filed; buyback authorization expanded', '13F shows a large fund adding to its position', 'Form 4: a director sold shares', '8-K: guidance updated'];
