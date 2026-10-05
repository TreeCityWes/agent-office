import './ui.css';
import { TV_KINDS, parseTvInput, tvEmbedUrl, tvTitle, type TvChannel, type TvKind, type TvScreen } from '../../../shared/tvwall';
import type { Net } from '../../net';
import { store } from '../../state';
import { h, openModal, toast } from '../../ui/dom';
import { tvFrame } from './css3d';

// The TV wall's window: pick a screen, then what goes on it (a YouTube link, a chart symbol, a news
// feed, a worker's terminal or any page), with a caption; and a viewer that blows a screen up big,
// with its sound on.

const KIND_NAME: Record<TvKind, string> = { youtube: '▶ YouTube', chart: '📈 Chart', ticker: '📰 Headlines', agent: '🤖 Agent', web: '🌐 Web page', off: '⏻ Off' };
const PLACEHOLDER: Record<TvKind, string> = {
  youtube: 'https://www.youtube.com/watch?v=…, a live link, or a channel link',
  chart: 'NASDAQ:AAPL, BITSTAMP:BTCUSD, or a TradingView link',
  ticker: 'https://… an RSS or Atom feed',
  agent: '',
  web: 'https://… a page that lets itself be shown in a frame',
  off: '',
};

/** Picks to start from, per kind. */
const PRESETS: Partial<Record<TvKind, readonly (readonly [string, string])[]>> = {
  chart: [
    ['S&P 500', 'AMEX:SPY'],
    ['Nasdaq 100', 'NASDAQ:QQQ'],
    ['Bitcoin', 'BITSTAMP:BTCUSD'],
    ['VIX', 'TVC:VIX'],
    ['Gold', 'TVC:GOLD'],
  ],
  ticker: [
    ['BBC Business', 'https://feeds.bbci.co.uk/news/business/rss.xml'],
    ['CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'],
    ['Yahoo Finance', 'https://finance.yahoo.com/news/rssindex'],
    ['Hacker News', 'https://hnrss.org/frontpage'],
  ],
};

/** The text a channel goes in its box as, to change it from. */
function asText(c: TvChannel): string {
  switch (c.kind) {
    case 'youtube':
      return c.video ? `https://www.youtube.com/watch?v=${c.video}` : c.channel ? `https://www.youtube.com/channel/${c.channel}` : `https://www.youtube.com/playlist?list=${c.list}`;
    case 'chart':
      return c.symbol;
    case 'web':
    case 'ticker':
      return c.url;
    default:
      return '';
  }
}

/** Whether `src` is the office's own site, which no screen shows (it'd be the office in itself, signed in as you). */
export function sameSite(src: string): boolean {
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return true;
  }
}

/** Blows screen `tv` up big, with its sound on and its controls. */
export function openViewer(screen: TvScreen) {
  const src = tvEmbedUrl(screen.channel, { sound: true, controls: true });
  if (!src || sameSite(src)) return toast("There's nothing to watch up close on that screen", 'warn');
  const el = h('div.modal.tv-viewer', { role: 'dialog', 'aria-label': 'TV' }, h('header', {}, h('h2', {}, `📺 ${screen.label ?? tvTitle(screen.channel)}`)), h('div.tv-viewer-body', {}, tvFrame(src)));
  openModal(el, { escCloses: true, closeButton: true, doing: '📺 watching the TV wall' });
}

/** The TV wall's window, on screen `first` (by id): `ids` are the floor's screens, in order. */
export function openTvWall(net: Net, ids: readonly string[], first?: string) {
  let tv = first && ids.includes(first) ? first : ids[0];
  let kind: TvKind = 'youtube';
  const tabs = h('div.tv-tabs', { role: 'tablist' });
  const kinds = h('div.tv-kinds');
  const input = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Link or symbol' }) as HTMLInputElement;
  const worker = h('select', { 'aria-label': 'Worker' }) as HTMLSelectElement;
  const caption = h('input', { type: 'text', maxlength: '40', placeholder: 'Caption (optional)', 'aria-label': 'Caption', spellcheck: 'false' }) as HTMLInputElement;
  const presets = h('div.tv-presets');
  const note = h('p.setting-note');
  const apply = h('button.btn.primary', { type: 'button' }, '📺 Put it on');
  const watch = h('button.btn', { type: 'button' }, '🔍 Watch up close');
  const el = h(
    'div.modal.tvwall',
    { role: 'dialog', 'aria-label': 'TV wall' },
    h('header', {}, h('h2', {}, '📺 TV wall')),
    h('div.body', {}, tabs, h('label', {}, 'What goes on it'), kinds, h('div.tv-what', {}, input, worker), presets, h('label', { style: 'margin-top:12px' }, 'Caption'), caption, note),
    h('footer', {}, h('span.grow', {}, 'Everyone on this floor sees the same screens.'), watch, apply),
  );

  const current = (): TvScreen => store.tvwall.screens[tv] ?? { channel: { kind: 'off' } };

  /** Fills the form in from what screen `tv` shows now. */
  const load = () => {
    const s = current();
    kind = s.channel.kind;
    input.value = asText(s.channel);
    caption.value = s.label ?? '';
    worker.value = s.channel.kind === 'agent' ? (s.channel.worker ?? '') : '';
    render();
  };

  const render = () => {
    tabs.replaceChildren(
      ...ids.map((id, i) => {
        const s = store.tvwall.screens[id];
        const on = id === tv;
        return h(
          'button.tv-tab',
          { type: 'button', role: 'tab', 'aria-selected': String(on), class: on ? 'on' : '', onclick: () => ((tv = id), load()) },
          h('span.tv-tab-n', {}, `TV ${i + 1}`),
          h('span.tv-tab-what', {}, s ? (s.label ?? tvTitle(s.channel)) : 'Off'),
        );
      }),
    );
    kinds.replaceChildren(
      ...TV_KINDS.map((k) => h('button.tv-kind', { type: 'button', class: k === kind ? 'on' : '', 'aria-pressed': String(k === kind), onclick: () => ((kind = k), render(), input.focus()) }, KIND_NAME[k])),
    );
    input.placeholder = PLACEHOLDER[kind];
    input.hidden = kind === 'agent' || kind === 'off';
    worker.hidden = kind !== 'agent';
    worker.replaceChildren(
      h('option', { value: '' }, 'Every worker on this floor, in turn'),
      ...[...store.workers.values()].map((w) => h('option', { value: w.id }, `${w.name} · ${w.status}`)),
    );
    const s = current();
    if (s.channel.kind === 'agent') worker.value = s.channel.worker ?? '';
    presets.replaceChildren(...(PRESETS[kind] ?? []).map(([name, value]) => h('button.btn.tv-preset', { type: 'button', onclick: () => ((input.value = value), caption.value || (caption.value = name)) }, name)));
    note.textContent =
      kind === 'web'
        ? "Plenty of sites won't be shown inside another page; those stay blank. YouTube, charts and dashboards made for embedding work best."
        : kind === 'youtube'
          ? 'Videos and live streams play muted on the wall. Watch up close to hear them.'
          : kind === 'ticker'
            ? 'The office fetches the feed every few minutes and crawls its headlines along the bottom.'
            : '';
    watch.hidden = !tvEmbedUrl(s.channel);
  };

  const put = () => {
    const parsed = kind === 'agent' ? { channel: { kind: 'agent', ...(worker.value ? { worker: worker.value } : {}) } as TvChannel } : parseTvInput(input.value, kind);
    if ('error' in parsed) {
      toast(parsed.error, 'warn');
      return input.focus();
    }
    const src = tvEmbedUrl(parsed.channel);
    if (src && sameSite(src)) return toast("A screen can't show the office itself", 'warn');
    net.send({ t: 'tv.set', tv, channel: parsed.channel, label: caption.value });
  };
  apply.addEventListener('click', put);
  for (const box of [input, caption])
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') put();
    });
  watch.addEventListener('click', () => openViewer(current()));

  openModal(el, { escCloses: true, closeButton: true, doing: '📺 at the TV wall', onClose: store.on('tvwall', render) });
  load();
  if (!input.hidden) input.focus();
}
