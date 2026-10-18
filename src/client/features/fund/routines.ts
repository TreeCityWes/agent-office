// The routines on the 💼 Fund window's Agents tab (docs/fund.md#research-requests-and-routines): standing
// prompts the office types into a desk's agent every so often, each with who set it, when it last ran and
// what happened, and when it's next due. An admin adds one, pauses or resumes it, runs it now or removes it.
import './work.css';
import { DEPARTMENTS, ROLES, type Department } from '../../../shared/fund/roles';
import type { FundState } from '../../../shared/fund/state';
import { everyLabel, routineNext, ROUTINE_MAX_EVERY, ROUTINE_MIN_EVERY, type Routine } from '../../../shared/fund/work';
import { h, timeAgo } from '../../ui/dom';
import { deskTitle } from './pnl';
import { confirmButton, numberOf, section, table, type TabDeps } from './view';

const clockOf = (at: number) => h('span.fd-time', { title: new Date(at).toLocaleString() }, new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

/** The Agents tab's routines: the form to add one (for an admin) and the list. */
export function routinesSection(deps: TabDeps): { el: HTMLElement; update(s: FundState): void } {
  const form = h('div');
  const list = h('div');
  const el = section('Routines', form, list);

  // The form, made once: a desk, how often, and what it should do each time.
  const role = h(
    'select.fd-input',
    { 'aria-label': 'Which desk' },
    ...(Object.entries(DEPARTMENTS) as [Department, (typeof DEPARTMENTS)[Department]][]).map(([id, d]) => h('optgroup', { label: `${d.icon} ${d.label}` }, ...ROLES.filter((r) => r.department === id).map((r) => h('option', { value: r.id }, r.title)))),
  ) as HTMLSelectElement;
  role.value = 'cio';
  const every = h('input.fd-input', { type: 'number', min: String(ROUTINE_MIN_EVERY), max: String(ROUTINE_MAX_EVERY), step: '5', value: '60', 'aria-label': 'Every how many minutes' }) as HTMLInputElement;
  const prompt = h('input.fd-input', { placeholder: 'What the desk should do each time, e.g. “Check BTC funding and open interest; note anything stretched”', maxlength: '4000', 'aria-label': 'Prompt' }) as HTMLInputElement;
  const add = () => {
    const text = prompt.value.trim();
    const min = numberOf(every);
    if (!text) return prompt.focus();
    if (min === undefined || min < ROUTINE_MIN_EVERY || min > ROUTINE_MAX_EVERY) return every.focus();
    deps.send({ t: 'fund.routine', routine: { role: role.value, prompt: text, everyMin: Math.round(min) } });
    prompt.value = '';
  };
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  const adder = h(
    'div',
    {},
    h('div.fd-rt-add', {}, role, h('label.fd-rt-every', {}, 'every', every, 'min'), prompt, h('button.fd-btn.go', { type: 'button', onclick: add }, 'Add')),
    h('div.fd-hint', {}, 'Typed into the desk’s agent when it comes due, unless it’s busy (it waits, up to one more interval) or nobody holds the desk (it skips). The CIO, PM and CRO can set them too, with fund_routine.'),
  );

  let sig = '';
  return {
    el,
    update(s) {
      const admin = deps.admin();
      const held = new Set(s.desks.desks.map((d) => d.role));
      const next = JSON.stringify([admin, [...held], s.desks.routines, Math.floor(Date.now() / 60_000)]);
      if (next === sig) return;
      if (el.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement!.tagName)) return;
      if (list.querySelector('.fd-btn.armed')) return;
      sig = next;
      form.replaceChildren(admin ? adder : '');
      list.replaceChildren(
        table(
          ['Routine', 'Desk', 'Every', 'Prompt', 'Set by', 'Runs', 'Last', 'Next', ''],
          s.desks.routines.map((r: Routine) => [
            h('b.fd-id', {}, r.id),
            h('span', { class: `fd-role${held.has(r.role) ? '' : ' fd-rt-vacant'}`, title: held.has(r.role) ? '' : 'Nobody holds this desk: it skips until someone does' }, deskTitle(r.role)),
            everyLabel(r.everyMin).replace(/^every /, ''),
            h('span.fd-rt-prompt', { title: r.prompt }, r.prompt.slice(0, 140)),
            r.by.name,
            h('span.num', {}, String(r.runs)),
            r.lastAt ? h('span', { class: `fd-rt-last${r.last?.startsWith('Typed') ? '' : ' warn'}`, title: new Date(r.lastAt).toLocaleString() }, `${r.last ?? ''} · ${timeAgo(r.lastAt)}`) : h('span.flat', {}, 'not yet'),
            r.on ? clockOf(routineNext(r)) : h('span.fd-rt-off', {}, 'paused'),
            admin
              ? h(
                  'span.fd-desk-actions',
                  {},
                  h('button.fd-btn.small', { type: 'button', onclick: () => deps.send({ t: 'fund.routine', routine: { id: r.id, on: !r.on } }) }, r.on ? 'Pause' : 'Resume'),
                  h('button.fd-btn.small', { type: 'button', disabled: !held.has(r.role), onclick: () => deps.send({ t: 'fund.routine.run', id: r.id }) }, 'Run now'),
                  confirmButton('Remove', 'Remove it?', () => deps.send({ t: 'fund.routine.remove', id: r.id }), 'danger small'),
                )
              : '',
          ]),
          { right: [5], empty: 'No routines yet. A routine hands a desk the same piece of work on a schedule: a morning macro read, a funding check every hour, a risk sweep every day.' },
        ),
      );
    },
  };
}
