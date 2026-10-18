// Research requests and routines from the 💼 Fund window (docs/fund.md#research-requests-and-routines):
// a person asks a desk a question that's tracked until it's answered, takes one back, and sets, changes,
// runs or removes the routines the office types into each desk on a schedule. Only an admin does any of it.
import { ROLE_BY_ID } from '../../../shared/fund/roles.js';
import { everyLabel } from '../../../shared/fund/work.js';
import type { FundWorkClientMsg } from '../../../shared/protocol/fund.js';
import { actor, admin } from './fund.js';
import type { HandlerMap } from './types.js';

const title = (role: string) => ROLE_BY_ID.get(role)?.title ?? role;

export const fundWorkHandlers = {
  'fund.request'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.desks.requests.ask(actor(c), msg.request);
    if ('error' in r) return ctx.warn(c, r.error);
    ctx.sendTo(c, { t: 'toast', text: r.note ?? `🔎 ${r.request.id} sent to the ${title(r.request.to)}`, level: r.delivered ? 'info' : 'warn' });
  },
  'fund.request.withdraw'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.desks.requests.withdraw(actor(c), { id: msg.id, note: msg.note });
    if ('error' in r) return ctx.warn(c, r.error);
  },
  'fund.routine'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.desks.routines.set(actor(c), msg.routine);
    if ('error' in r) return ctx.warn(c, r.error);
    if (!msg.routine?.id) ctx.sendTo(c, { t: 'toast', text: `⏰ ${r.routine.id}: the ${title(r.routine.role)}, ${everyLabel(r.routine.everyMin)}`, level: 'info' });
  },
  'fund.routine.run'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.desks.routines.run(actor(c), { id: msg.id });
    if ('error' in r) return ctx.warn(c, r.error);
    ctx.sendTo(c, { t: 'toast', text: `⏰ ${r.routine.id}: ${r.routine.last ?? ''}`, level: r.routine.last === 'Typed in' ? 'info' : 'warn' });
  },
  'fund.routine.remove'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.desks.routines.remove(actor(c), { id: msg.id });
    if ('error' in r) return ctx.warn(c, r.error);
  },
} satisfies HandlerMap<FundWorkClientMsg>;
