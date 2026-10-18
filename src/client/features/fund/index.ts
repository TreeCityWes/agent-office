/**
 * The paper-trading fund (docs/fund.md): the 💼 Fund window, the brief the top bar shows of it
 * (proposals waiting on your approval, a halted fund), and its screens on the trading floor.
 */
import type { Ctx } from '../../core/context';
import type { Modal } from '../../ui/dom';
import { driveFloorScreens } from './floor';
import { openFund } from './ui';

/** Asks for the fund's brief on arriving, and keeps the fund watched across a reconnect while anything here wants it. */
export function installFund(ctx: Ctx) {
  const { net } = ctx;
  let modal: Modal | null = null;
  // The window and the floor's screens each watch the fund; the office hears of the first to start
  // and the last to stop.
  let watchers = 0;
  const watch = (on: boolean) => {
    const was = watchers > 0;
    watchers = Math.max(0, watchers + (on ? 1 : -1));
    if (watchers > 0 !== was) net.send({ t: 'fund.watch', on: watchers > 0 });
  };
  ctx.messages.on('welcome', () => {
    net.send({ t: 'fund.brief' });
    // A reconnected office has forgotten who was watching.
    if (watchers) net.send({ t: 'fund.watch', on: true });
  });
  driveFloorScreens(ctx, watch);

  /** Opens the 💼 Fund window, or leaves it be if it's open. */
  function showFund() {
    if (modal) return;
    modal = openFund(
      (msg) => (msg.t === 'fund.watch' ? watch(msg.on) : net.send(msg)),
      () => (modal = null),
    );
  }

  return { showFund };
}
