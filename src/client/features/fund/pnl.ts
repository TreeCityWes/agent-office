// The 💼 Fund window's P&L, on the Portfolio tab: each day's P&L as bars, what made and lost money by
// asset, desk and strategy (realized on closed trades, unrealized on open ones), and the latest closed
// trades. The fund works it out over every trade it has made (shared/fund/pnl.ts).
import { price, signedUsd } from '../../../shared/fund/format';
import type { DayPnl, PnlLine, PnlReport } from '../../../shared/fund/pnl';
import { ROLE_BY_ID } from '../../../shared/fund/roles';
import { h, timeAgo } from '../../ui/dom';
import { change, money, section, table } from './view';

export const deskTitle = (key: string) => (key === 'people' ? 'People' : (ROLE_BY_ID.get(key)?.title ?? key));

/** Each day's P&L as a bar, green up and red down, with the best and worst days named. */
function dailyBars(days: readonly DayPnl[]): HTMLElement {
  const wrap = h('div.fd-chart.fd-bars');
  if (!days.length) {
    wrap.append(h('div.fd-empty', {}, 'Each day’s P&L is drawn here once the fund has a NAV history.'));
    return wrap;
  }
  const W = 600;
  const H = 110;
  const top = Math.max(1, ...days.map((d) => Math.abs(d.pnl)));
  const mid = H / 2;
  const step = W / Math.max(days.length, 30);
  const left = W - step * days.length;
  const bw = Math.max(1, step * 0.7);
  const bars = days
    .map((d, i) => {
      const hgt = (Math.abs(d.pnl) / top) * (mid - 4);
      const y = d.pnl >= 0 ? mid - hgt : mid;
      return `<rect x="${(left + i * step + (step - bw) / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, hgt).toFixed(1)}" class="${d.pnl >= 0 ? 'up' : 'down'}"><title>${d.day}: ${signedUsd(d.pnl)} (${d.pct.toFixed(2)}%)</title></rect>`;
    })
    .join('');
  const svg = h('div');
  svg.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Daily P&L"><line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="base" />${bars}</svg>`;
  const best = days.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const worst = days.reduce((a, b) => (b.pnl < a.pnl ? b : a));
  const up = days.filter((d) => d.pnl > 0).length;
  wrap.append(
    h('div.fd-legend', {}, h('span', {}, `${days.length} day${days.length === 1 ? '' : 's'} · ${up} up · ${days.filter((d) => d.pnl < 0).length} down`), h('span.grow'), h('span', {}, 'best ', money(best.pnl, true), ` ${best.day}`), h('span', {}, 'worst ', money(worst.pnl, true), ` ${worst.day}`)),
    svg.firstElementChild!,
  );
  return wrap;
}

/** One bucket's lines: what's realized, what's open, and the closed trades' wins. */
function lines(title: string, rows: readonly PnlLine[], name: (key: string) => string, empty: string): HTMLElement {
  return h(
    'div.fd-pnl-part',
    {},
    h('h4', {}, title),
    table(
      ['', 'Realized', 'Open', 'Total', 'Closed'],
      rows.slice(0, 12).map((l) => [h('span.fd-sym', { title: l.key }, name(l.key)), money(l.realized, true), money(l.unrealized, true), money(l.realized + l.unrealized, true), h('span.num', {}, l.closed ? `${l.wins}/${l.closed}` : '—')]),
      { right: [1, 2, 3, 4], empty },
    ),
  );
}

/** The P&L sections: daily bars, where it came from, and the latest closed trades. */
export function pnlSections(): { el: HTMLElement[]; update(r: PnlReport): void } {
  const daily = h('div');
  const parts = h('div.fd-pnl-grid');
  const trades = h('div');
  let sig = '';
  return {
    el: [section('Daily P&L', daily), section('Where the P&L came from', parts), section('Closed trades', trades)],
    update(r: PnlReport) {
      const next = JSON.stringify(r);
      if (next === sig) return;
      sig = next;
      daily.replaceChildren(dailyBars(r.days));
      parts.replaceChildren(
        lines('By asset', r.byAsset, (k) => k, 'No trades yet.'),
        lines('By desk', r.byDesk, deskTitle, 'No desk has traded yet.'),
        lines('By strategy', r.byStrategy, (k) => k, 'No trades under a strategy yet.'),
        r.unattributed ? h('div.fd-note.wide', {}, 'Realized outside any trade (a position a person closed, or fees): ', money(r.unattributed, true)) : '',
      );
      trades.replaceChildren(
        table(
          ['Closed', 'Trade', 'Asset', 'Side', 'Desk', 'Qty', 'Entry', 'Exit', 'P&L', 'Return'],
          r.trades.map((t) => [
            h('span.fd-time', { title: new Date(t.closedAt).toLocaleString() }, timeAgo(t.closedAt)),
            h('b.fd-id', {}, t.id),
            h('span.fd-sym', {}, t.symbol, t.strategyId ? h('span.fd-strat-tag', { title: 'Under this quant lab strategy' }, ` 🧪 ${t.strategyId}`) : null),
            h('span', { class: `fd-side ${t.side}` }, t.side.toUpperCase()),
            deskTitle(t.by),
            h('span.num', {}, t.qty.toLocaleString('en-US', { maximumFractionDigits: 6 })),
            h('span.num', {}, price(t.entry)),
            h('span.num', {}, t.exit !== undefined ? price(t.exit) : '—'),
            money(t.pnl, true),
            change(t.returnPct, 1),
          ]),
          { right: [5, 6, 7, 8, 9], empty: 'No closed trades yet. A trade shows here once it’s exited, at its stop, its target or by hand.' },
        ),
      );
    },
  };
}
