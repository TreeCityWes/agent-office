// A desk's record, opened from its row on the 💼 Fund window's Agents tab: what its role lets it do, in
// words and as the fund tools its agent gets (fundToolsFor in shared/fund/desks.ts), and how the trades
// it proposed have done, as a running P&L and one by one, with how well its confidence foretold them.
import { FUND_TOOLS_BY_PERMISSION, fundToolsFor, winRate, type DeskRecord, type DeskTrade } from '../../../shared/fund/desks';
import type { Permission, RoleDef } from '../../../shared/fund/roles';
import { h } from '../../ui/dom';
import { change, money, table } from './view';

/** What each permission lets a role do, in words. */
const MAY: Record<Permission, string> = {
  propose: 'Proposes trades, and takes its own back before they trade',
  rule: 'Rules on proposals at CIO review: backs them on to a person, or turns them down',
  assign: 'Hands the desks tasks, and sets the routines typed into them',
  committee: 'Calls an investment committee, closes its vote and records its decision',
  strategy: 'Writes strategies for the lab and moves them through its stages',
};

/** How many of its closed trades are listed, the latest first. */
const LISTED = 12;

/** The running total of what its closed trades made, oldest first, against nothing made. */
function pnlLine(trades: readonly DeskTrade[]): HTMLElement {
  const W = 300;
  const H = 60;
  let run = 0;
  const sums = [0, ...trades.map((t) => (run += t.pnl))];
  const lo = Math.min(0, ...sums);
  const span = Math.max(0, ...sums) - lo || 1;
  const x = (i: number) => (i / (sums.length - 1)) * W;
  const y = (v: number) => H - 4 - ((v - lo) / span) * (H - 8);
  const line = sums.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const wrap = h('div.fd-chart.fd-rec-chart');
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Its closed trades' running P&amp;L">
    <line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="base" />
    <path d="${line}" class="line ${run >= 0 ? 'up' : 'down'}" />
  </svg>`;
  return wrap;
}

const day = (at: number) => new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });

export function recordView(role: RoleDef, r: DeskRecord | undefined): HTMLElement {
  const tools = fundToolsFor(role);
  const own = new Set(role.can.flatMap((p) => FUND_TOOLS_BY_PERMISSION[p]));
  const may = h(
    'div.fd-mem-block',
    {},
    h('h4', {}, 'What it may do'),
    h('div.fd-mem', {}, 'As every desk: reads the book, the market, the proposals, the desks and their memories; keeps its own memory and status; messages the others, asks them for research and answers what it’s asked; escalates to you; reviews its trades, votes in committee and runs backtests.'),
    ...(role.can.length ? role.can.map((p) => h('div.fd-mem', {}, h('b', {}, '✓ '), MAY[p])) : [h('div.fd-mem', {}, 'Nothing more: it advises.')]),
    h('div.fd-mem.fd-muted', {}, 'No desk moves money: a trade fills on paper only after the risk engine’s checks and a person’s approval.'),
    h('div.fd-tools', { title: 'The fund tools its agent gets: highlighted, those that come with its role. The office refuses any its role doesn’t allow.' }, ...tools.map((t) => h('code', { class: own.has(t) ? 'own' : undefined }, t))),
  );
  if (!r?.proposed) return h('div.fd-memory', {}, may, h('div.fd-mem-block', {}, h('h4', {}, 'How its calls have done'), h('div.fd-mem', {}, 'No proposals from this role yet.')));
  const wr = winRate(r);
  const trades = [...r.history].reverse().slice(0, LISTED);
  return h(
    'div.fd-memory',
    {},
    may,
    h(
      'div.fd-mem-block',
      {},
      h('h4', {}, 'How its calls have done'),
      h('div.fd-mem', {}, `${r.proposed} proposed · ${r.filled} filled · ${r.rejected} rejected · ${r.open} open · ${r.closed} closed`),
      r.closed
        ? h(
            'div.fd-mem',
            {},
            `Won ${r.wins} of ${r.closed}${wr !== undefined ? ` (${wr.toFixed(0)}%)` : ''} · realized `,
            money(r.realizedPnl),
            r.avgReturnPct !== undefined ? ' · the average trade ' : null,
            r.avgReturnPct !== undefined ? change(r.avgReturnPct, 1) : null,
            r.brier !== undefined ? h('span', { title: 'The mean squared gap between the confidence it gave and what happened: 0 is perfect, 0.25 is always saying 50%' }, ` · Brier ${r.brier.toFixed(3)}`) : null,
          )
        : null,
      r.history.length > 1 ? pnlLine(r.history) : null,
      trades.length
        ? table(
            ['Closed', 'Trade', 'Confidence', 'P&L', 'Return', 'Thesis'],
            trades.map((t) => [day(t.at), `${t.id} ${t.side} ${t.symbol}`, `${t.confidence}%`, money(t.pnl), change(t.returnPct, 1), t.thesisHeld === undefined ? 'not reviewed' : t.thesisHeld ? 'held' : 'didn’t hold']),
            { right: [2, 3, 4] },
          )
        : null,
      r.closed > trades.length ? h('div.fd-mem.fd-muted', {}, `The latest ${trades.length} of its ${r.closed} closed trades.`) : null,
    ),
  );
}
