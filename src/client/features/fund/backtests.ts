// The 💼 Fund window's backtests: a form to run one (of a strategy, or of rules tried out here), every
// run with its headline numbers, and the one picked in full: its equity against buying and holding the
// same assets, the drawdown, the numbers in and out of sample, the validation bar's checks, its trades
// and exactly which prices it ran on. The engine is shared/fund/backtest.ts; this only draws it.
import './lab.css';
import { pct } from '../../../shared/fund/format';
import type { FundState } from '../../../shared/fund/state';
import { rulesLabel, validate, type Backtest } from '../../../shared/fund/strategy';
import { h, timeAgo } from '../../ui/dom';
import { rulesForm } from './rules-form';
import { change, numberOf, section, table, type FundTab, type TabDeps } from './view';

/** The run picked, kept across tabs so the Strategies tab can open one here. */
let picked: string | undefined;
/** Set when another tab opens a run here, so the Backtests tab scrolls to it. */
let reveal = false;
/** Opens backtest `id` the next time the Backtests tab is drawn. */
export const showBacktest = (id: string) => {
  picked = id;
  reveal = true;
};

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const fixed = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const times = (n: number) => `×${n.toFixed(2)}`;

export function backtestsTab(deps: TabDeps): FundTab {
  const form = runForm(deps);
  const runs = h('div');
  const detail = h('div.fd-bt');
  const el = h('div.fd-tab', {}, form.el, section('Runs', runs), detail);
  let runsSig = '';
  let detailSig = '';

  function update(s: FundState) {
    form.update(s);
    const fresh = form.arrived(s);
    if (fresh) picked = fresh;
    if (!picked || !s.backtests.some((b) => b.id === picked)) picked = s.backtests[0]?.id;
    const real = s.config.market === 'public';
    const sig = JSON.stringify([picked, s.backtests.map((b) => b.id), s.config.validationBar, real, s.strategies.map((x) => [x.id, x.name])]);
    if (sig !== runsSig) {
      runsSig = sig;
      const names = new Map(s.strategies.map((x) => [x.id, x.name]));
      const t = table(
        ['Run', 'Strategy', 'Rules', 'Universe', 'Sharpe', 'OOS', 'CAGR', 'Max DD', 'PF', 'Trades', 'Bar', 'By'],
        s.backtests.map((b) => {
          const v = validate(b, s.config.validationBar, real);
          return [
            h('b.fd-id', {}, b.id),
            b.strategyId ? h('span', { title: names.get(b.strategyId) ?? '' }, b.strategyId) : h('span.fd-hint', {}, 'tried out'),
            rulesLabel(b.rules),
            b.universe.join(' '),
            fixed(b.metrics.sharpe),
            h('span', { class: `num ${b.outOfSample.sharpe >= s.config.validationBar.oosSharpe ? 'up' : 'down'}` }, fixed(b.outOfSample.sharpe)),
            change(b.metrics.cagrPct, 1),
            pct(b.metrics.maxDrawdownPct),
            fixed(b.metrics.profitFactor),
            String(b.metrics.trades),
            h('span', { class: v.passed ? 'fd-pass' : 'fd-fail', title: v.passed ? 'Clears the validation bar' : v.checks.filter((c) => !c.ok).map((c) => c.label).join(', ') }, v.passed ? '✔' : '✖'),
            h('span', { title: new Date(b.at).toLocaleString() }, `${b.by.name} · ${timeAgo(b.at)}`),
          ];
        }),
        { right: [4, 5, 6, 7, 8, 9], empty: 'No backtests yet. The Quant, Strategy and Backtester desks run them with fund_backtest, or run one above.' },
      );
      t.querySelectorAll<HTMLElement>('tbody tr').forEach((tr, i) => {
        const id = s.backtests[i].id;
        tr.classList.add('fd-pick');
        tr.classList.toggle('on', id === picked);
        tr.addEventListener('click', () => {
          picked = id;
          update(s);
        });
      });
      runs.replaceChildren(t);
    }
    const b = s.backtests.find((x) => x.id === picked);
    const dsig = JSON.stringify([b?.id, s.config.validationBar, real, b?.strategyId && s.strategies.find((x) => x.id === b.strategyId)?.name]);
    if (dsig !== detailSig) {
      detailSig = dsig;
      detail.replaceChildren(...(b ? full(b, s) : []));
    }
    if (reveal && b) {
      reveal = false;
      requestAnimationFrame(() => detail.scrollIntoView({ block: 'start' }));
    }
  }

  return { el, update };
}

/** One run in full. */
function full(b: Backtest, s: FundState): HTMLElement[] {
  const v = validate(b, s.config.validationBar, s.config.market === 'public');
  const strategy = b.strategyId ? s.strategies.find((x) => x.id === b.strategyId) : undefined;
  const m = b.metrics;
  const rows: [string, (x: Backtest['metrics']) => string, boolean][] = [
    ['Total return', (x) => pct(x.totalReturnPct, 1, true), true],
    ['CAGR', (x) => pct(x.cagrPct, 1, true), true],
    ['Volatility', (x) => pct(x.volPct, 1), true],
    ['Sharpe', (x) => fixed(x.sharpe), true],
    ['Sortino', (x) => fixed(x.sortino), false],
    ['Max drawdown', (x) => pct(x.maxDrawdownPct, 1), true],
    ['Longest under water', (x) => `${x.maxDrawdownDays} days`, false],
    ['Calmar', (x) => fixed(x.calmar), false],
    ['Closed trades', (x) => String(x.trades), false],
    ['Win rate', (x) => pct(x.winRatePct, 0), false],
    ['Profit factor', (x) => fixed(x.profitFactor), false],
    ['Average trade', (x) => pct(x.avgTradePct, 2, true), false],
    ['Turnover', (x) => `${fixed(x.turnover, 1)}× a year`, false],
    ['Exposure', (x) => pct(x.exposurePct, 0), false],
  ];
  const bench = b.benchmark as Partial<Backtest['metrics']>;
  return [
    section(
      `${b.id}: ${rulesLabel(b.rules)} on ${b.universe.join(', ')}`,
      h(
        'div.fd-bt-meta',
        {},
        strategy ? h('span', {}, `${strategy.id} · ${strategy.name} · `) : h('span', {}, 'Rules tried out, not a registered strategy · '),
        `${day(m.from)} to ${day(m.to)} (${b.years}y) · costs ${b.costBps}bp a trade · run by ${b.by.name} ${timeAgo(b.at)}`,
        b.mock ? h('span.fd-mock', {}, ' · MOCK PRICES: simulated, not evidence about the real market') : null,
      ),
      curveChart(b),
      drawdownChart(b),
    ),
    h(
      'div.fd-bt-grid',
      {},
      section(
        'Numbers',
        table(
          ['', 'Whole period', 'In sample', 'Out of sample', 'Buy & hold'],
          rows.map(([label, f, hasBench]) => [label, f(m), f(b.inSample), h('b', {}, f(b.outOfSample)), hasBench ? f({ ...m, ...bench } as Backtest['metrics']) : '—']),
          { right: [1, 2, 3, 4] },
        ),
        h('div.fd-hint', {}, `Out of sample is the last 30%, from ${day(b.splitAt)}: the part to trust. Returns are on capital with the positions held at each close and costs taken on every change.`),
      ),
      section(
        `Validation bar: ${v.passed ? 'clears it' : 'falls short'}`,
        h('ul.fd-checks', {}, ...v.checks.map((c) => h('li', { class: c.ok ? 'pass' : 'fail' }, h('span.mark', {}, c.ok ? '✔' : '✖'), h('b', {}, c.label), ` ${c.value} (needs ${c.need})`))),
        h('div.fd-hint', {}, 'The bar is set in ⚙️ Settings; a strategy goes on paper only with a backtest of its current rules that clears it.'),
        h('h4.fd-mini', {}, 'Its position after the last close'),
        h('div.fd-signals', {}, ...Object.entries(b.signals).map(([sym, p]) => signalChip(sym, p))),
      ),
    ),
    section(
      `Latest trades (${b.trades.length} shown)`,
      table(
        ['Asset', 'Side', 'In', 'Out', 'Return'],
        [...b.trades].reverse().map((t) => [h('span.fd-sym', {}, t.symbol), h('span', { class: `fd-side ${t.side}` }, t.side.toUpperCase()), day(t.from), t.open ? h('span.fd-hint', {}, 'still open') : day(t.to), change(t.returnPct)]),
        { right: [4], empty: 'No trades: it never changed position.' },
      ),
    ),
    section(
      'The prices it ran on',
      table(
        ['Asset', 'Source', 'Closes', 'From', 'To', 'sha256'],
        b.data.map((d) => [h('span.fd-sym', {}, d.symbol), d.mock ? h('span.fd-mock', {}, d.source) : d.source, String(d.bars), day(d.from), day(d.to), h('code.fd-hash', {}, d.hash)]),
        { right: [2] },
      ),
      h('div.fd-hint', {}, 'The same source and range give the same hash: run it again to check the result.'),
    ),
  ];
}

/** "BTC long", "ETH flat", "SPY short 40%". */
export function signalChip(sym: string, p: number): HTMLElement {
  const side = p > 0 ? 'long' : p < 0 ? 'short' : 'flat';
  return h('span', { class: `fd-signal ${side}` }, h('b', {}, sym), ` ${side}${p && Math.abs(p) < 1 ? ` ${Math.round(Math.abs(p) * 100)}%` : ''}`);
}

/** Growth of 1 for the strategy and for buying and holding, on a log scale, with the out-of-sample part shaded. */
function curveChart(b: Backtest): HTMLElement {
  const W = 600;
  const H = 170;
  const pts = b.curve;
  const wrap = h('div.fd-chart.fd-bt-chart');
  if (pts.length < 2) return wrap;
  const last = pts[pts.length - 1];
  const vals = pts.flatMap((p) => [p.equity, p.benchmark]).filter((v) => v > 0);
  const lo = Math.log(Math.min(1, ...vals));
  const hi = Math.log(Math.max(1, ...vals));
  const t0 = pts[0].t;
  const t1 = last.t;
  const x = (t: number) => (((t - t0) / (t1 - t0 || 1)) * W).toFixed(1);
  const y = (v: number) => (H - 6 - ((Math.log(Math.max(v, 1e-6)) - lo) / (hi - lo || 1)) * (H - 12)).toFixed(1);
  const line = (f: (p: (typeof pts)[number]) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(f(p))}`).join('');
  const sx = x(b.splitAt);
  const up = last.equity >= 1;
  wrap.append(
    h(
      'div.fd-legend',
      {},
      h('span', { class: `fd-lg ${up ? 'up' : 'down'}` }, `Strategy ${times(last.equity)}`),
      h('span.fd-lg.bench', {}, `Buy & hold ${times(last.benchmark)}`),
      h('span.fd-lg.oos', {}, `Out of sample from ${day(b.splitAt)}`),
      h('span.grow'),
      h('span.fd-hint', {}, `log scale, ×${Math.exp(lo).toFixed(2)} to ×${Math.exp(hi).toFixed(2)}`),
    ),
  );
  wrap.insertAdjacentHTML(
    'beforeend',
    `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Equity against buy and hold">
    <rect x="${sx}" y="0" width="${(W - Number(sx)).toFixed(1)}" height="${H}" class="oos" />
    <line x1="${sx}" x2="${sx}" y1="0" y2="${H}" class="split" />
    <line x1="0" x2="${W}" y1="${y(1)}" y2="${y(1)}" class="base" />
    <path d="${line((p) => p.benchmark)}" class="bench" />
    <path d="${line((p) => p.equity)}" class="line ${up ? 'up' : 'down'}" />
  </svg>`,
  );
  return wrap;
}

/** How far below its high the strategy was, all along. */
function drawdownChart(b: Backtest): HTMLElement {
  const W = 600;
  const H = 60;
  const pts = b.curve;
  const wrap = h('div.fd-chart.fd-dd-chart');
  if (pts.length < 2) return wrap;
  const worst = Math.min(-1, ...pts.map((p) => p.drawdownPct));
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t: number) => (((t - t0) / (t1 - t0 || 1)) * W).toFixed(1);
  const y = (d: number) => ((d / worst) * (H - 2)).toFixed(1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.drawdownPct)}`).join('');
  wrap.append(h('div.fd-legend', {}, h('span.fd-lg.dd', {}, `Drawdown, worst ${pct(b.metrics.maxDrawdownPct, 1)}`), h('span.grow'), h('span.fd-hint', {}, `longest under water ${b.metrics.maxDrawdownDays} days`)));
  wrap.insertAdjacentHTML('beforeend', `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Drawdown"><path d="${line}L${W},0L0,0Z" class="dd" /></svg>`);
  return wrap;
}

/** The form to run a backtest. Made once, so what you type survives every update. */
function runForm(deps: TabDeps) {
  const strategy = h('select.fd-input', { 'aria-label': 'What to backtest' }) as HTMLSelectElement;
  const rules = rulesForm();
  const universe = h('input.fd-input', { type: 'text', placeholder: 'BTC, ETH', maxlength: '200' }) as HTMLInputElement;
  const years = h('input.fd-input', { type: 'number', min: '1', max: '15', step: 'any', value: '5' }) as HTMLInputElement;
  const cost = h('input.fd-input', { type: 'number', min: '0', max: '500', step: 'any' }) as HTMLInputElement;
  const custom = h('div.fd-form.fd-custom', {}, h('label.fd-field.wide', {}, h('span', {}, 'Universe (equally weighted)'), universe), ...rules.fields);
  const go = h('button.fd-btn.go', { type: 'button' }, 'Run backtest') as HTMLButtonElement;
  let seen: Set<string> | undefined;
  let waiting = false;
  let options = '';

  const toggle = () => custom.classList.toggle('hidden', strategy.value !== '');
  strategy.addEventListener('change', toggle);
  go.addEventListener('click', () => {
    if (!strategy.value && !universe.value.trim()) return universe.focus();
    const r = rules.read();
    deps.send({
      t: 'fund.backtest',
      run: {
        ...(strategy.value ? { strategyId: strategy.value } : { ...r, universe: universe.value.split(/[\s,]+/).filter(Boolean) }),
        years: numberOf(years),
        costBps: numberOf(cost),
      },
    });
    waiting = true;
  });

  const el = h(
    'details.fd-propose',
    {},
    h('summary', {}, 'Run a backtest'),
    h(
      'div.fd-form',
      {},
      h('label.fd-field', {}, h('span', {}, 'Backtest'), strategy),
      h('label.fd-field', {}, h('span', {}, 'History'), h('div.fd-row', {}, years, h('span.fd-unit', {}, 'years'))),
      h('label.fd-field', {}, h('span', {}, 'Costs per trade'), h('div.fd-row', {}, cost, h('span.fd-unit', {}, 'bp'))),
    ),
    custom,
    h('div.fd-actions', {}, h('span.fd-hint', {}, 'Daily closes, decided at each close and held to the next, no look-ahead; the last 30% held out of sample. It goes on the record.'), go),
  );

  return {
    el,
    update(s: FundState) {
      el.classList.toggle('hidden', !deps.admin());
      cost.placeholder = `at least ${s.config.feeBps + s.config.slippageBps} (fee + slippage)`;
      const live = s.strategies.filter((x) => x.stage !== 'retired');
      const sig = live.map((x) => `${x.id}:${x.name}`).join('|');
      if (sig === options) return;
      options = sig;
      const was = strategy.value;
      strategy.replaceChildren(h('option', { value: '' }, 'Rules tried out here'), ...live.map((x) => h('option', { value: x.id }, `${x.id} · ${x.name}`)));
      strategy.value = live.some((x) => x.id === was) ? was : '';
      toggle();
    },
    /** A run of yours that just came in, to open it. */
    arrived(s: FundState): string | undefined {
      const ids = s.backtests.map((b) => b.id);
      const fresh = seen && waiting ? s.backtests.find((b) => !seen!.has(b.id) && b.by.kind === 'user') : undefined;
      seen = new Set(ids);
      if (fresh) waiting = false;
      return fresh?.id;
    },
  };
}
