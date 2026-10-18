/**
 * The paper-trading fund (docs/fund.md): the 💼 Fund window, and the brief the top bar shows of it
 * (proposals waiting on your approval, a halted fund).
 */
import type { Ctx } from '../../core/context';
import type { Modal } from '../../ui/dom';
import { openFund } from './ui';

/** Asks for the fund's brief on arriving, and keeps an open window watching across a reconnect. */
export function installFund(ctx: Ctx) {
  const { net } = ctx;
  let modal: Modal | null = null;
  ctx.messages.on('welcome', () => {
    net.send({ t: 'fund.brief' });
    // A reconnected office has forgotten who was watching.
    if (modal) net.send({ t: 'fund.watch', on: true });
  });

  /** Opens the 💼 Fund window, or leaves it be if it's open. */
  function showFund() {
    if (modal) return;
    modal = openFund(
      (msg) => net.send(msg),
      () => (modal = null),
    );
  }

  return { showFund };
}
