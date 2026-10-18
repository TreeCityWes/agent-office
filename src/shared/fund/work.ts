// Work between the fund's desks beyond messages (docs/fund.md#research-requests-and-routines): research
// requests, which stay open until the desk asked answers them, and routines, standing prompts the office
// types into a desk's agent on a schedule. Pure: the server keeps them (server/fund/requests.ts and
// routines.ts), and the 💼 Fund window and the fund tools show them.
import type { Actor } from './types.js';

export type RequestStatus = 'open' | 'answered' | 'withdrawn';

export interface RequestAnswer {
  at: number;
  by: Actor;
  text: string;
  confidence?: number;
  sources?: string[];
}

/** A question put to a desk: open until whoever holds it answers (or the asker withdraws it). */
export interface ResearchRequest {
  /** R-1, R-2… */
  id: string;
  at: number;
  from: Actor;
  /** The role it's for. */
  to: string;
  question: string;
  proposalId?: string;
  symbol?: string;
  /** When the asker needs it by. */
  dueAt?: number;
  status: RequestStatus;
  answer?: RequestAnswer;
  /** The desk was reminded once it went past due. */
  reminded?: boolean;
  withdrawn?: { at: number; by: Actor; note?: string };
}

/** A standing prompt for a desk, typed into its agent every so often. */
export interface Routine {
  /** RT-1, RT-2… */
  id: string;
  role: string;
  prompt: string;
  everyMin: number;
  on: boolean;
  /** Who set it up, and when (or last changed it). */
  by: Actor;
  at: number;
  /** When it last came due, whatever happened then. */
  lastAt?: number;
  /** What happened then: typed in, or why not. */
  last?: string;
  runs: number;
  removed?: boolean;
}

export const ROUTINE_MIN_EVERY = 5;
export const ROUTINE_MAX_EVERY = 7 * 24 * 60;
export const DUE_MAX_MIN = 7 * 24 * 60;

type Raw = Record<string, unknown>;
const obj = (raw: unknown): Raw => (raw && typeof raw === 'object' ? (raw as Raw) : {});
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const minutes = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);
const confidenceOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v <= 1 && v > 0 ? v * 100 : v))) : undefined);
const proposalIdOf = (v: unknown) => (typeof v === 'string' && /^P-\d+$/i.test(v.trim()) ? v.trim().toUpperCase() : undefined);
const symbolOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9.\-]{1,15}$/.test(v.trim()) ? v.trim().toUpperCase() : undefined);
const sourcesOf = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((s) => text(s, 300)).filter(Boolean).slice(0, 10);
export const requestIdOf = (v: unknown) => (typeof v === 'string' && /^R-\d+$/i.test(v.trim()) ? v.trim().toUpperCase() : undefined);
export const routineIdOf = (v: unknown) => (typeof v === 'string' && /^RT-\d+$/i.test(v.trim()) ? v.trim().toUpperCase() : undefined);

export function checkRequest(raw: unknown): { to: string; question: string; proposalId?: string; symbol?: string; dueInMin?: number } | { error: string } {
  const r = obj(raw);
  const to = text(r.to, 64);
  if (!to) return { error: 'Which desk? to: a role (crypto-analyst, quant…) or a worker’s name' };
  const question = text(r.question ?? r.text, 4000);
  if (!question) return { error: 'What should it find out? question' };
  const due = minutes(r.dueInMin ?? r.dueMin);
  if (r.dueInMin !== undefined && !(due >= 1 && due <= DUE_MAX_MIN)) return { error: `dueInMin: minutes from now, 1 to ${DUE_MAX_MIN}` };
  const proposalId = proposalIdOf(r.proposalId ?? r.proposal);
  const symbol = symbolOf(r.symbol);
  return { to, question, ...(proposalId ? { proposalId } : {}), ...(symbol ? { symbol } : {}), ...(Number.isFinite(due) ? { dueInMin: Math.round(due) } : {}) };
}

export function checkAnswer(raw: unknown): { id: string; text: string; confidence?: number; sources?: string[] } | { error: string } {
  const r = obj(raw);
  const id = requestIdOf(r.id ?? r.requestId);
  if (!id) return { error: 'Which request? id, like R-3 (fund_requests lists yours)' };
  const said = text(r.text ?? r.answer, 8000);
  if (!said) return { error: 'What did you find? text' };
  const confidence = confidenceOf(r.confidence);
  const sources = sourcesOf(r.sources);
  return { id, text: said, ...(confidence !== undefined ? { confidence } : {}), ...(sources.length ? { sources } : {}) };
}

export function checkRoutine(raw: unknown): { id?: string; role?: string; prompt?: string; everyMin?: number; on?: boolean } | { error: string } {
  const r = obj(raw);
  const id = r.id === undefined ? undefined : routineIdOf(r.id);
  if (r.id !== undefined && !id) return { error: 'id: a routine, like RT-2' };
  const role = text(r.role ?? r.to, 64);
  const prompt = text(r.prompt ?? r.text, 4000);
  const every = minutes(r.everyMin ?? r.every);
  if (!id && (!role || !prompt || r.everyMin === undefined)) return { error: 'A routine needs role (the desk), prompt (what to do each time) and everyMin' };
  if (r.everyMin !== undefined && !(every >= ROUTINE_MIN_EVERY && every <= ROUTINE_MAX_EVERY)) return { error: `everyMin: ${ROUTINE_MIN_EVERY} to ${ROUTINE_MAX_EVERY} minutes` };
  return { ...(id ? { id } : {}), ...(role ? { role } : {}), ...(prompt ? { prompt } : {}), ...(Number.isFinite(every) ? { everyMin: Math.round(every) } : {}), ...(typeof r.on === 'boolean' ? { on: r.on } : {}) };
}

/** When a routine next comes due. */
export const routineNext = (r: Routine) => (r.lastAt ?? r.at) + r.everyMin * 60_000;

/** Every so often, in words: "every 30 min", "every 2 h", "every day". */
export function everyLabel(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? 'every day' : `every ${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? 'every hour' : `every ${min / 60} h`;
  return `every ${min} min`;
}

/** Requests as the window and the tools list them: open ones first, oldest due first, then the newest. */
export function requestOrder(a: ResearchRequest, b: ResearchRequest): number {
  const open = Number(b.status === 'open') - Number(a.status === 'open');
  if (open) return open;
  if (a.status === 'open') return (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.at - b.at;
  return (b.answer?.at ?? b.withdrawn?.at ?? b.at) - (a.answer?.at ?? a.withdrawn?.at ?? a.at);
}
