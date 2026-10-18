// The 💼 Fund window's desks: every role at the fund by department, the agent holding each (what it
// says it's doing, its thesis and confidence, how its calls have done), and the messages between them.
// An admin staffs a role with a new agent or one already at a desk, hands it a task, messages it, or
// takes the role back; anyone can read a role's memory, and its record: what it may do and how its trades
// have done (desk-record.ts). The desks' routines are listed under them (routines.ts).
import './agents.css';
import { winRate, type DeskMemory, type DeskRecord, type DeskView, type FundMessage } from '../../../shared/fund/desks';
import { DEPARTMENTS, DESK_STATUS_LABEL, ROLE_BY_ID, ROLES, type Department, type RoleDef } from '../../../shared/fund/roles';
import type { FundState } from '../../../shared/fund/state';
import type { Actor } from '../../../shared/fund/types';
import type { AgentProvider } from '../../../shared/providers';
import { store } from '../../state';
import { h, STATUS_LABEL, timeAgo } from '../../ui/dom';
import { PROVIDER_LABEL, supportedProviders } from '../../ui/provider';
import { recordView } from './desk-record';
import { routinesSection } from './routines';
import { clock, confirmButton, money, section, type FundTab, type TabDeps } from './view';

/** The desks to staff first: a CIO to run it, research on macro and crypto, a quant, and the Skeptic. */
const CORE = ['cio', 'macro', 'crypto-analyst', 'quant', 'skeptic'];
const KIND_ICON: Record<FundMessage['kind'], string> = { message: '📨', assignment: '📋', escalation: '🚨', committee: '🏛️', request: '🔎', routine: '⏰' };

type Panel = 'assign' | 'message' | 'memory' | 'record';

const named = (a: Actor) => (a.role && ROLE_BY_ID.get(a.role) ? `${a.name} (${ROLE_BY_ID.get(a.role)!.title})` : a.name);

/** Which agent a role goes to: a new one ('new:' and its provider, or the office's default) or one at a desk ('worker:' and its id). */
function staffPicker(taken: ReadonlySet<string>): HTMLSelectElement {
  const providers = supportedProviders(store.project);
  const free = [...store.workers.values()].filter((w) => w.kind === 'agent' && !taken.has(w.id));
  return h(
    'select.fd-input.fd-pick',
    { 'aria-label': 'Who takes the role' },
    h('option', { value: 'new:' }, 'A new agent'),
    ...(providers.length > 1 ? providers.map((p) => h('option', { value: `new:${p}` }, `A new ${PROVIDER_LABEL[p]} agent`)) : []),
    ...free.map((w) => h('option', { value: `worker:${w.id}` }, `${w.name}, at a desk here`)),
  ) as HTMLSelectElement;
}

function recordLine(r: DeskRecord | undefined): HTMLElement | null {
  if (!r?.proposed) return null;
  const wr = winRate(r);
  return h(
    'span.fd-record',
    { title: 'Its role’s proposals: how many it made, filled, won and lost, and what the closed ones made. Record has the trades.' },
    `${r.proposed} proposed · ${r.filled} filled`,
    r.closed ? ` · ${r.wins}W ${r.losses}L${wr !== undefined ? ` (${wr.toFixed(0)}%) ` : ' '}` : ' ',
    r.closed ? money(r.realizedPnl, true) : null,
  );
}

function confidence(n: number | undefined): HTMLElement | null {
  if (n === undefined) return null;
  return h('span.fd-conf', { title: `Confidence ${n}%` }, h('i', { style: `width:${n}%` }), h('b', {}, `${n}%`));
}

function memoryView(m: DeskMemory): HTMLElement {
  const block = (title: string, items: HTMLElement[]) => (items.length ? h('div.fd-mem-block', {}, h('h4', {}, title), ...items) : null);
  const when = (at: number) => h('span.fd-time', { title: new Date(at).toLocaleString() }, timeAgo(at));
  const parts = [
    block('Thesis history', m.theses.slice(0, 8).map((t) => h('div.fd-mem', {}, when(t.at), t.confidence !== undefined ? h('b', {}, ` ${t.confidence}% `) : ' ', t.thesis.slice(0, 500), t.why ? h('i', {}, ` (${t.why.slice(0, 200)})`) : null))),
    block('Observations', m.observations.slice(0, 12).map((o) => h('div.fd-mem', {}, when(o.at), o.symbol ? h('b', {}, ` ${o.symbol} `) : ' ', o.text.slice(0, 400), o.sources?.length ? h('span.fd-src', {}, ` [${o.sources.slice(0, 3).join(', ')}]`) : null))),
    block('Decisions', m.decisions.slice(0, 12).map((d) => h('div.fd-mem', {}, when(d.at), h('b', {}, ` ${d.kind}${d.proposalId ? ` ${d.proposalId}` : ''} `), d.text.slice(0, 300)))),
  ].filter((x) => !!x);
  return h('div.fd-memory', {}, ...(parts.length ? parts : [h('div.fd-empty', {}, 'Nothing remembered yet: whoever holds this role writes here with fund_thesis and fund_observe, and every proposal and ruling it makes is added.')]));
}

export function agentsTab(deps: TabDeps): FundTab {
  const team = h('div.fd-team');
  const depts = new Map<Department, { el: HTMLElement; title: HTMLElement; list: HTMLElement }>();
  for (const [id, d] of Object.entries(DEPARTMENTS) as [Department, (typeof DEPARTMENTS)[Department]][]) {
    const title = h('h3', {}, `${d.icon} ${d.label}`);
    const list = h('div.fd-desks');
    depts.set(id, { el: h('section.fd-section.fd-dept', { style: `--dept:${d.color}` }, title, list), title, list });
  }
  const messages = h('ol.fd-log.fd-msgs');
  const routines = routinesSection(deps);
  const el = h('div.fd-tab', {}, team, ...[...depts.values()].map((d) => d.el), routines.el, section('Between the desks', messages));
  const rows = new Map<string, { sig: string; el: HTMLElement }>();
  const open = new Map<string, Panel>();
  const drafts = new Map<string, string>();
  let last: FundState | null = null;
  let teamSig = '';
  let msgSig = '';

  function toggle(role: string, panel: Panel) {
    if (open.get(role) === panel) open.delete(role);
    else {
      open.set(role, panel);
      if (panel === 'memory') deps.send({ t: 'fund.memory', role });
    }
    redraw(role);
  }

  function redraw(role: string) {
    rows.get(role)!.sig = '';
    if (last) update(last);
  }

  function panel(role: RoleDef, kind: Panel, rec: DeskRecord | undefined): HTMLElement {
    if (kind === 'record') return recordView(role, rec);
    if (kind === 'memory') {
      const m = store.fundMemory;
      return m?.role === role.id ? memoryView(m) : h('div.fd-empty', {}, 'Reading its memory…');
    }
    const key = `${kind}:${role.id}`;
    const text = h('textarea.fd-input', { rows: '3', maxlength: '8000', placeholder: kind === 'assign' ? `A task for the ${role.title}: what you need back, and by when` : `A message for the ${role.title}` }) as HTMLTextAreaElement;
    text.value = drafts.get(key) ?? '';
    text.addEventListener('input', () => drafts.set(key, text.value));
    const go = () => {
      const said = text.value.trim();
      if (!said) return;
      deps.send(kind === 'assign' ? { t: 'fund.assign', role: role.id, text: said } : { t: 'fund.message', to: role.id, text: said });
      drafts.delete(key);
      open.delete(role.id);
      redraw(role.id);
    };
    return h('div.fd-compose', {}, text, h('div.fd-actions', {}, h('span.fd-hint', {}, 'It’s typed into the agent’s session, and kept in its inbox and the fund’s log.'), h('button.fd-btn', { type: 'button', onclick: () => toggle(role.id, kind) }, 'Cancel'), h('button.fd-btn.go', { type: 'button', onclick: go }, kind === 'assign' ? 'Assign' : 'Send')));
  }

  function row(role: RoleDef, d: DeskView | undefined, rec: DeskRecord | undefined, taken: ReadonlySet<string>): HTMLElement {
    const admin = deps.admin();
    const btn = (label: string, kind: Panel) => h('button', { type: 'button', class: `fd-btn small${open.get(role.id) === kind ? ' on' : ''}`, onclick: () => toggle(role.id, kind) }, label);
    const actions: (HTMLElement | null)[] = [];
    if (d && admin) actions.push(btn('Assign', 'assign'), btn('Message', 'message'));
    actions.push(btn('Memory', 'memory'), btn('Record', 'record'));
    if (d && admin) actions.push(confirmButton('Release', 'Free the desk?', () => deps.send({ t: 'fund.release', workerId: d.workerId }), 'danger small'));
    if (!d && admin) {
      const pick = staffPicker(taken);
      actions.push(
        pick,
        h(
          'button.fd-btn.go.small',
          {
            type: 'button',
            onclick: () => {
              const [how, what] = pick.value.split(':');
              deps.send(how === 'worker' ? { t: 'fund.staff', role: role.id, workerId: what } : { t: 'fund.staff', role: role.id, ...(what ? { provider: what as AgentProvider } : {}) });
            },
          },
          'Staff',
        ),
      );
    }
    const kind = open.get(role.id);
    return h(
      'div',
      { class: `fd-desk${d ? ' staffed' : ''}` },
      h(
        'div.fd-desk-head',
        {},
        h('span.fd-role', { title: role.blurb }, role.title),
        d ? h('span.fd-who', { title: `${d.floorName}${d.provider ? ` · ${PROVIDER_LABEL[d.provider]}` : ''}${d.model ? ` · ${d.model}` : ''}` }, d.name) : h('span.fd-vacant', {}, 'vacant'),
        d ? h('span', { class: `fd-proc ${d.process}`, title: 'What its process is doing' }, STATUS_LABEL[d.process]) : null,
        d ? h('span', { class: `fd-dstat ${d.status}`, title: `What it says it’s doing, since ${new Date(d.updatedAt).toLocaleTimeString()}` }, DESK_STATUS_LABEL[d.status]) : null,
        h('span.grow'),
        recordLine(rec),
        h('span.fd-desk-actions', {}, ...actions),
      ),
      d?.note ? h('div.fd-desk-note', {}, d.note) : null,
      !d ? h('div.fd-desk-note.muted', {}, role.blurb) : null,
      d?.assignment ? h('div.fd-desk-assign', {}, '📋 ', h('b', {}, d.assignment.by), ` ${timeAgo(d.assignment.at)}: `, d.assignment.text) : null,
      d?.thesis ? h('div.fd-desk-thesis', {}, confidence(d.confidence), h('span', {}, d.thesis.length > 320 ? `${d.thesis.slice(0, 320)}…` : d.thesis)) : null,
      kind ? panel(role, kind, rec) : null,
    );
  }

  function drawTeam(s: FundState) {
    const held = new Set(s.desks.desks.map((d) => d.role));
    const vacant = CORE.filter((r) => !held.has(r));
    const working = s.desks.desks.filter((d) => d.process === 'working').length;
    const sig = `${deps.admin()}|${vacant.join()}|${s.desks.desks.length}|${working}|${supportedProviders(store.project).join()}`;
    if (sig === teamSig) return;
    teamSig = sig;
    const summary = h('span.fd-team-sum', {}, h('b', {}, `${s.desks.desks.length}`), ` of ${ROLES.length} desks staffed · `, h('b', {}, `${working}`), ' working');
    if (!deps.admin() || !vacant.length) return void team.replaceChildren(summary, h('span.grow'), h('span.fd-hint', {}, s.desks.desks.length ? 'Every agent here is a real session at a desk in the office.' : 'An admin staffs the desks.'));
    const providers = supportedProviders(store.project);
    const pick = h('select.fd-input.fd-pick', { 'aria-label': 'Which agent' }, h('option', { value: '' }, 'Office default'), ...providers.map((p) => h('option', { value: p }, PROVIDER_LABEL[p]))) as HTMLSelectElement;
    const names = vacant.map((r) => ROLE_BY_ID.get(r)!.title).join(', ');
    team.replaceChildren(
      summary,
      h('span.grow'),
      h('span.fd-hint', {}, `Core team: ${names}`),
      ...(providers.length > 1 ? [pick] : []),
      confirmButton(`Hire ${vacant.length} agent${vacant.length === 1 ? '' : 's'}`, `Start ${vacant.length} agent${vacant.length === 1 ? '' : 's'}?`, () => {
        for (const role of vacant) deps.send({ t: 'fund.staff', role, ...(pick.value ? { provider: pick.value as AgentProvider } : {}) });
      }, 'go'),
    );
  }

  function drawMessages(s: FundState) {
    const sig = s.desks.messages.map((m) => m.id).join();
    if (sig === msgSig) return;
    msgSig = sig;
    messages.replaceChildren(
      ...(s.desks.messages.length
        ? s.desks.messages.slice(0, 40).map((m) =>
            h(
              'li',
              { class: `fd-event ${m.kind === 'escalation' ? 'warn' : 'info'}` },
              h('span.fd-time', { title: new Date(m.at).toLocaleString() }, clock(m.at)),
              h('span.fd-kind', {}, `${KIND_ICON[m.kind]} ${m.kind.toUpperCase()}`),
              h('span.fd-actor', { class: m.from.kind }, `${named(m.from)} → ${m.to === 'people' ? 'the people' : (ROLE_BY_ID.get(m.to)?.title ?? m.to)}`),
              h('span.fd-text', {}, m.proposalId ? h('b', {}, `${m.proposalId} `) : null, m.text.length > 400 ? `${m.text.slice(0, 400)}…` : m.text),
            ),
          )
        : [h('li.fd-empty', {}, 'No messages yet. Desks write to each other with fund_message, the CIO assigns work with fund_assign, and anyone can escalate to you with fund_escalate.')]),
    );
  }

  function update(s: FundState) {
    last = s;
    drawTeam(s);
    const byRole = new Map(s.desks.desks.map((d) => [d.role, d]));
    const taken = new Set(s.desks.desks.map((d) => d.workerId));
    const free = [...store.workers.values()].filter((w) => w.kind === 'agent' && !taken.has(w.id)).map((w) => w.id);
    for (const role of ROLES) {
      const d = byRole.get(role.id);
      const rec = s.desks.records[role.id];
      const kind = open.get(role.id);
      const memo = kind === 'memory' && store.fundMemory?.role === role.id ? store.fundMemory : null;
      const sig = JSON.stringify([deps.admin(), d && { ...d, since: 0 }, rec, kind, memo && [memo.theses.length, memo.observations.length, memo.decisions.length], !d && free]);
      const had = rows.get(role.id);
      if (had?.sig === sig) continue;
      // Not while someone's typing or choosing in it: it's redrawn on the next change after.
      if (had && had.el.contains(document.activeElement) && /^(TEXTAREA|SELECT|INPUT)$/.test(document.activeElement!.tagName)) continue;
      const next = row(role, d, rec, taken);
      if (had) had.el.replaceWith(next);
      else depts.get(role.department)!.list.append(next);
      rows.set(role.id, { sig, el: next });
    }
    for (const [id, dept] of depts) {
      const roles = ROLES.filter((r) => r.department === id);
      dept.title.textContent = `${DEPARTMENTS[id].icon} ${DEPARTMENTS[id].label} · ${roles.filter((r) => byRole.has(r.id)).length}/${roles.length}`;
    }
    routines.update(s);
    drawMessages(s);
  }

  // A role's memory arrives a moment after it's asked for (and the window may have closed meanwhile).
  const off = store.on('fundMemory', () => {
    if (!el.isConnected) return off();
    const role = store.fundMemory?.role;
    if (role && open.get(role) === 'memory') redraw(role);
  });

  return { el, update };
}
