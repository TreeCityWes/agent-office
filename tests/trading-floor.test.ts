// The trading floor (shared/maps/floor.ts, docs/fund.md#the-trading-floor): its plan, a department
// to a table, everyone able to walk out, and what its screens make of the fund (shared/fund/floor.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid, pathLength } from '../src/shared/nav.js';
import { planOf } from '../src/shared/maps/index.js';
import { WING_DESKS } from '../src/shared/layout.js';
import { departmentSeat, desksByDepartment, heatTiles, pipeline, riskAlarm, tickerItems, treemap, RECENT_REJECTION_MS } from '../src/shared/fund/floor.js';
import { DEFAULT_LIMITS } from '../src/shared/fund/risk.js';
import type { FundState } from '../src/shared/fund/state.js';

test('the trading floor seats a department to a table, every seat with its table’s name', () => {
  const plan = planOf('floor');
  assert.equal(plan.style, 'floor');
  assert.equal(plan.desks.length + plan.overflow.length, 32);
  const tables = new Map<string, number>();
  for (const d of [...plan.desks, ...plan.overflow]) {
    const m = /^(.+), seat (\d+)$/.exec(d.label);
    assert.ok(m, `${d.id} is labelled with its table: ${d.label}`);
    tables.set(m[1], (tables.get(m[1]) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(tables), { '🏛️ Executive': 3, '🛡️ Risk': 5, '📈 Trading': 6, '🔎 Research': 8, '💻 Hot desks': 4, '🧪 Quant lab': 6 });
  // The office's back office seats, only sat at once it's built out, are the hot desks, so every department's are there from the start.
  for (const d of WING_DESKS) assert.match(plan.byId.get(d.id)?.label ?? '', /^💻 Hot desks, seat \d$/, d.id);
  assert.ok(plan.throne, 'your desk, on its dais');
  assert.ok(plan.herald, 'someone to staff new desks');
  assert.equal(plan.lineup.length, 7);
});

test('on the trading floor every worker can walk from its seat to the lifts and the line, glass rooms and all', () => {
  const plan = planOf('floor');
  const nav = new NavGrid(plan.bounds, plan.obstacles!);
  for (const s of plan.lineup) assert.ok(nav.walkable(s.x, s.z), `the line at (${s.x}, ${s.z}) is clear`);
  assert.ok(nav.walkable(plan.door.x, plan.door.z), 'the way out is clear');
  const clear = (way: [number, number][], what: string) => {
    for (let i = 2; i < way.length; i++) {
      const [x0, z0] = way[i - 1];
      const [x1, z1] = way[i];
      const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.2);
      for (let k = 0; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const z = z0 + ((z1 - z0) * k) / n;
        assert.ok(nav.walkable(x, z), `${what} walks into something at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
  };
  for (const d of plan.byId.values()) {
    for (const to of [plan.door, ...plan.lineup]) {
      const way = nav.wayFrom(d, [to.x, to.z]);
      clear(way, `${d.id} (${d.label}) going`);
      assert.ok(pathLength(way) < 3 * Math.hypot(to.x - d.x, to.z - d.z) + 10, `${d.id} (${d.label}) doesn't go the long way round`);
    }
  }
});

/** A fund as the screens see it: `nav` in cash and the positions given, at their weights. */
function fund(over: { positions?: { symbol: string; weightPct: number; value: number }[]; dayPnlPct?: number; drawdownPct?: number; leverage?: number; proposals?: unknown[]; halted?: string; quotes?: { symbol: string; price: number; changePct?: number }[]; desks?: { role: string }[] } = {}): FundState {
  return {
    paper: true,
    config: { name: 'Acme' },
    limits: DEFAULT_LIMITS,
    portfolio: { nav: 100_000, dayPnl: (over.dayPnlPct ?? 0) * 1000, dayPnlPct: over.dayPnlPct ?? 0, drawdownPct: over.drawdownPct ?? 0, leverage: over.leverage ?? 0.5, positions: (over.positions ?? []).map((x) => ({ ...x, unrealizedPct: 0 })) },
    proposals: over.proposals ?? [],
    halted: over.halted,
    market: { mode: 'mock', quotes: over.quotes ?? [] },
    desks: { desks: over.desks ?? [] },
  } as unknown as FundState;
}

test('the risk beacon is calm inside the limits, amber near one or after a rejection, red past one or halted', () => {
  const now = 1_000_000_000;
  assert.equal(riskAlarm(fund({ positions: [{ symbol: 'BTC', weightPct: 5, value: 5000 }] }), now).level, 'calm');
  const near = riskAlarm(fund({ positions: [{ symbol: 'BTC', weightPct: 8.5, value: 8500 }] }), now);
  assert.equal(near.level, 'watch');
  assert.match(near.reasons[0], /Largest position is at 85%/);
  const over = riskAlarm(fund({ positions: [{ symbol: 'BTC', weightPct: 12, value: 12_000 }] }), now);
  assert.equal(over.level, 'alarm');
  assert.match(over.reasons[0], /Largest position 12\.0% is over its 10\.0% limit/);
  // A loss limit's hit at the limit itself; the others only past it.
  assert.equal(riskAlarm(fund({ dayPnlPct: -3 }), now).level, 'alarm');
  assert.equal(riskAlarm(fund({ positions: [{ symbol: 'BTC', weightPct: 10, value: 10_000 }] }), now).level, 'watch');
  assert.equal(riskAlarm(fund({ halted: 'the journals don’t check out' }), now).reasons[0], 'Trading halted: the journals don’t check out');
  const turnedDown = (at: number) => [{ side: 'long', symbol: 'ETH', stage: 'rejected', updatedAt: at, risk: { decision: 'rejected', at } }];
  assert.equal(riskAlarm(fund({ proposals: turnedDown(now - 60_000) }), now).level, 'watch');
  assert.equal(riskAlarm(fund({ proposals: turnedDown(now - RECENT_REJECTION_MS - 1) }), now).level, 'calm');
  assert.deepEqual(
    riskAlarm(fund(), now).limits.map((l) => l.key),
    ['position', 'top3', 'leverage', 'drawdown', 'dayLoss'],
  );
});

test('the ticker leads with a warning, then the fund, then what it holds before what it only watches', () => {
  const quotes = [
    { symbol: 'AAPL', price: 190.5, changePct: -1.25 },
    { symbol: 'BTC', price: 64_321.7, changePct: 2.5 },
    { symbol: 'DOGE', price: 0.12345 },
  ];
  const calm = tickerItems(fund({ quotes, positions: [{ symbol: 'BTC', weightPct: 5, value: 5000 }] }), 0);
  assert.deepEqual(
    calm.map((i) => i.text),
    ['ACME NAV 100,000', 'DAY +0 (+0.00%)', 'PAPER', '●BTC 64,322 ▲2.50%', 'AAPL 190.50 ▼1.25%', 'DOGE 0.1235', 'MOCK MARKET: SIMULATED PRICES'],
  );
  assert.deepEqual(
    calm.slice(3, 6).map((i) => i.tone),
    ['up', 'down', 'flat'],
  );
  const alarm = tickerItems(fund({ halted: 'bad journal' }), 0);
  assert.deepEqual(alarm[0], { text: '⚠ RISK: Trading halted: bad journal', tone: 'alarm' });
});

test('the heatmap sizes what’s held by its value and gives what’s only watched a share of the rest', () => {
  const tiles = heatTiles(
    fund({
      positions: [
        { symbol: 'BTC', weightPct: 6, value: 6000 },
        { symbol: 'TSLA', weightPct: 3, value: -3000 },
      ],
      quotes: [
        { symbol: 'BTC', price: 1, changePct: 1 },
        { symbol: 'TSLA', price: 1, changePct: -2 },
        { symbol: 'SPY', price: 1, changePct: 0.5 },
        { symbol: 'GLD', price: 1 },
      ],
    }),
  );
  assert.deepEqual(
    tiles.map((t) => [t.symbol, t.weight, t.held, t.changePct]),
    [
      ['BTC', 6000, true, 1],
      ['TSLA', 3000, true, -2],
      ['GLD', 1500, false, 0],
      ['SPY', 1500, false, 0.5],
    ],
  );
  // Nothing held: the watched share all of it.
  assert.deepEqual(
    heatTiles(
      fund({
        quotes: [
          { symbol: 'A', price: 1 },
          { symbol: 'B', price: 1 },
        ],
      }),
    ).map((t) => t.weight),
    [0.5, 0.5],
  );
});

test('the treemap gives every tile its share of the area, inside it, overlapping none', () => {
  const area = { x: 10, y: 20, w: 600, h: 300 };
  const weights = [50, 25, 10, 8, 4, 2, 1];
  const rects = treemap(weights, area);
  const total = weights.reduce((a, b) => a + b, 0);
  rects.forEach((r, i) => {
    assert.ok(Math.abs(r.w * r.h - (weights[i] / total) * area.w * area.h) < 1e-6, `tile ${i} has its share`);
    assert.ok(r.x >= area.x - 1e-9 && r.y >= area.y - 1e-9 && r.x + r.w <= area.x + area.w + 1e-6 && r.y + r.h <= area.y + area.h + 1e-6, `tile ${i} is inside`);
  });
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      const overlap = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.ok(overlap < 1e-6, `tiles ${i} and ${j} don’t overlap`);
    }
  assert.deepEqual(treemap([], area), []);
  assert.deepEqual(treemap([0, 0], area), [
    { x: 10, y: 20, w: 0, h: 0 },
    { x: 10, y: 20, w: 0, h: 0 },
  ]);
});

test('the pipeline counts proposals at each stage of the workflow, the stopped ones last', () => {
  const p = (symbol: string, stage: string, updatedAt: number) => ({ side: 'long', symbol, stage, updatedAt });
  const rows = pipeline(fund({ proposals: [p('BTC', 'risk_review', 1), p('ETH', 'risk_review', 2), p('SOL', 'monitoring', 3), p('AAPL', 'rejected', 4), p('NVDA', 'expired', 5)] }));
  assert.deepEqual(
    rows.map((r) => r.stage),
    ['idea', 'research', 'proposed', 'risk_review', 'cio_review', 'user_approval', 'executing', 'monitoring', 'exited', 'reviewed', 'stopped'],
  );
  const at = Object.fromEntries(rows.map((r) => [r.stage, r.items]));
  assert.deepEqual(at.risk_review, ['long ETH', 'long BTC']);
  assert.deepEqual(at.monitoring, ['long SOL']);
  assert.deepEqual(at.stopped, ['long NVDA', 'long AAPL']);
  assert.equal(
    rows.reduce((a, r) => a + r.count, 0),
    5,
  );
});

test('the desks board groups the desks by department, in the departments’ order', () => {
  const groups = desksByDepartment(fund({ desks: [{ role: 'backtester' }, { role: 'pm' }, { role: 'cio' }, { role: 'quant' }, { role: 'nobody' }] }));
  assert.deepEqual(
    groups.map((g) => [g.department, g.desks.map((d) => d.role)]),
    [
      ['executive', ['cio', 'pm']],
      ['quant', ['backtester', 'quant']],
    ],
  );
});

test('a new hire for a role sits at its department’s table on the trading floor, and anywhere on a map without one', () => {
  const plan = planOf('floor');
  const label = (id: string | undefined) => (id ? plan.byId.get(id)?.label : undefined);
  const free = () => false;
  assert.equal(label(departmentSeat(plan, 'risk', free)), '🛡️ Risk, seat 1');
  assert.equal(label(departmentSeat(plan, 'quant', free)), '🧪 Quant lab, seat 1');
  assert.equal(label(departmentSeat(plan, 'research', free)), '🔎 Research, seat 1');
  // Its next seat once the first is taken, and none when they all are.
  const first = departmentSeat(plan, 'executive', free)!;
  assert.equal(label(departmentSeat(plan, 'executive', (id) => id === first)), '🏛️ Executive, seat 2');
  assert.equal(departmentSeat(plan, 'executive', (id) => label(id)?.startsWith('🏛️ Executive') ?? false), undefined);
  const research = [...plan.desks, ...plan.overflow].filter((d) => d.label.startsWith('🔎 Research')).map((d) => d.id);
  assert.equal(label(departmentSeat(plan, 'research', (id) => research.slice(0, 7).includes(id))), '🔎 Research, seat 8');
  // The traders' seats are past the regular ones, among the overflow seats, and they count too.
  const trading = departmentSeat(plan, 'trading', free);
  assert.equal(label(trading), '📈 Trading, seat 1');
  assert.ok(plan.overflow.some((d) => d.id === trading));
  assert.equal(departmentSeat(planOf('office'), 'risk', free), undefined);
  assert.equal(departmentSeat(planOf('castle'), 'risk', free), undefined);
});
