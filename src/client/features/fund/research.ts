// The 💼 Fund window's Research tab (docs/fund.md#research): what the desks are working on now, every
// desk's thesis and how its confidence moved, which assets the fund covers and how closely, the ideas
// still being filled in, the notes the desks post, and how their calls did against the confidence they
// gave. An admin can ask any desk to look into something, tracked with the desks' own requests until it's
// answered (requests.ts). It's read from the desks' memory on disk, so it's asked for (fund.research) when
// the tab opens and again when a desk writes, not sent with the fund.
import './research.css';
import { price } from '../../../shared/fund/format';
import { STAGE_LABEL } from '../../../shared/fund/proposals';
import { coverage, type Coverage, type DeskThesis, type ResearchNote, type ResearchView } from '../../../shared/fund/research';
import { DEPARTMENTS, DESK_STATUS_LABEL, ROLE_BY_ID, ROLES, type Department } from '../../../shared/fund/roles';
import type { FundState } from '../../../shared/fund/state';
import type { ActivityEvent, ActivityKind } from '../../../shared/fund/types';
import { store } from '../../state';
import { h, timeAgo } from '../../ui/dom';
import { deskTitle } from './pnl';
import { requestsSection } from './requests';
import { change, money, section, table, type FundTab, type TabDeps } from './view';

/** What a desk writing changes here: a new note or thesis, or a trade closing and being reviewed. */
const CHANGES: readonly ActivityKind[] = ['observation', 'thesis', 'exit', 'review'];
const THROTTLE_MS = 3000;
const STALE_MS = 60_000;

const deptOf = (role: string): Department | undefined => ROLE_BY_ID.get(role)?.department;
const color = (role: string) => {
  const d = deptOf(role);
  return d ? DEPARTMENTS[d].color : '#7f8c9b';
};
const when = (at: number) => h('span.fd-time', { title: new Date(at).toLocaleString() }, timeAgo(at));
/** A source, as a link when it's a web address and as text when it isn't. */
const source = (s: string) => (/^https?:\/\//i.test(s) ? h('a', { href: s, target: '_blank', rel: 'noopener noreferrer' }, s.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 48)) : h('span', {}, s.slice(0, 80)));

function confidenceBar(n: number | undefined, was?: number): HTMLElement | null {
  if (n === undefined) return null;
  const moved = was === undefined ? 0 : n - was;
  return h(
    'span.fd-rs-conf',
    { title: was === undefined ? `Confidence ${n}%` : `Confidence ${n}%, was ${was}%` },
    h('span.fd-conf', {}, h('i', { style: `width:${n}%` }), h('b', {}, `${n}%`)),
    moved ? h('span', { class: `num ${moved > 0 ? 'up' : 'down'}` }, `${moved > 0 ? '▲' : '▼'}${Math.abs(moved)}`) : null,
  );
}

function thesisCard(t: DeskThesis): HTMLElement {
  const role = ROLE_BY_ID.get(t.role);
  const dept = role ? DEPARTMENTS[role.department] : undefined;
  return h(
    'article.fd-rs-thesis',
    { style: `--dept:${color(t.role)}` },
    h('div.fd-rs-thesis-head', {}, h('span.fd-role', {}, `${dept?.icon ?? ''} ${role?.title ?? t.role}`), h('span.grow'), confidenceBar(t.confidence, t.was)),
    h('p', {}, t.thesis.slice(0, 600)),
    t.why ? h('p.fd-rs-why', {}, 'Why it changed: ', t.why.slice(0, 300)) : null,
    h('div.fd-rs-thesis-foot', {}, h('span.fd-who', {}, t.by.name), ' · ', when(t.at), t.versions > 1 ? ` · version ${t.versions}` : ''),
  );
}

function coverageRow(c: Coverage, top: number, pick: (symbol: string) => void): (Node | string)[] {
  const heat = c.notes + 2 * (c.ideas + c.live) + c.signals;
  return [
    h('button.fd-rs-sym', { type: 'button', title: `Show the notes on ${c.symbol}`, onclick: () => pick(c.symbol) }, c.symbol),
    h('span.fd-rs-heat', { title: `${heat}: notes, plus twice the ideas and live proposals, plus signals` }, h('i', { style: `width:${top ? Math.round((heat / top) * 100) : 0}%` })),
    h('span.num', {}, c.notes ? String(c.notes) : '—'),
    h('span.fd-rs-desks', {}, ...c.desks.slice(0, 4).map((d) => h('i', { style: `background:${color(d)}`, title: deskTitle(d) }))),
    h('span.num', {}, c.ideas ? String(c.ideas) : '—'),
    h('span.num', {}, c.live ? String(c.live) : '—'),
    c.long || c.short ? h('span.fd-rs-lean', { title: `${c.long} long, ${c.short} short, ideas included` }, c.long ? h('span.num.up', {}, `▲${c.long}`) : null, c.short ? h('span.num.down', {}, `▼${c.short}`) : null) : h('span.num.flat', {}, '—'),
    c.position ? h('span', {}, h('span', { class: `fd-side ${c.position.side}` }, c.position.side.toUpperCase()), ' ', money(c.position.unrealizedPnl, true)) : h('span.flat', {}, '—'),
    h('span.num', {}, c.signals ? String(c.signals) : '—'),
    c.latest ? h('span.fd-rs-latest', { title: c.latest.text }, when(c.latest.at), ' ', c.latest.text.slice(0, 90)) : '',
  ];
}

function noteRow(n: ResearchNote): HTMLElement {
  return h(
    'li.fd-rs-note',
    { style: `--dept:${color(n.role)}` },
    h('div.fd-rs-note-head', {}, h('span.fd-role', {}, deskTitle(n.role)), h('span.fd-who', {}, n.by.name), n.symbol ? h('b.fd-sym', {}, n.symbol) : null, n.proposalId ? h('b.fd-id', {}, n.proposalId) : null, h('span.grow'), when(n.at)),
    h('div', {}, n.text.slice(0, 700)),
    n.sources?.length ? h('div.fd-src', {}, ...n.sources.slice(0, 4).flatMap((s, i) => (i ? [' · ', source(s)] : [source(s)]))) : null,
  );
}

export function researchTab(deps: TabDeps): FundTab {
  const ask = h('div');
  const working = h('div.fd-rs-working');
  const theses = h('div.fd-rs-theses');
  const cover = h('div');
  const ideas = h('div');
  const noteChips = h('div.fd-chips');
  const notes = h('ol.fd-rs-notes');
  const calib = h('div');
  const calls = h('div');
  const reqs = requestsSection(deps);
  const el = h(
    'div.fd-tab',
    {},
    ask,
    reqs.el,
    section('On the desks now', working),
    section('Theses', theses),
    section('Coverage by asset', cover),
    section('Ideas being researched', ideas),
    section('Research notes', noteChips, notes),
    section('Calls and calibration', calib, calls),
  );

  let last: FundState | null = null;
  let dept: Department | 'all' = 'all';
  let symbol = '';
  let asked = 0;
  let seen = '';
  let later: ReturnType<typeof setTimeout> | undefined;
  const sigs = new Map<string, string>();
  /** Redraws a part only when what it shows changed, so a form or a scroll isn't thrown away. */
  const draw = (key: string, data: unknown, paint: () => void) => {
    const sig = JSON.stringify(data);
    if (sigs.get(key) === sig) return;
    sigs.set(key, sig);
    paint();
  };

  function request() {
    clearTimeout(later);
    later = undefined;
    if (!el.isConnected) return;
    asked = Date.now();
    deps.send({ t: 'fund.research' });
  }

  // The request form, made once: a desk, an asset if it's about one, the question, and by when.
  const desk = h('select.fd-input', { 'aria-label': 'Which desk' }) as HTMLSelectElement;
  const due = h('select.fd-input', { 'aria-label': 'By when' }, ...[['', 'No deadline'], ['30', 'Within 30 min'], ['60', 'Within an hour'], ['240', 'Within 4 h'], ['1440', 'Within a day']].map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
  const sym = h('input.fd-input', { placeholder: 'BTC, SPY… (optional)', maxlength: '16', 'aria-label': 'Asset' }) as HTMLInputElement;
  const question = h('input.fd-input', { placeholder: 'What should it find out?', maxlength: '1000', 'aria-label': 'Question' }) as HTMLInputElement;
  const send = () => {
    const q = question.value.trim();
    if (!q || !desk.value) return question.focus();
    const on = sym.value.trim().toUpperCase();
    deps.send({ t: 'fund.request', request: { to: desk.value, question: q, ...(on ? { symbol: on } : {}), ...(due.value ? { dueInMin: Number(due.value) } : {}) } });
    question.value = '';
  };
  question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  const form = section(
    'Ask a desk to research',
    h('div.fd-rs-ask', {}, desk, sym, question, due, h('button.fd-btn.go', { type: 'button', onclick: send }, 'Ask')),
    h('div.fd-hint', {}, 'It’s typed into the desk’s agent and stays open below until the desk answers with fund_answer; a vacant desk is told when someone takes it.'),
  );

  function drawDesks(s: FundState) {
    const held = new Map(s.desks.desks.map((d) => [d.role, d]));
    draw('ask', [store.me.admin, [...held.keys()]], () => {
      const keep = desk.value;
      desk.replaceChildren(
        ...(Object.entries(DEPARTMENTS) as [Department, (typeof DEPARTMENTS)[Department]][]).map(([id, d]) =>
          h('optgroup', { label: `${d.icon} ${d.label}` }, ...ROLES.filter((r) => r.department === id).map((r) => h('option', { value: r.id }, held.has(r.id) ? `${r.title} · ${held.get(r.id)!.name}` : `${r.title} (vacant)`))),
        ),
      );
      desk.value = keep || (ROLES.find((r) => held.has(r.id) && r.department === 'research')?.id ?? ROLES.find((r) => held.has(r.id))?.id ?? 'macro');
      ask.replaceChildren(store.me.admin ? form : '');
    });
    const rows = s.desks.desks.map((d) => ({ role: d.role, name: d.name, status: d.status, process: d.process, note: d.note, assignment: d.assignment?.text }));
    draw('working', rows, () =>
      working.replaceChildren(
        ...(rows.length
          ? rows.map((d) =>
              h(
                'div.fd-rs-desk',
                { style: `--dept:${color(d.role)}` },
                h('div', {}, h('span.fd-role', {}, deskTitle(d.role)), ' ', h('span.fd-who', {}, d.name)),
                h('div', {}, h('span', { class: `fd-dstat ${d.status}` }, DESK_STATUS_LABEL[d.status]), d.process === 'needs_input' ? h('span.fd-proc.needs_input', {}, 'Needs you') : null),
                d.note ? h('div.fd-desk-note', {}, d.note.slice(0, 160)) : null,
                d.assignment ? h('div.fd-desk-assign', {}, h('b', {}, 'Asked: '), d.assignment.slice(0, 160)) : null,
              ),
            )
          : [h('div.fd-empty', {}, 'No desk is staffed yet. ', h('button.fd-btn.small', { type: 'button', onclick: () => deps.go('agents') }, 'Staff the desks'))]),
      ),
    );
  }

  function drawResearch() {
    const r: ResearchView | null = store.fundResearch;
    const s = last;
    if (!s) return;
    if (!r) {
      theses.replaceChildren(h('div.fd-empty.fd-loading', {}, 'Reading the desks’ memory…'));
      return;
    }
    draw('theses', r.theses, () => theses.replaceChildren(...(r.theses.length ? r.theses.map(thesisCard) : [h('div.fd-empty', {}, 'No desk has written a thesis yet. Each desk keeps one with fund_thesis, and changes it as it learns.')])));

    const rows = coverage(s.config.watchlist, r.notes, s.proposals, s.portfolio.positions, s.market.signals).slice(0, 24);
    draw('cover', rows, () => {
      const top = Math.max(0, ...rows.map((c) => c.notes + 2 * (c.ideas + c.live) + c.signals));
      cover.replaceChildren(
        table(
          ['Asset', 'Heat', 'Notes', 'Desks', 'Ideas', 'Live', 'Long / short', 'Held', 'Signals', 'Latest note'],
          rows.map((c) =>
            coverageRow(c, top, (picked) => {
              symbol = symbol === picked ? '' : picked;
              drawNotes(r);
              noteChips.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }),
          ),
          { right: [2, 4, 5, 8], empty: 'Nothing covered yet: add assets to the watchlist in Settings, or let the desks write.' },
        ),
      );
    });
    drawNotes(r);

    draw('calls', [r.calibration, r.calls.slice(0, 15)], () => {
      calib.replaceChildren(
        table(
          ['Desk', 'Calls', 'Hit rate', 'Avg confidence', 'Brier', 'Avg return', 'Realized'],
          r.calibration.map((c) => [
            h('span.fd-role', { style: `color:${color(c.role)}` }, deskTitle(c.role)),
            h('span.num', {}, `${c.wins}/${c.calls}`),
            h('span.num', {}, `${c.hitRatePct.toFixed(0)}%`),
            h('span.num', {}, `${c.avgConfidence.toFixed(0)}%`),
            h('span', { class: `num ${c.brier <= 0.2 ? 'up' : c.brier >= 0.3 ? 'down' : 'flat'}`, title: '0 is perfect, 0.25 is always saying 50%' }, c.brier.toFixed(3)),
            change(c.avgReturnPct, 1),
            money(c.realizedPnl, true),
          ]),
          { right: [1, 2, 3, 4, 5, 6], empty: 'No closed calls yet. When a trade a desk proposed closes, it’s scored here against the confidence the desk gave.' },
        ),
        r.calibration.length ? h('div.fd-hint.fd-rs-gap', {}, 'Brier is the mean squared gap between the confidence a desk gave, as a chance, and whether the trade made money: lower is better, and 0.25 is what always saying 50% scores.') : '',
      );
      calls.replaceChildren(
        r.calls.length
          ? table(
              ['Closed', 'Trade', 'Desk', 'Asset', 'Side', 'Confidence', 'P&L', 'Return', ''],
              r.calls.slice(0, 15).map((c) => [when(c.at), h('b.fd-id', {}, c.id), deskTitle(c.role), h('span.fd-sym', {}, c.symbol), h('span', { class: `fd-side ${c.side}` }, c.side.toUpperCase()), h('span.num', {}, `${c.confidence}%`), money(c.pnl, true), change(c.returnPct, 1), h('span', { class: `num ${c.won ? 'up' : 'down'}`, title: c.won ? 'Made money' : 'Lost money' }, c.won ? '✓' : '✗')]),
              { right: [5, 6, 7] },
            )
          : '',
      );
    });
  }

  function drawNotes(r: ResearchView) {
    const symbols = [...new Set(r.notes.flatMap((n) => (n.symbol ? [n.symbol] : [])))].sort();
    if (symbol && !symbols.includes(symbol)) symbols.unshift(symbol);
    const shown = r.notes.filter((n) => (dept === 'all' || deptOf(n.role) === dept) && (!symbol || n.symbol === symbol)).slice(0, 60);
    draw('notes', [dept, symbol, symbols, shown], () => {
      const chip = (label: string, on: boolean, pick: () => void) => h('button', { type: 'button', class: `fd-chip${on ? ' on' : ''}`, onclick: pick }, label);
      const sel = h('select.fd-input.fd-rs-filter', { 'aria-label': 'Asset', onchange: () => ((symbol = sel.value), drawNotes(r)) }, h('option', { value: '' }, 'Every asset'), ...symbols.map((x) => h('option', { value: x }, x))) as HTMLSelectElement;
      sel.value = symbol;
      noteChips.replaceChildren(
        chip('Every desk', dept === 'all', () => ((dept = 'all'), drawNotes(r))),
        ...(Object.entries(DEPARTMENTS) as [Department, (typeof DEPARTMENTS)[Department]][]).map(([id, d]) => chip(`${d.icon} ${d.label}`, dept === id, () => ((dept = id), drawNotes(r)))),
        h('span.grow'),
        sel,
      );
      notes.replaceChildren(...(shown.length ? shown.map(noteRow) : [h('li.fd-empty', {}, r.notes.length ? 'No notes match.' : 'No research notes yet. The desks post what they find with fund_observe, with an asset and their sources.')]));
    });
  }

  function drawIdeas(s: FundState) {
    const list = s.proposals.filter((p) => p.stage === 'idea' || p.stage === 'research');
    draw('ideas', list.map((p) => [p.id, p.stage, p.updatedAt, p.confidence]), () =>
      ideas.replaceChildren(
        table(
          ['Idea', 'Stage', 'Asset', 'Side', 'Desk', 'Confidence', 'Entry', 'Thesis', 'Updated'],
          list.map((p) => [
            h('b.fd-id', {}, p.id),
            h('span', { class: `fd-stage ${p.stage}` }, STAGE_LABEL[p.stage]),
            h('span.fd-sym', {}, p.symbol),
            h('span', { class: `fd-side ${p.side}` }, p.side.toUpperCase()),
            p.author.kind === 'agent' && p.author.role ? deskTitle(p.author.role) : p.author.name,
            h('span.num', {}, `${p.confidence}%`),
            h('span.num', {}, p.entry ? price(p.entry) : 'market'),
            h('span.fd-rs-latest', { title: p.thesis }, p.thesis.slice(0, 120)),
            when(p.updatedAt),
          ]),
          { right: [5, 6], empty: 'No ideas being researched. A desk files one with fund_propose as an idea, fills it in, then sends it to risk.' },
        ),
      ),
    );
  }

  const off = store.on('fundResearch', () => {
    if (!el.isConnected) return off();
    drawResearch();
  });

  return {
    el,
    update(s: FundState, activity: readonly ActivityEvent[]) {
      last = s;
      drawDesks(s);
      reqs.update(s);
      drawIdeas(s);
      drawResearch();
      // Ask again when a desk wrote something, a few seconds apart at most, and at least once a minute.
      const latest = activity.find((e) => CHANGES.includes(e.kind))?.id ?? '';
      const since = Date.now() - asked;
      if (!asked || since > STALE_MS) {
        seen = latest;
        request();
      } else if (latest !== seen) {
        seen = latest;
        if (since > THROTTLE_MS) request();
        else later ??= setTimeout(request, THROTTLE_MS - since);
      }
    },
  };
}
