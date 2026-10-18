import test from 'node:test';
import assert from 'node:assert/strict';
import { assetTable } from '../src/shared/fund/assets.js';
import { canMove, checkProposalInput, isLive, moveProposal } from '../src/shared/fund/proposals.js';
import { DEPARTMENTS, ROLES, ROLE_BY_ID, roleBrief } from '../src/shared/fund/roles.js';
import type { Proposal } from '../src/shared/fund/types.js';

const assets = assetTable();
const agent = { kind: 'agent', id: 'w1', name: 'Ada', role: 'macro' } as const;
const good = { symbol: 'btc', side: 'buy', sizeUsd: 25_000, stop: 90_000, target: 120_000, thesis: 'Liquidity is turning and ETF flows are back.', confidence: 72.4, horizon: '3w', evidence: ['ETF inflows 5 days running (Farside)'] };

test('a proposal is checked and tidied: symbols upper-cased, buy/sell read as long/short, confidence rounded', () => {
  const r = checkProposalInput(good, assets);
  assert.ok('input' in r);
  assert.equal(r.input.symbol, 'BTC');
  assert.equal(r.input.side, 'long');
  assert.equal(r.input.confidence, 72);
  assert.deepEqual(r.input.evidence, ['ETF inflows 5 days running (Farside)']);
});

test('what a proposal needs, each with a reason an agent can act on', () => {
  const bad = (over: Record<string, unknown>) => {
    const r = checkProposalInput({ ...good, ...over }, assets);
    assert.ok('error' in r, JSON.stringify(over));
    return r.error;
  };
  assert.match(bad({ symbol: 'DOGWIFHAT' }), /isn't in the fund's universe/);
  assert.match(bad({ symbol: '' }), /Which asset/);
  assert.match(bad({ side: 'up' }), /long or short/);
  assert.match(bad({ thesis: 'moon' }), /thesis/);
  assert.match(bad({ sizeUsd: -5 }), /sizeUsd/);
  assert.match(bad({ confidence: 'high' }), /confidence/);
  assert.match(bad({ horizon: '' }), /horizon/);
  assert.match(bad({ evidence: [] }), /evidence/);
  assert.match(bad({ stop: 0 }), /stop is a price/);
});

test('an idea needs only the asset, the direction and the thesis', () => {
  const r = checkProposalInput({ symbol: 'ETH', side: 'short', thesis: 'Staking yield compresses as supply unlocks.' }, assets, { idea: true });
  assert.ok('input' in r);
  assert.equal(r.input.sizeUsd, 0);
});

test('proposals move only along the workflow, each move recorded with who and when', () => {
  assert.ok(canMove('proposed', 'risk_review'));
  assert.ok(canMove('risk_review', 'cio_review'));
  assert.ok(canMove('user_approval', 'executing'));
  assert.ok(!canMove('proposed', 'executing'), 'nothing skips risk review');
  assert.ok(!canMove('cio_review', 'executing'), 'nothing skips approval');
  assert.ok(!canMove('rejected', 'user_approval'));
  assert.ok(!isLive('reviewed') && isLive('monitoring'));
  const p = { id: 'p1', stage: 'proposed', history: [], updatedAt: 0 } as unknown as Proposal;
  const r = moveProposal(p, 'risk_review', agent, 5, 'checked');
  assert.ok('proposal' in r);
  assert.equal(r.proposal.stage, 'risk_review');
  assert.deepEqual(r.proposal.history, [{ at: 5, stage: 'risk_review', by: agent, note: 'checked' }]);
  assert.ok('error' in moveProposal(p, 'monitoring', agent, 5));
});

test('the org chart: every role is in a department, ids are unique, only the CIO and PM rule and call committees', () => {
  assert.equal(ROLE_BY_ID.size, ROLES.length);
  for (const r of ROLES) assert.ok(r.department in DEPARTMENTS, r.id);
  assert.deepEqual(ROLES.filter((r) => r.can.includes('rule')).map((r) => r.id), ['cio', 'pm']);
  assert.deepEqual(ROLES.filter((r) => r.can.includes('committee')).map((r) => r.id), ['cio', 'pm']);
  assert.deepEqual(ROLE_BY_ID.get('skeptic')!.can, []);
  for (const d of Object.keys(DEPARTMENTS)) assert.ok(ROLES.some((r) => r.department === d), d);
  const brief = roleBrief(ROLE_BY_ID.get('macro')!, 'agents/macro');
  assert.match(brief, /PAPER only/);
  assert.match(brief, /Macro Analyst \(Research\)/);
  assert.match(brief, /agents\/macro/);
});
