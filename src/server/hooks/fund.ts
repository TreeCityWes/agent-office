import type http from 'node:http';
import { deskName, fundToolsFor } from '../../shared/fund/desks.js';
import { ROLE_BY_ID, ROLES } from '../../shared/fund/roles.js';
import type { ActivityKind, Actor, Proposal } from '../../shared/fund/types.js';
import type { WorkerInfo } from '../../shared/protocol.js';
import type { Ctx } from '../office/context.js';
import { readBody, send } from '../http/util.js';

type Body = Record<string, unknown>;
type Answer = object | Promise<object>;

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const list = (v: string | null) => (v ? v.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 40) : []);

/** A proposal in a list: enough to know what it is and where it's got to; fund_proposals with its id has the rest. */
const line = (p: Proposal) => ({
  id: p.id,
  stage: p.stage,
  symbol: p.symbol,
  side: p.side,
  sizeUsd: p.sizeUsd,
  confidence: p.confidence,
  horizon: p.horizon,
  author: deskName(p.author),
  thesis: p.thesis.slice(0, 240),
  ...(p.risk ? { risk: { decision: p.risk.decision, approvedUsd: p.risk.approvedUsd, reasons: p.risk.reasons } } : {}),
  ...(p.pnl !== undefined ? { pnl: p.pnl } : {}),
  updatedAt: new Date(p.updatedAt).toISOString(),
});

/** What every tool reads: the fund, the worker asking, who it is to the fund, and what it sent. */
interface Ask {
  ctx: Ctx;
  me: WorkerInfo;
  by: Actor;
  q: URLSearchParams;
  body: Body;
}

const READS: Record<string, (a: Ask) => Answer> = {
  me({ ctx, me }) {
    const p = ctx.fund.desks.profile(me.id);
    const role = p && ROLE_BY_ID.get(p.role);
    return { you: { id: me.id, name: me.name }, paper: true, role: role ? { id: role.id, title: role.title, department: role.department, can: role.can } : null, desk: p ?? null, tools: fundToolsFor(role) };
  },
  portfolio({ ctx }) {
    const f = ctx.fund;
    f.market.touch();
    const halted = f.halted();
    return { paper: true, venue: f.venue.label, ...(halted ? { halted } : {}), portfolio: f.portfolio(), limits: f.limits };
  },
  quotes({ ctx, q }) {
    const m = ctx.fund.market;
    m.touch();
    const want = list(q.get('symbols') ?? q.get('symbol'));
    const quotes = want.length ? want.flatMap((s) => m.quote(s) ?? []) : [...m.all().values()];
    const missing = want.filter((s) => !m.quote(s));
    return { mode: m.state().mode, quotes, ...(missing.length ? { missing, note: 'No price yet: the fund only prices assets it knows (its watchlist and its assets in ⚙️ Settings), and it may take a minute once it starts asking.' } : {}) };
  },
  market({ ctx, q }) {
    const m = ctx.fund.market;
    m.touch();
    const symbol = list(q.get('symbol'))[0];
    const s = m.state();
    return {
      mode: s.mode,
      sources: s.sources,
      signals: m.signals({ kind: str(q.get('kind'), 30), symbol }).slice(0, 100),
      ...(symbol ? { history: m.priceHistory(symbol).slice(-200) } : {}),
    };
  },
  proposals({ ctx, q }) {
    const id = str(q.get('id'), 20)?.toUpperCase();
    if (id) {
      const p = ctx.fund.proposals.get(id);
      return p ? { proposal: p, activity: ctx.fund.activity.list({ proposalId: id, limit: 50 }) } : { error: `There's no proposal ${id}` };
    }
    const stages = (q.get('stage') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const live = ctx.fund.state().proposals;
    return { proposals: live.filter((p) => !stages.length || stages.includes(p.stage)).slice(0, 60).map(line) };
  },
  desks({ ctx }) {
    const s = ctx.fund.desks.state();
    return {
      desks: s.desks.map((d) => ({ role: d.role, title: ROLE_BY_ID.get(d.role)?.title, name: d.name, status: d.status, note: d.note, assignment: d.assignment, thesis: d.thesis?.slice(0, 300), confidence: d.confidence, process: d.process, floor: d.floorName })),
      roles: ROLES.map((r) => ({ id: r.id, title: r.title, department: r.department, blurb: r.blurb, can: r.can, held: s.desks.some((d) => d.role === r.id), record: s.records[r.id] })),
    };
  },
  memory({ ctx, me, q }) {
    const key = str(q.get('role'), 64) ?? ctx.fund.desks.profile(me.id)?.role;
    if (!key) return { error: 'Whose memory? role: a role id, like macro or cio' };
    return ctx.fund.desks.memory(key);
  },
  inbox: ({ ctx, by }) => ctx.fund.desks.inbox(by),
  activity({ ctx, q }) {
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50));
    return { events: ctx.fund.activity.list({ limit, proposalId: str(q.get('proposalId'), 20)?.toUpperCase(), symbol: list(q.get('symbol'))[0], kind: str(q.get('kind'), 20) as ActivityKind | undefined }) };
  },
};

/** After a fund action an agent took: on its role's record when it went through. */
async function noted(ctx: Ctx, by: Actor, run: Promise<{ error: string } | { ok: true; proposal: Proposal }>, kind: (p: Proposal) => Parameters<Ctx['fund']['desks']['decided']>[1], text: (p: Proposal) => string) {
  const r = await run;
  if ('proposal' in r) ctx.fund.desks.decided(by, kind(r.proposal), text(r.proposal), r.proposal.id);
  return r;
}

const ruling = (v: unknown): 'approve' | 'reject' | undefined => {
  const d = String(v ?? '').toLowerCase();
  return ['approve', 'approved', 'back', 'endorse', 'yes'].includes(d) ? 'approve' : ['reject', 'rejected', 'turn down', 'no'].includes(d) ? 'reject' : undefined;
};

const ACTIONS: Record<string, (a: Ask) => Answer> = {
  'risk-check': ({ ctx, body }) => ctx.fund.riskCheck(body),
  propose: ({ ctx, by, body }) =>
    noted(ctx, by, ctx.fund.propose(body, by, { idea: body.idea === true }), (p) => (p.stage === 'idea' ? 'idea' : 'proposed'), (p) => `${p.side} ${p.symbol} $${Math.round(p.sizeUsd)}: ${p.thesis}`),
  promote: ({ ctx, by, body }) => noted(ctx, by, ctx.fund.promote(body.id, body, by), () => 'proposed', (p) => `${p.side} ${p.symbol} $${Math.round(p.sizeUsd)}: ${p.thesis}`),
  withdraw: ({ ctx, by, body }) => noted(ctx, by, ctx.fund.withdraw(body.id, str(body.note, 500), by), () => 'withdrew', (p) => `${p.side} ${p.symbol}${body.note ? `: ${String(body.note)}` : ''}`),
  rule({ ctx, by, body }) {
    const decision = ruling(body.decision);
    if (!decision) return { error: 'decision: approve (back it, on to a person) or reject' };
    const note = str(body.note ?? body.reason, 500);
    return noted(ctx, by, ctx.fund.rule(body.id, decision, note, by), () => (decision === 'approve' ? 'backed' : 'turned down'), (p) => `${p.side} ${p.symbol}${note ? `: ${note}` : ''}`);
  },
  review: ({ ctx, by, body }) => noted(ctx, by, ctx.fund.review(body.id, body, by), () => 'reviewed', (p) => `${p.review?.thesisHeld ? 'Thesis held' : "Thesis didn't hold"}: ${p.review?.lessons ?? ''}`),
  status: ({ ctx, by, body }) => ctx.fund.desks.setStatus(by, body),
  thesis: ({ ctx, by, body }) => ctx.fund.desks.thesis(by, body),
  observe: ({ ctx, by, body }) => ctx.fund.desks.observe(by, body),
  message: ({ ctx, by, body }) => ctx.fund.desks.message(by, body, 'message'),
  assign: ({ ctx, by, body }) => ctx.fund.desks.message(by, body, 'assignment'),
  escalate: ({ ctx, by, body }) => ctx.fund.desks.escalate(by, body),
};

/**
 * The fund's tools for the agents at its desks (docs/fund.md#the-fund-tools): GET /fund/<read> and
 * POST /fund/<action> on the loopback hook server, which bin/office-fund.js calls for the office-fund
 * command and the fund_* tools of the agent-office MCP server. The worker's own hook token says who's
 * asking; the fund and its desks decide what that worker's role may do, so this only translates.
 */
export async function fundTools(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const workerId = url.searchParams.get('worker') ?? '';
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const me = ctx.workerFloor(workerId)?.workers.authenticate(workerId, token);
  if (!me) return send(res, 401, { error: 'Send your own AGENT_OFFICE_WORKER_ID as ?worker= and AGENT_OFFICE_HOOK_TOKEN as the bearer token' });
  const name = url.pathname.slice('/fund/'.length);
  const read = req.method === 'GET' ? READS[name] : undefined;
  const act = req.method === 'POST' ? ACTIONS[name] : undefined;
  if (!Object.hasOwn(READS, name) && !Object.hasOwn(ACTIONS, name)) return send(res, 404, { error: `GET /fund/${Object.keys(READS).join('|')}, or POST /fund/${Object.keys(ACTIONS).join('|')}` });
  if (!read && !act) return send(res, 405, { error: `/fund/${name} is ${READS[name] ? 'GET' : 'POST'}` });
  let body: Body = {};
  if (act) {
    try {
      const raw = JSON.parse((await readBody(req)) || '{}') as unknown;
      body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Body) : {};
    } catch {
      return send(res, 400, { error: 'Send JSON' });
    }
  }
  try {
    const out = await (read ?? act)!({ ctx, me, by: ctx.fund.desks.actor(me), q: url.searchParams, body });
    send(res, 'error' in out ? 400 : 200, out);
  } catch (err) {
    console.error(`agent-office: fund tool ${name}:`, err);
    send(res, 500, { error: `The fund couldn't do that: ${err instanceof Error ? err.message : String(err)}` });
  }
}
