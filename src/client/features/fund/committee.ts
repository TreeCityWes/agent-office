// The 💼 Fund window's investment committee: every committee sitting, its seats and their sealed or
// open ballots (BUY / HOLD / SELL, with confidence, argument, evidence and risks), the tally and the
// chair's decision; then the ones decided. An admin calls a committee, opens its ballots early, or
// decides one a person chairs (or overrides its chair, on the record).
import './committee.css';
import { COMMITTEE_STATUS_LABEL, DEFAULT_MINUTES, tally, VOTES, type Ballot, type Committee, type Vote } from '../../../shared/fund/committee';
import { usd } from '../../../shared/fund/format';
import { ROLE_BY_ID } from '../../../shared/fund/roles';
import type { FundState } from '../../../shared/fund/state';
import type { Actor, Proposal } from '../../../shared/fund/types';
import { h, timeAgo } from '../../ui/dom';
import { clock, confirmButton, numberOf, section, type FundTab, type TabDeps } from './view';

const title = (role: string) => ROLE_BY_ID.get(role)?.title ?? role;
const named = (a: Actor) => (a.role ? `${a.name} (${title(a.role)})` : a.name);
/** Proposals worth a committee: not yet traded, or open and worth re-underwriting. */
const ASKABLE = new Set<Proposal['stage']>(['idea', 'research', 'cio_review', 'user_approval', 'monitoring']);

const voteChip = (v: Vote, extra = '') => h('span', { class: `fd-vote ${v}${extra}` }, v);

function ballotView(b: Ballot | undefined, role: string, skeptic: boolean, status: Committee['status'], name?: string): HTMLElement {
  const sealed = status === 'voting';
  return h(
    'div',
    { class: `fd-seat${skeptic ? ' skeptic' : ''}${b ? '' : ' waiting'}` },
    h(
      'div.fd-seat-head',
      {},
      h('span.fd-role', {}, skeptic ? `😈 ${title(role)}` : title(role)),
      name ? h('span.fd-who', {}, name) : null,
      h('span.grow'),
      b ? voteChip(b.vote) : h('span.fd-vacant', {}, status === 'voting' || status === 'open' ? 'no ballot yet' : 'no ballot'),
      b ? h('span.fd-conf', { title: `Confidence ${b.confidence}%` }, h('i', { style: `width:${b.confidence}%` }), h('b', {}, `${b.confidence}%`)) : null,
      b?.revised ? h('span.fd-hint', {}, 'revised') : null,
    ),
    b ? h('div.fd-ballot-arg', {}, b.argument) : null,
    b?.evidence.length ? h('ul.fd-ballot-list.evidence', {}, ...b.evidence.map((e) => h('li', {}, e))) : null,
    b?.risks.length ? h('ul.fd-ballot-list.risks', {}, ...b.risks.map((r) => h('li', {}, r))) : null,
    b && sealed ? h('div.fd-hint', {}, 'Sealed: the other seats can’t see it yet.') : null,
  );
}

function tallyBar(c: Committee): HTMLElement {
  const t = tally(c);
  const n = c.ballots.length || 1;
  return h(
    'div.fd-tally',
    {},
    h('div.fd-tally-bar', {}, ...VOTES.map((v) => (t[v] ? h('i', { class: v, style: `width:${(t[v] / n) * 100}%` }, `${v} ${t[v]}`) : null))),
    h('span.fd-tally-sum', { title: 'Each ballot counts by its confidence: +100 is everyone sure of BUY, -100 everyone sure of SELL' }, `score ${t.score > 0 ? '+' : ''}${t.score} · leaning `, voteChip(t.lean), t.abstained.length ? ` · ${t.abstained.length} not voted` : ''),
  );
}

export function committeeTab(deps: TabDeps): FundTab {
  const call = h('div.fd-call');
  const sitting = h('div.fd-cmts');
  const done = h('div.fd-cmts');
  const el = h('div.fd-tab', {}, call, section('Sitting', sitting), section('Decided', done));
  const cards = new Map<string, { sig: string; el: HTMLElement }>();
  const drafts = new Map<string, { vote: Vote; summary: string }>();
  let callSig = '';
  let calling = false;
  let last: FundState | null = null;

  function drawCall(s: FundState) {
    const staffed = s.desks.desks;
    const askable = s.proposals.filter((p) => ASKABLE.has(p.stage));
    const sig = JSON.stringify([deps.admin(), calling, staffed.map((d) => [d.role, d.name]), askable.map((p) => [p.id, p.stage])]);
    if (sig === callSig) return;
    if (call.contains(document.activeElement) && /^(TEXTAREA|SELECT|INPUT)$/.test(document.activeElement!.tagName)) return;
    callSig = sig;
    const hasSkeptic = staffed.some((d) => d.role === 'skeptic');
    const intro = h('span.fd-hint', {}, 'Each seat casts a sealed BUY / HOLD / SELL ballot with its confidence, argument, evidence and risks; the Skeptic always sits. A committee advises: every trade still goes through risk and a person.');
    if (!deps.admin()) return void call.replaceChildren(intro);
    if (!hasSkeptic) return void call.replaceChildren(intro, h('span.grow'), h('button.fd-btn', { type: 'button', onclick: () => deps.go('agents') }, 'Staff the Skeptic first'));
    if (!calling) return void call.replaceChildren(intro, h('span.grow'), h('button.fd-btn.go', { type: 'button', onclick: () => ((calling = true), (callSig = ''), last && update(last)) }, '🏛️ Call a committee'));
    const question = h('input.fd-input', { type: 'text', maxlength: '500', placeholder: 'What the committee is to decide (left empty: whether to take the proposal)' }) as HTMLInputElement;
    const proposal = h(
      'select.fd-input',
      { 'aria-label': 'About which proposal' },
      h('option', { value: '' }, 'No proposal: a question of its own'),
      ...askable.map((p) => h('option', { value: p.id }, `${p.id} · ${p.side} ${p.symbol} ${usd(p.sizeUsd, { compact: true })} · ${p.stage.replace('_', ' ')}`)),
    ) as HTMLSelectElement;
    const minutes = h('input.fd-input', { type: 'number', min: '1', max: '240', step: '1', value: String(DEFAULT_MINUTES) }) as HTMLInputElement;
    const boxes = staffed.map((d) => {
      const box = h('input', { type: 'checkbox', checked: true, disabled: d.role === 'skeptic', value: d.role }) as HTMLInputElement;
      return { role: d.role, box, el: h('label.fd-check', {}, box, ` ${title(d.role)} `, h('span.fd-who', {}, d.name)) };
    });
    const go = () => {
      const seats = boxes.filter((b) => b.box.checked).map((b) => b.role);
      const q = question.value.trim();
      if (!q && !proposal.value) return question.focus();
      deps.send({ t: 'fund.convene', question: q || `Should the fund take ${proposal.value}?`, ...(proposal.value ? { proposalId: proposal.value } : {}), seats, minutes: numberOf(minutes) ?? DEFAULT_MINUTES });
      calling = false;
      callSig = '';
    };
    call.replaceChildren(
      h(
        'div.fd-form.fd-call-form',
        {},
        h('label.fd-field.wide', {}, h('span', {}, 'Question'), question),
        h('label.fd-field', {}, h('span', {}, 'About'), proposal),
        h('label.fd-field', {}, h('span', {}, 'Voting stays open'), h('div.fd-row', {}, minutes, h('span.fd-unit', {}, 'min'))),
        h('div.fd-field.wide', {}, h('span', {}, 'Seats (you decide: a committee you call is chaired by the people running the fund)'), h('div.fd-seats-pick', {}, ...boxes.map((b) => b.el))),
      ),
      h('div.fd-actions', {}, h('span.fd-hint', {}, 'Each seat is told in its session, with the proposal in full.'), h('button.fd-btn', { type: 'button', onclick: () => ((calling = false), (callSig = ''), last && update(last)) }, 'Cancel'), h('button.fd-btn.go', { type: 'button', onclick: go }, 'Call it')),
    );
  }

  function decideForm(c: Committee): HTMLElement {
    const draft = drafts.get(c.id) ?? { vote: tally(c).lean, summary: '' };
    const vote = h('select.fd-input.fd-pick', { 'aria-label': 'The decision' }, ...VOTES.map((v) => h('option', { value: v, selected: v === draft.vote }, v))) as HTMLSelectElement;
    const summary = h('textarea.fd-input', { rows: '2', maxlength: '2000', placeholder: 'What the committee found, the dissent, and why you decide this way' }) as HTMLTextAreaElement;
    summary.value = draft.summary;
    const keep = () => drafts.set(c.id, { vote: vote.value as Vote, summary: summary.value });
    vote.addEventListener('change', keep);
    summary.addEventListener('input', keep);
    const over = !!c.chair;
    return h(
      'div.fd-compose',
      {},
      summary,
      h(
        'div.fd-actions',
        {},
        h('span.fd-hint', {}, over ? `The ${title(c.chair!)} chairs this one: deciding it yourself overrides the chair, on the record.` : 'You chair this one: your decision goes to every seat.'),
        vote,
        h('button.fd-btn.go', { type: 'button', onclick: () => (summary.value.trim().length < 10 ? summary.focus() : (deps.send({ t: 'fund.decide', id: c.id, vote: vote.value as Vote, summary: summary.value.trim() }), drafts.delete(c.id))) }, over ? 'Decide over the chair' : 'Decide'),
      ),
    );
  }

  function card(c: Committee, s: FundState): HTMLElement {
    const p = c.proposalId ? s.proposals.find((x) => x.id === c.proposalId) : undefined;
    const names = new Map(s.desks.desks.map((d) => [d.role, d.name]));
    const sitting = c.status === 'voting' || c.status === 'open';
    const when = c.status === 'voting' ? `voting closes ${clock(c.closesAt)}` : c.status === 'open' && c.decideBy ? `decision due ${clock(c.decideBy)}` : timeAgo(c.updatedAt);
    const seats = c.seats.map((role) => {
      const b = c.ballots.find((x) => x.role === role);
      return ballotView(b, role, role === 'skeptic', c.status, b?.by.name ?? names.get(role));
    });
    const actions: (HTMLElement | null)[] = [];
    if (deps.admin() && c.status === 'voting') actions.push(confirmButton('Open the ballots now', 'Open them?', () => deps.send({ t: 'fund.committee.close', id: c.id }), 'small'));
    return h(
      'article',
      { class: `fd-cmt ${c.status}` },
      h(
        'div.fd-cmt-head',
        {},
        h('b.fd-id', {}, c.id),
        h('span', { class: `fd-cstat ${c.status}` }, COMMITTEE_STATUS_LABEL[c.status]),
        h('span.fd-cmt-q', {}, c.question),
        h('span.grow'),
        h('span.fd-time', { title: new Date(c.openedAt).toLocaleString() }, when),
        ...actions,
      ),
      h(
        'div.fd-cmt-meta',
        {},
        `${c.chair && c.calledBy.role === c.chair ? `Called and chaired by ${named(c.calledBy)}` : `Called by ${named(c.calledBy)} · ${c.chair ? `chaired by the ${title(c.chair)}` : 'people chair it'}`} · ${c.ballots.length} of ${c.seats.length} voted`,
        p ? h('span.fd-cmt-p', {}, ` · ${p.id}: ${p.side} ${p.symbol} ${usd(p.risk?.approvedUsd ?? p.sizeUsd, { compact: true })}, ${p.stage.replace('_', ' ')}`) : null,
      ),
      c.ballots.length && c.status !== 'voting' ? tallyBar(c) : null,
      h('div.fd-seats', {}, ...seats),
      c.decision ? h('div.fd-decision', {}, voteChip(c.decision.vote, ' big'), h('div', {}, h('b', {}, `Decided by ${named(c.decision.by)} `), h('span.fd-time', {}, timeAgo(c.decision.at)), h('div', {}, c.decision.summary))) : null,
      c.status === 'lapsed' ? h('div.fd-hint', {}, 'Nobody decided in time: the ballots stand as they were.') : null,
      sitting && deps.admin() && c.status === 'open' ? decideForm(c) : null,
    );
  }

  function draw(list: HTMLElement, items: Committee[], s: FundState, empty: string) {
    if (!items.length) {
      list.replaceChildren(h('div.fd-empty', {}, empty));
      return;
    }
    const els = items.map((c) => {
      const sig = JSON.stringify([deps.admin(), c, c.proposalId && s.proposals.find((p) => p.id === c.proposalId)?.stage, c.seats.map((r) => s.desks.desks.find((d) => d.role === r)?.name)]);
      const had = cards.get(c.id);
      if (had && (had.sig === sig || (had.el.contains(document.activeElement) && /^(TEXTAREA|SELECT|INPUT)$/.test(document.activeElement!.tagName)))) return had.el;
      const next = card(c, s);
      cards.set(c.id, { sig, el: next });
      return next;
    });
    if (els.length !== list.children.length || els.some((e, i) => list.children[i] !== e)) list.replaceChildren(...els);
  }

  function update(s: FundState) {
    last = s;
    drawCall(s);
    const live = s.committees.filter((c) => c.status === 'voting' || c.status === 'open');
    draw(sitting, live, s, 'No committee is sitting. The CIO or PM calls one with fund_committee, or call one above.');
    draw(done, s.committees.filter((c) => !live.includes(c)), s, 'None decided yet.');
  }

  return { el, update };
}
