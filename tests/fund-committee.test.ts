import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkBallot, checkConvene, checkDecision, tally, voteFor, type Ballot, type Committee } from '../src/shared/fund/committee.js';
import { handleMcp } from '../bin/office-workers.js';
import { fundOffice, PEOPLE, toolServer, trade, wait } from './fund-office.js';

const ballot = (role: string, vote: Ballot['vote'], confidence: number): Ballot => ({ role, by: { kind: 'agent', id: role, name: role }, vote, confidence, argument: 'Because.', evidence: [], risks: ['Being wrong'], at: 0 });
const err = (r: unknown) => (r as { error: string }).error;
const committee = (r: unknown) => (r as { committee: Committee }).committee;

test('the committee rules: a confidence-weighted tally, and what a ballot, a meeting and a decision take', () => {
  const t = tally({ seats: ['macro', 'quant', 'skeptic', 'cro'], ballots: [ballot('macro', 'BUY', 80), ballot('quant', 'BUY', 60), ballot('skeptic', 'SELL', 90)] });
  assert.deepEqual({ ...t }, { BUY: 2, HOLD: 0, SELL: 1, score: 17, lean: 'BUY', abstained: ['cro'], dissent: ['skeptic'] });
  assert.equal(tally({ seats: ['a', 'b'], ballots: [ballot('a', 'BUY', 50), ballot('b', 'SELL', 50)] }).lean, 'HOLD', 'a tie holds');
  assert.equal(tally({ seats: ['a'], ballots: [] }).lean, 'HOLD');
  assert.equal(voteFor('short'), 'SELL');

  const b = checkBallot({ vote: 'long', confidence: 0.7, argument: 'Flows lead price here.', evidence: 'ETF inflows', risk: 'A macro shock' });
  assert.deepEqual(b, { vote: 'BUY', confidence: 70, argument: 'Flows lead price here.', evidence: ['ETF inflows'], risks: ['A macro shock'] });
  assert.match(err(checkBallot({ vote: 'maybe', confidence: 50, argument: 'Not sure at all.', risks: ['x'] })), /BUY, HOLD or SELL/);
  assert.match(err(checkBallot({ vote: 'SELL', confidence: 50, argument: 'Too rich.', risks: ['x'] })), /argument/);
  assert.match(err(checkBallot({ vote: 'SELL', confidence: 50, argument: 'Valuations are stretched.' })), /at least one thing that would make your vote wrong/);

  assert.deepEqual(checkConvene({ proposalId: 'p-3', seats: 'Macro, skeptic' }), { question: 'Should the fund take P-3?', proposalId: 'P-3', symbol: undefined, seats: ['macro', 'skeptic'], minutes: 15 });
  assert.match(err(checkConvene({ question: 'Cut gross?', seats: ['janitor'] })), /no role janitor/);
  assert.match(err(checkConvene({ question: 'Cut gross?', minutes: 0 })), /1 to 240/);
  assert.match(err(checkConvene({})), /question/);
  assert.match(err(checkDecision({ vote: 'BUY', summary: 'Yes.' })), /summary/);
});

test('a committee sits: sealed ballots, the Skeptic always seated, then the ballots open and the chair decides', async () => {
  const { fund, hire, as, last } = fundOffice();
  await fund.market.refreshAll();
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('m', 'Max'), 'macro', PEOPLE);
  fund.desks.staff(hire('t', 'Tex'), 'crypto-trader', PEOPLE);
  assert.ok('proposal' in (await fund.propose(trade, as('t'))));
  const c = fund.committees;

  assert.match(err(c.convene(as('m'), { proposalId: 'P-1' })), /A Macro Analyst doesn't call the committee/);
  assert.match(err(c.convene(as('c'), { proposalId: 'P-1' })), /always seats the Skeptic/);
  fund.desks.staff(hire('s', 'Sid'), 'skeptic', PEOPLE);
  assert.match(err(c.convene(as('c'), { proposalId: 'P-1', seats: ['quant', 'skeptic'] })), /Nobody holds Quant Researcher/);
  const called = committee(c.convene(as('c'), { proposalId: 'P-1', minutes: 30 }));
  assert.deepEqual({ id: called.id, chair: called.chair, seats: called.seats, symbol: called.symbol, status: called.status }, { id: 'C-1', chair: 'cio', seats: ['macro', 'crypto-trader', 'skeptic'], symbol: 'BTC', status: 'voting' });
  assert.match(err(c.convene(as('c'), { proposalId: 'P-1' })), /already sitting on P-1/);
  assert.match(last('m'), /Investment committee C-1, called by Cleo[\s\S]*P-1 from Tex \(Crypto Trader\)[\s\S]*fund_ballot/);
  assert.match(last('s'), /You are the Skeptic: make the strongest case against/);
  assert.ok(!/You are the Skeptic/.test(last('m')));
  assert.equal(fund.state().desks.messages[0].kind, 'committee');

  // Sealed: each seat sees its own ballot, and the log says who voted but not how.
  assert.ok('ok' in c.ballot(as('m'), { id: 'C-1', vote: 'BUY', confidence: 70, argument: 'Real yields are rolling over.', risks: ['Hot CPI'] }));
  assert.equal(c.view(c.get('C-1')!, as('m')).ballots.length, 1);
  assert.equal(c.view(c.get('C-1')!, as('s')).ballots.length, 0);
  assert.ok('sealed' in c.view(c.get('C-1')!, as('s')));
  assert.equal(fund.activity.list({ kind: 'committee' }).at(-1)!.text, 'Cast a sealed ballot on C-1');
  assert.match(err(c.ballot(as('c'), { id: 'C-1', vote: 'BUY', confidence: 90, argument: 'I like it a lot.', risks: ['x'] })), /You don't sit on C-1/);
  assert.match(err(c.decide(as('c'), { id: 'C-1', vote: 'BUY', summary: 'Too early to say anything.' })), /still voting/);

  assert.ok('ok' in c.ballot(as('t'), { id: 'C-1', vote: 'BUY', confidence: 60, argument: 'Funding reset, room to run.', risks: ['Liquidations'] }));
  const opened = committee(c.ballot(as('s'), { id: 'C-1', vote: 'SELL', confidence: 85, argument: 'Everyone is long the same story.', evidence: ['Funding 0.05%'], risks: ['Squeeze higher'] }));
  assert.equal(opened.status, 'open', 'the last ballot opens them');
  assert.match(last('c'), /You chair C-1[\s\S]*SELL at 85%[\s\S]*fund_decide/);
  assert.match(last('s'), /C-1's ballots are open \(everyone voted\)[\s\S]*Real yields are rolling over/);
  assert.equal(c.view(opened, as('s')).ballots.length, 3);
  const revised = c.ballot(as('s'), { id: 'C-1', vote: 'SELL', confidence: 90, argument: 'Even more sure after reading theirs.', risks: ['Squeeze higher'] });
  assert.equal((revised as { ballot: Ballot }).ballot.revised, true);
  assert.match(fund.activity.list({ kind: 'committee' }).at(-1)!.text, /Revised its ballot on C-1: SELL at 90%/);

  assert.match(err(c.decide(as('m'), { id: 'C-1', vote: 'BUY', summary: 'I would like to decide this.' })), /Only C-1's chair decides it: the Chief Investment Officer/);
  const decided = committee(c.decide(as('c'), { id: 'C-1', vote: 'BUY', summary: 'Two desks for, the Skeptic against on crowding; size stays inside risk.' }));
  assert.equal(decided.decision?.vote, 'BUY');
  assert.match(last('t'), /C-1 decided: BUY, by Cleo/);
  assert.equal(c.decidedFor('P-1')?.id, 'C-1');
  assert.match(err(c.ballot(as('m'), { id: 'C-1', vote: 'SELL', confidence: 50, argument: 'Changed my mind on it.', risks: ['x'] })), /decided: too late to vote/);
  assert.equal(fund.state().committees[0].status, 'decided');
  fund.stop();
});

test("an agent CIO can't rule on a big proposal until a committee has decided it; a person can", async () => {
  const { fund, hire, as, last } = fundOffice();
  await fund.market.refreshAll();
  assert.ok('ok' in (await fund.setConfig({ committeeOverPct: 4 }, PEOPLE)));
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('t', 'Tex'), 'crypto-trader', PEOPLE);
  fund.desks.staff(hire('s', 'Sid'), 'skeptic', PEOPLE);
  assert.ok('proposal' in (await fund.propose(trade, as('t'))));
  await wait(1700);
  assert.match(last('c'), /P-1 is 5\.0% of NAV, over the fund's 4%: it needs an investment committee's decision/);
  assert.match(err(await fund.rule('P-1', 'approve', 'Fits the book', as('c'))), /needs an investment committee's decision before the CIO rules/);

  const c = fund.committees;
  c.convene(as('c'), { proposalId: 'P-1' });
  c.ballot(as('t'), { id: 'C-1', vote: 'BUY', confidence: 70, argument: 'My own trade, still like it.', risks: ['Macro shock'] });
  // A committee that only opened hasn't decided anything yet.
  assert.equal(committee(c.ballot(as('s'), { id: 'C-1', vote: 'HOLD', confidence: 40, argument: 'Wait for the CPI print.', risks: ['Missing the move'] })).status, 'open');
  assert.ok('error' in (await fund.rule('P-1', 'approve', 'Fits the book', as('c'))));
  c.decide(as('c'), { id: 'C-1', vote: 'BUY', summary: 'The trader is for it, the Skeptic would wait; we go at the size risk allows.' });
  const ruled = await fund.rule('P-1', 'approve', 'Committee backed it', as('c'));
  assert.ok('proposal' in ruled && ruled.proposal.stage === 'user_approval');

  // People aren't held to it: they can approve past the CIO without any committee.
  assert.ok('proposal' in (await fund.propose({ ...trade, thesis: 'A second look at the same flows story.' }, as('t'))));
  assert.ok('proposal' in (await fund.approve('P-2', 'My call', PEOPLE)));
  assert.match(err(await fund.setConfig({ committeeOverPct: 120 }, PEOPLE)), /committeeOverPct/);
  fund.stop();
});

test('a person chairs from the window; a vote runs out of time, a decision that never comes lapses, and it all survives a restart', async () => {
  let clock = Date.now();
  const now = () => clock;
  const { fund, dir, hire, as, toasts } = fundOffice({ now });
  fund.desks.staff(hire('m', 'Max'), 'macro', PEOPLE);
  fund.desks.staff(hire('s', 'Sid'), 'skeptic', PEOPLE);
  const c = fund.committees;
  const called = committee(c.convene(PEOPLE, { question: 'Is it time to cut gross exposure?', minutes: 5 }));
  assert.equal(called.chair, undefined);
  assert.deepEqual(called.seats, ['macro', 'skeptic']);
  assert.match(toasts.at(-1)!, /C-1 is sitting: Is it time to cut gross/);
  c.ballot(as('m'), { id: 'C-1', vote: 'SELL', confidence: 65, argument: 'Breadth is rolling over.', risks: ['A dovish Fed'] });

  clock += 5 * 60_000;
  c.tick();
  assert.equal(c.get('C-1')!.status, 'open');
  assert.match(fund.activity.list({ kind: 'committee' }).at(-1)!.text, /time ran out; no ballot from Skeptic/);
  assert.match(toasts.at(-1)!, /waits on a person's decision/);
  clock += 10 * 60_000;
  c.tick();
  assert.equal(c.get('C-1')!.status, 'lapsed');
  assert.match(err(c.decide(PEOPLE, { id: 'C-1', vote: 'SELL', summary: 'Too late, but for the record.' })), /lapsed already/);
  fund.stop();

  const again = fundOffice({ dir, now });
  assert.equal(again.fund.committees.get('C-1')?.status, 'lapsed');
  assert.equal(again.fund.halted(), undefined);
  again.fund.stop();
  // An edited committee journal stops the fund trading, like any other.
  const file = path.join(dir, 'committees.jsonl');
  writeFileSync(file, readFileSync(file, 'utf8').replace('cut gross exposure', 'buy everything'));
  const edited = fundOffice({ dir, now });
  assert.match(edited.fund.halted() ?? '', /committees journal doesn't check out/);
  edited.fund.stop();
});

test('agents sit on a committee through office-fund, and their role decides which committee tools they get', async (t) => {
  const { fund, hire, workers } = fundOffice();
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('m', 'Max'), 'macro', PEOPLE);
  fund.desks.staff(hire('s', 'Sid'), 'skeptic', PEOPLE);
  const { server, env, run } = await toolServer(fund, workers, { c: 'c-token', m: 'm-token', s: 's-token' });
  t.after(() => server.close());
  const listed = async (id: string) => ((await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { env: env(id), fetch })).result.tools as { name: string }[]).map((x) => x.name);
  const skeptic = await listed('s');
  assert.ok(skeptic.includes('fund_ballot') && skeptic.includes('fund_committees') && !skeptic.includes('fund_committee') && !skeptic.includes('fund_decide'));

  assert.equal(JSON.parse((await run('c', 'fund_committee', '{"question":"Do we add duration here?","minutes":20}')).out).committee.id, 'C-1');
  assert.match((await run('m', 'fund_committee', '{"question":"Me too?"}')).err, /doesn't call the committee/);
  await run('m', 'fund_ballot', JSON.stringify({ id: 'C-1', vote: 'BUY', confidence: 72, argument: 'Term premium has room to compress.', risks: ['Supply'] }));
  const seen = JSON.parse((await run('s', 'fund_committees', '{"id":"C-1"}')).out).committee;
  assert.deepEqual([seen.status, seen.ballots.length, seen.seats.find((x: { role: string }) => x.role === 'macro').voted], ['Voting (sealed)', 0, true]);
  const opened = JSON.parse((await run('s', 'fund_ballot', JSON.stringify({ id: 'C-1', vote: 'HOLD', confidence: 55, argument: 'The curve says wait.', risks: ['Rally without us'] }))).out).committee;
  assert.equal(opened.status, 'Ballots open');
  assert.equal(opened.tally.lean, 'BUY');
  assert.equal((await run('c', 'fund_decide', '{"id":"C-1","vote":"HOLD","summary":"Macro is for it, the Skeptic would wait; we wait for supply."}')).code, 0);
  const memory = (role: string) => {
    const m = fund.desks.memory(role);
    return 'error' in m ? [] : m.decisions.map((d) => d.kind);
  };
  assert.deepEqual(memory('cio'), ['decided', 'called']);
  assert.deepEqual(memory('skeptic'), ['voted']);
  assert.match(fund.activity.list({ kind: 'committee' }).at(-1)!.text, /Decided C-1: HOLD \(against the ballots' BUY\)/);
  fund.stop();
});
