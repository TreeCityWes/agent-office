// The desks' research from the 💼 Fund window (docs/fund.md#research): every desk's thesis now, the latest
// notes across the desks and how their calls did. Anyone signed in may read it, as anyone may read a
// role's memory; asking a desk to research something is an assignment (ws/handlers/fund-desks.ts).
import type { FundResearchClientMsg } from '../../../shared/protocol/fund.js';
import { fundResearch } from '../../fund/research.js';
import type { HandlerMap } from './types.js';

export const fundResearchHandlers = {
  'fund.research'(ctx, c) {
    ctx.sendTo(c, { t: 'fund.research', research: fundResearch(ctx.fund) });
  },
} satisfies HandlerMap<FundResearchClientMsg>;
