import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkStatus, checkThesis, deskRecord, findRole, fundToolsFor } from '../src/shared/fund/desks.js';
import { ROLE_BY_ID } from '../src/shared/fund/roles.js';
import { handleMcp } from '../bin/office-workers.js';
import { main as officeFund } from '../bin/office-fund.js';
import { fundOffice, PEOPLE, toolServer, trade, wait } from './fund-office.js';

test('what the desk tools take: statuses, theses, roles, and the tools each role gets', () => {
  assert.deepEqual(checkStatus({ status: 'Proposing trade', note: 'BTC long' }), { status: 'proposing', note: 'BTC long' });
  assert.match((checkStatus({ status: 'napping' }) as { error: string }).error, /idle, researching/);
  assert.equal((checkThesis({ thesis: 'Risk-on', confidence: 0.7 }) as { confidence: number }).confidence, 70);
  assert.equal((checkThesis({ thesis: 'Risk-on', confidence: 140 }) as { confidence: number }).confidence, 100);
  assert.equal(findRole('the Macro Analyst')?.id, 'macro');
  assert.equal(findRole('crypto analyst')?.id, 'crypto-analyst');
  assert.equal(findRole('janitor'), undefined);
  // The Skeptic reads and talks, but never proposes; the CIO rules and assigns.
  const skeptic = fundToolsFor(ROLE_BY_ID.get('skeptic'));
  assert.ok(skeptic.includes('fund_message') && skeptic.includes('fund_observe'));
  assert.ok(!skeptic.includes('fund_propose') && !skeptic.includes('fund_rule'));
  assert.ok(fundToolsFor(ROLE_BY_ID.get('cio')).includes('fund_rule'));
  assert.ok(fundToolsFor(ROLE_BY_ID.get('cio')).includes('fund_assign'));
  assert.deepEqual(fundToolsFor(undefined).filter((t) => t === 'fund_status' || t === 'fund_propose'), [], 'without a role, a worker only looks');
});

test('a desk is staffed by a real worker: one per role, its sign up, its memory kept after it goes', async () => {
  const { fund, dir, signs, hire, as, workers } = fundOffice();
  const ada = hire('w1', 'Ada');
  const r = fund.desks.staff(ada, 'macro', PEOPLE);
  assert.ok('ok' in r);
  assert.match(r.brief, /Macro Analyst/);
  assert.ok(r.brief.includes(path.join(dir, 'agents', 'macro')), 'the brief says where its memory is');
  assert.equal(signs.get('w1'), '🔎 Macro Analyst');
  assert.deepEqual(as('w1'), { kind: 'agent', id: 'w1', name: 'Ada', role: 'macro' });
  const bo = hire('w2', 'Bo');
  assert.match((fund.desks.staff(bo, 'macro', PEOPLE) as { error: string }).error, /Ada is already the Macro Analyst/);
  assert.match((fund.desks.staff(ada, 'quant', PEOPLE) as { error: string }).error, /already the Macro Analyst/);

  // What it says it's doing goes in the log only when it changes.
  assert.ok('ok' in fund.desks.setStatus(as('w1'), { status: 'researching', note: 'CPI print' }));
  fund.desks.setStatus(as('w1'), { status: 'researching', note: 'CPI print, again' });
  assert.equal(fund.activity.list({ kind: 'status' }).length, 1);
  assert.equal(fund.state().desks.desks[0].note, 'CPI print, again');

  assert.ok('ok' in fund.desks.thesis(as('w1'), { thesis: 'Disinflation keeps risk-on alive.', confidence: 65 }));
  fund.desks.thesis(as('w1'), { thesis: 'Sticky services inflation: fade the rally.', confidence: 40, why: 'Core services ran hot' });
  assert.match(readFileSync(path.join(dir, 'agents', 'macro', 'thesis.md'), 'utf8'), /Sticky services[\s\S]*Confidence: 40%[\s\S]*Core services ran hot/);
  assert.match(fund.activity.list({ kind: 'thesis' }).at(-1)!.text, /\(40%, was 65%\)/);
  fund.desks.observe(as('w1'), { text: 'Core services +0.5% m/m', sources: ['https://bls.gov'], symbol: 'spy' });
  const mem = fund.desks.memory('macro');
  assert.ok(!('error' in mem));
  assert.equal(mem.thesis, 'Sticky services inflation: fade the rally.');
  assert.equal(mem.theses.length, 2);
  assert.equal(mem.observations[0].symbol, 'SPY');

  // Gone home: it stops counting, and the next Macro Analyst starts from what it believed.
  workers.delete('w1');
  assert.equal(fund.desks.profile('w1'), undefined);
  assert.equal(fund.state().desks.desks.length, 0);
  assert.ok('ok' in fund.desks.staff(bo, 'macro', PEOPLE));
  assert.equal(fund.desks.profile('w2')?.thesis, 'Sticky services inflation: fade the rally.');
  assert.equal(fund.desks.profile('w2')?.confidence, 40);
  assert.ok('ok' in fund.desks.release('w2', PEOPLE));
  assert.equal(signs.has('w2'), false, 'its sign comes down');
  assert.ok(existsSync(path.join(dir, 'agents', 'macro', 'observations.jsonl')), 'the role keeps its memory');
  fund.stop();
});

test('desks message each other, the CIO assigns, and an escalation reaches everyone', async () => {
  const { fund, told, toasts, hire, as } = fundOffice();
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('m', 'Max'), 'macro', PEOPLE);
  fund.desks.staff(hire('s', 'Sid'), 'skeptic', PEOPLE);

  const sent = fund.desks.message(as('m'), { to: 'skeptic', text: 'Tear apart my risk-on view.' });
  assert.ok('ok' in sent && sent.delivered);
  assert.equal(told.at(-1)!.id, 's');
  assert.match(told.at(-1)!.text, /Fund message from Max \(Macro Analyst\)[\s\S]*fund_message to "macro"/);
  assert.equal((fund.desks.inbox(as('s')) as { messages: unknown[] }).messages.length, 1);
  assert.match((fund.desks.message(as('m'), { to: 'Sid', text: 'By name works too' }) as { message: { to: string } }).message.to, /skeptic/);
  assert.match((fund.desks.message(as('m'), { to: 'quant', text: 'Anyone there?' }) as { error: string }).error, /Nobody holds the Quant Researcher desk/);
  assert.match((fund.desks.message(as('m'), { to: 'macro', text: 'Hello me' }) as { error: string }).error, /your own desk/);

  // Assigning is the CIO's (and PM's, and CRO's), not an analyst's.
  assert.match((fund.desks.message(as('m'), { to: 'skeptic', text: 'Do this' }, 'assignment') as { error: string }).error, /doesn't assign work/);
  assert.ok('ok' in fund.desks.message(as('c'), { to: 'macro', text: 'Size the rates risk into CPI', proposalId: 'p-3' }, 'assignment'));
  assert.equal(fund.desks.profile('m')?.assignment?.text, 'Size the rates risk into CPI');
  assert.match(told.at(-1)!.text, /New assignment from Cleo \(Chief Investment Officer\) about P-3/);
  // A worker with no role can't use a desk's tools.
  assert.match((fund.desks.setStatus({ kind: 'agent', id: 'x', name: 'Nobody' }, { status: 'idle' }) as { error: string }).error, /hold no desk/);

  fund.desks.escalate(as('s'), { text: 'Funding at extremes: every desk is long.' });
  assert.match(toasts.at(-1)!, /Sid \(Skeptic\): Funding at extremes/);
  assert.equal(told.at(-1)!.id, 'c', 'the CIO hears it too');
  assert.equal(fund.activity.list({ kind: 'escalation' })[0].level, 'warn');
  assert.deepEqual(fund.state().desks.messages.map((m) => m.kind), ['escalation', 'assignment', 'message', 'message']);
  fund.stop();
});

test('with a CIO at a desk, proposals go to it first; the author hears what came of its trade', async () => {
  const { fund, told, toasts, hire, as } = fundOffice();
  await fund.market.refreshAll();
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('t', 'Tex'), 'crypto-trader', PEOPLE);
  fund.desks.staff(hire('s', 'Sid'), 'skeptic', PEOPLE);
  assert.match(((await fund.propose(trade, as('s'))) as { error: string }).error, /A Skeptic doesn't propose trades/);

  const r = await fund.propose(trade, as('t'));
  assert.ok('proposal' in r);
  assert.equal(r.proposal.stage, 'cio_review');
  assert.equal(r.proposal.author.role, 'crypto-trader');
  await wait(1700);
  const asked = told.filter((t) => t.id === 'c').at(-1);
  assert.match(asked!.text, /P-1 \(long BTC\).*passed risk and waits on your ruling/);

  assert.match(((await fund.rule('P-1', 'approve', 'Fits the house view', as('t'))) as { error: string }).error, /A Crypto Trader doesn't rule/);
  const backed = await fund.rule('P-1', 'approve', 'Fits the house view', as('c'));
  assert.ok('proposal' in backed && backed.proposal.stage === 'user_approval');
  await wait(1700);
  assert.match(told.filter((t) => t.id === 't').at(-1)!.text, /News on your P-1[\s\S]*Cleo \(Chief Investment Officer\): Backed P-1/);
  assert.match(toasts.at(-1)!, /P-1 \(long BTC\) from Tex \(Crypto Trader\) waits on a person/);

  // Only a person approves; then the author hears it filled, and the role's record has it.
  assert.match(((await fund.approve('P-1', undefined, as('c'))) as { error: string }).error, /Only a person/);
  assert.ok('proposal' in (await fund.approve('P-1', 'Go', PEOPLE)));
  await wait(1700);
  assert.match(told.filter((t) => t.id === 't').at(-1)!.text, /Approved P-1[\s\S]*It’s open/);
  assert.deepEqual({ ...deskRecord(fund.proposals.list(), 'crypto-trader') }, { proposed: 1, filled: 1, rejected: 0, open: 1, closed: 0, wins: 0, losses: 0, realizedPnl: 0 });
  fund.stop();
});

test('the desks carry on when the fund starts over', async () => {
  const { fund, hire } = fundOffice();
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  assert.ok('ok' in (await fund.reset(PEOPLE)));
  assert.equal(fund.desks.profile('c')?.role, 'cio');
  assert.equal(fund.state().desks.desks.length, 1);
  fund.stop();
});

test('an agent reaches the fund through office-fund and the agent-office MCP server, as itself', async (t) => {
  const { fund, hire, workers } = fundOffice();
  await fund.market.refreshAll();
  const cleo = hire('c', 'Cleo');
  hire('m', 'Max');
  fund.desks.staff(cleo, 'cio', PEOPLE);
  const { server, env, run } = await toolServer(fund, workers, { c: 'cleo-token', m: 'max-token' });
  t.after(() => server.close());

  // The CIO's MCP server lists its role's tools; Max holds no desk, so his lists none of the fund's.
  const listed = async (id: string) => ((await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { env: env(id), fetch })).result.tools as { name: string }[]).map((x) => x.name);
  const cio = await listed('c');
  assert.ok(cio.includes('list_workers') && cio.includes('fund_rule') && cio.includes('fund_assign') && cio.includes('fund_committee') && cio.includes('fund_decide'));
  assert.deepEqual((await listed('m')).filter((n) => n.startsWith('fund_')), []);

  const status = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fund_status', arguments: { status: 'analyzing', note: 'Reading the tape' } } }, { env: env('c'), fetch });
  assert.equal(status.result.isError, undefined);
  assert.equal(fund.desks.profile('c')?.status, 'analyzing');
  const book = await run('c', 'portfolio');
  assert.equal(book.code, 0);
  assert.equal(JSON.parse(book.out).portfolio.nav, 1_000_000);
  const quotes = JSON.parse((await run('m', 'quotes', '{"symbols":["BTC","NOPE"]}')).out);
  assert.equal(quotes.quotes[0].price, 100_000);
  assert.deepEqual(quotes.missing, ['NOPE']);

  // Max, with no desk, can look but not act; the fund itself says why.
  const refused = await run('m', 'propose', JSON.stringify(trade));
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Only a desk with a fund role may propose trades/);
  const proposed = await run('c', 'fund_propose', JSON.stringify(trade));
  assert.equal(JSON.parse(proposed.out).proposal.stage, 'user_approval', 'the CIO proposing goes straight to a person: it can’t rule on its own');
  const mine = fund.desks.memory('cio');
  assert.ok(!('error' in mine) && mine.decisions[0].kind === 'proposed');
  assert.match((await run('c', 'rule', '{"id":"P-1","decision":"approve"}')).err, /only a proposal at CIO review is ruled on/);
  assert.match((await run('m', 'portfolio')).out, /"paper": true/);
  const wrong = await officeFund(['portfolio'], { env: { ...env('m'), AGENT_OFFICE_HOOK_TOKEN: 'nope' }, out: () => {}, err: (s: string) => assert.match(s, /didn't accept this worker's token/) });
  assert.equal(wrong, 1);
  fund.stop();
});
