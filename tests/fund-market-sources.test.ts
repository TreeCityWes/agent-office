import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { assetTable } from '../src/shared/fund/assets.js';
import { SIGNAL_KINDS } from '../src/shared/fund/state.js';
import { MarketData } from '../src/server/fund/market/index.js';
import { fearGreed, fred, fredRows, mempool, okxLiquidations, rssItems, sec, yahooNews } from '../src/server/fund/market/signals.js';
import { bitbo, flowNumber, flowsTable } from '../src/server/fund/market/etf.js';
import type { Listing, SignalAdapter } from '../src/server/fund/market/types.js';

// The public signal sources against what each provider sends (captured from the real endpoints and
// trimmed), with fetch stubbed so no test calls out.

type Reply = unknown | ((url: URL) => unknown);
/** Stubs fetch with a reply per path (the first whose key the URL's host and path start with); returns what was asked. */
function serve(t: TestContext, replies: Record<string, Reply>) {
  const asked: { url: URL; agent: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input);
    asked.push({ url, agent: init?.headers?.['user-agent'] ?? '' });
    const key = Object.keys(replies).find((k) => `${url.host}${url.pathname}`.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = replies[key];
    const body = typeof r === 'function' ? (r as (u: URL) => unknown)(url) : r;
    if (body instanceof Response) return body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  });
  return asked;
}
const signal = () => AbortSignal.timeout(1_000);
const BTC: Listing = { symbol: 'BTC', feed: 'BTC-USDT-SWAP', class: 'crypto' };

test('OKX liquidations: the last hour in USD, longs and shorts apart, with each contract’s size asked once', async (t) => {
  const now = Date.now();
  const asked = serve(t, {
    'www.okx.com/api/v5/public/instruments': { code: '0', data: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctValCcy: 'BTC' }] },
    'www.okx.com/api/v5/public/liquidation-orders': {
      code: '0',
      data: [
        {
          instId: 'BTC-USDT-SWAP',
          details: [
            { bkPx: '100000', posSide: 'long', side: 'sell', sz: '100', ts: String(now - 10 * 60_000) },
            { bkPx: '101000', posSide: 'short', side: 'buy', sz: '50', ts: String(now - 15 * 60_000) },
            // Net mode: the side says which way it was.
            { bkPx: '100000', posSide: 'net', side: 'sell', sz: '10', ts: String(now - 20 * 60_000) },
            // Over an hour ago.
            { bkPx: '99000', posSide: 'long', side: 'sell', sz: '1000', ts: String(now - 2 * 3_600_000) },
          ],
        },
        { instId: 'BTC-USD-SWAP', details: [{ bkPx: '100000', posSide: 'long', side: 'sell', sz: '999', ts: String(now) }] },
      ],
    },
  });
  const [liq] = await okxLiquidations.signals([BTC], signal());
  assert.equal(liq.id, 'liquidations:BTC:okx');
  assert.equal(liq.kind, 'liquidations');
  assert.equal(liq.value, 100_000 + 50_500 + 10_000);
  assert.equal(liq.text, '$110K of longs and $50.5K of shorts liquidated on OKX BTC perps in the last hour');
  assert.equal(asked.find((a) => a.url.pathname.endsWith('liquidation-orders'))!.url.searchParams.get('instFamily'), 'BTC-USDT');
  await okxLiquidations.signals([BTC], signal());
  assert.equal(asked.filter((a) => a.url.pathname.endsWith('instruments')).length, 1, 'the contract size is kept');
  // It reads each asset's OKX names, not names of its own.
  assert.equal(okxLiquidations.feed, 'okx');
});

test('OKX liquidations say when OKX’s latest 100 don’t cover the hour', async (t) => {
  const now = Date.now();
  const details = Array.from({ length: 100 }, (_, i) => ({ bkPx: '100000', posSide: 'long', side: 'sell', sz: '1', ts: String(now - i * 6_000) }));
  serve(t, {
    'www.okx.com/api/v5/public/instruments': { data: [{ ctVal: '0.01' }] },
    'www.okx.com/api/v5/public/liquidation-orders': { data: [{ instId: 'ETH-USDT-SWAP', details }] },
  });
  const [liq] = await okxLiquidations.signals([{ symbol: 'ETH', feed: 'ETH-USDT-SWAP', class: 'crypto' }], signal());
  assert.match(liq.text!, /at least: OKX's latest 100 go back only 10 min/);
});

test('mempool.space: fees, the queue and the hashrate, keeping what answered', async (t) => {
  serve(t, {
    'mempool.space/api/v1/fees/recommended': { fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 2, minimumFee: 1 },
    'mempool.space/api/mempool': { count: 76362, vsize: 40_512_000, total_fee: 1e7 },
    'mempool.space/api/v1/mining/hashrate/3d': new Response('busy', { status: 503 }),
  });
  assert.equal(mempool.global, true, 'asked with no listings: it’s the network, not an asset');
  const got = await mempool.signals([], signal());
  assert.deepEqual(got.map((s) => [s.id, s.value, s.unit]), [['onchain:BTC:fees:mempool', 12, 'sat/vB'], ['onchain:BTC:mempool:mempool', 76362, 'tx']]);
  assert.equal(got[1].text, '76,362 unconfirmed transactions, 40.5 MvB waiting for a block');
  for (const s of got) assert.equal(s.kind, 'onchain');
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Yahoo! Finance: AAPL News</title>
<item><title>Apple &amp; the iPhone: what&#8217;s next</title><link>https://finance.yahoo.com/news/a.html?.tsrc=rss</link><pubDate>Sat, 17 Oct 2026 20:07:00 +0000</pubDate></item>
<item><title><![CDATA[Older one]]></title><link>https://example.com/b</link><pubDate>Thu, 15 Oct 2026 10:00:00 +0000</pubDate></item>
<item><title>Newest</title><link>javascript:alert(1)</link><pubDate>Sun, 18 Oct 2026 07:00:40 +0000</pubDate></item>
<item><title>Middle</title><link>https://example.com/c</link><pubDate>Fri, 16 Oct 2026 12:00:00 +0000</pubDate></item>
<item><title>No date</title></item>
</channel></rss>`;

test('Yahoo headlines: each asset’s newest three, with only web links kept', async (t) => {
  const items = rssItems(RSS);
  assert.equal(items.length, 4);
  assert.equal(items[0].title, 'Apple & the iPhone: what’s next');
  assert.equal(items[1].title, 'Older one');
  assert.equal(items[2].link, undefined);
  const asked = serve(t, { 'feeds.finance.yahoo.com/rss/2.0/headline': RSS });
  const got = await yahooNews.signals([{ symbol: 'AAPL', feed: 'AAPL', class: 'equity' }, { symbol: 'BTC', feed: 'BTC-USD', class: 'crypto' }], signal());
  assert.deepEqual(asked.map((a) => a.url.searchParams.get('s')), ['AAPL', 'BTC-USD']);
  const aapl = got.filter((s) => s.symbol === 'AAPL');
  assert.deepEqual(aapl.map((s) => s.text), ['Newest', 'Apple & the iPhone: what’s next', 'Middle']);
  assert.deepEqual(aapl.map((s) => s.id), ['news:AAPL:yahoo:0', 'news:AAPL:yahoo:1', 'news:AAPL:yahoo:2']);
  assert.equal(aapl[0].url, undefined);
  assert.equal(aapl[1].url, 'https://finance.yahoo.com/news/a.html?.tsrc=rss');
});

const csv = (id: string, rows: [string, string][]) => [`observation_date,${id}`, ...rows.map((r) => r.join(','))].join('\n');

test('FRED: the latest reading of each series and the one before, CPI as its change on a year before', async (t) => {
  assert.deepEqual(fredRows(csv('DGS10', [['2026-10-14', '5.19'], ['2026-10-15', '.'], ['2026-10-16', '5.10'], ['2026-10-17', '']])), [{ date: '2026-10-14', value: 5.19 }, { date: '2026-10-16', value: 5.1 }]);
  const cpi: [string, string][] = [];
  for (let m = 0; m < 14; m++) {
    const d = new Date(Date.UTC(2025, 7 + m, 1)).toISOString().slice(0, 10);
    cpi.push([d, String(300 * (1 + 0.003 * m))]);
  }
  const bodies: Record<string, string> = {
    UNRATE: csv('UNRATE', [['2026-08-01', '4.1'], ['2026-09-01', '4.2']]),
    CPIAUCSL: csv('CPIAUCSL', cpi),
    FEDFUNDS: csv('FEDFUNDS', [['2026-09-01', '3.75']]),
    DGS10: csv('DGS10', [['2026-10-15', '5.19'], ['2026-10-16', '5.10']]),
  };
  serve(t, { 'fred.stlouisfed.org/graph/fredgraph.csv': (u: URL) => bodies[u.searchParams.get('id')!] });
  assert.equal(fred.global, true);
  const got = await fred.signals([], signal());
  const by = new Map(got.map((s) => [s.id, s]));
  assert.equal(by.get('macro:UNRATE:fred')!.text, 'US unemployment rate 4.2% for Sep 2026, from 4.1%');
  // September 2026 on September 2025: 300·1.039 / 300·1.003.
  assert.equal(by.get('macro:CPIAUCSL:fred')!.value, Math.round((1.039 / 1.003 - 1) * 10_000) / 100);
  assert.equal(by.get('macro:FEDFUNDS:fred')!.text, 'Fed funds rate (effective) 3.75% for Sep 2026');
  assert.equal(by.get('macro:DGS10:fred')!.text, '10y Treasury yield 5.1% for 2026-10-16, from 5.19%');
  assert.equal(by.get('macro:DGS10:fred')!.at, Date.parse('2026-10-16T00:00:00Z'));
  for (const s of got) assert.equal(s.kind, 'macro');
});

test('SEC EDGAR: the newest filing of each kind worth reading, linked, asked as itself', async (t) => {
  const asked = serve(t, {
    'data.sec.gov/submissions/CIK0000320193.json': {
      filings: {
        recent: {
          form: ['424B2', '144', '4', '4', '8-K/A', '10-Q'],
          filingDate: ['2026-10-17', '2026-10-16', '2026-10-15', '2026-10-08', '2026-09-01', '2026-08-01'],
          acceptanceDateTime: ['2026-10-17T21:00:00.000Z', '2026-10-17T00:29:07.000Z', '2026-10-16T02:30:17.000Z', '2026-10-09T02:30:32.000Z', '2026-09-02T00:30:35.000Z', '2026-08-01T20:00:00.000Z'],
          accessionNumber: ['0000000000-26-000001', '0001950047-26-010286', '0001140361-26-039785', '0001140361-26-038000', '0001140361-26-035325', '0000320193-26-000070'],
          primaryDocument: ['note.htm', 'xsl144X01/primary_doc.xml', 'xslF345X06/form4.xml', 'xslF345X06/form4.xml', 'ef20081427_8ka.htm', 'aapl-20260627.htm'],
          items: ['', '', '', '', '5.02', ''],
        },
      },
    },
  });
  const got = await sec.signals([{ symbol: 'AAPL', feed: '320193', class: 'equity' }], signal());
  assert.deepEqual(got.map((s) => s.label), ['AAPL 144', 'AAPL 4', 'AAPL 8-K/A'], 'a structured note is noise, and one Form 4 is enough');
  assert.equal(got[1].text, 'AAPL filed Form 4 (insider trade) on 2026-10-15');
  assert.equal(got[2].text, 'AAPL filed 8-K (current report), amended, on 2026-09-01: items 5.02');
  assert.equal(got[2].url, 'https://www.sec.gov/Archives/edgar/data/320193/000114036126035325/ef20081427_8ka.htm');
  assert.equal(got[0].at, Date.parse('2026-10-17T00:29:07.000Z'));
  assert.match(asked[0].agent, /^agent-office\//, 'EDGAR is told who is asking');
  // A feed that isn't a CIK isn't asked about.
  assert.deepEqual(await sec.signals([{ symbol: 'X', feed: '../x', class: 'equity' }], signal()).catch(() => []), []);
});

test('fear & greed: today’s reading and the day before’s', async (t) => {
  serve(t, { 'api.alternative.me/fng/': { data: [{ value: '53', value_classification: 'Neutral', timestamp: '1792281600' }, { value: '55', value_classification: 'Greed', timestamp: '1792195200' }] } });
  const [s] = await fearGreed.signals([], signal());
  assert.deepEqual([s.kind, s.value, s.unit, s.text, s.at], ['sentiment', 53, '/100', 'Neutral at 53/100, from 55 the day before', 1792281600_000]);
});

// bitbo.io's flows table as it comes (trimmed to four funds and three days), newest first, then its summary rows.
const cell = (v: string) => `<td class="cell right-align"> <span>${v}</span> </td>`;
const BITBO = `<h2>Bitcoin ETF Flow (US$m)</h2><table class="stats-table larger-table"> <tbody>
<tr> <th> <span>Date</span> </th> <th> <span>IBIT</span> </th> <th> <span>FBTC</span> </th> <th> <span>GBTC</span> </th> <th> <span>BITB</span> </th> <th> <span>Totals</span> </th> </tr>
<tr>${['Oct 15, 2026', '16.7', '0.0', '-0.4', '-', '16.3'].map(cell).join('')}</tr>
<tr>${['Oct 14, 2026', '-110.9', '-152.7', '-0.4', '2.2', '-261.8'].map(cell).join('')}</tr>
<tr>${['Oct 13, 2026', '1,064.7', '101.2', '(0.4)', '0.0', '1,165.5'].map(cell).join('')}</tr>
<tr>${['Total', '970.5', '-51.5', '-1.2', '2.2', '920.0'].map(cell).join('')}</tr>
<tr>${['Average', '323.5', '-17.2', '-0.4', '0.7', '306.7'].map(cell).join('')}</tr>
</tbody></table><p>The above table shows the changes in BTC holdings for the last 10 days.</p>`;

test('bitbo.io ETF flows: the latest day’s net flow in USD, the funds that moved it, and the sessions shown', async (t) => {
  assert.deepEqual(['16.7', '-110.9', '1,064.7', '(0.4)', '0.0', '-', ''].map(flowNumber), [16.7, -110.9, 1064.7, -0.4, 0, undefined, undefined]);
  const table = flowsTable(BITBO);
  assert.deepEqual(table.tickers, ['IBIT', 'FBTC', 'GBTC', 'BITB']);
  assert.deepEqual(table.days.map((d) => [d.date, d.total]), [['Oct 13, 2026', 1165.5], ['Oct 14, 2026', -261.8], ['Oct 15, 2026', 16.3]], 'oldest first, the summary rows left out');
  assert.deepEqual(table.days[2].flows, [16.7, 0, -0.4, undefined]);
  const asked = serve(t, { 'bitbo.io/treasuries/etf-flows/': BITBO });
  const [s, ...rest] = await bitbo.signals([{ symbol: 'BTC', feed: 'etf-flows', class: 'crypto' }, { symbol: 'X', feed: '../x', class: 'crypto' }], signal());
  assert.equal(rest.length, 0, 'a feed that isn’t a page name isn’t asked');
  assert.deepEqual(asked.map((a) => a.url.href), ['https://bitbo.io/treasuries/etf-flows/']);
  assert.deepEqual([s.id, s.kind, s.symbol, s.value, s.unit, s.source, s.url, s.at], ['etf_flows:BTC:bitbo', 'etf_flows', 'BTC', 16_300_000, 'USD', 'bitbo', 'https://bitbo.io/treasuries/etf-flows/', Date.UTC(2026, 9, 15, 21)]);
  assert.equal(s.text, 'US spot BTC ETFs: $16.3M on Oct 15, 2026 (IBIT $16.7M, GBTC -$400K); $920M over the last 3 sessions');
  // A page without the table (bitbo changed it, or sent an error page) fails the source rather than reading zero.
  serve(t, { 'bitbo.io/': '<html><body>Not here</body></html>' });
  await assert.rejects(bitbo.signals([{ symbol: 'BTC', feed: 'etf-flows', class: 'crypto' }], signal()), /no flows table/);
});

test('market data asks a source for the feed it names, and a global one with no listings at all', async () => {
  const seen: Record<string, Listing[]> = {};
  const stub = (a: Partial<SignalAdapter> & { id: string }): SignalAdapter => ({ label: a.id, everyMs: 60_000, provides: ['news'], signals: async (ls) => ((seen[a.id] = ls), [{ id: `news:${a.id}`, kind: 'news', label: a.id, at: 1, source: a.id }]), ...a });
  const md = new MarketData({
    mode: 'public',
    assets: () => new Map([['BTC', assetTable().get('BTC')!]]),
    mustWatch: () => true,
    onQuotes: () => {},
    adapters: () => ({ prices: [], signals: [stub({ id: 'liq', feed: 'okx' }), stub({ id: 'net', global: true }), stub({ id: 'nobody' })] }),
  });
  await md.refreshAll();
  assert.deepEqual(seen.liq, [{ symbol: 'BTC', feed: 'BTC-USDT-SWAP', class: 'crypto' }]);
  assert.deepEqual(seen.net, []);
  assert.equal(seen.nobody, undefined, 'a source no asset lists isn’t asked');
  assert.deepEqual(md.signals().map((s) => s.source).sort(), ['liq', 'net']);
});

test('the public sources cover every kind of signal', () => {
  const md = new MarketData({ mode: 'public', assets: () => assetTable(), mustWatch: () => false, onQuotes: () => {} });
  const sources = md.state().sources;
  assert.deepEqual(sources.map((s) => s.id), ['coinbase', 'yahoo', 'okx', 'okx-liquidations', 'bitbo', 'mempool', 'yahoo-news', 'fred', 'sec', 'fear-greed']);
  const covered = new Set(sources.flatMap((s) => s.provides));
  assert.deepEqual(SIGNAL_KINDS.filter((k) => !covered.has(k)), []);
  for (const s of sources) assert.equal(s.mock, undefined);
  // Every equity the fund knows by default has its CIK; every asset has a headlines feed.
  for (const a of assetTable().values()) {
    assert.ok(a.feeds.news, a.symbol);
    if (a.class === 'equity') assert.match(a.feeds.sec ?? '', /^\d+$/, a.symbol);
  }
});
