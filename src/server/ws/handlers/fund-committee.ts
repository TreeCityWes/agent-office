// The investment committee from the 💼 Fund window (docs/fund.md#the-investment-committee): a person
// calls one, opens its ballots early, or decides it. Only an admin does; the window shows everyone.
import type { FundCommitteeClientMsg } from '../../../shared/protocol/fund.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { actor, admin } from './fund.js';
import type { HandlerMap } from './types.js';

/** A word when it's done (unless everyone was just told anyway), or why not. */
function reply(ctx: Ctx, c: Client, r: { error: string } | { ok: true }, done: string) {
  if ('error' in r) return ctx.warn(c, r.error);
  if (done) ctx.sendTo(c, { t: 'toast', text: done, level: 'info' });
}

export const fundCommitteeHandlers = {
  'fund.convene'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    // Everyone in the building hears a committee people chair is sitting.
    reply(ctx, c, ctx.fund.committees.convene(actor(c), msg), '');
  },
  'fund.committee.close'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.committees.close(actor(c), msg.id);
    // When people chair it, everyone hears its ballots are open; when an agent does, only the agent is told.
    reply(ctx, c, r, 'committee' in r && r.committee.chair ? `🏛️ ${r.committee.id}'s ballots are open: its chair decides` : '');
  },
  'fund.decide'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.committees.decide(actor(c), msg);
    reply(ctx, c, r, 'committee' in r ? `🏛️ ${r.committee.id} decided: ${r.committee.decision?.vote}` : '');
  },
} satisfies HandlerMap<FundCommitteeClientMsg>;
