import { BOARDS, FLOOR } from './layout.js';

// The TV wall: big screens up over the boards, each showing whatever someone on the floor tuned it
// to: a YouTube video or live channel, a market chart, a web page, a crawl of headlines from a news
// feed, or a worker's terminal. What's on each is the floor's, saved with it (server/tvwall.ts), and
// everyone on the floor sees the same thing.

/** What's on a screen. */
export type TvChannel =
  | { kind: 'off' }
  /** A video (`video`), a channel's live stream (`channel`, its UC… id) or a playlist (`list`). */
  | { kind: 'youtube'; video?: string; channel?: string; list?: string }
  /** A TradingView chart of `symbol` (EXCHANGE:TICKER, or just a ticker). */
  | { kind: 'chart'; symbol: string }
  /** Any web page that lets itself be shown in a frame. */
  | { kind: 'web'; url: string }
  /** The headlines from an RSS or Atom feed, crawling along the bottom of the screen. */
  | { kind: 'ticker'; url: string }
  /** A worker's terminal, by worker id; without one, each of the floor's workers in turn. */
  | { kind: 'agent'; worker?: string };

export type TvKind = TvChannel['kind'];
export const TV_KINDS: readonly TvKind[] = ['youtube', 'chart', 'ticker', 'agent', 'web', 'off'];

/** One screen: what's on it, what its caption says, and who tuned it. */
export interface TvScreen {
  channel: TvChannel;
  label?: string;
  by?: string;
}

/** Every screen on the floor, by its id (one of the map's TvPlaces). */
export interface TvWallState {
  screens: Record<string, TvScreen>;
}

/** Where a screen hangs: its middle, the way it faces (0 is +z), and its size. */
export interface TvPlace {
  id: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  width: number;
  height: number;
}

/** A screen's size: 16:9, wide enough to read a chart from across the room. */
const TV_W = 3.4;
const TV_H = (TV_W * 9) / 16;
/** Its middle: clear over each board's sign, and under the ceiling (WALL_HEIGHT). */
const TV_Y = 5.7;

/** The office's screens: one up over each board along the north wall. */
export const OFFICE_TVS: readonly TvPlace[] = (['issues', 'queue', 'pulls'] as const).map((k, i) => ({
  id: `tv-${i + 1}`,
  x: BOARDS[k].x,
  y: TV_Y,
  z: FLOOR.minZ + 0.12,
  rotY: 0,
  width: TV_W,
  height: TV_H,
}));

/** What the screens show on a floor nobody's tuned yet. */
export const DEFAULT_TVS: Record<string, TvScreen> = {
  'tv-1': { channel: { kind: 'agent' }, label: 'Agents' },
  'tv-2': { channel: { kind: 'chart', symbol: 'AMEX:SPY' }, label: 'SPY' },
  'tv-3': { channel: { kind: 'ticker', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' }, label: 'Headlines' },
};

export const MAX_TV_LABEL = 40;
const MAX_URL = 2048;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const YT_LIST = /^[A-Za-z0-9_-]{10,64}$/;
const SYMBOL = /^[A-Z0-9_.!&-]{1,24}(:[A-Z0-9_.!&-]{1,24})?$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);

type Checked = { channel: TvChannel } | { error: string };

function webUrl(raw: unknown): { url: string } | { error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { error: 'Paste a link' };
  if (s.length > MAX_URL) return { error: 'That link is too long' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "That isn't a web link. Paste an address that starts with https://" };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http and https links go on a screen' };
  if (u.username || u.password) return { error: "Links with a password in them can't go on a screen" };
  return { url: u.href };
}

/** A channel that came off the wire or out of a file, checked: only what it should have, and well-formed. */
export function checkTvChannel(raw: unknown): Checked {
  if (!raw || typeof raw !== 'object') return { error: 'Pick something to put on' };
  const c = raw as Record<string, unknown>;
  switch (c.kind) {
    case 'off':
      return { channel: { kind: 'off' } };
    case 'youtube': {
      const one = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : undefined);
      const video = one(c.video, YT_ID);
      const channel = one(c.channel, YT_CHANNEL);
      const list = one(c.list, YT_LIST);
      if (!video && !channel && !list) return { error: "That isn't a YouTube video, channel or playlist" };
      return { channel: { kind: 'youtube', ...(video ? { video } : channel ? { channel } : { list }) } };
    }
    case 'chart': {
      const symbol = typeof c.symbol === 'string' ? c.symbol.trim().toUpperCase() : '';
      if (!SYMBOL.test(symbol)) return { error: 'A chart needs a symbol, like NASDAQ:AAPL or BTCUSD' };
      return { channel: { kind: 'chart', symbol } };
    }
    case 'web':
    case 'ticker': {
      const u = webUrl(c.url);
      return 'error' in u ? u : { channel: { kind: c.kind, url: u.url } };
    }
    case 'agent': {
      const worker = typeof c.worker === 'string' ? c.worker.trim().slice(0, 32) : '';
      return { channel: { kind: 'agent', ...(worker ? { worker } : {}) } };
    }
    default:
      return { error: "The screens don't show that" };
  }
}

/** A YouTube link as a channel, or undefined when it isn't one. */
function youtubeFrom(u: URL): TvChannel | undefined {
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return undefined;
  const parts = u.pathname.split('/').filter(Boolean);
  const list = u.searchParams.get('list');
  const v = u.searchParams.get('v') ?? (host === 'youtu.be' ? parts[0] : ['embed', 'live', 'shorts', 'v'].includes(parts[0]) ? parts[1] : undefined);
  if (v && YT_ID.test(v)) return { kind: 'youtube', video: v };
  if (parts[0] === 'embed' && parts[1] === 'live_stream') {
    const ch = u.searchParams.get('channel');
    if (ch && YT_CHANNEL.test(ch)) return { kind: 'youtube', channel: ch };
  }
  if (parts[0] === 'channel' && parts[1] && YT_CHANNEL.test(parts[1])) return { kind: 'youtube', channel: parts[1] };
  if (list && YT_LIST.test(list)) return { kind: 'youtube', list };
  return undefined;
}

/** A TradingView link (…/symbols/NASDAQ-AAPL/, …/chart/?symbol=NASDAQ:AAPL) as a chart. */
function chartFrom(u: URL): TvChannel | undefined {
  if (!/(^|\.)tradingview\.com$/i.test(u.hostname)) return undefined;
  const q = u.searchParams.get('symbol') ?? u.searchParams.get('tvwidgetsymbol');
  if (q) return { kind: 'chart', symbol: q.toUpperCase() };
  const m = /\/symbols\/([A-Za-z0-9_.!&]+)(?:-([A-Za-z0-9_.!&]+))?/.exec(u.pathname);
  if (m) return { kind: 'chart', symbol: (m[2] ? `${m[1]}:${m[2]}` : m[1]).toUpperCase() };
  return undefined;
}

/** Looks like a news feed rather than a page to show. */
const FEEDISH = /(\.(rss|xml|atom)$)|\/(rss|feed|feeds|atom)(\/|$|\.)/i;

/**
 * What someone typed into a screen's box, as a channel: `kind` says what they picked, and without it
 * the link says (a YouTube link is a video, a TradingView one a chart, a feed's a ticker, the rest
 * web pages). A bare ticker symbol is a chart, and "agent" (or "agent:<worker id>") a terminal.
 */
export function parseTvInput(text: string, kind?: TvKind): Checked {
  const s = text.trim();
  if (kind === 'off') return { channel: { kind: 'off' } };
  if (kind === 'agent' || /^agents?(:|$)/i.test(s)) return checkTvChannel({ kind: 'agent', worker: s.replace(/^agents?:?/i, '') });
  let u: URL | undefined;
  try {
    u = /^https?:\/\//i.test(s) ? new URL(s) : undefined;
  } catch {
    u = undefined;
  }
  if (!u) {
    if (kind === 'chart' || (!kind && SYMBOL.test(s.toUpperCase()) && s.length <= 30)) return checkTvChannel({ kind: 'chart', symbol: s });
    if (kind === 'youtube' && YT_ID.test(s)) return { channel: { kind: 'youtube', video: s } };
    return checkTvChannel({ kind: kind ?? 'web', url: s });
  }
  if (kind === 'web' || kind === 'ticker') return checkTvChannel({ kind, url: s });
  const yt = youtubeFrom(u);
  if (yt) return { channel: yt };
  if (kind === 'youtube') return { error: "That isn't a YouTube video, channel or playlist link" };
  const chart = chartFrom(u);
  if (chart) return checkTvChannel(chart);
  if (kind === 'chart') return { error: 'Paste a TradingView link, or a symbol like NASDAQ:AAPL' };
  return checkTvChannel({ kind: FEEDISH.test(u.pathname) ? 'ticker' : 'web', url: s });
}

/** The address a framed channel loads in its screen, or undefined for one the office paints itself. */
export function tvEmbedUrl(c: TvChannel, opts: { sound?: boolean; controls?: boolean } = {}): string | undefined {
  switch (c.kind) {
    case 'youtube': {
      const q = new URLSearchParams({ autoplay: '1', mute: opts.sound ? '0' : '1', playsinline: '1', rel: '0', controls: opts.controls ? '1' : '0' });
      if (c.video) {
        // A video plays round and round: a playlist of just itself.
        q.set('loop', '1');
        q.set('playlist', c.video);
        return `https://www.youtube-nocookie.com/embed/${c.video}?${q}`;
      }
      if (c.channel) return `https://www.youtube-nocookie.com/embed/live_stream?channel=${c.channel}&${q}`;
      q.set('list', c.list!);
      return `https://www.youtube-nocookie.com/embed/videoseries?${q}`;
    }
    case 'chart': {
      const q = new URLSearchParams({ symbol: c.symbol, interval: '15', theme: 'dark', style: '1', locale: 'en', hidesidetoolbar: '1', hide_top_toolbar: opts.controls ? '0' : '1', withdateranges: '0', save_image: '0', timezone: 'exchange' });
      return `https://s.tradingview.com/widgetembed/?${q}`;
    }
    case 'web':
      return c.url;
    default:
      return undefined;
  }
}

/** A short name for what's on: the caption when the screen has none. */
export function tvTitle(c: TvChannel): string {
  switch (c.kind) {
    case 'off':
      return 'Off';
    case 'youtube':
      return c.channel ? 'YouTube live' : c.list ? 'YouTube playlist' : 'YouTube';
    case 'chart':
      return c.symbol;
    case 'web':
    case 'ticker':
      try {
        return new URL(c.url).hostname.replace(/^www\./, '');
      } catch {
        return c.kind;
      }
    case 'agent':
      return c.worker ? 'Agent' : 'Agents';
  }
}

/** A caption someone typed, tidied: trimmed, one line, not too long. */
export function cleanTvLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TV_LABEL);
  return s || undefined;
}
