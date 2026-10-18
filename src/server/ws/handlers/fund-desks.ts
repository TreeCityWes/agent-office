// The fund's desks from the 💼 Fund window (docs/fund.md#agents-at-the-desks): a person gives a role to
// an agent already at a desk or hires one for it, takes it back, hands a desk a task or a message, and
// reads a role's memory. Only an admin staffs or talks to the desks; anyone may read.
import { deskSign } from '../../../shared/fund/desks.js';
import { departmentSeat } from '../../../shared/fund/floor.js';
import { ROLE_BY_ID } from '../../../shared/fund/roles.js';
import { cleanLabel } from '../../../shared/floorplan.js';
import { DESK_BY_ID, deskBuilt, nextFreeSeat } from '../../../shared/layout.js';
import { OPEN_CODE_MODEL_MAX } from '../../../shared/providers.js';
import { isAgentEffort, isAgentProvider } from '../../../shared/protocol.js';
import type { FundDeskClientMsg } from '../../../shared/protocol/fund.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { str } from '../../office/input.js';
import { here, workerOf } from './common.js';
import { actor, admin } from './fund.js';
import type { HandlerMap } from './types.js';

/** A message or a task from a person to a desk: a word when it's typed in, or why not. */
function tell(ctx: Ctx, c: Client, to: unknown, text: unknown, kind: 'message' | 'assignment') {
  if (!admin(ctx, c)) return;
  const r = ctx.fund.desks.message(actor(c), { to, text }, kind);
  if ('error' in r) return ctx.warn(c, r.error);
  const title = ROLE_BY_ID.get(r.message.to)?.title ?? r.message.to;
  ctx.sendTo(c, { t: 'toast', text: r.note ?? `💼 ${kind === 'assignment' ? 'Assigned to' : 'Sent to'} the ${title}`, level: r.delivered ? 'info' : 'warn' });
}

export const fundDeskHandlers = {
  'fund.staff'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const role = ROLE_BY_ID.get(str(msg.role, 40));
    if (!role) return ctx.warn(c, "There's no such role at the fund");
    const desks = ctx.fund.desks;
    if (desks.holder(role.id)) return ctx.warn(c, `The ${role.title} desk is already staffed`);
    const by = actor(c);
    if (msg.workerId !== undefined) {
      const w = workerOf(ctx, msg.workerId);
      if (!w?.info) return ctx.warn(c, 'That worker has gone home');
      if (w.info.kind !== 'agent') return ctx.warn(c, "A shell can't hold a desk at the fund: it takes an agent");
      const r = desks.staff(w.info, role.id, by);
      if ('error' in r) return ctx.warn(c, r.error);
      const said = w.floor.workers.prompt(w.wid, r.brief, c.peer.name);
      ctx.warn(c, said === 'Worker is not running' ? w.floor.workers.resume(w.wid, r.brief) : said);
      return ctx.toastFloor(w.floor, `💼 ${c.peer.name} made ${w.info.name} the fund's ${role.title}`);
    }
    const floor = here(ctx, c);
    if (!floor) return;
    if (msg.provider !== undefined && (!isAgentProvider(msg.provider) || !floor.project.agentProviders.includes(msg.provider))) return ctx.warn(c, 'Unknown agent provider');
    const model = msg.model === undefined ? undefined : str(msg.model, OPEN_CODE_MODEL_MAX + 1) || undefined;
    const effort = isAgentEffort(msg.effort) ? msg.effort : undefined;
    const hire = () => {
      if (desks.holder(role.id)) return ctx.warn(c, `The ${role.title} desk is already staffed`);
      // The desk with the role's sign, when its last holder left it free; else a free seat at its
      // department's table, on a map that has one (the trading floor); else the next free one.
      const taken = (id: string) => floor.workers.deskOccupied(id);
      // A back office seat only once it's built out, on whichever map (see deskBuilt).
      const built = (id: string) => { const d = DESK_BY_ID.get(id); return !d || deskBuilt(d, floor.plan.wing); };
      const sign = cleanLabel(deskSign(role));
      const labels = floor.plan.state().labels;
      const deskId = Object.keys(labels).find((id) => labels[id].text === sign && !taken(id)) ?? departmentSeat(ctx.maps.plan(), role.department, (id) => taken(id) || !built(id)) ?? nextFreeSeat(taken, floor.plan.wing)?.id;
      if (!deskId) return ctx.warn(c, "There's no free desk on this floor");
      const w = floor.workers.spawn(deskId, c.peer.name, desks.brief(role), false, 'agent', msg.provider, model, effort, undefined, c.accountId);
      if (typeof w === 'string') return ctx.warn(c, w);
      // Before its agent starts and asks the office for its tools.
      const r = desks.staff(w, role.id, by);
      if ('error' in r) return ctx.warn(c, r.error);
      ctx.toastFloor(floor, `💼 ${c.peer.name} hired ${w.name} as the fund's ${role.title}`);
    };
    ctx.withSignIn(c, ctx.claudeFor(msg.provider ?? floor.workers.officeDefault.provider), hire);
  },
  'fund.release'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.desks.release(str(msg.workerId, 32), actor(c));
    if ('error' in r) return ctx.warn(c, r.error);
    ctx.sendTo(c, { t: 'toast', text: `💼 The ${ROLE_BY_ID.get(r.role)?.title} desk is free`, level: 'info' });
  },
  'fund.assign'(ctx, c, msg) {
    tell(ctx, c, msg.role, msg.text, 'assignment');
  },
  'fund.message'(ctx, c, msg) {
    tell(ctx, c, msg.to, msg.text, 'message');
  },
  'fund.memory'(ctx, c, msg) {
    const m = ctx.fund.desks.memory(str(msg.role, 64));
    if ('error' in m) return ctx.warn(c, m.error);
    ctx.sendTo(c, { t: 'fund.memory', role: m.role, memory: m });
  },
} satisfies HandlerMap<FundDeskClientMsg>;
