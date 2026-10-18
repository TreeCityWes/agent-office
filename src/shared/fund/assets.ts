// The assets the fund knows out of the box, and checking ones added in its settings. Each says what
// it is (class, sector, correlation group) and what each source calls it: `news` is its Yahoo
// headlines symbol, `sec` the company's SEC EDGAR CIK, `bitbo` the bitbo.io page of its US spot ETFs'
// daily flows.
import { ASSET_CLASSES, type Asset, type AssetClass } from './types.js';

const crypto = (symbol: string, name: string, sector: string, group = 'crypto-beta'): Asset => ({
  symbol,
  name,
  class: 'crypto',
  sector,
  group,
  feeds: { coinbase: `${symbol}-USD`, okx: `${symbol}-USDT-SWAP`, news: `${symbol}-USD`, mock: symbol },
});
const withEtfFlows = (a: Asset, page: string): Asset => ({ ...a, feeds: { ...a.feeds, bitbo: page } });
const listed = (symbol: string, name: string, cls: AssetClass, sector: string, group: string, cik?: number): Asset => ({
  symbol,
  name,
  class: cls,
  sector,
  group,
  feeds: { yahoo: symbol, news: symbol, ...(cik ? { sec: String(cik) } : {}), mock: symbol },
});

export const DEFAULT_ASSETS: readonly Asset[] = [
  withEtfFlows(crypto('BTC', 'Bitcoin', 'Store of value'), 'etf-flows'),
  crypto('ETH', 'Ethereum', 'Layer 1'),
  crypto('SOL', 'Solana', 'Layer 1'),
  crypto('XRP', 'XRP', 'Payments'),
  crypto('DOGE', 'Dogecoin', 'Memecoin'),
  crypto('LINK', 'Chainlink', 'Oracles'),
  crypto('AVAX', 'Avalanche', 'Layer 1'),
  listed('SPY', 'SPDR S&P 500 ETF', 'etf', 'Broad market', 'us-equity'),
  listed('QQQ', 'Invesco QQQ (Nasdaq 100)', 'etf', 'Broad market', 'us-tech'),
  listed('IWM', 'iShares Russell 2000', 'etf', 'Small caps', 'us-equity'),
  listed('AAPL', 'Apple', 'equity', 'Technology', 'us-tech', 320193),
  listed('MSFT', 'Microsoft', 'equity', 'Technology', 'us-tech', 789019),
  listed('NVDA', 'NVIDIA', 'equity', 'Semiconductors', 'us-tech', 1045810),
  listed('AMZN', 'Amazon', 'equity', 'Consumer', 'us-tech', 1018724),
  listed('TSLA', 'Tesla', 'equity', 'Autos', 'us-tech', 1318605),
  listed('JPM', 'JPMorgan Chase', 'equity', 'Financials', 'us-equity', 19617),
  listed('XOM', 'Exxon Mobil', 'equity', 'Energy', 'energy', 34088),
  listed('COIN', 'Coinbase', 'equity', 'Financials', 'crypto-beta', 1679788),
  listed('MSTR', 'Strategy (MicroStrategy)', 'equity', 'Technology', 'crypto-beta', 1050446),
  listed('TLT', 'iShares 20+ Year Treasury', 'rates', 'Treasuries', 'duration'),
  listed('GLD', 'SPDR Gold Shares', 'commodity', 'Gold', 'gold'),
  listed('USO', 'United States Oil Fund', 'commodity', 'Oil', 'energy'),
  listed('IBIT', 'iShares Bitcoin Trust', 'etf', 'Spot bitcoin ETF', 'crypto-beta'),
];

/** What the market screens follow until someone changes it. */
export const DEFAULT_WATCHLIST: readonly string[] = ['BTC', 'ETH', 'SOL', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'TLT', 'GLD'];

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-]{0,15}$/;

/** A symbol as the fund writes it, or undefined when it can't be one. */
export function cleanSymbol(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toUpperCase();
  return SYMBOL.test(s) ? s : undefined;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** An asset added in the fund's settings, checked; or why it can't be one. */
export function checkAsset(raw: unknown): { asset: Asset } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'An asset is an object' };
  const r = raw as Record<string, unknown>;
  const symbol = cleanSymbol(r.symbol);
  if (!symbol) return { error: 'An asset needs a symbol: letters, digits, dots and dashes, up to 16' };
  const cls = r.class as AssetClass;
  if (!ASSET_CLASSES.includes(cls)) return { error: `${symbol}: its class is one of ${ASSET_CLASSES.join(', ')}` };
  const feeds: Record<string, string> = {};
  if (r.feeds && typeof r.feeds === 'object')
    for (const [k, v] of Object.entries(r.feeds as Record<string, unknown>)) {
      const id = text(k, 24);
      const name = text(v, 40);
      if (/^[a-z][a-z0-9-]*$/.test(id) && name) feeds[id] = name;
    }
  feeds.mock ??= symbol;
  return {
    asset: {
      symbol,
      name: text(r.name, 60) || symbol,
      class: cls,
      sector: text(r.sector, 40) || 'Other',
      group: text(r.group, 40).toLowerCase() || `${cls}-${symbol.toLowerCase()}`,
      feeds,
    },
  };
}

/** The fund's assets: the defaults, with any added in its settings on top (the same symbol replaces one). */
export function assetTable(extra: readonly Asset[] = []): Map<string, Asset> {
  const table = new Map<string, Asset>();
  for (const a of DEFAULT_ASSETS) table.set(a.symbol, a);
  for (const a of extra) table.set(a.symbol, a);
  return table;
}
