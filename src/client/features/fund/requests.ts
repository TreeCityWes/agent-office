// The research requests between the desks, on the 💼 Fund window's Research tab
// (docs/fund.md#research-requests-and-routines): who asked which desk what, by when, and the answer once
// it's in, with the desk's confidence and sources. Open ones come first, the soonest due at the top; an
// admin can take one back.
import './work.css';
import type { FundState } from '../../../shared/fund/state';
import { requestOrder, type ResearchRequest } from '../../../shared/fund/work';
import { h, timeAgo } from '../../ui/dom';
import { deskTitle } from './pnl';
import { confirmButton, section, type TabDeps } from './view';

const STATUS: Record<ResearchRequest['status'], string> = { open: 'Open', answered: 'Answered', withdrawn: 'Withdrawn' };
const SHOWN = 30;

const when = (at: number) => h('span.fd-time', { title: new Date(at).toLocaleString() }, timeAgo(at));
const asker = (r: ResearchRequest) => (r.from.kind === 'agent' && r.from.role ? `${deskTitle(r.from.role)} · ${r.from.name}` : r.from.name);
/** A while, in words: "25 min", "3 h", "2 days". */
const span = (ms: number) => {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 120 ? `${min} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
};
const source = (s: string) => (/^https?:\/\//i.test(s) ? h('a', { href: s, target: '_blank', rel: 'noopener noreferrer' }, s.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 48)) : h('span', {}, s.slice(0, 80)));

function requestRow(r: ResearchRequest, now: number, deps: TabDeps): HTMLElement {
  const overdue = r.status === 'open' && r.dueAt !== undefined && now > r.dueAt;
  const a = r.answer;
  return h(
    'li',
    { class: `fd-rq ${overdue ? 'overdue' : r.status}` },
    h(
      'div.fd-rq-head',
      {},
      h('b.fd-id', {}, r.id),
      h('span', { class: `fd-rq-status ${overdue ? 'overdue' : r.status}` }, overdue ? 'Overdue' : STATUS[r.status]),
      h('span.fd-who', {}, asker(r)),
      h('span.fd-rq-arrow', {}, '→'),
      h('span.fd-role', {}, deskTitle(r.to)),
      r.symbol ? h('b.fd-sym', {}, r.symbol) : null,
      r.proposalId ? h('b.fd-id', {}, r.proposalId) : null,
      h('span.grow'),
      r.status === 'open' && r.dueAt !== undefined ? h('span.fd-rq-due', { title: new Date(r.dueAt).toLocaleString() }, overdue ? `due ${span(now - r.dueAt)} ago` : `due in ${span(r.dueAt - now)}`) : null,
      when(r.at),
      r.status === 'open' && deps.admin() ? confirmButton('Withdraw', 'Take it back?', () => deps.send({ t: 'fund.request.withdraw', id: r.id }), 'danger small') : null,
    ),
    h('div.fd-rq-q', {}, r.question.slice(0, 700)),
    a
      ? h(
          'div.fd-rq-a',
          {},
          h('div.fd-rq-a-head', {}, '📬 ', h('span.fd-who', {}, a.by.name), a.confidence !== undefined ? h('b', {}, ` ${a.confidence}%`) : null, ' · ', when(a.at)),
          h('div', {}, a.text.slice(0, 1500)),
          a.sources?.length ? h('div.fd-src', {}, ...a.sources.slice(0, 5).flatMap((s, i) => (i ? [' · ', source(s)] : [source(s)]))) : null,
        )
      : null,
    r.withdrawn ? h('div.fd-rq-w', {}, `Withdrawn by ${r.withdrawn.by.name}${r.withdrawn.note ? `: ${r.withdrawn.note}` : ''} · `, when(r.withdrawn.at)) : null,
  );
}

/** The Research tab's list of requests, redrawn only when one changes (or the minute turns, for how long until each is due). */
export function requestsSection(deps: TabDeps): { el: HTMLElement; update(s: FundState): void } {
  const sum = h('div.fd-hint');
  const list = h('ol.fd-rq-list');
  const el = section('Research requests', sum, list);
  let sig = '';
  return {
    el,
    update(s) {
      const all = [...s.desks.requests].sort(requestOrder);
      const now = Date.now();
      const next = JSON.stringify([deps.admin(), Math.floor(now / 60_000), all.map((r) => [r.id, r.status, r.reminded])]);
      if (next === sig) return;
      // Not while a Withdraw is waiting for its second click.
      if (list.querySelector('.fd-btn.armed')) return;
      sig = next;
      const open = all.filter((r) => r.status === 'open');
      const late = open.filter((r) => r.dueAt !== undefined && now > r.dueAt).length;
      sum.textContent = open.length
        ? `${open.length} open${late ? `, ${late} overdue` : ''}. The desk asked answers with fund_answer, and whoever asked hears it.`
        : 'A desk asks another with fund_request, or you ask one above: it stays here, open, until that desk answers.';
      list.replaceChildren(...(all.length ? all.slice(0, SHOWN).map((r) => requestRow(r, now, deps)) : [h('li.fd-empty', {}, 'No requests yet.')]));
    },
  };
}
