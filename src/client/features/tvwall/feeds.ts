// The ticker's headlines: fetched through the office (GET /api/tv/feed, see server/feeds.ts), which
// can read a feed a browser isn't allowed to, and fetched again every few minutes while a screen shows it.

export interface Headline {
  title: string;
  link?: string;
  at?: number;
}

export interface FeedNow {
  title?: string;
  items: Headline[];
  /** Why there are no headlines, when the feed couldn't be read. */
  error?: string;
}

const REFRESH_MS = 3 * 60_000;
const RETRY_MS = 60_000;

const feeds = new Map<string, { now: FeedNow | null; next: number; loading: boolean }>();

/** The headlines from `url` as last fetched (null while the first fetch is on its way), fetching again when they're stale. */
export function headlines(url: string): FeedNow | null {
  let f = feeds.get(url);
  if (!f) feeds.set(url, (f = { now: null, next: 0, loading: false }));
  if (!f.loading && performance.now() >= f.next) {
    f.loading = true;
    const entry = f;
    void load(url).then((now) => {
      // A failed refresh keeps the headlines it had.
      entry.now = now.error && entry.now?.items.length ? entry.now : now;
      entry.next = performance.now() + (now.error ? RETRY_MS : REFRESH_MS);
      entry.loading = false;
    });
  }
  return f.now;
}

async function load(url: string): Promise<FeedNow> {
  try {
    const res = await fetch(`/api/tv/feed?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
    const body = (await res.json()) as FeedNow & { error?: string };
    if (!res.ok) return { items: [], error: body.error ?? `The office answered ${res.status}` };
    return { title: body.title, items: Array.isArray(body.items) ? body.items : [] };
  } catch {
    return { items: [], error: "Couldn't reach the office" };
  }
}
