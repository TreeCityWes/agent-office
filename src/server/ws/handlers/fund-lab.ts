// The quant lab from the 💼 Fund window (docs/fund.md#strategies-and-backtests): a person registers or
// edits a strategy, moves it along (approving one is a person's call alone) or runs a backtest. Only
// an admin does; the window shows everyone. The lab checks every gate again whoever asks.
import { STRATEGY_STAGE_LABEL } from '../../../shared/fund/strategy.js';
import type { FundLabClientMsg } from '../../../shared/protocol/fund.js';
import type { Ctx } from '../../office/context.js';
import type { Client } from '../../office/client.js';
import { actor, admin } from './fund.js';
import type { HandlerMap } from './types.js';

/** A word when it's done, or why not. */
function reply(ctx: Ctx, c: Client, r: { error: string } | { ok: true }, done: string) {
  if ('error' in r) return ctx.warn(c, r.error);
  ctx.sendTo(c, { t: 'toast', text: done, level: 'info' });
}

export const fundLabHandlers = {
  'fund.strategy'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.strategies.save(actor(c), msg.strategy);
    reply(ctx, c, r, 'strategy' in r ? `🧪 ${msg.strategy?.id ? 'Saved' : 'Registered'} ${r.strategy.id}` : '');
  },
  'fund.strategy.stage'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    const r = ctx.fund.strategies.move(actor(c), msg);
    reply(ctx, c, r, 'strategy' in r ? `🧪 ${r.strategy.id} is at ${STRATEGY_STAGE_LABEL[r.strategy.stage]}` : '');
  },
  'fund.backtest'(ctx, c, msg) {
    if (!admin(ctx, c)) return;
    ctx.sendTo(c, { t: 'toast', text: '🧪 Fetching prices for the backtest…', level: 'info' });
    void ctx.fund.strategies.run(actor(c), msg.run).then((r) => reply(ctx, c, r, 'backtest' in r ? `🧪 ${r.backtest.id}: Sharpe ${r.backtest.metrics.sharpe}, out of sample ${r.backtest.outOfSample.sharpe}` : ''));
  },
} satisfies HandlerMap<FundLabClientMsg>;
