// Research requests and routines for the agents at the fund's desks (docs/fund.md#research-requests-and-routines):
// asking another desk a question that stays open until it's answered, answering what you're asked, and
// the routines the office types into each desk on a schedule. hooks/fund.ts serves them with the rest of
// the fund's tools; the requests and routines decide who may.
import { deskName } from '../../shared/fund/desks.js';
import { ROLE_BY_ID } from '../../shared/fund/roles.js';
import { everyLabel, routineNext, type ResearchRequest, type RequestStatus, type Routine } from '../../shared/fund/work.js';
import type { Answer, Ask } from './fund.js';

const iso = (at: number | undefined) => (at === undefined ? undefined : new Date(at).toISOString());
const title = (role: string) => ROLE_BY_ID.get(role)?.title ?? role;
const STATUSES: readonly string[] = ['open', 'answered', 'withdrawn'];

const requestLine = (r: ResearchRequest, now: number) => ({
  id: r.id,
  status: r.status,
  from: deskName(r.from),
  to: title(r.to),
  toRole: r.to,
  question: r.question,
  ...(r.proposalId ? { proposalId: r.proposalId } : {}),
  ...(r.symbol ? { symbol: r.symbol } : {}),
  asked: iso(r.at),
  ...(r.dueAt ? { due: iso(r.dueAt), overdue: r.status === 'open' && now > r.dueAt } : {}),
  ...(r.answer ? { answer: { by: deskName(r.answer.by), text: r.answer.text, confidence: r.answer.confidence, sources: r.answer.sources, at: iso(r.answer.at) } } : {}),
  ...(r.withdrawn ? { withdrawn: { by: r.withdrawn.by.name, note: r.withdrawn.note, at: iso(r.withdrawn.at) } } : {}),
});

const routineLine = (r: Routine) => ({ id: r.id, desk: title(r.role), role: r.role, prompt: r.prompt, every: everyLabel(r.everyMin), everyMin: r.everyMin, on: r.on, setBy: r.by.name, runs: r.runs, last: r.last, lastAt: iso(r.lastAt), ...(r.on ? { next: iso(routineNext(r)) } : {}) });

export const WORK_READS: Record<string, (a: Ask) => Answer> = {
  requests({ ctx, by, q }) {
    const reqs = ctx.fund.desks.requests;
    const now = ctx.fund.now();
    const id = q.get('id')?.trim().toUpperCase();
    if (id) {
      const r = reqs.get(id);
      return r ? { request: requestLine(r, now) } : { error: `There's no request ${id}` };
    }
    const status = q.get('status')?.trim().toLowerCase() || 'open';
    if (status !== 'all' && !STATUSES.includes(status)) return { error: 'status: open (the default), answered, withdrawn or all' };
    // `mine`: put to your desk (to), or asked by it (from); otherwise every desk's.
    const mine = q.get('mine')?.trim().toLowerCase();
    if (mine && mine !== 'to' && mine !== 'from') return { error: 'mine: to (put to your desk) or from (asked by it)' };
    const role = by.role;
    if (mine && !role) return { error: 'You hold no desk at the fund, so none are yours' };
    const list = reqs
      .list()
      .filter((r) => status === 'all' || r.status === (status as RequestStatus))
      .filter((r) => !mine || (mine === 'to' ? r.to === role : r.from.role === role))
      .slice(0, 40);
    return { requests: list.map((r) => requestLine(r, now)), note: 'Answer one put to your desk with fund_answer (its id, what you found, your confidence and sources).' };
  },
  routines({ ctx }) {
    return { routines: ctx.fund.desks.routines.list().map(routineLine) };
  },
};

export const WORK_ACTIONS: Record<string, (a: Ask) => Answer> = {
  request({ ctx, by, body }) {
    const reqs = ctx.fund.desks.requests;
    // `withdraw`: one of yours taken back, rather than a new one.
    if (body.withdraw !== undefined) {
      const w = reqs.withdraw(by, { id: body.withdraw, note: body.note });
      return 'request' in w ? { ok: true, request: requestLine(w.request, ctx.fund.now()) } : w;
    }
    const r = reqs.ask(by, body);
    return 'request' in r ? { ok: true, request: requestLine(r.request, ctx.fund.now()), delivered: r.delivered, ...(r.note ? { note: r.note } : {}) } : r;
  },
  answer({ ctx, by, body }) {
    const r = ctx.fund.desks.requests.answer(by, body);
    return 'request' in r ? { ok: true, request: requestLine(r.request, ctx.fund.now()), told: r.told } : r;
  },
  routine({ ctx, by, body }) {
    const routines = ctx.fund.desks.routines;
    const r = body.remove === true ? routines.remove(by, body) : body.run === true ? routines.run(by, body) : routines.set(by, body);
    return 'routine' in r ? { ok: true, routine: routineLine(r.routine) } : r;
  },
};
