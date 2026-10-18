// The 💼 Fund window's quant lab: every strategy on a board by its stage (idea → research → backtest →
// validation → paper → approved), each with its rules, its latest backtest, whether that clears the
// validation bar, its signal while on paper and how the trades proposed under it have done. An admin
// registers strategies, backtests them and moves them along; the gates are shared/fund/strategy.ts's,
// worked out here too so the board can say what stands in the way before the server does.
import './lab.css';
import { usd } from '../../../shared/fund/format';
import { ROLE_BY_ID, ROLES } from '../../../shared/fund/roles';
import type { FundState } from '../../../shared/fund/state';
import { checkMove, fingerprint, NEXT_STAGE, paperProfitFactor, rulesLabel, STRATEGY_STAGE_LABEL, validate, type Backtest, type PaperRecord, type Strategy, type StrategyStage, type StrategyView } from '../../../shared/fund/strategy';
import type { Actor } from '../../../shared/fund/types';
import { h, timeAgo } from '../../ui/dom';
import { showBacktest, signalChip } from './backtests';
import { rulesForm } from './rules-form';
import { confirmButton, money, section, type FundTab, type TabDeps } from './view';

const COLUMNS: StrategyStage[] = ['idea', 'research', 'backtest', 'validation', 'paper', 'approved'];
const YOU: Actor = { kind: 'user', id: 'you', name: 'you' };
const title = (role?: string) => (role ? (ROLE_BY_ID.get(role)?.title ?? role) : 'People');

/** Its latest backtest of the rules it has now (the fund sends every strategy's own). */
function latestOf(s: Strategy, backtests: readonly Backtest[]): Backtest | undefined {
  const b = s.backtestId ? backtests.find((x) => x.id === s.backtestId) : undefined;
  return b && b.fingerprint === fingerprint(s.rules, s.universe) ? b : undefined;
}

export function strategiesTab(deps: TabDeps): FundTab {
  const form = newForm(deps);
  const board = h('div.fd-board');
  const retired = h('div');
  const el = h(
    'div.fd-tab',
    {},
    h('div.fd-call', {}, h('span.fd-hint', {}, 'Each step has a gate in code: research needs rules, backtest a backtest of them, validation enough history, paper a backtest that clears the validation bar (moved there by a desk that didn’t write it), approved a person, after its days on paper. A strategy’s trades still go through risk and your approval.')),
    form.el,
    board,
    retired,
  );
  /** Cards whose details are open, kept open across redraws. */
  const open = new Set<string>();
  let sig = '';

  function update(s: FundState) {
    form.update(s);
    const hour = Math.floor(Date.now() / 3_600_000);
    const next = JSON.stringify([deps.admin(), hour, s.config.validationBar, s.config.market, s.config.strategyPaperDays, s.strategies, s.backtests.map((b) => b.id)]);
    if (next === sig) return;
    sig = next;
    board.replaceChildren(
      ...COLUMNS.map((stage) => {
        const items = s.strategies.filter((x) => x.stage === stage);
        return h('div', { class: `fd-col ${stage}` }, h('div.fd-col-head', {}, STRATEGY_STAGE_LABEL[stage], h('span.fd-col-n', {}, String(items.length))), ...items.map((x) => card(x, s)));
      }),
    );
    const gone = s.strategies.filter((x) => x.stage === 'retired');
    retired.replaceChildren(gone.length ? section(`Retired (${gone.length})`, h('div.fd-retired', {}, ...gone.map((x) => card(x, s)))) : '');
    if (!s.strategies.length) board.append(h('div.fd-empty.fd-board-empty', {}, 'No strategies yet. The Quant and Strategy desks register them with fund_strategy, or register one above.'));
  }

  function card(x: StrategyView, s: FundState): HTMLElement {
    const c = s.config;
    const b = latestOf(x, s.backtests);
    const v = b && validate(b, c.validationBar, c.market === 'public');
    const gate = (to: StrategyStage) =>
      checkMove(x, to, { by: YOU, canStrategy: true, canRule: false, latest: b, bar: c.validationBar, realMarket: c.market === 'public', paperDays: c.strategyPaperDays, paper: x.record, paperTrades: c.strategyPaperTrades, paperProfitFactor: c.strategyPaperProfitFactor, now: Date.now() });
    const to = NEXT_STAGE[x.stage];
    const blocked = to ? gate(to) : undefined;
    const r = x.record;
    const days = x.paperSince ? Math.floor((Date.now() - x.paperSince) / 86_400_000) : undefined;
    const actions: HTMLElement[] = [];
    if (deps.admin() && x.stage !== 'retired') {
      actions.push(h('button.fd-btn.small', { type: 'button', title: 'Backtest its rules as they are now', onclick: () => deps.send({ t: 'fund.backtest', run: { strategyId: x.id } }) }, 'Backtest'));
      if (to) actions.push(h('button.fd-btn.small.go', { type: 'button', disabled: !!blocked, title: blocked ?? `Move it to ${STRATEGY_STAGE_LABEL[to]}`, onclick: () => deps.send({ t: 'fund.strategy.stage', id: x.id, stage: to }) }, `→ ${STRATEGY_STAGE_LABEL[to]}`));
      if (x.stage !== 'idea' && x.stage !== 'research') actions.push(h('button.fd-btn.small', { type: 'button', title: 'Back to research: off paper, its rules open again', onclick: () => deps.send({ t: 'fund.strategy.stage', id: x.id, stage: 'research' }) }, '↩ Research'));
      actions.push(confirmButton('Retire', 'Retire it?', () => deps.send({ t: 'fund.strategy.stage', id: x.id, stage: 'retired' }), 'small'));
    }
    const details = h(
      'details.fd-strat-more',
      { open: open.has(x.id) },
      h('summary', {}, 'Hypothesis, checks and history'),
      h('p.fd-thesis', {}, x.hypothesis),
      v ? h('ul.fd-checks', {}, ...v.checks.map((k) => h('li', { class: k.ok ? 'pass' : 'fail' }, h('span.mark', {}, k.ok ? '✔' : '✖'), h('b', {}, k.label), ` ${k.value} (needs ${k.need})`))) : null,
      h('ol.fd-strat-hist', {}, ...x.history.map((st) => h('li', {}, `${new Date(st.at).toLocaleString()} · ${STRATEGY_STAGE_LABEL[st.stage]} · ${st.by.name}${st.note ? ` · ${st.note}` : ''}`))),
    );
    details.addEventListener('toggle', () => (details.open ? open.add(x.id) : open.delete(x.id)));
    return h(
      'article',
      { class: `fd-strat ${x.stage}${v ? (v.passed ? ' clears' : ' short') : ''}` },
      h('div.fd-strat-head', {}, h('b.fd-id', {}, x.id), h('span.fd-strat-name', {}, x.name)),
      h('div.fd-strat-rules', {}, rulesLabel(x.rules)),
      h('div.fd-strat-meta', {}, x.universe.join(' '), ' · ', h('span', { title: `Written by ${x.author.name}` }, title(x.owner))),
      b
        ? h(
            'button',
            { type: 'button', class: 'fd-strat-bt', title: `Open ${b.id} in Backtests`, onclick: () => (showBacktest(b.id), deps.go('backtests')) },
            h('b', {}, b.id),
            ` Sharpe ${b.metrics.sharpe.toFixed(2)} · OOS ${b.outOfSample.sharpe.toFixed(2)} · DD ${b.metrics.maxDrawdownPct.toFixed(0)}% · ${b.metrics.trades} trades · turnover ${b.metrics.turnover.toFixed(1)}×/yr`,
            v ? h('span', { class: v.passed ? 'fd-pass' : 'fd-fail' }, v.passed ? ' ✔ clears the bar' : ` ✖ ${v.checks.filter((k) => !k.ok).length} short of the bar`) : null,
            b.mock ? h('span.fd-mock', {}, ' MOCK') : null,
          )
        : h('div.fd-hint', {}, 'No backtest of these rules yet'),
      x.signal ? h('div.fd-signals', { title: x.signalAt ? `Worked out ${timeAgo(x.signalAt)}` : '' }, ...Object.entries(x.signal).map(([sym, p]) => signalChip(sym, p))) : null,
      days !== undefined && x.stage !== 'retired'
        ? h('div.fd-strat-meta', {}, `${days}d on paper${x.stage === 'paper' ? ` of ${c.strategyPaperDays}` : ''} · ${r.proposals} proposed · ${r.open} open · ${r.closed} closed${r.closed ? ` (${r.wins} won) · ` : ''}`, r.closed ? money(r.realizedPnl, true) : '')
        : null,
      r.closed && x.stage !== 'retired' ? h('div.fd-strat-meta', { title: 'Its closed trades on paper, fees included' }, paperLine(r)) : null,
      details,
      actions.length ? h('div.fd-strat-acts', {}, ...actions) : null,
      deps.admin() && to && blocked && x.stage !== 'idea' ? h('div.fd-strat-gate', {}, blocked) : null,
    );
  }

  return { el, update };
}

/** Its closed paper trades' performance: profit factor, return on what they put to work, Sharpe, drawdown, turnover. */
function paperLine(r: PaperRecord): string {
  const pf = paperProfitFactor(r)!;
  const sharpe = r.sharpe !== undefined ? ` · Sharpe ${r.sharpe.toFixed(2)}` : '';
  const turnover = r.turnover !== undefined ? ` · turnover ${r.turnover.toFixed(1)}×/yr` : '';
  return `Paper: profit factor ${pf === Infinity ? '∞' : pf.toFixed(2)} · ${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1)}% on what it put to work · win rate ${Math.round((r.wins / r.closed) * 100)}%${sharpe} · max drawdown ${usd(r.maxDrawdown)}${turnover}`;
}

/** The form to register a strategy. Made once, so what you type survives every update. */
function newForm(deps: TabDeps) {
  const name = h('input.fd-input', { type: 'text', maxlength: '80', placeholder: 'Crypto trend, 20/100' }) as HTMLInputElement;
  const hypothesis = h('textarea.fd-input', { rows: '2', maxlength: '2000', placeholder: 'What it bets on, and why that should pay' }) as HTMLTextAreaElement;
  const universe = h('input.fd-input', { type: 'text', maxlength: '200', placeholder: 'BTC, ETH' }) as HTMLInputElement;
  const owner = h('select.fd-input', {}, h('option', { value: '' }, 'People (no desk)'), ...ROLES.map((r) => h('option', { value: r.id, selected: r.id === 'quant' }, r.title))) as HTMLSelectElement;
  const rules = rulesForm();
  const go = h('button.fd-btn.go', { type: 'button' }, 'Register it') as HTMLButtonElement;
  const field = (label: string, input: HTMLElement, wide = false) => h('label', { class: `fd-field${wide ? ' wide' : ''}` }, h('span', {}, label), input);
  /** The name last sent: once a strategy by that name shows up, the form is cleared. */
  let sent = '';

  go.addEventListener('click', () => {
    if (name.value.trim().length < 3) return name.focus();
    if (hypothesis.value.trim().length < 20) return hypothesis.focus();
    if (!universe.value.trim()) return universe.focus();
    sent = name.value.trim();
    deps.send({ t: 'fund.strategy', strategy: { name: sent, hypothesis: hypothesis.value.trim(), universe: universe.value.split(/[\s,]+/).filter(Boolean), ...rules.read(), ...(owner.value ? { owner: owner.value } : {}) } });
  });

  const el = h(
    'details.fd-propose',
    {},
    h('summary', {}, 'Register a strategy'),
    h(
      'div.fd-form',
      {},
      field('Name', name),
      field('Universe', universe),
      field('Owner (told when its signal changes)', owner),
      field('Hypothesis', hypothesis, true),
      ...rules.fields,
      h('div.fd-actions.wide', {}, h('span.fd-hint', {}, 'It starts as an idea. Backtest it from its card or the Backtests tab.'), go),
    ),
  );

  return {
    el,
    update(s: FundState) {
      el.classList.toggle('hidden', !deps.admin());
      if (sent && s.strategies.some((x) => x.author.kind === 'user' && x.name === sent)) {
        sent = '';
        for (const i of [name, hypothesis, universe]) i.value = '';
        el.open = false;
      }
    },
  };
}
