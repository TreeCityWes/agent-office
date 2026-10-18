// The 💼 Fund window's first tab: the NAV and what moves it, the chart, the positions and the exposure.
import { pct, price, usd } from '../../../shared/fund/format';
import type { FundState } from '../../../shared/fund/state';
import type { Exposure } from '../../../shared/fund/types';
import { h, timeAgo } from '../../ui/dom';
import { change, confirmButton, gauge, money, navChart, section, stat, table, type FundTab, type TabDeps } from './view';

export function overviewTab(deps: TabDeps): FundTab {
  const stats = h('div.fd-stats');
  const chart = h('div');
  const positions = h('div');
  const exposure = h('div');
  const el = h(
    'div.fd-tab',
    {},
    stats,
    section('NAV', chart),
    section('Positions', positions),
    section('Exposure by asset class', exposure),
  );

  function update(s: FundState) {
    const p = s.portfolio;
    const l = s.limits;
    stats.replaceChildren(
      stat('NAV', usd(p.nav), `capital ${usd(p.startingCapital, { compact: true })}`),
      stat('Day P&L', money(p.dayPnl), change(p.dayPnlPct)),
      stat('Total P&L', money(p.totalPnl), change(p.totalPnlPct)),
      stat('Cash', usd(p.cash, { compact: true }), `${pct(p.cashPct)} of NAV`),
      stat('Gross / net', `${usd(p.gross, { compact: true })} / ${usd(p.net, { compact: true })}`, `${p.positions.length} position${p.positions.length === 1 ? '' : 's'}`),
      stat('Leverage', `${p.leverage.toFixed(2)}×`, gauge(p.leverage, l.maxLeverage), p.leverage >= l.maxLeverage),
      stat('Drawdown', pct(p.drawdownPct), gauge(p.drawdownPct, l.maxDrawdownPct), p.drawdownPct >= l.maxDrawdownPct),
      stat('Fees paid', usd(p.fees, { cents: true }), `realized ${usd(p.realizedPnl, { compact: true })}`),
    );
    chart.replaceChildren(navChart(s.nav, p.startingCapital));
    positions.replaceChildren(
      table(
        ['Asset', 'Side', 'Qty', 'Avg cost', 'Last', 'Value', 'Weight', 'Unrealized', ''],
        p.positions.map((pos) => [
          h('span.fd-sym', { title: `${pos.name} · ${pos.sector}` }, pos.symbol),
          h('span', { class: `fd-side ${pos.side}` }, pos.side.toUpperCase()),
          h('span.num', {}, Math.abs(pos.qty).toLocaleString('en-US', { maximumFractionDigits: 6 })),
          h('span.num', {}, price(pos.avgCost)),
          h('span.num', { title: pos.priceAt ? `${pos.source ?? ''} · ${timeAgo(pos.priceAt)}` : 'No price: valued at cost' }, pos.priceAt ? price(pos.price) : `${price(pos.price)}*`),
          h('span.num', {}, usd(pos.value, { compact: true })),
          h('span.num', {}, pct(pos.weightPct)),
          h('span', {}, money(pos.unrealizedPnl, true), ' ', change(pos.unrealizedPct, 1)),
          deps.admin() ? confirmButton('Close', 'Close all?', () => deps.send({ t: 'fund.close', symbol: pos.symbol })) : '',
        ]),
        { right: [2, 3, 4, 5, 6, 7], empty: 'No positions. Approved proposals fill here, on paper.' },
      ),
      p.unpriced.length ? h('div.fd-note', {}, `* No price for ${p.unpriced.join(', ')}: valued at cost.`) : '',
    );
    exposure.replaceChildren(exposureTable(p.byClass, (cls) => l.maxClassPct[cls as keyof typeof l.maxClassPct] ?? l.defaultClassPct));
  }

  return { el, update };
}

/** Exposure per bucket, gross against its cap. */
export function exposureTable(by: Record<string, Exposure>, cap: (bucket: string) => number, net = false): HTMLElement {
  const rows = Object.entries(by)
    .filter(([, e]) => e.gross > 0)
    .sort((a, b) => b[1].gross - a[1].gross)
    .map(([bucket, e]) => {
      const used = net ? Math.abs(e.netPct) : e.grossPct;
      return [h('span.fd-sym', {}, bucket), h('span.num', {}, usd(e.long, { compact: true })), h('span.num', {}, usd(-e.short, { compact: true })), h('span.num', {}, pct(e.grossPct)), h('span.num', {}, pct(e.netPct, 1, true)), h('div.fd-cap', {}, gauge(used, cap(bucket)), h('span.num', {}, `${pct(used)} / ${pct(cap(bucket), 0)}`))];
    });
  return table(['', 'Long', 'Short', 'Gross', 'Net', net ? 'Net vs cap' : 'Gross vs cap'], rows, { right: [1, 2, 3, 4], empty: 'No exposure: the fund is all cash.' });
}
