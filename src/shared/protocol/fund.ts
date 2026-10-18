// The paper-trading fund (docs/fund.md): what the 💼 Fund window shows, and what people do there.
import type { FundConfig, FundState } from '../fund/state.js';
import type { ActivityEvent, ProposalInput, RiskLimits } from '../fund/types.js';

/** What the top bar shows of the fund, sent to everyone: enough to know it wants someone. */
export interface FundBrief {
  /** Proposals waiting on a person's approval. */
  awaiting: number;
  /** Positions open. */
  open: number;
  /** Trading has stopped: a journal doesn't check out. */
  halted: boolean;
}

export type FundClientMsg =
  /** Send me the brief (on arriving, and again after a reconnect). */
  | { t: 'fund.brief' }
  /** The 💼 Fund window opened (`on`) or closed: the fund as it is, then every change while it's open. */
  | { t: 'fund.watch'; on: boolean }
  /** A trade a person puts forward: it goes through risk like any other. */
  | { t: 'fund.propose'; proposal: Partial<ProposalInput> }
  | { t: 'fund.approve'; id: string; note?: string }
  | { t: 'fund.reject'; id: string; note?: string }
  /** Out of one trade now, at the market. */
  | { t: 'fund.exit'; id: string }
  /** Out of a whole position now, at the market. */
  | { t: 'fund.close'; symbol: string }
  | { t: 'fund.limits'; limits: Partial<RiskLimits> }
  | { t: 'fund.config'; config: Partial<FundConfig> }
  /** Capital paid in (positive) or taken out (negative), in USD. */
  | { t: 'fund.cash'; amount: number; note?: string }
  /** Start the fund over; its records are moved aside, not deleted. */
  | { t: 'fund.reset' };

export type FundServerMsg =
  | { t: 'fund.brief'; brief: FundBrief }
  /** The whole fund, to whoever has the window open. */
  | { t: 'fund'; state: FundState }
  /** Activity log lines, oldest first: the latest when the window opens (`all`), then each as it happens. */
  | { t: 'fund.activity'; events: ActivityEvent[]; all?: boolean };
