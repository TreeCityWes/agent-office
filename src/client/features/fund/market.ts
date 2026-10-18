// The 💼 Fund window's market tab: the prices everyone trades on and where each came from, the
// signals the desks read (funding, open interest, flows, news…), and whether each source is answering.
import { assetTable } from '../../../shared/fund/assets';
import { price, usd } from '../../../shared/fund/format';
import type { FundState } from '../../../shared/fund/state';
import { h, timeAgo } from '../../ui/dom';
import { change, section, table, type FundTab } from './view';

export function marketTab(): FundTab {
  const quotes = h('div');
  const signals = h('div');
  const sources = h('div');
  const el = h('div.fd-tab', {}, section('Prices', quotes), section('Signals', signals), section('Sources', sources));

  function update(s: FundState) {
    const assets = assetTable(s.config.assets);
    const held = new Set(s.portfolio.positions.map((p) => p.symbol));
    const watch = new Set([...held, ...s.config.watchlist]);
    // What's held and watched first, then whatever else has a price.
    const rows = [...s.market.quotes].sort((a, b) => Number(watch.has(b.symbol)) - Number(watch.has(a.symbol)) || a.symbol.localeCompare(b.symbol));
    const maxAge = s.limits.maxQuoteAgeMin * 60_000;
    quotes.replaceChildren(
      table(
        ['Asset', 'Class', 'Last', 'Change', 'Traded / day', 'Source', 'Priced'],
        rows.map((q) => {
          const a = assets.get(q.symbol);
          const stale = Date.now() - q.at > maxAge;
          return [
            h('span', { class: `fd-sym${held.has(q.symbol) ? ' held' : ''}`, title: a ? `${a.name} · ${a.sector}` : '' }, q.symbol),
            a?.class ?? '',
            h('span.num', {}, price(q.price)),
            change(q.changePct),
            h('span.num', {}, q.volumeUsd ? usd(q.volumeUsd, { compact: true }) : '—'),
            h('span', { class: q.source === 'mock' ? 'fd-mock' : '' }, q.source === 'mock' ? 'MOCK' : `${q.source}${q.delayed ? ' · delayed' : ''}`),
            h('span', { class: stale ? 'fd-stale' : '', title: stale ? 'Older than the risk limit allows: nothing opens on it' : '' }, timeAgo(q.at)),
          ];
        }),
        { right: [2, 3, 4], empty: s.market.polling ? 'Asking the sources…' : 'No prices yet: they come while the fund window is open, an agent asks, or the fund holds something.' },
      ),
    );
    signals.replaceChildren(
      table(
        ['Kind', 'Asset', 'Signal', 'Value', 'Source', 'When'],
        s.market.signals.slice(0, 60).map((g) => [
          g.kind.replace(/_/g, ' '),
          g.symbol ?? '',
          g.url && /^https?:\/\//.test(g.url) ? h('a', { href: g.url, target: '_blank', rel: 'noopener noreferrer' }, g.label) : g.text ? h('span', { title: g.text }, g.label) : g.label,
          g.value !== undefined ? h('span.num', {}, `${g.value.toLocaleString('en-US', { maximumFractionDigits: 4 })}${g.unit ? ` ${g.unit}` : ''}`) : (g.text ?? ''),
          h('span', { class: g.mock ? 'fd-mock' : '' }, g.mock ? 'MOCK' : g.source),
          timeAgo(g.at),
        ]),
        { empty: 'No signals yet.' },
      ),
    );
    sources.replaceChildren(
      h(
        'div.fd-sources',
        {},
        ...s.market.sources.map((src) =>
          h(
            'div',
            { class: `fd-source ${src.ok ? 'ok' : src.at ? 'bad' : 'idle'}`, title: src.error ?? '' },
            h('span.dot'),
            h('b', {}, src.label),
            ` ${src.provides.join(', ')}`,
            src.mock ? h('span.fd-mock', {}, ' MOCK') : null,
            src.delayed ? h('span.fd-hint', {}, ' delayed') : null,
            h('span.fd-hint', {}, src.at ? ` · ${src.ok ? 'answered' : `failed: ${src.error ?? 'no answer'}`} ${timeAgo(src.at)}` : ' · not asked yet'),
          ),
        ),
      ),
    );
  }

  return { el, update };
}
