// The investment committee (docs/fund.md#the-investment-committee): the CIO or PM, or a person, puts a
// question to a few desks, each casts a sealed BUY / HOLD / SELL ballot with its confidence, argument,
// evidence and risks, the Skeptic always among them; then the ballots are opened and the chair decides.
// Pure: the server keeps committees (server/fund/committee.ts), and the 💼 Fund window shows them.
import { ROLE_BY_ID } from './roles.js';
import type { Actor, Side } from './types.js';

export type Vote = 'BUY' | 'HOLD' | 'SELL';
export const VOTES: readonly Vote[] = ['BUY', 'HOLD', 'SELL'];

/**
 * - voting: ballots sealed, each seat sees only its own
 * - open: every seat voted, or time ran out; ballots are open, seats may revise, the chair decides
 * - decided: the chair's decision and summary are on the record
 * - lapsed: nobody decided in time; the ballots stand as they were
 */
export type CommitteeStatus = 'voting' | 'open' | 'decided' | 'lapsed';

export interface Ballot {
  role: string;
  by: Actor;
  vote: Vote;
  /** 0–100. */
  confidence: number;
  argument: string;
  evidence: string[];
  risks: string[];
  at: number;
  /** Changed after the ballots were opened. */
  revised?: boolean;
}

export interface CommitteeDecision {
  vote: Vote;
  summary: string;
  by: Actor;
  at: number;
}

export interface Committee {
  /** C-1, C-2… */
  id: string;
  question: string;
  proposalId?: string;
  symbol?: string;
  calledBy: Actor;
  /** The role that chairs and decides (the CIO or PM who called it), or none when a person did: then people decide. */
  chair?: string;
  /** The roles at the table, the Skeptic always among them. */
  seats: string[];
  status: CommitteeStatus;
  /** Each seat's latest ballot. */
  ballots: Ballot[];
  openedAt: number;
  /** When voting closes, and then when the chair's decision is due. */
  closesAt: number;
  decideBy?: number;
  decision?: CommitteeDecision;
  updatedAt: number;
}

export interface Tally {
  BUY: number;
  HOLD: number;
  SELL: number;
  /** -100 (everyone sure it's a SELL) to 100 (everyone sure it's a BUY): each ballot counts by its confidence, HOLD as 0. */
  score: number;
  /** The vote with the most confidence behind it; HOLD on a tie or when nobody voted. */
  lean: Vote;
  /** Seats that cast no ballot. */
  abstained: string[];
  /** Seats whose ballot went against the lean. */
  dissent: string[];
}

export const COMMITTEE_STATUS_LABEL: Record<CommitteeStatus, string> = { voting: 'Voting (sealed)', open: 'Ballots open', decided: 'Decided', lapsed: 'Lapsed' };
export const MIN_SEATS = 2;
export const MAX_SEATS = 9;
export const DEFAULT_MINUTES = 15;

const SIGN: Record<Vote, number> = { BUY: 1, HOLD: 0, SELL: -1 };

export function tally(c: Pick<Committee, 'seats' | 'ballots'>): Tally {
  const t: Tally = { BUY: 0, HOLD: 0, SELL: 0, score: 0, lean: 'HOLD', abstained: [], dissent: [] };
  const weight: Record<Vote, number> = { BUY: 0, HOLD: 0, SELL: 0 };
  for (const b of c.ballots) {
    t[b.vote]++;
    weight[b.vote] += b.confidence;
    t.score += SIGN[b.vote] * b.confidence;
  }
  t.score = c.ballots.length ? Math.round(t.score / c.ballots.length) : 0;
  const top = Math.max(weight.BUY, weight.HOLD, weight.SELL);
  const leaders = VOTES.filter((v) => weight[v] === top);
  t.lean = c.ballots.length && leaders.length === 1 ? leaders[0] : 'HOLD';
  t.abstained = c.seats.filter((s) => !c.ballots.some((b) => b.role === s));
  t.dissent = c.ballots.filter((b) => b.vote !== t.lean).map((b) => b.role);
  return t;
}

/** The vote that backs a trade on that side: BUY for a long, SELL for a short. */
export const voteFor = (side: Side): Vote => (side === 'long' ? 'BUY' : 'SELL');

export function checkVote(v: unknown): Vote | undefined {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'BUY' || s === 'LONG') return 'BUY';
  if (s === 'SELL' || s === 'SHORT') return 'SELL';
  if (s === 'HOLD' || s === 'PASS' || s === 'ABSTAIN') return 'HOLD';
  return undefined;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const lines = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((x) => text(x, max)).filter(Boolean).slice(0, n);

/** A ballot as an agent sent it: its vote, confidence (0–100, or 0–1), argument, evidence and risks. */
export function checkBallot(raw: unknown): Pick<Ballot, 'vote' | 'confidence' | 'argument' | 'evidence' | 'risks'> | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Send your ballot: id, vote (BUY, HOLD or SELL), confidence, argument, evidence, risks' };
  const r = raw as Record<string, unknown>;
  const vote = checkVote(r.vote);
  if (!vote) return { error: 'vote: BUY, HOLD or SELL' };
  let confidence = Number(r.confidence);
  if (!Number.isFinite(confidence)) return { error: 'confidence: how sure you are, 0 to 100' };
  if (confidence > 0 && confidence <= 1 && !Number.isInteger(confidence)) confidence *= 100;
  confidence = Math.round(Math.min(100, Math.max(0, confidence)));
  const argument = text(r.argument ?? r.reason, 2000);
  if (argument.length < 10) return { error: 'argument: why you vote the way you do, in a few sentences' };
  const evidence = lines(r.evidence, 10, 300);
  const risks = lines(r.risks ?? r.risk, 10, 300);
  if (!risks.length) return { error: 'risks: at least one thing that would make your vote wrong' };
  return { vote, confidence, argument, evidence, risks };
}

/** What calling a committee takes: the question, and optionally a proposal, a symbol, the seats and how long voting lasts. */
export function checkConvene(raw: unknown): { question: string; proposalId?: string; symbol?: string; seats?: string[]; minutes: number } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Send the question, and optionally proposalId, symbol, seats (roles) and minutes' };
  const r = raw as Record<string, unknown>;
  const proposalId = text(r.proposalId ?? r.proposal, 20).toUpperCase() || undefined;
  const question = text(r.question, 500) || (proposalId ? `Should the fund take ${proposalId}?` : '');
  if (question.length < 5) return { error: 'question: what the committee is to decide' };
  const symbol = text(r.symbol, 20).toUpperCase() || undefined;
  let seats: string[] | undefined;
  if (r.seats !== undefined) {
    const raw = Array.isArray(r.seats) ? r.seats : String(r.seats).split(/[\s,]+/);
    seats = [...new Set(raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
    const unknown = seats.filter((s) => !ROLE_BY_ID.has(s));
    if (unknown.length) return { error: `seats are role ids (cio, macro, quant, skeptic…): no role ${unknown.join(', ')}` };
  }
  const m = r.minutes === undefined ? DEFAULT_MINUTES : Number(r.minutes);
  if (!Number.isFinite(m) || m < 1 || m > 240) return { error: 'minutes: how long voting stays open, 1 to 240' };
  return { question, proposalId, symbol, seats, minutes: Math.round(m) };
}

export function checkDecision(raw: unknown): { vote: Vote; summary: string } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Send id, vote (BUY, HOLD or SELL) and summary' };
  const r = raw as Record<string, unknown>;
  const vote = checkVote(r.vote ?? r.decision);
  if (!vote) return { error: 'vote: BUY, HOLD or SELL' };
  const summary = text(r.summary ?? r.note, 2000);
  if (summary.length < 10) return { error: 'summary: what the committee found and why you decide this way, including the dissent' };
  return { vote, summary };
}
