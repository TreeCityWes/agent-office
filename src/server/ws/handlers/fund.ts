// The paper-trading fund (docs/fund.md): the 💼 Fund window, and what people do there. Anyone in the
// office can look; only an admin approves, rejects, exits, changes the limits or settings, moves
// capital or starts the fund over, and the fund itself checks every one of those again.
import type { FundBrief, FundClientMsg } from '../../../shared/protocol.js';
import type { FundDeskClientMsg } from '../../../shared/protocol/fund.js';
import type { ActivityEvent, Actor } from '../../../shared/fund/types.js';
import type { Fund, Result } from '../../fund/fund.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import type { HandlerMap } from './types.js';

/** Who has the 💼 Fund window open. */
const watching = new WeakSet<Client>();
/** The brief everyone was last sent, so it only goes out again when it's different. */
let lastBrief = '';

/** A person in the office, as the fund's records name them. */
export const actor = (c: Client): Actor => ({ kind: 'user', id: c.accountId ? `account:${c.accountId}` : `guest:${c.id}`, name: c.peer.name });

export const fundBrief = (fund: Fund): FundBrief => {
  const s = fund.state();
  return { awaiting: s.proposals.filter((p) => p.stage === 'user_approval').length, open: s.portfolio.positions.length, halted: !!s.halted };
};

/** The fund changed: everyone with the window open gets it as it is, and everyone the brief, if that changed. */
export function fundChanged(ctx: Ctx) {
  let sent = false;
  for (const c of ctx.clients.values()) {
    if (!watching.has(c)) continue;
    ctx.sendTo(c, { t: 'fund', state: ctx.fund.state() });
    sent = true;
  }
  // Someone's looking, so prices keep coming.
  if (sent) ctx.fund.market.touch();
  const brief = fundBrief(ctx.fund);
  const json = JSON.stringify(brief);
  if (json === lastBrief) return;
  lastBrief = json;
  ctx.broadcast({ t: 'fund.brief', brief });
}

/** A line in the fund's activity log, for everyone with the window open. */
export function fundActivity(ctx: Ctx, e: ActivityEvent) {
  for (const c of ctx.clients.values()) if (watching.has(c)) ctx.sendTo(c, { t: 'fund.activity', events: [e] });
}

/** Only an admin runs the fund; anyone else is told so. */
export function admin(ctx: Ctx, c: Client): boolean {
  if (!c.admin) ctx.warn(c, 'Only an admin can do that in the fund');
  return c.admin;
}

/** What came of something `c` asked the fund to do: a word when it's done, or why not. */
function reply(ctx: Ctx, c: Client, run: Promise<Result>, done: string) {
  void run.then((r) => ('error' in r ? ctx.warn(c, r.error) : ctx.sendTo(c, { t: 'toast', text: done, level: 'info' })));
}

const short = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export const fundHandlers = {
  'fund.brief'(ctx, c) {
    ctx.sendTo(c, { t: 'fund.brief', brief: fundBrief(ctx.fund) });
  },
  'fund.watch'(ctx, c, msg) {
    if (!msg.on) return void watching.delete(c);
    watching.add(c);
    ctx.fund.market.touch();
    ctx.sendTo(c, { t: 'fund', state: ctx.fund.state() });
    ctx.sendTo(c, { t: 'fund.activity', events: ctx.fund.activity.list({ limit: 200 }), all: true });
  },
  'fund.propose'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.propose(msg.proposal, actor(c)), '💼 Proposal sent to risk');
  },
  'fund.approve'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.approve(msg.id, short(msg.note, 500), actor(c)), `💼 ${String(msg.id)} approved and filled on paper`);
  },
  'fund.reject'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.reject(msg.id, short(msg.note, 500), actor(c)), `💼 ${String(msg.id)} rejected`);
  },
  'fund.exit'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.exit(msg.id, actor(c)), `💼 Out of ${String(msg.id)}`);
  },
  'fund.close'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.close(msg.symbol, actor(c)), `💼 Closed ${String(msg.symbol)}`);
  },
  'fund.limits'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.setLimits(msg.limits, actor(c)), '💼 Risk limits saved');
  },
  'fund.config'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.setConfig(msg.config, actor(c)), '💼 Fund settings saved');
  },
  'fund.cash'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.adjustCash(msg.amount, short(msg.note, 200), actor(c)), '💼 Capital moved');
  },
  'fund.reset'(ctx, c) {
    if (!admin(ctx, c)) return;
    reply(ctx, c, ctx.fund.reset(actor(c)), '💼 The fund starts over; the old records were kept');
  },
} satisfies HandlerMap<Exclude<FundClientMsg, FundDeskClientMsg>>;
