// The rest of the fund's free public signals, beside OKX's funding and open interest (public.ts):
// liquidations from OKX, the bitcoin network from mempool.space, headlines from Yahoo Finance, US
// macro series from FRED, filings from SEC EDGAR and the crypto fear & greed index from
// alternative.me, with US spot bitcoin ETF flows from bitbo.io (etf.ts). None needs a key.
import { usd } from '../../../shared/fund/format.js';
import type { Signal } from '../../../shared/fund/state.js';
import { bitbo } from './etf.js';
import { allOk, eachListing, getJson, getText, n, type SignalAdapter } from './types.js';

const HOUR = 3_600_000;
const round2 = (x: number) => Math.round(x * 100) / 100;
const httpUrl = (s: string | undefined) => (s && /^https?:\/\//.test(s) ? s : undefined);

/** Each swap's contract size in its coin (0.01 BTC for BTC-USDT-SWAP), which doesn't change. */
const contractSizes = new Map<string, number>();

/**
 * OKX's filled liquidation orders on each perpetual swap: what was forced out in the last hour, in
 * USD, longs and shorts apart. OKX gives only the latest 100, so on a wild hour the text says how far
 * back those go.
 */
export const okxLiquidations: SignalAdapter = {
  id: 'okx-liquidations',
  label: 'OKX liquidations',
  feed: 'okx',
  everyMs: 5 * 60_000,
  provides: ['liquidations'],
  signals: (listings, signal) =>
    eachListing(listings, async (l): Promise<Signal | undefined> => {
      let size = contractSizes.get(l.feed);
      if (size === undefined) {
        const inst = (await getJson(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(l.feed)}`, signal)) as { data?: Record<string, unknown>[] };
        size = n(inst.data?.[0]?.ctVal);
        if (!size) return undefined;
        contractSizes.set(l.feed, size);
      }
      const family = encodeURIComponent(l.feed.replace(/-SWAP$/, ''));
      const body = (await getJson(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instFamily=${family}&state=filled&limit=100`, signal)) as { data?: { instId?: string; details?: Record<string, unknown>[] }[] };
      const now = Date.now();
      let longs = 0;
      let shorts = 0;
      let count = 0;
      let oldest = now;
      for (const d of body.data ?? []) {
        if (d.instId && d.instId !== l.feed) continue;
        for (const x of d.details ?? []) {
          const at = n(x.ts);
          const px = n(x.bkPx);
          const sz = n(x.sz);
          if (!at || !px || !sz) continue;
          count++;
          oldest = Math.min(oldest, at);
          if (now - at > HOUR) continue;
          // A liquidated long is sold out of; in net mode the position side doesn't say, the order's side does.
          if (x.posSide === 'long' || (x.posSide !== 'short' && x.side === 'sell')) longs += sz * size * px;
          else shorts += sz * size * px;
        }
      }
      const partial = count >= 100 && now - oldest < HOUR ? ` (at least: OKX's latest 100 go back only ${Math.max(1, Math.round((now - oldest) / 60_000))} min)` : '';
      return {
        id: `liquidations:${l.symbol}:okx`,
        kind: 'liquidations',
        symbol: l.symbol,
        label: `${l.symbol} liquidations, last hour`,
        value: Math.round(longs + shorts),
        unit: 'USD',
        text: `${usd(longs, { compact: true })} of longs and ${usd(shorts, { compact: true })} of shorts liquidated on OKX ${l.symbol} perps in the last hour${partial}`,
        at: now,
        source: 'okx',
      };
    }),
};

/** The bitcoin network from mempool.space: the fee to get into the next block, the queue waiting, and the hashrate. */
export const mempool: SignalAdapter = {
  id: 'mempool',
  label: 'mempool.space (bitcoin network)',
  global: true,
  everyMs: 10 * 60_000,
  provides: ['onchain'],
  signals(_listings, signal) {
    const at = Date.now();
    const api = (p: string) => getJson(`https://mempool.space/api/${p}`, signal) as Promise<Record<string, unknown>>;
    const sig = (key: string, s: Pick<Signal, 'label' | 'value' | 'unit' | 'text'>): Signal => ({ id: `onchain:BTC:${key}:mempool`, kind: 'onchain', symbol: 'BTC', ...s, url: 'https://mempool.space/', at, source: 'mempool.space' });
    return allOk([
      api('v1/fees/recommended').then((f) => {
        const fast = n(f.fastestFee);
        return fast === undefined ? undefined : sig('fees', { label: 'BTC next-block fee', value: fast, unit: 'sat/vB', text: `Next block ${fast} sat/vB, within half an hour ${n(f.halfHourFee) ?? '?'}, within an hour ${n(f.hourFee) ?? '?'}` });
      }),
      api('mempool').then((m) => {
        const count = n(m.count);
        const vsize = n(m.vsize) ?? 0;
        return count === undefined ? undefined : sig('mempool', { label: 'BTC transactions waiting', value: count, unit: 'tx', text: `${count.toLocaleString('en-US')} unconfirmed transactions, ${(vsize / 1e6).toFixed(1)} MvB waiting for a block` });
      }),
      api('v1/mining/hashrate/3d').then((h) => {
        const rate = n(h.currentHashrate);
        const difficulty = n(h.currentDifficulty);
        return rate === undefined ? undefined : sig('hashrate', { label: 'BTC hashrate', value: Math.round(rate / 1e18), unit: 'EH/s', text: `Hashrate ${Math.round(rate / 1e18)} EH/s${difficulty ? `, difficulty ${(difficulty / 1e12).toFixed(1)}T` : ''}` });
      }),
    ]);
  },
};

/** The items of an RSS feed that have a title and a date. */
export function rssItems(xml: string): { title: string; link?: string; at: number }[] {
  const out: { title: string; link?: string; at: number }[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const title = tag(m[1], 'title');
    const at = Date.parse(tag(m[1], 'pubDate') ?? '');
    if (title && Number.isFinite(at)) out.push({ title: title.slice(0, 240), link: httpUrl(tag(m[1], 'link')), at });
  }
  return out;
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  if (!m) return undefined;
  const raw = m[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
  const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return raw.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()])).trim() || undefined;
}

/** How many of each asset's latest headlines and filings the fund keeps. */
const NEWS_EACH = 3;
const FILINGS_EACH = 3;

/** Yahoo Finance's latest headlines for each asset, from its RSS feed (a coin by its Yahoo pair, BTC-USD). */
export const yahooNews: SignalAdapter = {
  id: 'yahoo-news',
  label: 'Yahoo Finance headlines',
  feed: 'news',
  everyMs: 15 * 60_000,
  provides: ['news'],
  async signals(listings, signal) {
    const each = await eachListing(listings, async (l) => {
      const xml = await getText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(l.feed)}&region=US&lang=en-US`, signal);
      const items = rssItems(xml).sort((a, b) => b.at - a.at).slice(0, NEWS_EACH);
      return items.map((it, i): Signal => ({ id: `news:${l.symbol}:yahoo:${i}`, kind: 'news', symbol: l.symbol, label: `${l.symbol} headline`, text: it.title, ...(it.link ? { url: it.link } : {}), at: it.at, source: 'yahoo' }));
    });
    return each.flat();
  },
};

const FRED_SERIES = [
  { id: 'UNRATE', name: 'US unemployment rate' },
  { id: 'CPIAUCSL', name: 'US CPI y/y', yoy: true },
  { id: 'FEDFUNDS', name: 'Fed funds rate (effective)' },
  { id: 'DGS10', name: '10y Treasury yield', daily: true },
] as const;

/** A FRED CSV download's readings, oldest first, without the days it has none ('.'). */
export function fredRows(csv: string): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [date, v] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^-?\d/.test(v?.trim() ?? '')) continue;
    const value = n(v.trim());
    if (value !== undefined) out.push({ date, value });
  }
  return out;
}

/** A monthly index as its change on the same month a year before, %. */
function yearOnYear(rows: { date: string; value: number }[]): { date: string; value: number }[] {
  const byDate = new Map(rows.map((r) => [r.date, r.value]));
  return rows.flatMap((r) => {
    const before = byDate.get(`${Number(r.date.slice(0, 4)) - 1}${r.date.slice(4)}`);
    return before ? [{ date: r.date, value: (r.value / before - 1) * 100 }] : [];
  });
}

/**
 * US macro series from FRED's CSV downloads, which need no key: unemployment, CPI as its change on a
 * year before, the effective fed funds rate and the 10-year yield, each its latest reading and the
 * one before, dated by the period it's for.
 */
export const fred: SignalAdapter = {
  id: 'fred',
  label: 'FRED (St. Louis Fed)',
  global: true,
  everyMs: 6 * HOUR,
  provides: ['macro'],
  signals(_listings, signal) {
    const since = new Date(Date.now() - 15 * 31 * 86_400_000).toISOString().slice(0, 10);
    return allOk(
      FRED_SERIES.map(async (s): Promise<Signal | undefined> => {
        const rows = fredRows(await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.id}&cosd=${since}`, signal));
        const series = 'yoy' in s ? yearOnYear(rows) : rows;
        const last = series.at(-1);
        const prev = series.at(-2);
        if (!last) return undefined;
        const period = 'daily' in s ? last.date : new Date(`${last.date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
        return {
          id: `macro:${s.id}:fred`,
          kind: 'macro',
          label: s.name,
          value: round2(last.value),
          unit: '%',
          text: `${s.name} ${round2(last.value)}% for ${period}${prev ? `, from ${round2(prev.value)}%` : ''}`,
          url: `https://fred.stlouisfed.org/series/${s.id}`,
          at: Date.parse(`${last.date}T00:00:00Z`),
          source: 'fred',
        };
      }),
    );
  },
};

/** SEC EDGAR asks callers to say who they are. */
const SEC_AGENT = 'agent-office/0.1 (self-hosted paper fund)';
/** The filings worth a desk's attention, and what each is; amendments (/A) count too. */
const FORMS: Record<string, string> = {
  '10-K': '10-K (annual report)',
  '10-Q': '10-Q (quarterly report)',
  '8-K': '8-K (current report)',
  '4': 'Form 4 (insider trade)',
  '144': 'Form 144 (planned insider sale)',
  'S-1': 'S-1 (registration)',
  'S-3': 'S-3 (shelf registration)',
  'DEF 14A': 'DEF 14A (proxy)',
  'SC 13D': 'SC 13D (activist stake)',
  'SC 13G': 'SC 13G (5%+ stake)',
  'SCHEDULE 13D': 'Schedule 13D (activist stake)',
  'SCHEDULE 13G': 'Schedule 13G (5%+ stake)',
  '20-F': '20-F (annual report)',
  '6-K': '6-K (current report)',
};

/**
 * Each company's latest filings from SEC EDGAR, by its CIK (an asset's `sec` feed): the newest of each
 * kind worth reading, up to three, linked to the document. An 8-K says which items it reports
 * (2.02 is results, 5.02 a change of officers).
 */
export const sec: SignalAdapter = {
  id: 'sec',
  label: 'SEC EDGAR filings',
  everyMs: HOUR,
  provides: ['filings'],
  async signals(listings, signal) {
    const each = await eachListing(listings, async (l) => {
      const cik = l.feed.replace(/^0+/, '');
      if (!/^\d{1,10}$/.test(cik)) return undefined;
      const body = (await getJson(`https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`, signal, SEC_AGENT)) as { filings?: { recent?: Record<string, unknown[] | undefined> } };
      const r = body.filings?.recent ?? {};
      const out: Signal[] = [];
      const seen = new Set<string>();
      const forms = r.form ?? [];
      for (let i = 0; i < forms.length && out.length < FILINGS_EACH; i++) {
        const form = String(forms[i]);
        const base = form.replace(/\/A$/, '');
        if (!FORMS[base] || seen.has(base)) continue;
        const accession = String(r.accessionNumber?.[i] ?? '');
        const filed = String(r.filingDate?.[i] ?? '');
        const at = Date.parse(String(r.acceptanceDateTime?.[i] ?? '')) || Date.parse(filed);
        if (!/^[\d-]+$/.test(accession) || !Number.isFinite(at)) continue;
        seen.add(base);
        const doc = String(r.primaryDocument?.[i] ?? '');
        const items = String(r.items?.[i] ?? '').trim();
        out.push({
          id: `filings:${l.symbol}:sec:${out.length}`,
          kind: 'filings',
          symbol: l.symbol,
          label: `${l.symbol} ${form}`,
          text: `${l.symbol} filed ${FORMS[base]}${form !== base ? ', amended,' : ''} on ${filed}${items ? `: items ${items}` : ''}`,
          url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${/^[\w./-]+$/.test(doc) ? doc : ''}`,
          at,
          source: 'sec',
        });
      }
      return out;
    });
    return each.flat();
  },
};

/** alternative.me's crypto fear & greed index, 0 (extreme fear) to 100 (extreme greed), and the day before's. */
export const fearGreed: SignalAdapter = {
  id: 'fear-greed',
  label: 'Crypto fear & greed (alternative.me)',
  global: true,
  everyMs: HOUR,
  provides: ['sentiment'],
  async signals(_listings, signal) {
    const body = (await getJson('https://api.alternative.me/fng/?limit=2', signal)) as { data?: Record<string, unknown>[] };
    const [today, before] = body.data ?? [];
    const value = n(today?.value);
    if (value === undefined) throw new Error('alternative.me sent no reading');
    const prev = n(before?.value);
    return [
      {
        id: 'sentiment:crypto:alternative.me',
        kind: 'sentiment',
        label: 'Crypto fear & greed',
        value,
        unit: '/100',
        text: `${String(today.value_classification ?? '')} at ${value}/100${prev !== undefined ? `, from ${prev} the day before` : ''}`,
        url: 'https://alternative.me/crypto/fear-and-greed-index/',
        at: (n(today.timestamp) ?? Date.now() / 1000) * 1000,
        source: 'alternative.me',
      },
    ];
  },
};

/** The public signal sources after OKX's funding and open interest, in the order the market tab lists them. */
export const PUBLIC_SIGNALS: readonly SignalAdapter[] = [okxLiquidations, bitbo, mempool, yahooNews, fred, sec, fearGreed];
