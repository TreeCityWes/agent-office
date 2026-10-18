// The fund's desks: the agents holding its roles, what they say they're doing, what they remember, the
// messages between them, and each role's track record (see docs/fund.md#agents-roles-and-departments).
// Pure: the server keeps them (server/fund/desks.ts), and the 💼 Fund window shows them.
import type { AgentProvider } from '../providers.js';
import type { WorkerStatus } from '../protocol/workers.js';
import { DEPARTMENTS, DESK_STATUSES, ROLE_BY_ID, ROLES, type DeskProfile, type DeskStatus, type Permission, type RoleDef } from './roles.js';
import type { Actor, Proposal } from './types.js';
import type { ResearchRequest, Routine } from './work.js';

/** A desk as the window shows it: its profile, the worker at it, and how its role's calls have done. */
export interface DeskView extends DeskProfile {
  name: string;
  floorId: string;
  floorName: string;
  deskId: string;
  provider?: AgentProvider;
  model?: string;
  /** What its process is doing: working, waiting on someone, stopped… */
  process: WorkerStatus;
}

export type MessageKind = 'message' | 'assignment' | 'escalation' | 'committee' | 'request' | 'routine';

/** A message between desks, or from a person to one, kept in messages.jsonl and typed into the agent it's for. */
export interface FundMessage {
  id: string;
  at: number;
  kind: MessageKind;
  from: Actor;
  /** A role it went to, or `people` for an escalation. */
  to: string;
  text: string;
  proposalId?: string;
}

/** Everything the window knows about the desks. */
export interface DesksState {
  desks: DeskView[];
  /** Each role's record, held or not. */
  records: Record<string, DeskRecord>;
  /** The latest messages, newest first. */
  messages: FundMessage[];
  /** Every open research request, then the latest answered or withdrawn. */
  requests: ResearchRequest[];
  routines: Routine[];
}

// ---- Memory ------------------------------------------------------------------------------------

export interface ThesisEntry {
  at: number;
  by: Actor;
  thesis: string;
  confidence?: number;
  why?: string;
}

export interface Observation {
  at: number;
  by: Actor;
  text: string;
  sources?: string[];
  symbol?: string;
  proposalId?: string;
}

export type DecisionKind = 'proposed' | 'idea' | 'backed' | 'turned down' | 'withdrew' | 'reviewed' | 'called' | 'voted' | 'decided' | 'strategy' | 'backtested';

export interface Decision {
  at: number;
  by: Actor;
  kind: DecisionKind;
  proposalId?: string;
  text: string;
}

/** A role's memory: what whoever held it believed, noticed and decided, and how its calls did. */
export interface DeskMemory {
  role: string;
  thesis?: string;
  theses: ThesisEntry[];
  observations: Observation[];
  decisions: Decision[];
  record: DeskRecord;
}

// ---- Track record ------------------------------------------------------------------------------

export interface DeskRecord {
  proposed: number;
  /** Got past risk, the CIO and a person, and filled. */
  filled: number;
  rejected: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  /** Realized, fees included, on what's closed. */
  realizedPnl: number;
  /** The average closed trade's return on what it put on, in %. */
  avgReturnPct?: number;
}

const OPEN_STAGES: readonly string[] = ['executing', 'monitoring'];
const CLOSED_STAGES: readonly string[] = ['exited', 'reviewed'];

/** How the proposals made by whoever held `role` have done. */
export function deskRecord(proposals: readonly Proposal[], role: string): DeskRecord {
  const r: DeskRecord = { proposed: 0, filled: 0, rejected: 0, open: 0, closed: 0, wins: 0, losses: 0, realizedPnl: 0 };
  const returns: number[] = [];
  for (const p of proposals) {
    if (p.author.role !== role || p.stage === 'idea' || p.stage === 'research') continue;
    r.proposed++;
    if (p.entryFill) r.filled++;
    if (p.stage === 'rejected') r.rejected++;
    if (OPEN_STAGES.includes(p.stage)) r.open++;
    if (CLOSED_STAGES.includes(p.stage) && p.pnl !== undefined) {
      r.closed++;
      r.realizedPnl += p.pnl;
      if (p.pnl > 0) r.wins++;
      else r.losses++;
      const put = (p.qty ?? 0) * (p.entryPrice ?? 0);
      if (put > 0) returns.push((p.pnl / put) * 100);
    }
  }
  if (returns.length) r.avgReturnPct = returns.reduce((a, b) => a + b, 0) / returns.length;
  return r;
}

export const winRate = (r: DeskRecord): number | undefined => (r.closed ? (r.wins / r.closed) * 100 : undefined);

/** The sign over a desk holding `role`: "🔎 Macro Analyst". */
export const deskSign = (role: RoleDef) => `${DEPARTMENTS[role.department].icon} ${role.title}`;

/** Who someone is, in a log line or a message: "Ada (Macro Analyst)". */
export const deskName = (a: Actor) => (a.role && ROLE_BY_ID.get(a.role) ? `${a.name} (${ROLE_BY_ID.get(a.role)!.title})` : a.name);

// ---- What the tools take -----------------------------------------------------------------------

type Raw = Record<string, unknown>;
const obj = (raw: unknown): Raw => (raw && typeof raw === 'object' ? (raw as Raw) : {});
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const confidenceOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v <= 1 && v > 0 ? v * 100 : v))) : undefined);
const proposalIdOf = (v: unknown) => (typeof v === 'string' && /^P-\d+$/i.test(v.trim()) ? v.trim().toUpperCase() : undefined);
const symbolOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9.\-]{1,15}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined);

export function checkStatus(raw: unknown): { status: DeskStatus; note?: string } | { error: string } {
  const r = obj(raw);
  const status = String(r.status ?? '').toLowerCase().replace(/ trade$/, '') as DeskStatus;
  if (!DESK_STATUSES.includes(status)) return { error: `status is one of ${DESK_STATUSES.join(', ')}` };
  const note = text(r.note ?? r.doing, 200);
  return { status, ...(note ? { note } : {}) };
}

export function checkThesis(raw: unknown): { thesis: string; confidence?: number; why?: string } | { error: string } {
  const r = obj(raw);
  const thesis = text(r.thesis, 4000);
  if (!thesis) return { error: 'Say what your thesis is: thesis' };
  const confidence = confidenceOf(r.confidence);
  const why = text(r.why ?? r.reason, 1000);
  return { thesis, ...(confidence !== undefined ? { confidence } : {}), ...(why ? { why } : {}) };
}

export function checkObservation(raw: unknown): Omit<Observation, 'at' | 'by'> | { error: string } {
  const r = obj(raw);
  const said = text(r.text ?? r.observation, 2000);
  if (!said) return { error: 'Say what you noticed: text' };
  const sources = (Array.isArray(r.sources) ? r.sources : typeof r.sources === 'string' ? [r.sources] : []).map((s) => text(s, 300)).filter(Boolean).slice(0, 10);
  const symbol = symbolOf(r.symbol);
  const proposalId = proposalIdOf(r.proposalId ?? r.proposal);
  return { text: said, ...(sources.length ? { sources } : {}), ...(symbol ? { symbol } : {}), ...(proposalId ? { proposalId } : {}) };
}

export function checkMessage(raw: unknown): { to: string; text: string; proposalId?: string } | { error: string } {
  const r = obj(raw);
  const to = text(r.to, 64);
  if (!to) return { error: 'Who is it for? to: a role (macro, cio…) or a worker’s name' };
  const said = text(r.text ?? r.message ?? r.task, 8000);
  if (!said) return { error: 'Say something: text' };
  const proposalId = proposalIdOf(r.proposalId ?? r.proposal);
  return { to, text: said, ...(proposalId ? { proposalId } : {}) };
}

/** The role `key` names: its id (macro), its title (Macro Analyst), or near enough (the macro analyst). */
export function findRole(key: string): RoleDef | undefined {
  const k = key.trim().toLowerCase().replace(/^the\s+/, '');
  return ROLE_BY_ID.get(k) ?? ROLES.find((r) => r.title.toLowerCase() === k) ?? ROLES.find((r) => r.id === k.replace(/\s+/g, '-'));
}

/**
 * The fund tools a desk may call. Everyone with a role reads the book, the market, the proposals,
 * the desks and anyone's memory, keeps its own memory and status, messages the others, asks them for
 * research and answers what it's asked, escalates, reviews its own trades and runs backtests; proposing,
 * ruling, assigning (and setting routines) and the lab's strategies are by role. A worker with no role only looks.
 */
export const FUND_TOOLS_ANYONE = ['fund_portfolio', 'fund_quotes', 'fund_market', 'fund_proposals', 'fund_activity', 'fund_risk_check', 'fund_desks', 'fund_memory', 'fund_research', 'fund_requests', 'fund_routines', 'fund_committees', 'fund_strategies', 'fund_backtests', 'fund_history'] as const;
export const FUND_TOOLS_DESK = ['fund_status', 'fund_thesis', 'fund_observe', 'fund_message', 'fund_inbox', 'fund_request', 'fund_answer', 'fund_escalate', 'fund_review', 'fund_ballot', 'fund_backtest'] as const;
export const FUND_TOOLS_BY_PERMISSION: Record<Permission, readonly string[]> = {
  propose: ['fund_propose', 'fund_withdraw'],
  rule: ['fund_rule'],
  assign: ['fund_assign', 'fund_routine'],
  committee: ['fund_committee', 'fund_committee_close', 'fund_decide'],
  strategy: ['fund_strategy', 'fund_strategy_stage'],
};

export function fundToolsFor(role: RoleDef | undefined): string[] {
  if (!role) return [...FUND_TOOLS_ANYONE];
  return [...FUND_TOOLS_ANYONE, ...FUND_TOOLS_DESK, ...role.can.flatMap((p) => FUND_TOOLS_BY_PERMISSION[p])];
}
