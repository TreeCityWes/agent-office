import { checkTvChannel } from '../shared/tvwall.js';

// News feeds for the TV wall's ticker. A browser can't read most feeds itself (they send no CORS
// headers), so the office fetches them, the way it fetches pictures for the walls (see ImageProxy in
// decor.ts), and only for people signed in. It hands back just the headlines.

export interface Headline {
  title: string;
  link?: string;
  /** When it was published, ms since 1970, when the feed says. */
  at?: number;
}

export interface Feed {
  title?: string;
  items: Headline[];
}

export type FeedResult = Feed | { status: number; error: string };

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_HEADLINES = 40;
const CACHE_MS = 2 * 60_000;
const CACHE_FEEDS = 32;
const TIMEOUT_MS = 10_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const untag = (s: string) => s.replace(/<[^>]*>/g, ' ');

/** Text out of XML: CDATA unwrapped, tags dropped, entities decoded, whitespace squeezed. */
function text(raw: string): string {
  const cdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, s: string) => s);
  // Headlines are sometimes HTML inside the XML, escaped: drop its tags too, once they're decoded.
  return untag(decode(untag(cdata))).replace(/\s+/g, ' ').trim();
}

/** What's inside the first <tag>…</tag> in `xml` (with any namespace prefix), or undefined. */
function first(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i').exec(xml);
  return m?.[1];
}

/** An Atom entry's link: the alternate one, or the first. */
function atomLink(entry: string): string | undefined {
  const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
  return pick ? /href=["']([^"']+)["']/i.exec(pick)?.[1] : undefined;
}

/** Only http(s) links come back; anything else is dropped. */
function safeLink(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const c = checkTvChannel({ kind: 'web', url: text(raw) });
  return 'channel' in c && c.channel.kind === 'web' ? c.channel.url : undefined;
}

/**
 * The headlines in an RSS, RDF or Atom feed. It's read with patterns rather than an XML parser, and a
 * feed that declares entities of its own is turned away (that's how XML bombs go off).
 */
export function parseFeed(xml: string): Feed | { error: string } {
  if (/<!ENTITY/i.test(xml)) return { error: "That feed declares entities of its own, which the office doesn't read" };
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const itemAt = atom ? /<entry[\s>]/i : /<item[\s>]/i;
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) return { error: "That link isn't a news feed (RSS or Atom)" };
  const blocks = [...xml.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const items: Headline[] = [];
  for (const b of blocks) {
    const title = text(first(b, 'title') ?? '');
    if (!title) continue;
    const link = safeLink(atom ? atomLink(b) : first(b, 'link'));
    const when = first(b, atom ? 'updated' : 'pubDate') ?? first(b, 'published') ?? first(b, 'date');
    const at = when ? Date.parse(text(when)) : NaN;
    items.push({ title: title.slice(0, 300), ...(link ? { link } : {}), ...(Number.isFinite(at) ? { at } : {}) });
    if (items.length >= MAX_HEADLINES) break;
  }
  // The feed's own title comes before its first item or entry.
  const cut = xml.search(itemAt);
  const title = text(first(cut >= 0 ? xml.slice(0, cut) : xml, 'title') ?? '').slice(0, 120);
  return { ...(title ? { title } : {}), items };
}

/** Fetches feeds for signed-in people, keeping a couple of minutes' worth of each. */
export class FeedProxy {
  private cache = new Map<string, { feed: Feed; at: number }>();
  private inflight = new Map<string, Promise<FeedResult>>();

  get(raw: string): Promise<FeedResult> {
    const c = checkTvChannel({ kind: 'ticker', url: raw });
    if ('error' in c) return Promise.resolve({ status: 400, error: c.error });
    if (c.channel.kind !== 'ticker') return Promise.resolve({ status: 400, error: 'Paste a link to a news feed' });
    const url = c.channel.url;
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.feed);
    let p = this.inflight.get(url);
    if (!p) {
      p = this.fetch(url).finally(() => this.inflight.delete(url));
      this.inflight.set(url, p);
    }
    return p;
  }

  private async fetch(url: string): Promise<FeedResult> {
    const host = new URL(url).host;
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
          'user-agent': 'Mozilla/5.0 (compatible; agent-office; +https://github.com/AgentSystemLabs/agent-office)',
        },
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (e.name === 'TimeoutError') return { status: 504, error: `${host} took too long to answer` };
      return { status: 502, error: `Couldn't reach ${host}${e.cause?.code ? ` (${e.cause.code})` : ''}` };
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { status: 502, error: `${host} answered ${res.status}` };
    }
    let body: string;
    try {
      body = await readCapped(res, MAX_FEED_BYTES);
    } catch {
      return { status: 413, error: 'That feed is too big' };
    }
    const feed = parseFeed(body);
    if ('error' in feed) return { status: 415, error: feed.error };
    this.cache.delete(url);
    this.cache.set(url, { feed, at: Date.now() });
    // The oldest goes once there are too many.
    if (this.cache.size > CACHE_FEEDS) this.cache.delete(this.cache.keys().next().value!);
    return feed;
  }
}

/** A response's body as text, giving up past `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > limit) {
    void res.body?.cancel().catch(() => {});
    throw new Error('too large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      throw new Error('too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
