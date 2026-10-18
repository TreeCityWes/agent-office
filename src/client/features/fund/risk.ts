// The 💼 Fund window's risk tab: how close the book is to each limit, exposure by correlation group,
// and the limits themselves, which only an admin changes (and every change is on the record).
import { pct } from '../../../shared/fund/format';
import type { FundState } from '../../../shared/fund/state';
import { ASSET_CLASSES, type AssetClass, type RiskLimits } from '../../../shared/fund/types';
import { h } from '../../ui/dom';
import { exposureTable } from './overview';
import { gauge, numberOf, section, table, type FundTab, type TabDeps } from './view';

type NumberLimit = { [K in keyof RiskLimits]: RiskLimits[K] extends number ? K : never }[keyof RiskLimits];

/** The limits a number sets, with what each means and its unit. */
const NUMBERS: { key: NumberLimit; label: string; unit: string }[] = [
  { key: 'maxPositionPct', label: 'Largest position', unit: '% of NAV' },
  { key: 'defaultClassPct', label: 'Any other asset class, gross', unit: '% of NAV' },
  { key: 'maxGroupPct', label: 'A correlation group, net', unit: '% of NAV' },
  { key: 'maxTop3Pct', label: 'Top three positions', unit: '% of NAV' },
  { key: 'maxLeverage', label: 'Leverage', unit: '× NAV' },
  { key: 'maxDrawdownPct', label: 'No new risk past a drawdown of', unit: '%' },
  { key: 'maxDailyLossPct', label: 'No new risk past a day’s loss of', unit: '% of the day’s start' },
  { key: 'maxLossPerTradePct', label: 'Loss at a trade’s stop', unit: '% of NAV' },
  { key: 'minLiquidityUsd', label: 'Least traded a day', unit: 'USD' },
  { key: 'maxParticipationPct', label: 'Most of a day’s volume', unit: '%' },
  { key: 'minTradeUsd', label: 'Smallest trade', unit: 'USD' },
  { key: 'maxQuoteAgeMin', label: 'Oldest price traded on', unit: 'minutes' },
];

export function riskTab(deps: TabDeps): FundTab {
  const usage = h('div');
  const groups = h('div');
  const form = limitsForm(deps);
  const el = h('div.fd-tab', {}, section('Against the limits', usage), section('Exposure by correlation group', groups), section('Risk limits', form.el));

  function update(s: FundState) {
    const p = s.portfolio;
    const l = s.limits;
    const weights = p.positions.map((x) => x.weightPct).sort((a, b) => b - a);
    const dayLoss = Math.max(0, -p.dayPnlPct);
    const rows: [string, number, number, (n: number) => string][] = [
      ['Largest position', weights[0] ?? 0, l.maxPositionPct, (n) => pct(n)],
      ['Top three positions', weights.slice(0, 3).reduce((a, b) => a + b, 0), l.maxTop3Pct, (n) => pct(n)],
      ['Leverage', p.leverage, l.maxLeverage, (n) => `${n.toFixed(2)}×`],
      ['Drawdown', p.drawdownPct, l.maxDrawdownPct, (n) => pct(n)],
      ['Today’s loss', dayLoss, l.maxDailyLossPct, (n) => pct(n, 2)],
    ];
    usage.replaceChildren(
      table(
        ['', 'Now', 'Limit', ''],
        rows.map(([label, now, limit, fmt]) => [label, h('span.num', {}, fmt(now)), h('span.num', {}, fmt(limit)), gauge(now, limit)]),
        { right: [1, 2] },
      ),
      p.drawdownPct >= l.maxDrawdownPct || dayLoss >= l.maxDailyLossPct ? h('div.fd-banner.bad', {}, 'A loss limit is hit: the risk engine opens nothing new until it recovers. Taking risk off is always allowed.') : '',
    );
    groups.replaceChildren(exposureTable(p.byGroup, () => l.maxGroupPct, true));
    form.update(l);
  }

  return { el, update };
}

/** The limits as a form. It follows the fund until you change something, then keeps what you typed until you save or undo. */
function limitsForm(deps: TabDeps): { el: HTMLElement; update(l: RiskLimits): void } {
  let current: RiskLimits | undefined;
  let dirty = false;
  const inputs = new Map<NumberLimit, HTMLInputElement>();
  const classCaps = new Map<AssetClass, HTMLInputElement>();
  const allowed = new Map<AssetClass, HTMLInputElement>();
  const requireStop = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const allowShorts = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const mark = () => {
    dirty = true;
    actions.classList.remove('hidden');
  };

  const numbers = NUMBERS.map(({ key, label, unit }) => {
    const input = h('input.fd-input', { type: 'number', step: 'any', min: '0', oninput: mark }) as HTMLInputElement;
    inputs.set(key, input);
    return h('label.fd-field', {}, h('span', {}, label), h('div.fd-row', {}, input, h('span.fd-unit', {}, unit)));
  });
  const classes = ASSET_CLASSES.map((cls) => {
    const cap = h('input.fd-input', { type: 'number', step: 'any', min: '0', placeholder: 'default', oninput: mark }) as HTMLInputElement;
    const on = h('input', { type: 'checkbox', onchange: mark }) as HTMLInputElement;
    classCaps.set(cls, cap);
    allowed.set(cls, on);
    return [h('label.fd-check', {}, on, ` ${cls}`), h('div.fd-row', {}, cap, h('span.fd-unit', {}, '% gross'))];
  });
  requireStop.addEventListener('change', mark);
  allowShorts.addEventListener('change', mark);

  const save = h('button.fd-btn.go', { type: 'button' }, 'Save limits');
  const undo = h('button.fd-btn', { type: 'button' }, 'Undo');
  const actions = h('div.fd-actions.hidden', {}, h('span.fd-hint', {}, 'Saved limits apply to every check from then on, and go in the ledger with your name.'), undo, save);

  save.addEventListener('click', () => {
    if (!current) return;
    const out: Partial<RiskLimits> = {};
    for (const [key, input] of inputs) {
      const v = numberOf(input);
      if (v !== undefined && v !== current[key]) (out as Record<string, number>)[key] = v;
    }
    const caps: Partial<Record<AssetClass, number>> = {};
    for (const [cls, input] of classCaps) {
      const v = numberOf(input);
      if (v !== undefined) caps[cls] = v;
    }
    if (JSON.stringify(caps) !== JSON.stringify(current.maxClassPct)) out.maxClassPct = caps;
    const classesOn = ASSET_CLASSES.filter((c) => allowed.get(c)!.checked);
    if (classesOn.join() !== current.allowedClasses.join()) out.allowedClasses = classesOn;
    if (requireStop.checked !== current.requireStop) out.requireStop = requireStop.checked;
    if (allowShorts.checked !== current.allowShorts) out.allowShorts = allowShorts.checked;
    deps.send({ t: 'fund.limits', limits: out });
    dirty = false;
    actions.classList.add('hidden');
    // Filled again from what the fund says next, whether it took them or not.
    current = undefined;
  });
  undo.addEventListener('click', () => {
    dirty = false;
    actions.classList.add('hidden');
    if (current) fill(current);
  });

  function fill(l: RiskLimits) {
    for (const [key, input] of inputs) input.value = String(l[key]);
    for (const [cls, input] of classCaps) input.value = l.maxClassPct[cls] === undefined ? '' : String(l.maxClassPct[cls]);
    for (const [cls, input] of allowed) input.checked = l.allowedClasses.includes(cls);
    requireStop.checked = l.requireStop;
    allowShorts.checked = l.allowShorts;
  }

  const fieldset = h(
    'fieldset.fd-limits',
    {},
    h('div.fd-form', {}, ...numbers),
    h('div.fd-form', {}, h('label.fd-check', {}, requireStop, ' Every proposal needs a stop'), h('label.fd-check', {}, allowShorts, ' Shorts allowed')),
    h('div.fd-classes', {}, h('div.fd-label', {}, 'Asset classes the fund may trade, and each one’s cap'), h('div.fd-form', {}, ...classes.flat())),
  ) as HTMLFieldSetElement;
  const el = h('div', {}, fieldset, actions);

  function update(l: RiskLimits) {
    fieldset.disabled = !deps.admin();
    if (dirty || JSON.stringify(l) === JSON.stringify(current)) return;
    current = l;
    fill(l);
  }

  return { el, update };
}
