// A strategy's rules as form fields, for the Strategies and Backtests tabs: its kind, the kind's params
// (with their defaults and bounds from shared/fund/strategy.ts), shorts and a volatility target.
import { KIND_BY_ID, STRATEGY_KINDS, type StrategyRules } from '../../../shared/fund/strategy';
import { h } from '../../ui/dom';
import { numberOf } from './view';

export interface RulesForm {
  /** The fields, for an .fd-form grid. */
  fields: HTMLElement[];
  read(): StrategyRules;
}

export function rulesForm(): RulesForm {
  const kind = h('select.fd-input', { 'aria-label': 'Kind of strategy' }, ...STRATEGY_KINDS.map((k) => h('option', { value: k.id }, k.label))) as HTMLSelectElement;
  const blurb = h('span.fd-hint');
  const params = h('div.fd-params');
  const short = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const vol = h('input.fd-input', { type: 'number', min: '1', max: '100', step: 'any', placeholder: 'off: full size' }) as HTMLInputElement;
  let inputs = new Map<string, HTMLInputElement>();

  const draw = () => {
    const k = KIND_BY_ID.get(kind.value)!;
    blurb.textContent = k.blurb;
    inputs = new Map(Object.entries(k.params).map(([id, d]) => [id, h('input.fd-input', { type: 'number', min: String(d.min), max: String(d.max), step: d.int ? '1' : 'any', value: String(d.def), title: `${d.min} to ${d.max}` }) as HTMLInputElement]));
    params.replaceChildren(...[...inputs].map(([id, input]) => h('label.fd-field', {}, h('span', {}, k.params[id].label), input)));
  };
  kind.addEventListener('change', draw);
  draw();

  return {
    fields: [
      h('label.fd-field', {}, h('span', {}, 'Kind'), kind),
      params,
      h('label.fd-field', {}, h('span', {}, 'Volatility target'), h('div.fd-row', {}, vol, h('span.fd-unit', {}, '% a year'))),
      h('label.fd-check', {}, short, ' May go short'),
      h('div.fd-field.wide', {}, blurb),
    ],
    read() {
      const k = KIND_BY_ID.get(kind.value)!;
      const v = numberOf(vol);
      return { kind: k.id, params: Object.fromEntries([...inputs].map(([id, i]) => [id, numberOf(i) ?? k.params[id].def])), short: short.checked, ...(v ? { volTargetPct: v } : {}) };
    },
  };
}
