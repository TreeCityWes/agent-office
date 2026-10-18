// US spot ETF flows from bitbo.io (BitcoinTreasuries.com), the free, keyless daily source: its public
// page of each US spot bitcoin ETF's net flow by day, in US$m, for the last ten sessions (an asset's
// `bitbo` feed names the page). It's an unofficial read of a public web page (bitbo's API is paid),
// so it reads the table loosely: the row of tickers, then every row that starts with a date.
import { usd } from '../../../shared/fund/format.js';
import type { Signal } from '../../../shared/fund/state.js';
import { eachListing, getText, type SignalAdapter } from './types.js';

/** One trading day of a flows table: each fund's flow in US$m (undefined when not reported) and the total. */
export interface EtfDay {
  date: string;
  /** After that day's US close (21:00 UTC is 4 or 5pm in New York), ms. */
  at: number;
  flows: (number | undefined)[];
  total?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/;
const TICKER = /^[A-Z][A-Z0-9]{1,5}$/;

const cellText = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();

/** A flow in US$m: "-110.9", "1,119.9", "(71.8)" for an outflow; "-" or nothing is a day not reported. */
export function flowNumber(s: string): number | undefined {
  const neg = /^\(.*\)$/.test(s);
  const x = Number(s.replace(/[(),\s]/g, ''));
  return s && s !== '-' && Number.isFinite(x) ? (neg ? -x : x) : undefined;
}

/** A page's first table of flows: its tickers, and its days oldest first. */
export function flowsTable(html: string): { tickers: string[]; days: EtfDay[] } {
  const start = html.indexOf('<table');
  if (start < 0) return { tickers: [], days: [] };
  const end = html.indexOf('</table>', start);
  const rows = html
    .slice(start, end < 0 ? undefined : end)
    .split(/<tr[\s>]/i)
    .slice(1)
    .map((r) => [...r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => cellText(m[1])));
  // The tickers are the header row whose cells between the date and the total look like them.
  const tickers = rows.find((r) => r.length > 2 && r.slice(1, -1).every((c) => TICKER.test(c)))?.slice(1, -1) ?? [];
  const days: EtfDay[] = [];
  for (const r of rows) {
    const d = DATE.exec(r[0] ?? '');
    const month = d ? MONTHS.indexOf(d[1]) : -1;
    if (!d || month < 0 || r.length < 3) continue;
    days.push({ date: r[0], at: Date.UTC(Number(d[3]), month, Number(d[2]), 21), flows: r.slice(1, -1).map(flowNumber), total: flowNumber(r[r.length - 1]) });
  }
  return { tickers, days: days.sort((a, b) => a.at - b.at) };
}

const millions = (m: number) => usd(m * 1e6, { compact: true });

/** The latest day with a total, as a signal: the net flow, the funds that moved most, and the sessions shown. */
export function etfSignal(symbol: string, url: string, html: string): Signal | undefined {
  const { tickers, days } = flowsTable(html);
  const totals = days.filter((d) => d.total !== undefined);
  const day = totals.at(-1);
  if (!day || day.total === undefined) return undefined;
  const movers = tickers
    .map((t, i) => [t, day.flows[i] ?? 0] as const)
    .filter(([, f]) => Math.abs(f) >= 0.05)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([t, f]) => `${t} ${millions(f)}`);
  const sum = totals.reduce((s, d) => s + (d.total ?? 0), 0);
  return {
    id: `etf_flows:${symbol}:bitbo`,
    kind: 'etf_flows',
    symbol,
    label: `US spot ${symbol} ETF net flow`,
    value: Math.round(day.total * 1e6),
    unit: 'USD',
    text: `US spot ${symbol} ETFs: ${millions(day.total)} on ${day.date}${movers.length ? ` (${movers.join(', ')})` : ''}; ${millions(sum)} over the last ${totals.length} sessions`,
    url,
    at: day.at,
    source: 'bitbo',
  };
}

/** bitbo.io's daily US spot ETF flows, for each asset with a `bitbo` page (BTC's is etf-flows). */
export const bitbo: SignalAdapter = {
  id: 'bitbo',
  label: 'bitbo.io (US spot ETF flows)',
  everyMs: 60 * 60_000,
  provides: ['etf_flows'],
  signals: (listings, signal) =>
    eachListing(listings, async (l) => {
      if (!/^[a-z0-9-]{1,40}$/.test(l.feed)) return undefined;
      const url = `https://bitbo.io/treasuries/${l.feed}/`;
      const s = etfSignal(l.symbol, url, await getText(url, signal));
      if (!s) throw new Error(`bitbo's ${l.feed} page had no flows table`);
      return s;
    }),
};
