// The 💼 Fund window's activity log: every proposal, verdict, ruling, fill, exit and limit change, and
// everything the desks said and did, with who did it, newest first. It's the fund's own record (activity.jsonl), not the chat.
import type { FundState } from '../../../shared/fund/state';
import type { ActivityEvent, ActivityKind } from '../../../shared/fund/types';
import { h } from '../../ui/dom';
import { clock, type FundTab } from './view';

/** A chip for every kind the log holds: a kind added to ActivityKind needs one here. */
const LABEL: Record<ActivityKind, string> = {
  proposal: 'Proposals',
  risk: 'Risk',
  ruling: 'Rulings',
  committee: 'Committees',
  strategy: 'Strategies',
  backtest: 'Backtests',
  fill: 'Fills',
  exit: 'Exits',
  limits: 'Limits',
  review: 'Reviews',
  thesis: 'Theses',
  observation: 'Observations',
  status: 'Status',
  assignment: 'Assignments',
  message: 'Messages',
  request: 'Requests',
  routine: 'Routines',
  escalation: 'Escalations',
  system: 'The office',
};
const KINDS: { id: 'all' | ActivityKind; label: string }[] = [{ id: 'all', label: 'Everything' }, ...(Object.entries(LABEL) as [ActivityKind, string][]).map(([id, label]) => ({ id, label }))];

export function activityTab(): FundTab {
  let kind: 'all' | ActivityKind = 'all';
  let last: readonly ActivityEvent[] = [];
  const chips = h('div.fd-chips');
  const list = h('ol.fd-log');
  const el = h('div.fd-tab', {}, chips, list);

  function drawChips() {
    chips.replaceChildren(
      ...KINDS.map((k) =>
        h(
          'button',
          {
            type: 'button',
            class: `fd-chip${k.id === kind ? ' on' : ''}`,
            onclick: () => {
              kind = k.id;
              drawChips();
              draw();
            },
          },
          k.label,
        ),
      ),
    );
  }

  function draw() {
    const shown = kind === 'all' ? last : last.filter((e) => e.kind === kind);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((e) =>
            h(
              'li',
              { class: `fd-event ${e.level ?? 'info'}` },
              h('span.fd-time', { title: new Date(e.at).toLocaleString() }, clock(e.at)),
              h('span.fd-kind', {}, e.kind.toUpperCase()),
              h('span.fd-actor', { class: e.actor.kind }, e.actor.name),
              // Most lines name their proposal already.
              h('span.fd-text', {}, e.proposalId && !e.text.includes(e.proposalId) ? h('b', {}, `${e.proposalId} `) : null, e.text),
            ),
          )
        : [h('li.fd-empty', {}, 'Nothing here yet.')]),
    );
  }

  drawChips();
  return {
    el,
    update(_s: FundState, activity: readonly ActivityEvent[]) {
      if (activity === last) return;
      last = activity;
      draw();
    },
  };
}
