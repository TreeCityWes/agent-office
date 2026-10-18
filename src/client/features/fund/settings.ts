// The 💼 Fund window's settings: the fund's name, costs, market data, approvals and the committee gate; the quant lab's
// validation bar; capital paid in or taken out; and starting over. Admins only, and every change goes in the ledger with who made it.
import { usd } from '../../../shared/fund/format';
import type { FundConfig, FundState } from '../../../shared/fund/state';
import type { ValidationBar } from '../../../shared/fund/strategy';
import { h } from '../../ui/dom';
import { confirmButton, numberOf, section, type FundTab, type TabDeps } from './view';

export function settingsTab(deps: TabDeps): FundTab {
  let current: FundConfig | undefined;
  let dirty = false;
  const mark = () => {
    dirty = true;
    save.disabled = false;
  };
  const name = h('input.fd-input', { type: 'text', maxlength: '60', oninput: mark }) as HTMLInputElement;
  const fee = h('input.fd-input', { type: 'number', min: '0', max: '100', step: 'any', oninput: mark }) as HTMLInputElement;
  const slip = h('input.fd-input', { type: 'number', min: '0', max: '100', step: 'any', oninput: mark }) as HTMLInputElement;
  const market = h('select.fd-input', { onchange: mark }, h('option', { value: 'public' }, 'Public sources (Coinbase, Yahoo, OKX)'), h('option', { value: 'mock' }, 'MOCK market (simulated, 60× fast)')) as HTMLSelectElement;
  const cio = h('input', { type: 'checkbox', onchange: mark }) as HTMLInputElement;
  const ttl = h('input.fd-input', { type: 'number', min: '1', max: '720', step: '1', oninput: mark }) as HTMLInputElement;
  const cmt = h('input.fd-input', { type: 'number', min: '0', max: '100', step: 'any', oninput: mark }) as HTMLInputElement;
  const barNum = (min: string, max: string) => h('input.fd-input', { type: 'number', min, max, step: 'any', oninput: mark }) as HTMLInputElement;
  const bar: Record<keyof ValidationBar, HTMLInputElement> = { years: barNum('0.5', '20'), trades: barNum('0', '1000'), oosSharpe: barNum('-5', '10'), maxDrawdownPct: barNum('1', '100'), profitFactor: barNum('0', '20') };
  const paperDays = h('input.fd-input', { type: 'number', min: '0', max: '365', step: 'any', oninput: mark }) as HTMLInputElement;
  const save = h('button.fd-btn.go', { type: 'button', disabled: true }, 'Save settings') as HTMLButtonElement;
  const field = (label: string, input: HTMLElement, unit = '') => h('label.fd-field', {}, h('span', {}, label), h('div.fd-row', {}, input, unit ? h('span.fd-unit', {}, unit) : null));

  save.addEventListener('click', () => {
    if (!current) return;
    const next: Partial<FundConfig> = {};
    if (name.value.trim() && name.value.trim() !== current.name) next.name = name.value.trim();
    const f = numberOf(fee);
    if (f !== undefined && f !== current.feeBps) next.feeBps = f;
    const sl = numberOf(slip);
    if (sl !== undefined && sl !== current.slippageBps) next.slippageBps = sl;
    if (market.value !== current.market) next.market = market.value as FundConfig['market'];
    if (cio.checked !== current.requireCio) next.requireCio = cio.checked;
    const t = numberOf(ttl);
    if (t !== undefined && t !== current.proposalTtlHours) next.proposalTtlHours = t;
    const c = numberOf(cmt);
    if (c !== undefined && c !== current.committeeOverPct) next.committeeOverPct = c;
    const b = { ...current.validationBar };
    for (const k of Object.keys(bar) as (keyof ValidationBar)[]) b[k] = numberOf(bar[k]) ?? b[k];
    if (JSON.stringify(b) !== JSON.stringify(current.validationBar)) next.validationBar = b;
    const pd = numberOf(paperDays);
    if (pd !== undefined && pd !== current.strategyPaperDays) next.strategyPaperDays = pd;
    deps.send({ t: 'fund.config', config: next });
    dirty = false;
    save.disabled = true;
    current = undefined;
  });

  const amount = h('input.fd-input', { type: 'number', step: 'any', placeholder: '250000' }) as HTMLInputElement;
  const note = h('input.fd-input', { type: 'text', maxlength: '200', placeholder: 'Why (optional)' }) as HTMLInputElement;
  const move = (sign: 1 | -1) => () => {
    const n = numberOf(amount);
    if (!n || n <= 0) return amount.focus();
    deps.send({ t: 'fund.cash', amount: sign * n, note: note.value || undefined });
    amount.value = '';
    note.value = '';
  };
  const cash = h('div.fd-cash');

  const config = h(
    'fieldset.fd-limits',
    {},
    h(
      'div.fd-form',
      {},
      field('Name', name),
      field('Fee per fill', fee, 'bp'),
      field('Slippage per fill', slip, 'bp'),
      field('Market data', market),
      field('Undecided proposals expire after', ttl, 'hours'),
      h('label.fd-check', {}, cio, ' A CIO or PM at a desk rules on proposals before a person does'),
      field('An agent CIO needs a committee over', cmt, '% of NAV'),
      h('div.fd-field.wide', {}, h('span', {}, 'The quant lab: what a backtest of a strategy’s current rules must show before it trades on paper, and how long it trades there before a person may approve it')),
      field('History tested, at least', bar.years, 'years'),
      field('Closed trades, at least', bar.trades),
      field('Out-of-sample Sharpe, at least', bar.oosSharpe),
      field('Max drawdown, at most', bar.maxDrawdownPct, '%'),
      field('Profit factor, at least', bar.profitFactor),
      field('Days on paper before approval', paperDays, 'days'),
    ),
    h('div.fd-actions', {}, h('span.fd-hint', {}, 'Switching the market data drops every price from the other: positions are valued at cost until new ones come.'), save),
  ) as HTMLFieldSetElement;
  const capital = h(
    'fieldset.fd-limits',
    {},
    cash,
    h('div.fd-form', {}, field('Amount (USD)', amount), field('Note', note)),
    h('div.fd-actions', {}, h('span.fd-hint', {}, 'Capital moves the NAV but isn’t profit: the day’s start and the high-water mark move with it.'), h('button.fd-btn', { type: 'button', onclick: move(-1) }, 'Take out'), h('button.fd-btn.go', { type: 'button', onclick: move(1) }, 'Pay in')),
  ) as HTMLFieldSetElement;
  const reset = h(
    'fieldset.fd-limits',
    {},
    h('p.fd-hint', {}, 'A new fund with $1,000,000 and the default limits. The old one’s journals are moved aside to a fund-<time> folder next to it, never deleted. This is also how a fund halted by an edited journal trades again.'),
    h('div.fd-actions', {}, confirmButton('Start the fund over', 'Really start over?', () => deps.send({ t: 'fund.reset' }))),
  ) as HTMLFieldSetElement;

  const el = h('div.fd-tab', {}, section('The fund', config), section('Capital', capital), section('Start over', reset));

  function update(s: FundState) {
    for (const f of [config, capital, reset]) f.disabled = !deps.admin();
    cash.textContent = `Paid in so far ${usd(s.portfolio.startingCapital)} · in cash now ${usd(s.portfolio.cash)} · venue: ${s.venue} (paper only)`;
    if (dirty || JSON.stringify(s.config) === JSON.stringify(current)) return;
    current = s.config;
    name.value = s.config.name;
    fee.value = String(s.config.feeBps);
    slip.value = String(s.config.slippageBps);
    market.value = s.config.market;
    cio.checked = s.config.requireCio;
    ttl.value = String(s.config.proposalTtlHours);
    cmt.value = String(s.config.committeeOverPct);
    for (const k of Object.keys(bar) as (keyof ValidationBar)[]) bar[k].value = String(s.config.validationBar[k]);
    paperDays.value = String(s.config.strategyPaperDays);
  }

  return { el, update };
}
