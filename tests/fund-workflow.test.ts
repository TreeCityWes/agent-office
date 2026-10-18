import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deskRecord } from '../src/shared/fund/desks.js';
import { DESK_STATUSES } from '../src/shared/fund/roles.js';
import { fundOffice, PEOPLE, toolServer } from './fund-office.js';

// The whole trade workflow in one run (docs/fund.md#trade-proposals): every step an agent takes goes
// through office-fund, the command and MCP tools a Claude Code, Codex or OpenCode desk calls, and only
// the approval is a person's, from the 💼 Fund window.

const WORKFLOW = ['idea', 'research', 'proposed', 'risk_review', 'cio_review', 'user_approval', 'executing', 'monitoring', 'exited', 'reviewed'];

test('one trade through every stage: idea, research, proposal, risk review, CIO review, a person, paper fill, monitoring, exit and review', async (t) => {
  const { fund, dir, hire, as, workers, last, prices } = fundOffice({ prices: { BTC: 100_000 } });
  await fund.market.refreshAll();
  // Each desk is a worker in the office (an agent session; stand-ins here), staffed by a person.
  const desks: Record<string, [string, string]> = { c: ['Cleo', 'cio'], t: ['Tex', 'crypto-trader'], r: ['Rae', 'crypto-analyst'], k: ['Kim', 'portfolio-risk'], s: ['Sid', 'skeptic'] };
  for (const [id, [name, role]] of Object.entries(desks)) assert.ok('ok' in fund.desks.staff(hire(id, name), role, PEOPLE));
  const { server, run } = await toolServer(fund, workers, Object.fromEntries(Object.keys(desks).map((id) => [id, `${id}-token`])));
  t.after(() => {
    server.close();
    fund.stop();
  });
  const call = async (id: string, tool: string, args: object = {}) => {
    const r = await run(id, tool, JSON.stringify(args));
    assert.equal(r.code, 0, `${desks[id][0]}'s ${tool}: ${r.err}`);
    return JSON.parse(r.out);
  };
  const seen = new Set<string>();
  const status = async (id: string, s: string, note: string) => {
    await call(id, 'status', { status: s, note });
    assert.equal(fund.desks.profile(id)?.status, s);
    seen.add(s);
  };
  const stage = () => fund.proposals.get('P-1')!.stage;
  await status('k', 'idle', 'Nothing open to watch');
  await status('s', 'waiting', 'For something to argue with');

  // 1. Idea: the trader files one for research.
  await status('t', 'researching', 'BTC flows');
  assert.equal((await call('t', 'propose', { symbol: 'BTC', side: 'long', thesis: 'Spot ETF inflows are absorbing supply while funding stays flat.', idea: true })).proposal.stage, 'idea');

  // 2. Research: asked of the crypto analyst, who works it, writes down what it found and reports back.
  await call('t', 'message', { to: 'crypto-analyst', text: 'Can you check the flows and positioning behind P-1?', proposalId: 'P-1' });
  await fund.serial(() => {});
  assert.equal(stage(), 'research');
  assert.match(last('r'), /Fund message from Tex[\s\S]*P-1/);
  await status('r', 'analyzing', 'P-1: ETF flows against funding');
  await call('r', 'observe', { text: 'ETF inflows five days running; perp funding near flat', symbol: 'BTC' });
  await status('r', 'backtesting', 'Flow-led entries since 2024');
  await call('r', 'thesis', { thesis: 'Flows lead price while positioning is light.', confidence: 68, symbol: 'BTC' });
  await call('r', 'message', { to: 'crypto-trader', text: 'Flows check out for P-1 and positioning is light.', proposalId: 'P-1' });
  assert.match(last('t'), /Flows check out/);
  await status('r', 'finished', 'P-1 research done');

  // 3–4. Proposal and risk review: the trader asks the risk engine first (and the log has that it asked),
  // fills it in too big anyway, and the risk engine (code, not a model) resizes it to the 10% position
  // limit. With a CIO at a desk, it goes to the CIO next.
  await status('t', 'proposing', 'P-1');
  const asked = (await call('t', 'risk-check', { symbol: 'BTC', side: 'long', sizeUsd: 150_000, stop: 95_000 })).verdict;
  assert.deepEqual([asked.decision, asked.approvedUsd], ['resized', 100_000]);
  const checked = fund.activity.list({ kind: 'risk' }).at(-1)!;
  assert.equal(checked.actor.name, 'Tex');
  assert.match(checked.text, /^Asked the risk engine about long BTC \$150,000: it would be resized to \$100,000 \(/);
  const proposed = (await call('t', 'propose', { id: 'P-1', sizeUsd: 150_000, entry: 100_000, stop: 95_000, target: 110_000, confidence: 70, horizon: '2w', catalyst: 'Quarter-end ETF rebalancing', evidence: ['ETF inflows five days running', 'Funding near flat'], dissent: 'A macro shock would hit crypto first.' })).proposal;
  assert.equal(proposed.stage, 'cio_review');
  assert.equal(proposed.risk.decision, 'resized');
  assert.equal(proposed.risk.approvedUsd, 100_000);
  assert.ok(proposed.risk.checks.length >= 8, 'every limit was checked');

  // 5. CIO review. At 10% of NAV it's over the committee line (8%), so the CIO can't rule until an
  // investment committee has sat on it: ballots from each seat, the Skeptic always among them.
  await status('c', 'analyzing', 'P-1 is at CIO review');
  const refused = await run('c', 'rule', JSON.stringify({ id: 'P-1', decision: 'approve' }));
  assert.match(refused.err, /needs an investment committee's decision/);
  await status('t', 'waiting', 'P-1 at committee');
  const called = (await call('c', 'committee', { proposalId: 'P-1', seats: ['crypto-analyst', 'crypto-trader', 'portfolio-risk'] })).committee;
  assert.deepEqual(called.seats, ['crypto-analyst', 'crypto-trader', 'portfolio-risk', 'skeptic']);
  assert.match(last('s'), /You are the Skeptic/);
  await call('r', 'ballot', { id: called.id, vote: 'BUY', confidence: 70, argument: 'Flows lead price here.', evidence: ['ETF inflows'], risks: ['A macro shock'] });
  await call('t', 'ballot', { id: called.id, vote: 'BUY', confidence: 75, argument: 'Funding reset leaves room to run.', risks: ['Liquidation cascade'] });
  await call('k', 'ballot', { id: called.id, vote: 'HOLD', confidence: 55, argument: 'Fine at the resized 10%, no bigger.', risks: ['Crypto beta already in the book'] });
  await status('s', 'blocked', 'Needs the ballots open to answer them');
  const opened = (await call('s', 'ballot', { id: called.id, vote: 'SELL', confidence: 80, argument: 'Everyone is long the same flows story.', evidence: ['Crowded ETF inflow trade'], risks: ['A squeeze higher'] })).committee;
  assert.equal(fund.committees.get(called.id)!.status, 'open', 'the last ballot opens them');
  assert.deepEqual(opened.ballots.map((b: { role: string; vote: string }) => [b.role, b.vote]), [['crypto-analyst', 'BUY'], ['crypto-trader', 'BUY'], ['portfolio-risk', 'HOLD'], ['skeptic', 'SELL']]);
  await call('c', 'decide', { id: called.id, vote: 'BUY', summary: 'Two desks for, risk holding at the resized size, the Skeptic against on crowding: take it at 10%.' });
  const backed = (await call('c', 'rule', { id: 'P-1', decision: 'approve', note: 'Committee backed it at the resized size.' })).proposal;
  assert.equal(backed.stage, 'user_approval');
  assert.equal(backed.cio.by.name, 'Cleo');

  // 6. A person approves: no agent can (an agent's approve isn't one of its tools; the fund refuses it too).
  assert.match((await fund.approve('P-1', undefined, as('c')) as { error: string }).error, /Only a person/);
  const filled = await fund.approve('P-1', 'Go', PEOPLE);
  assert.ok('proposal' in filled, JSON.stringify(filled));

  // 7–8. Paper execution, then monitoring: the position is open at average cost, the history says so.
  assert.equal(stage(), 'monitoring');
  const pos = fund.portfolio().positions[0];
  assert.equal(pos.symbol, 'BTC');
  assert.ok(Math.abs(pos.qty * pos.avgCost - 100_000) < 1e-3, 'filled at the size risk allowed');
  await status('t', 'monitoring', 'P-1 is open');
  await status('k', 'monitoring', 'BTC at 10% of NAV');
  const open = await call('k', 'portfolio', { symbol: 'BTC' });
  assert.deepEqual(open.history.map((e: { action: string; reason: string }) => [e.action, e.reason]), [['open', 'entry']]);
  assert.ok(open.portfolio.unrealizedPnl < 0, 'down the slippage and fee at once');

  // 9. Exit: the target trades, and the fund exits on its own.
  prices.BTC = 111_000;
  await fund.market.refreshAll();
  await fund.serial(() => {});
  assert.equal(stage(), 'exited');
  assert.match(fund.proposals.get('P-1')!.history.at(-1)!.note ?? '', /Target 110,000.00 hit/);
  assert.equal(fund.portfolio().positions.length, 0);

  // 10. Review: the author's, on the record.
  await call('t', 'review', { id: 'P-1', thesisHeld: true, lessons: 'Flows led price, as the research said; the committee sized it right.' });
  await status('t', 'finished', 'P-1 reviewed');

  const p = fund.proposals.get('P-1')!;
  assert.deepEqual(p.history.map((h) => h.stage), WORKFLOW);
  // Who moved it at each stage: the trader, the risk engine, the CIO, the person, the office (the fill and the exit), the trader.
  assert.deepEqual(p.history.map((h) => h.by.name), ['Tex', 'Tex', 'Tex', 'Risk engine', 'Risk engine', 'Cleo', 'Wes', 'The office', 'The office', 'Tex']);
  assert.ok(p.pnl! > 9_000, `made about 10%: ${p.pnl}`);
  assert.deepEqual([...seen].sort(), [...DESK_STATUSES].sort(), 'every desk status was used');

  // The record of it all: the position history, the desk's track record and memory, and the activity log.
  const closed = await call('k', 'portfolio', { symbol: 'BTC' });
  assert.deepEqual(closed.history.map((e: { action: string; reason: string; proposalId: string }) => [e.action, e.reason, e.proposalId]), [['close', 'target', 'P-1'], ['open', 'entry', 'P-1']]);
  assert.ok(closed.history[0].realized > 9_000);
  assert.deepEqual(fund.state().positionHistory.map((e) => e.action), ['close', 'open']);
  const record = deskRecord(fund.proposals.list(), 'crypto-trader');
  assert.deepEqual([record.proposed, record.filled, record.closed, record.wins, record.losses], [1, 1, 1, 1, 0]);
  // Its history: the trade, with the confidence it was proposed with and what its review said, and how well that confidence foretold it.
  const [trade] = record.history;
  assert.deepEqual([record.history.length, trade.id, trade.symbol, trade.side, trade.thesisHeld, trade.at], [1, 'P-1', 'BTC', p.side, p.review!.thesisHeld, p.history.find((h) => h.stage === 'exited')!.at]);
  assert.equal(trade.pnl, p.pnl);
  assert.ok(trade.returnPct! > 9 && trade.returnPct! < 11, `about 10%: ${trade.returnPct}`);
  assert.equal(record.brier, (1 - p.confidence / 100) ** 2, 'a win: the gap between its confidence and certainty');
  const memory = fund.desks.memory('crypto-analyst');
  assert.ok(!('error' in memory));
  assert.equal(memory.theses[0].confidence, 68);
  assert.match(memory.observations[0].text, /ETF inflows/);
  assert.deepEqual(fund.desks.memory('cio').decisions.map((d) => d.kind).sort(), ['backed', 'called', 'decided']);
  const log = fund.activity.list({ proposalId: 'P-1', limit: 100 });
  const kinds = new Set(log.map((e) => e.kind));
  for (const k of ['proposal', 'message', 'risk', 'committee', 'ruling', 'fill', 'exit', 'review']) assert.ok(kinds.has(k as never), `the activity log has the ${k}`);
  assert.ok(log.some((e) => e.kind === 'ruling' && e.actor.name === 'Cleo' && /^Backed P-1/.test(e.text)));
  assert.ok(log.some((e) => e.kind === 'ruling' && e.actor.name === 'Wes' && /^Approved P-1/.test(e.text)));
  // Every journal it wrote is hash-chained.
  const ledger = readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(ledger.every((e) => typeof e.hash === 'string' && 'prev' in e));
});

test('an idea moves to research when it is assigned to a desk or asked of a research or quant desk, and not otherwise', async () => {
  const { fund, hire, as } = fundOffice();
  await fund.market.refreshAll();
  fund.desks.staff(hire('c', 'Cleo'), 'cio', PEOPLE);
  fund.desks.staff(hire('t', 'Tex'), 'crypto-trader', PEOPLE);
  fund.desks.staff(hire('q', 'Quinn'), 'quant', PEOPLE);
  const idea = { symbol: 'BTC', side: 'long', thesis: 'Basis is wide enough to pay for the carry.' };
  for (let i = 0; i < 3; i++) assert.ok('proposal' in (await fund.propose(idea, as('t'), { idea: true })));
  const stageOf = async (id: string) => (await fund.serial(() => {}), fund.proposals.get(id)!.stage);
  // Telling the CIO about it is just a message.
  assert.ok('ok' in fund.desks.message(as('t'), { to: 'cio', text: 'Heads up on P-1.', proposalId: 'P-1' }));
  assert.equal(await stageOf('P-1'), 'idea');
  // Asking the quant lab is a research request.
  assert.ok('ok' in fund.desks.message(as('t'), { to: 'quant', text: 'Is the basis signal any good for P-2?', proposalId: 'P-2' }));
  assert.equal(await stageOf('P-2'), 'research');
  // The CIO assigning it, to any desk, is too.
  assert.ok('ok' in fund.desks.message(as('c'), { to: 'crypto-trader', text: 'Work P-3 up properly.', proposalId: 'P-3' }, 'assignment'));
  assert.equal(await stageOf('P-3'), 'research');
  assert.deepEqual(fund.proposals.get('P-3')!.history.map((h) => [h.stage, h.by.name, h.note]), [['idea', 'Tex', undefined], ['research', 'Cleo', 'assigned to the Crypto Trader']]);
  // Research doesn't send it back, and a proposal past research stays where it is.
  fund.desks.message(as('t'), { to: 'quant', text: 'More on P-2?', proposalId: 'P-2' });
  assert.equal(await stageOf('P-2'), 'research');
  fund.stop();
});
