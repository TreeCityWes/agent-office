import type { AssetClass, Quote } from '../../../shared/fund/types.js';
import type { Signal, SignalKind } from '../../../shared/fund/state.js';

/** An asset as one source knows it: the fund's symbol, and the source's own name for it. */
export interface Listing {
  symbol: string;
  feed: string;
  class: AssetClass;
}

/** A source of prices: one adapter per provider, keyed in each asset's `feeds` by its id. */
export interface PriceAdapter {
  id: string;
  label: string;
  /** How often it's asked, ms. */
  everyMs: number;
  delayed?: boolean;
  mock?: boolean;
  /** Prices for what it lists; a listing it can't price is left out, and it throws only when nothing worked. */
  quotes(listings: Listing[], signal: AbortSignal): Promise<Quote[]>;
}

/** A source of signals (funding rates, open interest, headlines…), asked for the listings it has a feed for. */
export interface SignalAdapter {
  id: string;
  label: string;
  everyMs: number;
  provides: SignalKind[];
  mock?: boolean;
  signals(listings: Listing[], signal: AbortSignal): Promise<Signal[]>;
}

/** A GET that gives JSON, or throws saying why, within `signal`'s time. */
export async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { 'user-agent': 'Mozilla/5.0 (agent-office fund)', accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

/** Runs `each` on every listing at once, keeping what worked; throws the first error only when nothing did. */
export async function eachListing<T>(listings: Listing[], each: (l: Listing) => Promise<T | undefined>): Promise<T[]> {
  const settled = await Promise.allSettled(listings.map(each));
  const out: T[] = [];
  let failed: unknown;
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      if (s.value !== undefined) out.push(s.value);
    } else failed ??= s.reason;
  }
  if (!out.length && failed) throw failed instanceof Error ? failed : new Error(String(failed));
  return out;
}

/** A finite number from a provider's field (often a string), or undefined. */
export const n = (v: unknown): number | undefined => {
  const x = typeof v === 'string' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
};
