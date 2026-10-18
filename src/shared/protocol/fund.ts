// The paper-trading fund (docs/fund.md): what the 💼 Fund window shows, and what people do there.
import type { Vote } from '../fund/committee.js';
import type { DeskMemory } from '../fund/desks.js';
import type { FundConfig, FundState } from '../fund/state.js';
import type { BacktestRequest, StrategyInput, StrategyStage } from '../fund/strategy.js';
import type { AgentEffort, AgentProvider } from './agents.js';
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
  | { t: 'fund.reset' }
  | FundDeskClientMsg
  | FundCommitteeClientMsg
  | FundLabClientMsg;

/** Staffing the fund's desks, and talking to them (ws/handlers/fund-desks.ts). */
export type FundDeskClientMsg =
  /**
   * A desk staffed: an agent already at a desk (`workerId`) takes the role, or a new one is hired for it at
   * a free desk on your floor (the one with the role's sign, if it's free), with the role's brief as its task.
   */
  | { t: 'fund.staff'; role: string; workerId?: string; provider?: AgentProvider; model?: string; effort?: AgentEffort }
  /** The worker gives up its role (it stays at its desk). */
  | { t: 'fund.release'; workerId: string }
  /** A task for a desk, from a person: typed into its agent, and shown on its desk. */
  | { t: 'fund.assign'; role: string; text: string }
  | { t: 'fund.message'; to: string; text: string }
  /** Send me a role's memory. */
  | { t: 'fund.memory'; role: string };

/** The investment committee, from the window (ws/handlers/fund-committee.ts). A person who calls one decides it. */
export type FundCommitteeClientMsg =
  | { t: 'fund.convene'; question: string; proposalId?: string; symbol?: string; seats?: string[]; minutes?: number }
  /** Open the ballots now, counting whoever hasn't voted as abstaining. */
  | { t: 'fund.committee.close'; id: string }
  | { t: 'fund.decide'; id: string; vote: Vote; summary: string };

/** The quant lab, from the window (ws/handlers/fund-lab.ts). Approving a strategy is a person's alone. */
export type FundLabClientMsg =
  | { t: 'fund.strategy'; strategy: StrategyInput }
  | { t: 'fund.strategy.stage'; id: string; stage: StrategyStage; note?: string }
  | { t: 'fund.backtest'; run: BacktestRequest };

export type FundServerMsg =
  | { t: 'fund.brief'; brief: FundBrief }
  /** The whole fund, to whoever has the window open. */
  | { t: 'fund'; state: FundState }
  /** Activity log lines, oldest first: the latest when the window opens (`all`), then each as it happens. */
  | { t: 'fund.activity'; events: ActivityEvent[]; all?: boolean }
  /** A role's memory, to whoever asked. */
  | { t: 'fund.memory'; role: string; memory: DeskMemory };
