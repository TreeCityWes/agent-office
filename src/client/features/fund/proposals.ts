// The 💼 Fund window's proposals: what waits on you first, with the risk engine's verdict on each and
// the buttons to decide, then open trades, ideas and what's finished. A person can put a trade forward
// here too; it goes through risk like an agent's.
import { assetTable } from '../../../shared/fund/assets';
import { COMMITTEE_STATUS_LABEL, tally, type Committee } from '../../../shared/fund/committee';
import { pct, price, usd } from '../../../shared/fund/format';
import { STAGE_LABEL } from '../../../shared/fund/proposals';
import { ROLE_BY_ID } from '../../../shared/fund/roles';
import type { FundState } from '../../../shared/fund/state';
import type { Actor, Proposal, ProposalStage } from '../../../shared/fund/types';
import { h, timeAgo } from '../../ui/dom';
import { confirmButton, money, numberOf, section, type FundTab, type TabDeps } from './view';

const GROUPS: { title: string; stages: ProposalStage[] }[] = [
  { title: 'Waiting on your approval', stages: ['user_approval'] },
  { title: 'With the CIO', stages: ['cio_review'] },
  { title: 'Open trades', stages: ['executing', 'monitoring'] },
  { title: 'Ideas and research', stages: ['idea', 'research', 'proposed', 'risk_review'] },
  { title: 'Finished', stages: ['exited', 'reviewed', 'rejected', 'withdrawn', 'expired', 'failed'] },
];

const whoIs = (a: Actor) => (a.role && ROLE_BY_ID.get(a.role) ? `${a.name} · ${ROLE_BY_ID.get(a.role)!.title}` : a.name);

export function proposalsTab(deps: TabDeps): FundTab {
  const form = proposeForm(deps);
  const list = h('div.fd-proposals');
  const el = h('div.fd-tab', {}, form.el, list);
  let signature = '';

  function update(s: FundState) {
    form.update(s);
    const sig = `${deps.admin()}|${s.proposals.map((p) => `${p.id}:${p.stage}:${p.updatedAt}`).join(',')}|${s.committees.map((c) => `${c.id}:${c.status}`).join(',')}`;
    if (sig !== signature) {
      signature = sig;
      const groups = GROUPS.map((g) => ({ ...g, items: s.proposals.filter((p) => g.stages.includes(p.stage)) })).filter((g) => g.items.length);
      list.replaceChildren(
        ...(groups.length
          ? groups.map((g) => section(`${g.title} (${g.items.length})`, ...g.items.map((p) => card(p, deps, s.committees.find((c) => c.proposalId === p.id)))))
          : [h('div.fd-empty', {}, 'No proposals yet. Agents put trades forward from their desks; you can propose one above.')]),
      );
    }
    // What open trades are making, on every new price, without redrawing the cards.
    for (const span of list.querySelectorAll<HTMLElement>('[data-live]')) {
      const p = s.proposals.find((x) => x.id === span.dataset.live);
      const q = p && s.market.quotes.find((x) => x.symbol === p.symbol);
      if (!p || !q || p.qty === undefined || p.entryPrice === undefined) continue;
      span.replaceChildren(money((q.price - p.entryPrice) * p.qty - (p.fees ?? 0)), ` at ${price(q.price)}`);
    }
  }

  return { el, update };
}

/** One proposal: what it is, why, what risk said, and what can be done with it now. */
function card(p: Proposal, deps: TabDeps, cmt?: Committee): HTMLElement {
  const v = p.risk;
  const pending = p.stage === 'user_approval' || p.stage === 'cio_review';
  const note = h('input.fd-input', { type: 'text', placeholder: 'A note for the record (optional)', maxlength: '500' }) as HTMLInputElement;
  const actions: HTMLElement[] = [];
  if (deps.admin() && pending) {
    actions.push(
      h('button.fd-btn.go', { type: 'button', onclick: () => deps.send({ t: 'fund.approve', id: p.id, note: note.value }) }, p.stage === 'cio_review' ? 'Approve without the CIO' : 'Approve'),
      h('button.fd-btn.danger', { type: 'button', onclick: () => deps.send({ t: 'fund.reject', id: p.id, note: note.value }) }, 'Reject'),
    );
  }
  if (deps.admin() && p.stage === 'monitoring') actions.push(confirmButton('Exit now', 'Exit at market?', () => deps.send({ t: 'fund.exit', id: p.id })));

  const levels = [p.entry ? `entry ${price(p.entry)}` : 'entry at market', p.stop ? `stop ${price(p.stop)}` : 'no stop', p.target ? `target ${price(p.target)}` : 'no target'];
  return h(
    'article',
    { class: `fd-card stage-${p.stage}` },
    h(
      'header',
      {},
      h('span.fd-id', {}, p.id),
      h('span', { class: `fd-side ${p.side}` }, p.side.toUpperCase()),
      h('span.fd-sym', {}, p.symbol),
      h('span.num', {}, usd(p.sizeUsd)),
      p.strategyId ? h('span.fd-strat-tag', { title: 'Proposed under this quant lab strategy, and only because its signal backs it' }, `🧪 ${p.strategyId}`) : null,
      v && v.decision !== 'approved' ? h('span', { class: `fd-verdict ${v.decision}` }, v.decision === 'resized' ? `risk: ${usd(v.approvedUsd)}` : 'risk: rejected') : null,
      h('span.grow'),
      h('span', { class: `fd-stage ${p.stage}` }, STAGE_LABEL[p.stage]),
    ),
    h('div.fd-meta', {}, `${whoIs(p.author)} · ${timeAgo(p.createdAt)} · confidence ${p.confidence} · ${p.horizon} · ${levels.join(' · ')}`),
    h('p.fd-thesis', {}, p.thesis),
    p.catalyst ? h('div.fd-line', {}, h('b', {}, 'Catalyst '), p.catalyst) : null,
    p.evidence.length ? h('ul.fd-evidence', {}, ...p.evidence.map((e) => h('li', {}, e))) : null,
    p.dissent ? h('div.fd-line.dissent', {}, h('b', {}, 'Against '), p.dissent) : null,
    v ? riskBlock(p) : null,
    cmt ? committeeLine(cmt) : null,
    p.cio ? h('div.fd-line', {}, h('b', {}, `CIO ${p.cio.decision === 'approve' ? 'backed it' : 'turned it down'} `), `${p.cio.by.name}${p.cio.note ? `: ${p.cio.note}` : ''}`) : null,
    p.user ? h('div.fd-line', {}, h('b', {}, `${p.user.decision === 'approve' ? 'Approved' : 'Rejected'} by `), `${p.user.by.name}${p.user.note ? `: ${p.user.note}` : ''}`) : null,
    p.entryPrice !== undefined && p.qty !== undefined
      ? h(
          'div.fd-line.fill',
          {},
          h('b', {}, 'Filled '),
          `${Math.abs(p.qty).toLocaleString('en-US', { maximumFractionDigits: 6 })} @ ${price(p.entryPrice)} · fees ${usd(p.fees ?? 0, { cents: true })}`,
          p.stage === 'monitoring' ? h('span', {}, ' · now ', h('span', { 'data-live': p.id }, '…')) : null,
        )
      : null,
    p.exitPrice !== undefined ? h('div.fd-line', {}, h('b', {}, 'Out '), `@ ${price(p.exitPrice)} · `, money(p.pnl ?? 0)) : null,
    p.review ? h('div.fd-line', {}, h('b', {}, p.review.thesisHeld ? 'Review: the thesis held. ' : "Review: the thesis didn't hold. "), p.review.lessons) : null,
    h('details.fd-history', {}, h('summary', {}, 'History'), h('ol', {}, ...p.history.map((c) => h('li', {}, `${new Date(c.at).toLocaleString()} · ${STAGE_LABEL[c.stage]} · ${c.by.name}${c.note ? ` · ${c.note}` : ''}`)))),
    actions.length ? h('div.fd-actions', {}, pending && deps.admin() ? note : null, ...actions) : null,
  );
}

/** The latest committee on it: still sitting, or what it decided. The Committee tab has the ballots. */
function committeeLine(c: Committee): HTMLElement {
  if (c.decision) return h('div.fd-line', {}, h('b', {}, `🏛️ ${c.id} decided ${c.decision.vote} `), `${c.decision.by.name}: ${c.decision.summary.slice(0, 240)}`);
  const t = tally(c);
  const count = c.status === 'voting' ? `${c.ballots.length}/${c.seats.length} voted` : `${t.BUY} BUY · ${t.HOLD} HOLD · ${t.SELL} SELL`;
  return h('div.fd-line', {}, h('b', {}, `🏛️ ${c.id} ${COMMITTEE_STATUS_LABEL[c.status].toLowerCase()} `), count);
}

/** The risk engine's verdict: the decision and why, and every check behind it. */
function riskBlock(p: Proposal): HTMLElement {
  const v = p.risk!;
  const failed = v.checks.filter((c) => !c.pass);
  return h(
    'details',
    { class: `fd-risk ${v.decision}` },
    h(
      'summary',
      {},
      h('b', {}, v.decision === 'approved' ? '✔ Risk approved' : v.decision === 'resized' ? `↘ Risk resized to ${usd(v.approvedUsd)}` : '✖ Risk rejected'),
      ` · ${v.checks.length - failed.length}/${v.checks.length} checks passed${v.price ? ` at ${price(v.price)}` : ''} · ${timeAgo(v.at)}`,
      v.reasons.length ? h('div.fd-reasons', {}, ...v.reasons.map((r) => h('div', {}, r))) : null,
    ),
    h('ul.fd-checks', {}, ...v.checks.map((c) => h('li', { class: c.pass ? 'pass' : 'fail' }, h('span.mark', {}, c.pass ? '✔' : '✖'), h('b', {}, c.label), ` ${c.detail}`, c.capUsd !== undefined ? h('span.num', {}, ` · cap ${usd(c.capUsd)}`) : null))),
  );
}

/** The form for a person's own proposal. Made once, so what you type survives every update. */
function proposeForm(deps: TabDeps): { el: HTMLElement; update(s: FundState): void } {
  const symbol = h('select.fd-input') as HTMLSelectElement;
  const side = h('select.fd-input', {}, h('option', { value: 'long' }, 'Long'), h('option', { value: 'short' }, 'Short')) as HTMLSelectElement;
  const num = (placeholder: string) => h('input.fd-input', { type: 'number', min: '0', step: 'any', placeholder }) as HTMLInputElement;
  const size = num('50000');
  const stop = num('required by default');
  const target = num('optional');
  const confidence = h('input.fd-input', { type: 'number', min: '0', max: '100', value: '60' }) as HTMLInputElement;
  const horizon = h('input.fd-input', { type: 'text', value: '2w', maxlength: '16' }) as HTMLInputElement;
  const thesis = h('textarea.fd-input', { rows: '2', placeholder: 'Why this trade, in a sentence or more', maxlength: '2000' }) as HTMLTextAreaElement;
  const evidence = h('textarea.fd-input', { rows: '2', placeholder: 'What supports it, one item per line, with its source', maxlength: '2000' }) as HTMLTextAreaElement;
  const dissent = h('input.fd-input', { type: 'text', placeholder: 'The strongest case against (optional)', maxlength: '1000' }) as HTMLInputElement;
  const quote = h('span.fd-hint');
  /** The thesis last sent: once a proposal with it shows up, the form is cleared. */
  let sent = '';
  let symbols = '';
  let last: FundState | undefined;

  const field = (label: string, input: HTMLElement, wide = false) => h('label', { class: `fd-field${wide ? ' wide' : ''}` }, h('span', {}, label), input);
  const submit = h('button.fd-btn.go', { type: 'button' }, 'Send to risk') as HTMLButtonElement;
  submit.addEventListener('click', () => {
    sent = thesis.value.trim();
    deps.send({
      t: 'fund.propose',
      proposal: {
        symbol: symbol.value,
        side: side.value as 'long' | 'short',
        sizeUsd: numberOf(size),
        stop: numberOf(stop),
        target: numberOf(target),
        confidence: numberOf(confidence),
        horizon: horizon.value,
        thesis: thesis.value,
        evidence: evidence.value.split('\n').map((l) => l.trim()).filter(Boolean),
        dissent: dissent.value || undefined,
      },
    });
  });
  const showQuote = () => {
    const q = last?.market.quotes.find((x) => x.symbol === symbol.value);
    quote.textContent = q ? `last ${price(q.price)}${q.changePct !== undefined ? ` (${pct(q.changePct, 2, true)})` : ''} · ${q.source}${q.delayed ? ' · delayed' : ''}` : 'no price yet';
  };
  symbol.addEventListener('change', showQuote);

  const el = h(
    'details.fd-propose',
    {},
    h('summary', {}, 'Propose a trade yourself'),
    h(
      'div.fd-form',
      {},
      field('Asset', h('div.fd-row', {}, symbol, quote)),
      field('Direction', side),
      field('Size (USD)', size),
      field('Stop', stop),
      field('Target', target),
      field('Confidence 0–100', confidence),
      field('Horizon', horizon),
      field('Thesis', thesis, true),
      field('Evidence', evidence, true),
      field('Against', dissent, true),
      h('div.fd-actions.wide', {}, h('span.fd-hint', {}, 'It goes through the same risk checks as any agent’s, then waits for an approval.'), submit),
    ),
  );

  function update(s: FundState) {
    last = s;
    el.classList.toggle('hidden', !deps.admin());
    const table = assetTable(s.config.assets);
    const keys = [...table.keys()].join(',');
    if (keys !== symbols) {
      symbols = keys;
      const was = symbol.value || 'BTC';
      symbol.replaceChildren(...[...table.values()].map((a) => h('option', { value: a.symbol }, `${a.symbol} · ${a.name}`)));
      symbol.value = table.has(was) ? was : symbol.options[0]?.value ?? '';
    }
    showQuote();
    if (sent && s.proposals.some((p) => p.author.kind === 'user' && p.thesis === sent)) {
      sent = '';
      for (const i of [size, stop, target, thesis, evidence, dissent]) i.value = '';
      el.open = false;
    }
  }

  return { el, update };
}
