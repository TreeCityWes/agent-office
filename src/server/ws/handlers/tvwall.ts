// The TV wall on every floor: the screens up over the boards.
import { tvTitle } from '../../../shared/tvwall.js';
import type { TvWallClientMsg } from '../../../shared/protocol.js';
import { here } from './common.js';
import type { HandlerMap, ViewPieces } from './types.js';

export const tvwallView: ViewPieces['tvwall'] = (_ctx, floor) => floor?.tvwall.state() ?? { screens: {} };

export const tvwallHandlers = {
  'tv.set'(ctx, c, msg) {
    const who = c.peer.name;
    const floor = here(ctx, c);
    if (!floor) return;
    const r = floor.tvwall.set(msg.tv, msg.channel, msg.label, who);
    if ('error' in r) return ctx.warn(c, r.error);
    ctx.toFloor(floor, { t: 'tvwall', state: floor.tvwall.state() });
    ctx.toastFloor(floor, r.channel.kind === 'off' ? `📺 ${who} switched a screen off` : `📺 ${who} put ${r.label ?? tvTitle(r.channel)} on the wall`);
  },
} satisfies HandlerMap<TvWallClientMsg>;
