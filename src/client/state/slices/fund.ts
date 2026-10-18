import type { FundBrief } from '../../../shared/protocol';
import type { DeskMemory } from '../../../shared/fund/desks';
import type { ResearchView } from '../../../shared/fund/research';
import type { FundState } from '../../../shared/fund/state';
import type { ActivityEvent } from '../../../shared/fund/types';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** What the top bar shows of the paper-trading fund. */
    fundBrief: FundBrief;
    /** The whole fund, while the 💼 Fund window is open (null before it first is). */
    fund: FundState | null;
    /** Its activity log, newest first, while the window is open. */
    fundActivity: ActivityEvent[];
    /** The role memory asked for last, from the Agents tab. */
    fundMemory: DeskMemory | null;
    /** The research across the desks, from the Research tab (null before it's asked for). */
    fundResearch: ResearchView | null;
  }
  interface Topics {
    fundBrief: true;
    fund: true;
    fundActivity: true;
    fundMemory: true;
    fundResearch: true;
  }
}

/** The most activity lines kept. */
const KEEP = 300;

/** The paper-trading fund (docs/fund.md). */
export const fund: Slice = {
  init(s) {
    s.fundBrief = { awaiting: 0, open: 0, halted: false };
    s.fund = null;
    s.fundActivity = [];
    s.fundMemory = null;
    s.fundResearch = null;
  },
  on: {
    'fund.brief'(s, m) {
      s.fundBrief = m.brief;
      return ['fundBrief'];
    },
    fund(s, m) {
      s.fund = m.state;
      return ['fund'];
    },
    'fund.activity'(s, m) {
      const latest = [...m.events].reverse();
      s.fundActivity = (m.all ? latest : [...latest, ...s.fundActivity]).slice(0, KEEP);
      return ['fundActivity'];
    },
    'fund.memory'(s, m) {
      s.fundMemory = m.memory;
      return ['fundMemory'];
    },
    'fund.research'(s, m) {
      s.fundResearch = m.research;
      return ['fundResearch'];
    },
  },
};
