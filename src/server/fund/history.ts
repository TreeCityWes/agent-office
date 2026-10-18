// Daily price history for the quant lab's backtests (docs/fund.md#strategies-and-backtests): from the
// same free sources as the fund's prices (Coinbase candles for crypto, Yahoo Finance for listed
// assets), or a simulated history in the mock market. Each series is cached in the fund's folder
// (history/<symbol>.<source>.json) for half a day, and hashed, so a backtest records exactly which
// prices it ran on. A source that fails says so; nothing quietly falls back to made-up prices.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Bar } from '../../shared/fund/backtest.js';
import type { Asset, AssetClass } from '../../shared/fund/types.js';
import { BASE, seeded, VOL } from './market/mock.js';
import { getJson, n } from './market/types.js';

const DAY_MS = 86_400_000;
const FRESH_MS = 12 * 3_600_000;
const TIMEOUT_MS = 30_000;

/** A source of daily closes, keyed in each asset's `feeds` by its id like the price adapters. */
export interface HistorySource {
  id: string;
  label: string;
  mock?: boolean;
  /** Daily closes for the source's name for an asset, oldest first, from `from` to `to` (ms). */
  daily(feed: string, cls: AssetClass, from: number, to: number, signal: AbortSignal): Promise<Bar[]>;
}

/** Coinbase Exchange's daily candles, 300 a request, paged back from `to`. */
export const coinbaseHistory: HistorySource = {
  id: 'coinbase',
  label: 'Coinbase Exchange',
  async daily(feed, _cls, from, to, signal) {
    const out = new Map<number, number>();
    for (let end = to; end > from; end -= 300 * DAY_MS) {
      const start = Math.max(from, end - 300 * DAY_MS);
      const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(feed)}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
      const rows = (await getJson(url, signal)) as unknown[];
      if (!Array.isArray(rows)) throw new Error('Coinbase sent no candles');
      // [time, low, high, open, close, volume], newest first.
      for (const row of rows) {
        const t = Array.isArray(row) ? n(row[0]) : undefined;
        const c = Array.isArray(row) ? n(row[4]) : undefined;
        if (t && c && c > 0) out.set(Math.floor((t * 1000) / DAY_MS), c);
      }
      if (rows.length === 0 && out.size) break;
    }
    return [...out].sort(([a], [b]) => a - b).map(([d, c]) => ({ t: d * DAY_MS, c }));
  },
};

/** Yahoo Finance's daily chart, adjusted for splits and dividends. */
export const yahooHistory: HistorySource = {
  id: 'yahoo',
  label: 'Yahoo Finance',
  async daily(feed, _cls, from, to, signal) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(feed)}?period1=${Math.floor(from / 1000)}&period2=${Math.floor(to / 1000)}&interval=1d&events=div%2Csplit`;
    const body = (await getJson(url, signal)) as { chart?: { result?: { timestamp?: unknown[]; indicators?: { adjclose?: { adjclose?: unknown[] }[]; quote?: { close?: unknown[] }[] } }[] } };
    const r = body.chart?.result?.[0];
    const times = r?.timestamp ?? [];
    const closes = r?.indicators?.adjclose?.[0]?.adjclose ?? r?.indicators?.quote?.[0]?.close ?? [];
    const out = new Map<number, number>();
    times.forEach((t, i) => {
      const s = n(t);
      const c = n(closes[i]);
      if (s && c && c > 0) out.set(Math.floor((s * 1000) / DAY_MS), c);
    });
    return [...out].sort(([a], [b]) => a - b).map(([d, c]) => ({ t: d * DAY_MS, c }));
  },
};

/** Where the simulated histories start. */
const ORIGIN_DAY = Math.floor(Date.UTC(2014, 0, 1) / DAY_MS);

/**
 * A simulated history: a random walk whose drift itself wanders, so it has trends and chop for the
 * strategies to find or lose money on. The same symbol always walks the same way, and the walk is
 * scaled to end at the mock market's price for it. Listed assets skip weekends. Marked mock.
 */
export const mockHistory: HistorySource = {
  id: 'mock',
  label: 'Mock market (simulated)',
  mock: true,
  async daily(feed, cls, from, to) {
    let seed = 0x9e3779b9;
    for (const ch of feed) seed = Math.imul(seed ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    const rand = seeded(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand());
    const sigma = VOL[cls] ?? 0.3;
    const weekdays = cls !== 'crypto';
    const perYear = weekdays ? 252 : 365;
    const dt = 1 / perYear;
    let drift = 0;
    let logP = 0;
    const days: { d: number; x: number }[] = [];
    for (let d = ORIGIN_DAY; d <= Math.floor(to / DAY_MS); d++) {
      const dow = (d + 4) % 7; // 1970-01-01 was a Thursday
      if (weekdays && (dow === 0 || dow === 6)) continue;
      // The drift wanders: a regime lasts a few months, and its yearly drift is typically within ±0.8σ.
      drift = 0.99 * drift + 0.8 * sigma * Math.sqrt(1 - 0.99 * 0.99) * gauss();
      logP += (drift - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * gauss();
      days.push({ d, x: logP });
    }
    const end = days[days.length - 1]?.x ?? 0;
    const base = BASE[feed] ?? 100;
    return days.filter((p) => p.d * DAY_MS >= from).map((p) => ({ t: p.d * DAY_MS, c: Math.round(base * Math.exp(p.x - end) * 1e6) / 1e6 }));
  },
};

export const HISTORY_SOURCES: readonly HistorySource[] = [coinbaseHistory, yahooHistory, mockHistory];

export interface Series {
  symbol: string;
  bars: Bar[];
  source: string;
  mock: boolean;
  /** sha256 of the closes, the first 16 hex digits. */
  hash: string;
}

interface Cached {
  /** How far back it was asked for: a source with less history than that has what it has. */
  asked: number;
  fetchedAt: number;
  bars: Bar[];
}

export const hashBars = (bars: readonly Bar[]) => createHash('sha256').update(bars.map((b) => `${b.t}:${b.c}`).join('\n')).digest('hex').slice(0, 16);

/** The fund's price history: each asset from the first source its feeds name, or the mock one in the mock market. */
export class History {
  private sources: Map<string, HistorySource>;
  private inflight = new Map<string, Promise<Bar[]>>();

  constructor(
    private dir: string,
    private now: () => number = Date.now,
    sources: readonly HistorySource[] = HISTORY_SOURCES,
  ) {
    this.sources = new Map(sources.map((s) => [s.id, s]));
  }

  /** Which source an asset's history comes from, in this market mode. */
  sourceFor(asset: Asset, mode: 'public' | 'mock'): HistorySource | undefined {
    if (mode === 'mock') return this.sources.get('mock');
    return Object.keys(asset.feeds)
      .map((id) => this.sources.get(id))
      .find((s) => s && !s.mock);
  }

  /** `years` of daily closes for an asset, up to today. */
  async series(asset: Asset, mode: 'public' | 'mock', years: number): Promise<Series> {
    const src = this.sourceFor(asset, mode);
    if (!src) throw new Error(`No source has ${asset.symbol}'s history: give it a coinbase or yahoo feed in ⚙️ Settings`);
    const to = this.now();
    const from = to - Math.round(years * 365.25) * DAY_MS;
    const feed = asset.feeds[src.id] ?? asset.symbol;
    const all = await this.cached(src, feed, asset, from, to);
    const bars = all.filter((b) => b.t >= from - DAY_MS);
    if (bars.length < 30) throw new Error(`${src.label} has only ${bars.length} days of ${asset.symbol}: too few to test on`);
    return { symbol: asset.symbol, bars, source: src.id, mock: !!src.mock, hash: hashBars(bars) };
  }

  private file(src: HistorySource, symbol: string) {
    return path.join(this.dir, 'history', `${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}.${src.id}.json`);
  }

  private async cached(src: HistorySource, feed: string, asset: Asset, from: number, to: number): Promise<Bar[]> {
    const file = this.file(src, asset.symbol);
    if (!src.mock) {
      try {
        const c = JSON.parse(readFileSync(file, 'utf8')) as Cached;
        if (c.asked <= from && to - c.fetchedAt < FRESH_MS && Array.isArray(c.bars)) return c.bars;
      } catch {
        // Not cached yet, or unreadable: fetch it.
      }
    }
    const key = `${src.id}:${feed}:${from}`;
    let run = this.inflight.get(key);
    if (!run) {
      run = (async () => {
        const bars = await src.daily(feed, asset.class, from, to, AbortSignal.timeout(TIMEOUT_MS * 4));
        if (!src.mock && bars.length) {
          mkdirSync(path.dirname(file), { recursive: true });
          const tmp = `${file}.tmp`;
          writeFileSync(tmp, JSON.stringify({ asked: from, fetchedAt: to, bars } satisfies Cached));
          renameSync(tmp, file);
        }
        return bars;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, run);
    }
    return run;
  }
}
