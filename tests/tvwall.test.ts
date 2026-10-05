import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFeed } from '../src/server/feeds.js';
import { TvWall } from '../src/server/tvwall.js';
import { BOARDS, WALL_HEIGHT } from '../src/shared/layout.js';
import { DEFAULT_TVS, OFFICE_TVS, checkTvChannel, cleanTvLabel, parseTvInput, tvEmbedUrl, type TvChannel } from '../src/shared/tvwall.js';

const channel = (text: string, kind?: Parameters<typeof parseTvInput>[1]): TvChannel => {
  const r = parseTvInput(text, kind);
  assert.ok('channel' in r, `${text}: ${'error' in r ? r.error : ''}`);
  return r.channel;
};

test('YouTube links of every shape become the video, live channel or playlist they are', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?t=42',
    'https://www.youtube.com/live/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
  ])
    assert.deepEqual(channel(url), { kind: 'youtube', video: 'dQw4w9WgXcQ' }, url);
  assert.deepEqual(channel('https://www.youtube.com/channel/UCIALMKvObZNtJ6AmdCLP7Lg'), { kind: 'youtube', channel: 'UCIALMKvObZNtJ6AmdCLP7Lg' });
  assert.deepEqual(channel('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'), { kind: 'youtube', list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' });
  assert.deepEqual(channel('dQw4w9WgXcQ', 'youtube'), { kind: 'youtube', video: 'dQw4w9WgXcQ' });
  assert.ok('error' in parseTvInput('https://example.com/watch?v=dQw4w9WgXcQ', 'youtube'));
});

test('a video embeds muted, looping and from the no-cookie site, and plays with sound up close', () => {
  const wall = new URL(tvEmbedUrl({ kind: 'youtube', video: 'dQw4w9WgXcQ' })!);
  assert.equal(wall.origin, 'https://www.youtube-nocookie.com');
  assert.equal(wall.pathname, '/embed/dQw4w9WgXcQ');
  assert.equal(wall.searchParams.get('mute'), '1');
  assert.equal(wall.searchParams.get('autoplay'), '1');
  assert.equal(wall.searchParams.get('playlist'), 'dQw4w9WgXcQ');
  const close = new URL(tvEmbedUrl({ kind: 'youtube', video: 'dQw4w9WgXcQ' }, { sound: true, controls: true })!);
  assert.equal(close.searchParams.get('mute'), '0');
  assert.equal(close.searchParams.get('controls'), '1');
  const live = new URL(tvEmbedUrl({ kind: 'youtube', channel: 'UCIALMKvObZNtJ6AmdCLP7Lg' })!);
  assert.equal(live.pathname, '/embed/live_stream');
  assert.equal(live.searchParams.get('channel'), 'UCIALMKvObZNtJ6AmdCLP7Lg');
});

test('charts come from a symbol or a TradingView link', () => {
  assert.deepEqual(channel('nasdaq:aapl', 'chart'), { kind: 'chart', symbol: 'NASDAQ:AAPL' });
  assert.deepEqual(channel('BTCUSD'), { kind: 'chart', symbol: 'BTCUSD' });
  assert.deepEqual(channel('https://www.tradingview.com/symbols/NASDAQ-AAPL/'), { kind: 'chart', symbol: 'NASDAQ:AAPL' });
  assert.deepEqual(channel('https://www.tradingview.com/chart/?symbol=BITSTAMP%3ABTCUSD'), { kind: 'chart', symbol: 'BITSTAMP:BTCUSD' });
  const src = new URL(tvEmbedUrl({ kind: 'chart', symbol: 'AMEX:SPY' })!);
  assert.equal(src.hostname, 's.tradingview.com');
  assert.equal(src.searchParams.get('symbol'), 'AMEX:SPY');
  assert.equal(src.searchParams.get('theme'), 'dark');
  assert.ok('error' in checkTvChannel({ kind: 'chart', symbol: 'AAPL"><script>' }));
});

test('feeds, agents and pages are told apart, and only web links get through', () => {
  assert.deepEqual(channel('https://feeds.bbci.co.uk/news/business/rss.xml'), { kind: 'ticker', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' });
  assert.deepEqual(channel('https://hnrss.org/frontpage', 'ticker'), { kind: 'ticker', url: 'https://hnrss.org/frontpage' });
  assert.deepEqual(channel('https://grafana.example.com/d/abc'), { kind: 'web', url: 'https://grafana.example.com/d/abc' });
  assert.deepEqual(channel('agent'), { kind: 'agent' });
  assert.deepEqual(channel('agent:w42'), { kind: 'agent', worker: 'w42' });
  assert.deepEqual(channel('', 'off'), { kind: 'off' });
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'https://user:pw@example.com/'])
    assert.ok('error' in checkTvChannel({ kind: 'web', url: bad }), bad);
  assert.ok('error' in checkTvChannel({ kind: 'web', url: `https://example.com/${'a'.repeat(3000)}` }));
  assert.ok('error' in checkTvChannel({ kind: 'teletext' }));
  assert.ok('error' in checkTvChannel(null));
});

test('a channel off the wire keeps only what it should', () => {
  assert.deepEqual(checkTvChannel({ kind: 'youtube', video: 'dQw4w9WgXcQ', channel: 'UCIALMKvObZNtJ6AmdCLP7Lg', extra: 1 }), { channel: { kind: 'youtube', video: 'dQw4w9WgXcQ' } });
  assert.deepEqual(checkTvChannel({ kind: 'agent', worker: 'x'.repeat(100) }), { channel: { kind: 'agent', worker: 'x'.repeat(32) } });
  assert.equal(cleanTvLabel('  Market\n open  '), 'Market open');
  assert.equal(cleanTvLabel('x'.repeat(100))!.length, 40);
  assert.equal(cleanTvLabel('   '), undefined);
});

test('the office screens hang over the boards, clear of their signs and under the ceiling', () => {
  assert.equal(OFFICE_TVS.length, 3);
  for (const tv of OFFICE_TVS) {
    assert.ok(Object.values(BOARDS).some((b) => b.x === tv.x));
    assert.ok(tv.y - tv.height / 2 > BOARDS.issues.y + BOARDS.issues.height / 2 + 0.8, `${tv.id} sits on the sign`);
    assert.ok(tv.y + tv.height / 2 < WALL_HEIGHT, `${tv.id} goes through the ceiling`);
    assert.ok(tv.id in DEFAULT_TVS);
  }
});

test('the wall keeps what each screen shows, and takes back only good screens from its file', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'office-tv-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wall = new TvWall(dir);
  assert.deepEqual(wall.state().screens, DEFAULT_TVS);
  const r = wall.set('tv-2', { kind: 'chart', symbol: 'nasdaq:qqq' }, ' Tech ', 'Ada');
  assert.deepEqual(r, { channel: { kind: 'chart', symbol: 'NASDAQ:QQQ' }, label: 'Tech', by: 'Ada' });
  assert.ok('error' in wall.set('tv-2', { kind: 'web', url: 'javascript:1' }, '', 'Ada'));
  assert.ok('error' in wall.set('../../etc', { kind: 'off' }, '', 'Ada'));
  assert.deepEqual(new TvWall(dir).state().screens['tv-2'], r);

  const file = path.join(dir, 'tvwall.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.screens['tv-9'] = { channel: { kind: 'web', url: 'javascript:alert(1)' } };
  saved.screens.bogus = { channel: { kind: 'off' } };
  writeFileSync(file, JSON.stringify(saved));
  const back = new TvWall(dir).state().screens;
  assert.ok(!('tv-9' in back) && !('bogus' in back));
  writeFileSync(file, '{ not json');
  assert.deepEqual(new TvWall(dir).state().screens, DEFAULT_TVS);
});

test('RSS, RDF and Atom feeds give their headlines, decoded, with only web links', () => {
  const rss = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>Markets &amp; More</title>
    <item><title><![CDATA[Stocks <b>rally</b> as rates hold]]></title><link>https://news.example/a</link><pubDate>Mon, 05 Oct 2026 14:00:00 GMT</pubDate></item>
    <item><title>Oil &#8212; down 3%</title><link>javascript:alert(1)</link></item>
    <item><title>   </title></item></channel></rss>`);
  assert.ok(!('error' in rss));
  assert.equal(rss.title, 'Markets & More');
  assert.deepEqual(rss.items, [
    { title: 'Stocks rally as rates hold', link: 'https://news.example/a', at: Date.UTC(2026, 9, 5, 14) },
    { title: 'Oil — down 3%' },
  ]);
  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Dev log</title>
    <entry><title>Shipped &lt;b&gt;v2&lt;/b&gt;</title><link rel="self" href="https://x.example/self"/><link rel="alternate" href="https://x.example/v2"/><updated>2026-10-01T00:00:00Z</updated></entry></feed>`);
  assert.ok(!('error' in atom));
  assert.equal(atom.title, 'Dev log');
  assert.deepEqual(atom.items, [{ title: 'Shipped v2', link: 'https://x.example/v2', at: Date.UTC(2026, 9, 1) }]);
  const rdf = parseFeed(`<rdf:RDF xmlns:rdf="x"><channel><title>Old school</title></channel><item><title>One</title><dc:date>2026-01-02T00:00:00Z</dc:date></item></rdf:RDF>`);
  assert.ok(!('error' in rdf));
  assert.deepEqual(rdf.items, [{ title: 'One', at: Date.UTC(2026, 0, 2) }]);
});

test('a feed with entities of its own, or a page that is no feed, is turned away', () => {
  assert.ok('error' in parseFeed('<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><rss><channel><item><title>&lol;</title></item></channel></rss>'));
  assert.ok('error' in parseFeed('<!doctype html><html><head><title>Home</title></head></html>'));
  const many = parseFeed(`<rss><channel>${'<item><title>x</title></item>'.repeat(100)}</channel></rss>`);
  assert.ok(!('error' in many) && many.items.length === 40);
});
