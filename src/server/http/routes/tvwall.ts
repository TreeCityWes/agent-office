// The TV wall's ticker: the headlines from a news feed, fetched by the office (see feeds.ts).
import { FeedProxy } from '../../feeds.js';
import { send } from '../util.js';
import type { Route } from '../router.js';

const feeds = new FeedProxy();

export const tvwallRoutes = {
  feed: {
    method: 'GET',
    path: '/api/tv/feed',
    auth: 'session',
    async handle(_ctx, { res, url }) {
      const r = await feeds.get(url.searchParams.get('url') ?? '');
      if ('error' in r) return send(res, r.status, { error: r.error });
      return send(res, 200, r, { 'cache-control': 'private, max-age=60' });
    },
  },
} satisfies Record<string, Route>;
