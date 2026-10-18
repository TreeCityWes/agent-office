import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Fund } from '../src/server/fund/fund.js';
import type { PriceAdapter } from '../src/server/fund/market/types.js';
import type { Client } from '../src/server/office/client.js';
import type { Ctx } from '../src/server/office/context.js';
import { fundActivity, fundChanged, fundHandlers } from '../src/server/ws/handlers/fund.js';
import { fundCommitteeHandlers } from '../src/server/ws/handlers/fund-committee.js';
import { fundLabHandlers } from '../src/server/ws/handlers/fund-lab.js';
import type { ServerMsg } from '../src/shared/protocol.js';

const idea = { symbol: 'BTC', side: 'long' as const, sizeUsd: 50_000, stop: 95_000, target: 120_000, thesis: 'ETF inflows and a funding reset point higher.', confidence: 70, horizon: '2w', evidence: ['ETF inflows 5 days running'] };

/** A fund on a test price source, and an office with two people in it: an admin and someone who isn't. */
function office() {
  const source: PriceAdapter = { id: 'mock', label: 'Test prices', everyMs: 60_000, mock: true, quotes: async (ls) => ls.filter((l) => l.symbol === 'BTC').map((l) => ({ symbol: l.symbol, price: 100_000, volumeUsd: 1e10, at: Date.now(), source: 'test' })) };
  const sent = new Map<string, ServerMsg[]>();
  const warned = new Map<string, string[]>();
  const broadcasts: ServerMsg[] = [];
  const person = (id: string, admin: boolean) => {
    sent.set(id, []);
    warned.set(id, []);
    return { id, admin, peer: { name: id === 'boss' ? 'Wes' : 'Guest' }, accountId: id } as unknown as Client;
  };
  const boss = person('boss', true);
  const guest = person('guest', false);
  const ctx = {
    clients: new Map([[boss.id, boss], [guest.id, guest]]),
    sendTo: (c: Client, m: ServerMsg) => sent.get(c.id)!.push(m),
    broadcast: (m: ServerMsg) => broadcasts.push(m),
    warn: (c: Client, e: string | undefined) => e && warned.get(c.id)!.push(e),
  } as unknown as Ctx;
  const fund = new Fund({
    dir: path.join(mkdtempSync(path.join(os.tmpdir(), 'fund-ws-')), 'fund'),
    marketAdapters: () => ({ prices: [source], signals: [] }),
    onChange: () => fundChanged(ctx),
    onActivity: (e) => fundActivity(ctx, e),
  });
  (ctx as { fund: Fund }).fund = fund;
  /** Lets what was asked finish, and the window hear of it (the fund tells it a quarter second later). */
  const settle = async () => {
    await fund.serial(() => {});
    await new Promise((r) => setTimeout(r, 300));
  };
  const of = (id: string, t: ServerMsg['t']) => sent.get(id)!.filter((m) => m.t === t);
  return { ctx, fund, boss, guest, sent, warned, broadcasts, settle, of };
}

test('anyone can watch the fund; only an admin acts on it, and the fund checks again', async () => {
  const { ctx, fund, boss, guest, warned, settle, of, broadcasts } = office();
  fundHandlers['fund.watch'](ctx, guest, { t: 'fund.watch', on: true });
  assert.equal(of('guest', 'fund').length, 1, 'the window gets the fund as it is');
  assert.equal(of('guest', 'fund.activity').length, 1);
  await fund.market.refreshAll();

  fundHandlers['fund.propose'](ctx, guest, { t: 'fund.propose', proposal: idea });
  assert.match(warned.get('guest')![0], /Only an admin/);
  fundHandlers['fund.propose'](ctx, boss, { t: 'fund.propose', proposal: idea });
  await settle();
  const p = fund.proposals.get('P-1')!;
  assert.equal(p.stage, 'user_approval');
  assert.equal(p.author.kind, 'user');
  assert.equal(p.author.name, 'Wes');
  assert.ok(of('boss', 'toast').length, 'the admin hears it went to risk');
  // The top bar everywhere hears a trade waits on someone.
  assert.deepEqual(broadcasts.filter((m) => m.t === 'fund.brief').at(-1), { t: 'fund.brief', brief: { awaiting: 1, open: 0, halted: false } });
  // The watcher saw it come in, and its line in the log.
  assert.ok(of('guest', 'fund').length > 1);
  assert.ok(of('guest', 'fund.activity').some((m) => m.t === 'fund.activity' && m.events.some((e) => e.proposalId === 'P-1')));

  fundHandlers['fund.approve'](ctx, guest, { t: 'fund.approve', id: 'P-1' });
  assert.equal(fund.proposals.get('P-1')!.stage, 'user_approval');
  fundHandlers['fund.approve'](ctx, boss, { t: 'fund.approve', id: 'P-1', note: 'go' });
  await settle();
  assert.equal(fund.proposals.get('P-1')!.stage, 'monitoring');
  assert.equal(fund.proposals.get('P-1')!.user!.by.name, 'Wes');
  assert.deepEqual(broadcasts.filter((m) => m.t === 'fund.brief').at(-1), { t: 'fund.brief', brief: { awaiting: 0, open: 1, halted: false } });

  // What the fund refuses comes back as a warning, not a toast.
  fundHandlers['fund.cash'](ctx, boss, { t: 'fund.cash', amount: -1e9 });
  await settle();
  assert.match(warned.get('boss')!.at(-1)!, /in cash/);
  fund.stop();
});

test('a closed window hears nothing more', async () => {
  const { ctx, fund, boss, settle, of } = office();
  fundHandlers['fund.watch'](ctx, boss, { t: 'fund.watch', on: true });
  fundHandlers['fund.watch'](ctx, boss, { t: 'fund.watch', on: false });
  const before = of('boss', 'fund').length;
  await fund.market.refreshAll();
  fundHandlers['fund.propose'](ctx, boss, { t: 'fund.propose', proposal: idea });
  await settle();
  assert.equal(of('boss', 'fund').length, before);
  assert.equal(of('boss', 'fund.activity').length, 1);
  fundHandlers['fund.brief'](ctx, boss, { t: 'fund.brief' });
  assert.deepEqual(of('boss', 'fund.brief').at(-1), { t: 'fund.brief', brief: { awaiting: 1, open: 0, halted: false } });
  fund.stop();
});

test('only an admin calls or decides a committee from the window, and the fund says why it won’t', () => {
  const { ctx, fund, boss, guest, warned } = office();
  fundCommitteeHandlers['fund.convene'](ctx, guest, { t: 'fund.convene', question: 'Cut gross exposure?' });
  assert.match(warned.get('guest')!.at(-1)!, /Only an admin/);
  fundCommitteeHandlers['fund.convene'](ctx, boss, { t: 'fund.convene', question: 'Cut gross exposure?' });
  assert.match(warned.get('boss')!.at(-1)!, /always seats the Skeptic/);
  fundCommitteeHandlers['fund.decide'](ctx, boss, { t: 'fund.decide', id: 'C-9', vote: 'HOLD', summary: 'Nothing to decide here.' });
  assert.match(warned.get('boss')!.at(-1)!, /committee \(C-1…\)/);
  assert.equal(fund.state().committees.length, 0);
  fund.stop();
});

test('the quant lab from the window: only an admin registers, moves or backtests a strategy', () => {
  const { ctx, fund, boss, guest, warned, of } = office();
  const strategy = { name: 'BTC trend', hypothesis: 'Bitcoin trends for months once a move gets going.', universe: ['BTC'], kind: 'trend' };
  fundLabHandlers['fund.strategy'](ctx, guest, { t: 'fund.strategy', strategy });
  assert.match(warned.get('guest')!.at(-1)!, /Only an admin/);
  fundLabHandlers['fund.backtest'](ctx, guest, { t: 'fund.backtest', run: { strategyId: 'S-1' } });
  assert.match(warned.get('guest')!.at(-1)!, /Only an admin/);
  assert.equal(of('guest', 'toast').length, 0);
  fundLabHandlers['fund.strategy'](ctx, boss, { t: 'fund.strategy', strategy });
  assert.deepEqual(fund.state().strategies.map((s) => [s.id, s.author.name]), [['S-1', 'Wes']]);
  fundLabHandlers['fund.strategy.stage'](ctx, guest, { t: 'fund.strategy.stage', id: 'S-1', stage: 'research' });
  assert.match(warned.get('guest')!.at(-1)!, /Only an admin/);
  fundLabHandlers['fund.strategy.stage'](ctx, boss, { t: 'fund.strategy.stage', id: 'S-1', stage: 'backtest' });
  assert.match(warned.get('boss')!.at(-1)!, /goes to Research next/);
  fundLabHandlers['fund.strategy.stage'](ctx, boss, { t: 'fund.strategy.stage', id: 'S-1', stage: 'research' });
  assert.deepEqual(
    of('boss', 'toast').map((m) => (m as { text: string }).text),
    ['🧪 Registered S-1', '🧪 S-1 is at Research'],
  );
  fund.stop();
});
