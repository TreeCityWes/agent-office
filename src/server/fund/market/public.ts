// The free public sources the fund starts with: Coinbase for crypto prices, Yahoo Finance for
// listed prices, OKX for perpetual funding rates and open interest. None needs a key.
import type { Quote } from '../../../shared/fund/types.js';
import type { Signal } from '../../../shared/fund/state.js';
import { eachListing, getJson, n, type PriceAdapter, type SignalAdapter } from './types.js';

/** Coinbase Exchange's 24-hour stats: the last trade, the open 24 hours ago, and the volume since. */
export const coinbase: PriceAdapter = {
  id: 'coinbase',
  label: 'Coinbase Exchange',
  everyMs: 15_000,
  quotes: (listings, signal) =>
    eachListing(listings, async (l): Promise<Quote | undefined> => {
      const s = (await getJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(l.feed)}/stats`, signal)) as Record<string, unknown>;
      const last = n(s.last);
      const open = n(s.open);
      const volume = n(s.volume);
      if (!last || last <= 0) return undefined;
      return {
        symbol: l.symbol,
        price: last,
        ...(open && open > 0 ? { changePct: ((last - open) / open) * 100 } : {}),
        ...(volume && volume > 0 ? { volumeUsd: volume * last } : {}),
        at: Date.now(),
        source: 'coinbase',
      };
    }),
};

/**
 * Yahoo Finance's chart endpoint over five sessions: the latest price and when it traded, the day's
 * change from the last close, and the average value traded per session (today's half-day aside) for
 * the liquidity checks. Outside market hours the price is the last close, as old as it is, and risk
 * won't open anything on a price that old.
 */
export const yahoo: PriceAdapter = {
  id: 'yahoo',
  label: 'Yahoo Finance',
  everyMs: 60_000,
  delayed: true,
  quotes: (listings, signal) =>
    eachListing(listings, async (l): Promise<Quote | undefined> => {
      const body = (await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(l.feed)}?range=5d&interval=1d`, signal)) as {
        chart?: { result?: { meta?: Record<string, unknown>; indicators?: { quote?: { volume?: unknown[]; close?: unknown[] }[] } }[] };
      };
      const r = body.chart?.result?.[0];
      const meta = r?.meta ?? {};
      const price = n(meta.regularMarketPrice);
      const time = n(meta.regularMarketTime);
      if (!price || price <= 0 || !time) return undefined;
      const closes = (r?.indicators?.quote?.[0]?.close ?? []).map(n).filter((x): x is number => !!x);
      const volumes = (r?.indicators?.quote?.[0]?.volume ?? []).map(n).filter((x): x is number => !!x);
      const full = volumes.length > 1 ? volumes.slice(0, -1) : volumes;
      const avgVolume = full.length ? full.reduce((a, b) => a + b, 0) / full.length : undefined;
      const prev = closes.length > 1 ? closes[closes.length - 2] : n(meta.chartPreviousClose);
      const delay = n(meta.exchangeDataDelayedBy) ?? 0;
      return {
        symbol: l.symbol,
        price,
        ...(prev && prev > 0 ? { changePct: ((price - prev) / prev) * 100 } : {}),
        ...(avgVolume ? { volumeUsd: avgVolume * price } : {}),
        at: time * 1000,
        source: 'yahoo',
        ...(delay > 0 ? { delayed: true } : {}),
      };
    }),
};

/** OKX's public perpetual swap data: the current funding rate and open interest in USD. */
export const okx: SignalAdapter = {
  id: 'okx',
  label: 'OKX perpetuals',
  everyMs: 5 * 60_000,
  provides: ['funding', 'open_interest'],
  async signals(listings, signal) {
    const pairs = await eachListing(listings, async (l): Promise<Signal[]> => {
      const id = encodeURIComponent(l.feed);
      const [fr, oi] = await Promise.all([
        getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`, signal) as Promise<{ data?: Record<string, unknown>[] }>,
        getJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${id}`, signal) as Promise<{ data?: Record<string, unknown>[] }>,
      ]);
      const out: Signal[] = [];
      const rate = n(fr.data?.[0]?.fundingRate);
      if (rate !== undefined)
        out.push({ id: `funding:${l.symbol}:okx`, kind: 'funding', symbol: l.symbol, label: `${l.symbol} funding`, value: rate * 100, unit: '%/8h', at: n(fr.data?.[0]?.ts) ?? Date.now(), source: 'okx' });
      const usd = n(oi.data?.[0]?.oiUsd);
      if (usd !== undefined)
        out.push({ id: `open_interest:${l.symbol}:okx`, kind: 'open_interest', symbol: l.symbol, label: `${l.symbol} open interest`, value: usd, unit: 'USD', at: n(oi.data?.[0]?.ts) ?? Date.now(), source: 'okx' });
      return out;
    });
    return pairs.flat();
  },
};
