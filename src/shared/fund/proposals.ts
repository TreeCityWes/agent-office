// A trade proposal's way through the fund (see docs/fund.md#trade-proposals): which stage may follow
// which, what each is called, and checking what an agent submits.
import { cleanSymbol } from './assets.js';
import type { Actor, Asset, Proposal, ProposalInput, ProposalStage, Side } from './types.js';

/** Which stages may follow each. The office moves proposals only along these. */
const NEXT: Record<ProposalStage, readonly ProposalStage[]> = {
  idea: ['research', 'proposed', 'withdrawn', 'expired'],
  research: ['proposed', 'withdrawn', 'expired'],
  proposed: ['risk_review', 'withdrawn'],
  risk_review: ['cio_review', 'user_approval', 'rejected'],
  cio_review: ['user_approval', 'rejected', 'withdrawn', 'expired'],
  user_approval: ['executing', 'rejected', 'withdrawn', 'expired'],
  executing: ['monitoring', 'rejected', 'failed'],
  monitoring: ['exited'],
  exited: ['reviewed'],
  reviewed: [],
  rejected: [],
  withdrawn: [],
  expired: [],
  failed: [],
};

export const STAGE_LABEL: Record<ProposalStage, string> = {
  idea: 'Idea',
  research: 'Research',
  proposed: 'Proposed',
  risk_review: 'Risk review',
  cio_review: 'CIO review',
  user_approval: 'Awaiting approval',
  executing: 'Executing',
  monitoring: 'Monitoring',
  exited: 'Exited',
  reviewed: 'Reviewed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
  failed: 'Failed',
};

/** Stages a proposal is still going somewhere from. */
export const isLive = (stage: ProposalStage) => NEXT[stage].length > 0;
/** Waiting on someone to rule on it: the CIO or PM, or a person. */
export const isPending = (stage: ProposalStage) => stage === 'cio_review' || stage === 'user_approval';

export const canMove = (from: ProposalStage, to: ProposalStage) => NEXT[from].includes(to);

/** `p` moved on to `to` by `by`, or why it can't go there from where it is. */
export function moveProposal(p: Proposal, to: ProposalStage, by: Actor, now: number, note?: string): { proposal: Proposal } | { error: string } {
  if (!canMove(p.stage, to)) return { error: `A proposal that's ${STAGE_LABEL[p.stage].toLowerCase()} can't be ${STAGE_LABEL[to].toLowerCase()}` };
  return { proposal: { ...p, stage: to, updatedAt: now, history: [...p.history, { at: now, stage: to, by, ...(note ? { note } : {}) }] } };
}

const LIMITS = { thesis: 4000, catalyst: 600, evidence: 600, evidenceItems: 12, dissent: 1500, horizon: 24 };
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const positive = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * What an agent sent as a proposal, checked; or the first thing wrong with it. With `idea`, only
 * the asset, the direction and the thesis are needed: the rest comes once it's researched.
 */
export function checkProposalInput(raw: unknown, assets: ReadonlyMap<string, Asset>, opts: { idea?: boolean } = {}): { input: ProposalInput } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'A proposal is an object' };
  const r = raw as Record<string, unknown>;
  const symbol = cleanSymbol(r.symbol ?? r.asset);
  if (!symbol) return { error: 'Which asset? Give its symbol, like BTC or NVDA' };
  if (!assets.has(symbol)) return { error: `${symbol} isn't in the fund's universe (${[...assets.keys()].slice(0, 12).join(', ')}…)` };
  const dir = text(r.side ?? r.direction, 8).toLowerCase();
  const side: Side | undefined = dir === 'long' || dir === 'buy' ? 'long' : dir === 'short' || dir === 'sell' ? 'short' : undefined;
  if (!side) return { error: 'The direction is long or short' };
  const thesis = text(r.thesis, LIMITS.thesis);
  if (thesis.length < 20) return { error: 'The thesis is what makes this a trade: say it in a sentence or more' };
  const evidence = (Array.isArray(r.evidence) ? r.evidence : typeof r.evidence === 'string' ? [r.evidence] : []).map((e) => text(e, LIMITS.evidence)).filter(Boolean).slice(0, LIMITS.evidenceItems);
  const confidence = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.round(Math.min(100, Math.max(0, r.confidence))) : undefined;
  const horizon = text(r.horizon ?? r.timeframe, LIMITS.horizon);
  const sizeUsd = positive(r.sizeUsd ?? r.size);
  for (const k of ['entry', 'stop', 'target'] as const) if (r[k] !== undefined && positive(r[k]) === undefined) return { error: `${k} is a price above 0` };
  if (!opts.idea) {
    if (sizeUsd === undefined || sizeUsd > 1e12) return { error: 'How big? sizeUsd is the trade in US dollars' };
    if (confidence === undefined) return { error: 'confidence is 0 to 100: how sure are you?' };
    if (!horizon) return { error: 'horizon is how long it should be held: 3d, 2w, 3m…' };
    if (!evidence.length) return { error: 'evidence: at least one thing that supports it, with its source' };
  }
  const catalyst = text(r.catalyst, LIMITS.catalyst);
  const dissent = text(r.dissent ?? r.dissentingView, LIMITS.dissent);
  const strategyId = text(r.strategyId, 64).toUpperCase();
  return {
    input: {
      symbol,
      side,
      sizeUsd: sizeUsd ?? 0,
      ...(positive(r.entry) ? { entry: r.entry as number } : {}),
      ...(positive(r.stop) ? { stop: r.stop as number } : {}),
      ...(positive(r.target) ? { target: r.target as number } : {}),
      thesis,
      ...(catalyst ? { catalyst } : {}),
      confidence: confidence ?? 50,
      horizon: horizon || '—',
      evidence,
      ...(dissent ? { dissent } : {}),
      ...(strategyId ? { strategyId } : {}),
    },
  };
}
