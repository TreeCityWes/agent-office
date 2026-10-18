import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkRequest, checkRoutine, everyLabel, requestOrder, routineNext, type ResearchRequest, type Routine } from '../src/shared/fund/work.js';
import { fundOffice, PEOPLE, toolServer, wait } from './fund-office.js';

const err = (r: object) => ('error' in r ? String(r.error) : '');
const T0 = Date.parse('2026-10-18T12:00:00Z');
const MIN = 60_000;

test('what research requests and routines take', () => {
  assert.deepEqual(checkRequest({ to: 'quant', question: ' Is momentum crowded? ', symbol: 'btc', dueInMin: 30, proposalId: 'p-2' }), { to: 'quant', question: 'Is momentum crowded?', proposalId: 'P-2', symbol: 'BTC', dueInMin: 30 });
  assert.match(err(checkRequest({ question: 'x' })), /Which desk/);
  assert.match(err(checkRequest({ to: 'quant' })), /question/);
  assert.match(err(checkRequest({ to: 'quant', question: 'x', dueInMin: 0 })), /dueInMin/);
  assert.match(err(checkRoutine({ role: 'cio', prompt: 'x' })), /everyMin/);
  assert.match(err(checkRoutine({ role: 'cio', prompt: 'x', everyMin: 2 })), /5 to 10080/);
  assert.match(err(checkRoutine({ id: 'R-3' })), /a routine, like RT-2/);
  assert.deepEqual(checkRoutine({ id: 'rt-3', on: false }), { id: 'RT-3', on: false });
  assert.deepEqual([30, 60, 120, 1440, 2880].map(everyLabel), ['every 30 min', 'every hour', 'every 2 h', 'every day', 'every 2 days']);
  assert.equal(routineNext({ at: 1000, everyMin: 5 } as Routine), 1000 + 5 * MIN);
  assert.equal(routineNext({ at: 1000, lastAt: 9000, everyMin: 5 } as Routine), 9000 + 5 * MIN);
  // Open first, the soonest due at the top (no deadline last); then the latest closed.
  const req = (id: string, status: ResearchRequest['status'], at: number, dueAt?: number, answeredAt?: number) => ({ id, status, at, dueAt, ...(answeredAt ? { answer: { at: answeredAt } } : {}) }) as ResearchRequest;
  const order = [req('R-1', 'answered', 1, undefined, 5), req('R-2', 'open', 2), req('R-3', 'open', 3, 50), req('R-4', 'answered', 4, undefined, 9), req('R-5', 'open', 5, 20)].sort(requestOrder);
  assert.deepEqual(order.map((r) => r.id), ['R-5', 'R-3', 'R-2', 'R-4', 'R-1']);
});

test('a research request is typed into the desk, stays open until it answers, and the answer goes back to whoever asked', async () => {
  let now = T0;
  const { fund, dir, hire, as, last, told, toasts } = fundOffice({ now: () => now });
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('q', 'Quinn'), 'quant', PEOPLE);
  fund.desks.staff(hire('r', 'Rae'), 'crypto-analyst', PEOPLE);
  hire('x', 'Xu');
  const reqs = fund.desks.requests;

  // A desk asks another desk, never its own; a worker with no desk doesn't ask.
  assert.match(err(reqs.ask(as('x'), { to: 'quant', question: 'Anything?' })), /desk/);
  assert.match(err(reqs.ask(as('q'), { to: 'quant', question: 'Anything?' })), /your own desk/);
  assert.ok(err(reqs.ask(as('c'), { to: 'janitor', question: 'Anything?' })));

  const r = reqs.ask(as('c'), { to: 'quant', question: 'Is BTC momentum crowded?', symbol: 'BTC', dueInMin: 30 });
  assert.ok('ok' in r && r.delivered);
  assert.equal(r.request.id, 'R-1');
  assert.match(last('q'), /Research request R-1 from Cleo \(Chief Investment Officer\) about BTC, wanted within 30 min:\n\nIs BTC momentum crowded\?[\s\S]*fund_answer \(id R-1/);
  assert.equal(fund.state().desks.messages[0].kind, 'request');
  assert.equal(fund.state().desks.requests[0].status, 'open');

  // Only the desk it's for answers it; the asker hears the answer, confidence and sources.
  assert.match(err(reqs.answer(as('r'), { id: 'R-1', text: 'No idea' })), /only whoever holds that desk answers it/);
  const a = reqs.answer(as('q'), { id: 'R-1', text: '12-1 momentum is in its 90th percentile.', confidence: 0.65, sources: ['backtest BT-4'] });
  assert.ok('ok' in a && a.told);
  assert.match(last('c'), /Answer to your research request R-1 \("Is BTC momentum crowded\?"\) from Quinn \(Quant Researcher\):\n\n12-1 momentum[\s\S]*Confidence: 65%\nSources: backtest BT-4/);
  assert.match(err(reqs.answer(as('q'), { id: 'R-1', text: 'Again' })), /already answered/);

  // A person asks from the Research tab: everyone hears when it's answered.
  now += MIN;
  const p = reqs.ask(PEOPLE, { to: 'crypto-analyst', question: 'Where is ETH funding?' });
  assert.ok('ok' in p && p.request.id === 'R-2');
  reqs.answer(as('r'), { id: 'R-2', text: 'Flat at 0.01% per 8h.' });
  assert.match(toasts.at(-1)!, /Crypto Analyst answered R-2/);

  // Withdrawn by whoever asked, not by another desk.
  now += MIN;
  const w = reqs.ask(as('r'), { to: 'quant', question: 'Backtest ETH carry?' });
  assert.ok('ok' in w);
  assert.match(err(reqs.withdraw(as('c'), { id: 'R-3' })), /Only whoever asked/);
  assert.ok('ok' in reqs.withdraw(as('r'), { id: 'R-3', note: 'Found it in BT-2' }));
  assert.equal(reqs.get('R-3')!.withdrawn!.note, 'Found it in BT-2');

  // An idea someone asks about moves to research.
  const idea = await fund.propose({ symbol: 'BTC', side: 'long', thesis: 'Funding reset, flows back.' }, as('r'), { idea: true });
  assert.ok('proposal' in idea && idea.proposal.stage === 'idea');
  reqs.ask(as('c'), { to: 'quant', question: 'Size the drawdowns for this.', proposalId: idea.proposal.id, dueInMin: 30 });
  await wait(20);
  assert.equal(fund.proposals.get(idea.proposal.id)!.stage, 'research');

  // A vacant desk: it stays open, and whoever takes the desk is told it's waiting.
  const v = reqs.ask(as('c'), { to: 'macro', question: 'What does the curve say?', dueInMin: 60 });
  assert.ok('ok' in v && !v.delivered);
  assert.match(v.note!, /Nobody holds the Macro Analyst desk yet: R-5 stays open/);
  const brief = fund.desks.staff(hire('m', 'Max'), 'macro', PEOPLE);
  assert.ok('ok' in brief);
  assert.match(brief.brief, /1 research request is waiting for your desk \(R-5\)/);

  // Past due: the desk is reminded once, and the log says so.
  const before = told.filter((t) => t.id === 'q').length;
  now += 31 * MIN;
  reqs.tick();
  reqs.tick();
  assert.equal(told.filter((t) => t.id === 'q').length, before + 1);
  assert.match(last('q'), /R-4 from Cleo \(Chief Investment Officer\) is past due/);
  assert.equal(fund.activity.list({ kind: 'request' }).filter((e) => /past due/.test(e.text)).length, 1);

  // Kept on disk, hash-chained, and read back as it was.
  fund.stop();
  assert.match(readFileSync(path.join(dir, 'requests.jsonl'), 'utf8'), /"hash"/);
  const again = fundOffice({ dir, now: () => now });
  assert.deepEqual(again.fund.desks.requests.list().map((x) => [x.id, x.status]), [['R-4', 'open'], ['R-5', 'open'], ['R-3', 'withdrawn'], ['R-2', 'answered'], ['R-1', 'answered']]);
  assert.equal(again.fund.desks.requests.get('R-4')!.reminded, true);
  again.fund.stop();
});

test('a routine is typed into its desk on schedule: never mid-turn, skipped while nobody holds the desk', () => {
  let now = T0;
  const { fund, dir, hire, as, last, told, workers } = fundOffice({ now: () => now });
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('q', 'Quinn'), 'quant', PEOPLE);
  fund.desks.staff(hire('t', 'Tex'), 'crypto-trader', PEOPLE);
  const rt = fund.desks.routines;
  const q = workers.get('q')!;
  const toQuinn = () => told.filter((t) => t.id === 'q').length;

  // People set routines, and so do the desks that assign work; a trader doesn't.
  assert.match(err(rt.set(as('t'), { role: 'quant', prompt: 'Scan momentum', everyMin: 30 })), /doesn't set routines/);
  const r1 = rt.set(as('c'), { role: 'quant', prompt: 'Scan BTC momentum and note anything stretched.', everyMin: 30 });
  assert.ok('ok' in r1 && r1.routine.id === 'RT-1' && r1.routine.on);
  const r2 = rt.set(PEOPLE, { role: 'macro', prompt: 'Read the overnight macro tape.', everyMin: 60 });
  assert.ok('ok' in r2 && r2.routine.id === 'RT-2');
  assert.match(err(rt.set(PEOPLE, { role: 'janitor', prompt: 'x', everyMin: 30 })), /no role called janitor/);

  // Not due yet: nothing happens.
  const start = toQuinn();
  rt.tick();
  assert.equal(toQuinn(), start);

  // Due while the agent is mid-turn: it waits; once the agent is idle, it's typed in.
  now += 30 * MIN;
  q.status = 'working';
  rt.tick();
  assert.equal(toQuinn(), start);
  q.status = 'idle';
  rt.tick();
  assert.equal(toQuinn(), start + 1);
  assert.match(last('q'), /⏰ Routine RT-1, every 30 min \(set by Cleo\):\n\nScan BTC momentum/);
  assert.deepEqual([rt.list()[1].runs, rt.list()[1].last], [1, 'Typed in']);
  assert.equal(fund.state().desks.messages[0].kind, 'routine');

  // Nobody at the macro desk: skipped, and said once in the log, not every time.
  now += 60 * MIN;
  rt.tick();
  now += 60 * MIN;
  rt.tick();
  assert.equal(fund.activity.list({ kind: 'routine' }).filter((e) => /RT-2 for the Macro Analyst skipped: nobody holds the desk/.test(e.text)).length, 1);
  assert.match(rt.list().find((r) => r.id === 'RT-2')!.last!, /Skipped: nobody holds the desk/);

  // Busy a whole interval past due: skipped, so routines don't pile up behind a long turn.
  const ran = toQuinn();
  q.status = 'working';
  now += 30 * MIN;
  rt.tick();
  now += 30 * MIN;
  rt.tick();
  assert.equal(toQuinn(), ran);
  assert.match(rt.list().find((r) => r.id === 'RT-1')!.last!, /busy the whole time/);

  // Run now: not while the agent is asking someone something.
  q.status = 'needs_input';
  assert.match(err(rt.run(PEOPLE, { id: 'RT-1' })), /asking someone something/);
  assert.match(err(rt.run(PEOPLE, { id: 'RT-2' })), /Nobody holds the Macro Analyst desk/);
  q.status = 'idle';
  assert.ok('ok' in rt.run(PEOPLE, { id: 'RT-1' }));
  assert.equal(toQuinn(), ran + 1);

  // An agent that's only just taken its desk is still on its brief: a routine due waits until it reports in.
  q.status = 'working';
  now += 60 * MIN;
  fund.desks.staff(hire('m', 'Mo'), 'macro', PEOPLE);
  workers.get('m')!.status = 'idle'; // as OpenCode reads before its first turn has got going
  const toMo = () => told.filter((t) => t.id === 'm').length;
  const briefed = toMo();
  rt.tick();
  assert.equal(toMo(), briefed);
  assert.ok('ok' in fund.desks.setStatus(as('m'), { status: 'analyzing', note: 'Reading the overnight tape' }));
  rt.tick();
  assert.equal(toMo(), briefed + 1);
  assert.match(last('m'), /⏰ Routine RT-2, every hour/);
  q.status = 'idle';

  // Paused: it doesn't come due; removed: it's gone (a trader can't remove one).
  assert.ok('ok' in rt.set(PEOPLE, { id: 'RT-1', on: false }));
  now += 300 * MIN;
  rt.tick();
  assert.equal(toQuinn(), ran + 1);
  assert.match(err(rt.remove(as('t'), { id: 'RT-2' })), /doesn't set routines/);
  assert.ok('ok' in rt.remove(as('c'), { id: 'RT-2' }));
  assert.ok(fund.activity.list({ kind: 'routine' }).some((e) => /^Paused RT-1/.test(e.text)));

  // Kept on disk: the paused one comes back paused (it ran four times: twice more while the macro desk sat empty), and the next one is RT-3.
  fund.stop();
  const again = fundOffice({ dir, now: () => now });
  assert.deepEqual(again.fund.desks.routines.list().map((r) => [r.id, r.on, r.runs]), [['RT-1', false, 4]]);
  const r3 = again.fund.desks.routines.set(PEOPLE, { role: 'cio', prompt: 'Review the book.', everyMin: 1440 });
  assert.ok('ok' in r3 && r3.routine.id === 'RT-3');
  again.fund.stop();
});

test('the agents ask, answer and set routines with the fund tools', async (t) => {
  const { fund, hire, workers, last } = fundOffice();
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('q', 'Quinn'), 'quant', PEOPLE);
  fund.desks.staff(hire('t', 'Tex'), 'crypto-trader', PEOPLE);
  const { server, run } = await toolServer(fund, workers, { c: 'c-token', q: 'q-token', t: 't-token' });
  t.after(() => {
    server.close();
    fund.stop();
  });
  const call = async (id: string, tool: string, args: object = {}) => {
    const r = await run(id, tool, JSON.stringify(args));
    assert.equal(r.code, 0, `${id}'s ${tool}: ${r.err}`);
    return JSON.parse(r.out);
  };

  const asked = await call('c', 'request', { to: 'quant', question: 'Is BTC momentum crowded?', dueInMin: 30 });
  assert.deepEqual([asked.request.id, asked.request.to, asked.delivered], ['R-1', 'Quant Researcher', true]);
  const mine = await call('q', 'requests', { mine: 'to' });
  assert.deepEqual(mine.requests.map((r: { id: string; overdue: boolean }) => [r.id, r.overdue]), [['R-1', false]]);
  const answered = await call('q', 'answer', { id: 'R-1', text: 'Stretched: 90th percentile.', confidence: 70, sources: ['BT-4'] });
  assert.equal(answered.request.status, 'answered');
  assert.match(last('c'), /Answer to your research request R-1/);
  assert.equal((await call('c', 'requests', { status: 'answered' })).requests[0].answer.confidence, 70);

  // The trader can't set routines; the CIO can, and runs one now.
  assert.match((await run('t', 'routine', JSON.stringify({ role: 'quant', prompt: 'x', everyMin: 30 }))).err, /doesn't set routines/);
  const set = await call('c', 'routine', { role: 'quant', prompt: 'Scan momentum.', everyMin: 60 });
  assert.deepEqual([set.routine.id, set.routine.every], ['RT-1', 'every hour']);
  workers.get('q')!.status = 'idle';
  await call('c', 'routine', { id: 'RT-1', run: true });
  assert.match(last('q'), /⏰ Routine RT-1, every hour \(set by Cleo\)/);
  assert.equal((await call('t', 'routines')).routines[0].runs, 1);
  await call('c', 'routine', { id: 'RT-1', remove: true });
  assert.deepEqual((await call('t', 'routines')).routines, []);
});
