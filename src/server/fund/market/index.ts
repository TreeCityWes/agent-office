import type { Asset, Quote } from '../../../shared/fund/types.js';
import type { FundConfig, MarketState, Signal, SourceStatus } from '../../../shared/fund/state.js';
import { MockMarket } from './mock.js';
import { coinbase, okx, yahoo } from './public.js';
import type { Listing, PriceAdapter, SignalAdapter } from './types.js';

/** How long the fund keeps asking for prices after anyone last looked or an agent last asked. */
const WANTED_MS = 10 * 60_000;
/** Each symbol's price history: a point a minute at most, the last day of them. */
const HISTORY_EVERY_MS = 60_000;
const HISTORY_POINTS = 24 * 60;
const TIMEOUT_MS = 10_000;

export interface PricePoint {
  at: number;
  price: number;
}

export interface MarketOptions {
  mode: FundConfig['market'];
  /** The fund's assets right now (its settings can add some). */
  assets: () => ReadonlyMap<string, Asset>;
  /** Whether prices are needed even with nobody looking: something's held, or a proposal is live. */
  mustWatch: () => boolean;
  /** New prices came in. */
  onQuotes: () => void;
  /** Stands in for the real sources, by mode (tests). */
  adapters?: (mode: FundConfig['market']) => { prices: PriceAdapter[]; signals: SignalAdapter[] };
  now?: () => number;
}

/**
 * The fund's one market data layer: every agent, the risk engine and every screen read prices from
 * here, so they all see the same ones. It asks its sources (the public ones, or the mock market)
 * only while the fund is in use or holds something, so an office that never opens the fund never
 * calls out to anyone.
 */
export class MarketData {
  private quotes = new Map<string, Quote>();
  private history = new Map<string, PricePoint[]>();
  private signalMap = new Map<string, Signal>();
  private status = new Map<string, SourceStatus>();
  private lastRun = new Map<string, number>();
  private running = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private wantedUntil = 0;
  private on = false;
  private sources!: { prices: PriceAdapter[]; signals: SignalAdapter[] };
  private now: () => number;
  private mode: FundConfig['market'];

  constructor(private opts: MarketOptions) {
    this.now = opts.now ?? Date.now;
    this.mode = opts.mode;
    this.use(opts.mode);
  }

  private use(mode: FundConfig['market']) {
    this.mode = mode;
    if (this.opts.adapters) this.sources = this.opts.adapters(mode);
    else if (mode === 'mock') {
      const mock = new MockMarket();
      this.sources = { prices: [mock.prices], signals: [mock.signalSource] };
    } else this.sources = { prices: [coinbase, yahoo], signals: [okx] };
    this.status.clear();
    for (const a of [...this.sources.prices, ...this.sources.signals])
      this.status.set(a.id, { id: a.id, label: a.label, provides: 'provides' in a ? [...a.provides] : ['prices'], ok: false, ...(a.mock ? { mock: true } : {}), ...('delayed' in a && a.delayed ? { delayed: true } : {}) });
  }

  /** Switches between public sources and the mock market, dropping every price from the other. */
  setMode(mode: FundConfig['market']) {
    if (mode === this.mode) return;
    this.quotes.clear();
    this.history.clear();
    this.signalMap.clear();
    this.lastRun.clear();
    this.use(mode);
    this.restartTimers();
    if (this.polling()) void this.refreshAll();
  }

  /** Someone is looking (the 💼 Fund window) or an agent asked: keep prices coming for a while. */
  touch() {
    const was = this.polling();
    this.wantedUntil = this.now() + WANTED_MS;
    if (!was) void this.refreshAll(true);
  }

  polling(): boolean {
    return this.now() < this.wantedUntil || this.opts.mustWatch();
  }

  start() {
    this.on = true;
    this.restartTimers();
    if (this.polling()) void this.refreshAll();
  }

  stop() {
    this.on = false;
    this.clearTimers();
  }

  private clearTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private restartTimers() {
    this.clearTimers();
    if (!this.on) return;
    for (const a of [...this.sources.prices, ...this.sources.signals]) {
      const t = setInterval(() => {
        if (this.polling()) void this.refresh(a);
      }, a.everyMs);
      t.unref();
      this.timers.push(t);
    }
  }
  /** Asks every source now; with `onlyStale`, only those not asked within their own interval. */
  async refreshAll(onlyStale = false) {
    const now = this.now();
    await Promise.all([...this.sources.prices, ...this.sources.signals].filter((a) => {
      const last = this.lastRun.get(a.id);
      return !onlyStale || last === undefined || now - last >= a.everyMs;
    }).map((a) => this.refresh(a)));
  }

  private listings(feed: string): Listing[] {
    const out: Listing[] = [];
    for (const a of this.opts.assets().values()) if (a.feeds[feed]) out.push({ symbol: a.symbol, feed: a.feeds[feed], class: a.class });
    return out;
  }

  private async refresh(a: PriceAdapter | SignalAdapter) {
    if (this.running.has(a.id)) return;
    const mode = this.mode;
    const listings = this.listings(a.mock ? 'mock' : a.id);
    if (!listings.length) return;
    this.running.add(a.id);
    this.lastRun.set(a.id, this.now());
    const st = this.status.get(a.id);
    try {
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      if ('quotes' in a) {
        const got = await a.quotes(listings, signal);
        if (mode !== this.mode) return;
        for (const q of got) this.put(q);
      } else {
        const got = await a.signals(listings, signal);
        if (mode !== this.mode) return;
        for (const s of got) this.signalMap.set(s.id, s);
      }
      if (st) Object.assign(st, { ok: true, at: this.now(), error: undefined });
      if ('quotes' in a) this.opts.onQuotes();
    } catch (err) {
      if (st) Object.assign(st, { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running.delete(a.id);
    }
  }

  private put(q: Quote) {
    this.quotes.set(q.symbol, q);
    let h = this.history.get(q.symbol);
    if (!h) this.history.set(q.symbol, (h = []));
    const last = h.at(-1);
    if (last && q.at - last.at < HISTORY_EVERY_MS) last.price = q.price;
    else {
      h.push({ at: q.at, price: q.price });
      if (h.length > HISTORY_POINTS) h.splice(0, h.length - HISTORY_POINTS);
    }
  }

  quote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol);
  }

  /** Every price there is, by symbol. */
  all(): ReadonlyMap<string, Quote> {
    return this.quotes;
  }

  priceHistory(symbol: string): PricePoint[] {
    return this.history.get(symbol) ?? [];
  }

  signals(filter: { kind?: string; symbol?: string } = {}): Signal[] {
    return [...this.signalMap.values()].filter((s) => (!filter.kind || s.kind === filter.kind) && (!filter.symbol || s.symbol === filter.symbol)).sort((a, b) => b.at - a.at);
  }

  state(): MarketState {
    return {
      mode: this.mode,
      polling: this.polling(),
      quotes: [...this.quotes.values()],
      signals: this.signals(),
      sources: [...this.status.values()].map((s) => ({ ...s })),
    };
  }
}
