// The fund's research across every desk (docs/fund.md#research): each desk's thesis now and how its
// confidence moved, the notes the desks post (fund_observe), what covers each asset, and how the trades
// the desks proposed did against the confidence they gave. Pure: server/fund/research.ts gathers it
// from the desks' memory, and the 💼 Fund window's Research tab and the fund_research tool show it.
import type { Observation, ThesisEntry } from './desks.js';
import type { Signal } from './state.js';
import type { Actor, PositionView, Proposal, ProposalStage, Side } from './types.js';

/** A desk's thesis now, and the confidence it had before. */
export interface DeskThesis {
  role: string;
  at: number;
  by: Actor;
  thesis: string;
  confidence?: number;
  /** The confidence its last thesis that gave one had. */
  was?: number;
  why?: string;
  /** How many theses the role has written. */
  versions: number;
}

/** An observation, with the role whose memory it's in. */
export interface ResearchNote extends Observation {
  role: string;
}

/** A closed trade a desk proposed, against the confidence it gave. */
export interface Call {
  id: string;
  role: string;
  symbol: string;
  side: Side;
  confidence: number;
  pnl: number;
  returnPct?: number;
  won: boolean;
  /** When it closed. */
  at: number;
  strategyId?: string;
}

/** How a desk's calls did, and how well its confidence foretold them. */
export interface Calibration {
  role: string;
  calls: number;
  wins: number;
  hitRatePct: number;
  avgConfidence: number;
  /** The mean squared gap between the confidence given (as a chance) and what happened: 0 is perfect, 0.25 is always saying 50%. */
  brier: number;
  avgReturnPct?: number;
  realizedPnl: number;
}

export interface ResearchView {
  /** Each desk's thesis now, the latest first. */
  theses: DeskThesis[];
  /** The latest notes across the desks, newest first. */
  notes: ResearchNote[];
  /** The latest closed calls, newest first. */
  calls: Call[];
  /** Each desk's calls taken together, the most first. */
  calibration: Calibration[];
  at: number;
}

/** A role's thesis now, from its history (oldest first). */
export function currentThesis(role: string, history: readonly ThesisEntry[]): DeskThesis | undefined {
  const last = history.at(-1);
  if (!last) return undefined;
  const before = history
    .slice(0, -1)
    .reverse()
    .find((t) => t.confidence !== undefined);
  return {
    role,
    at: last.at,
    by: last.by,
    thesis: last.thesis,
    ...(last.confidence !== undefined ? { confidence: last.confidence } : {}),
    ...(before ? { was: before.confidence } : {}),
    ...(last.why ? { why: last.why } : {}),
    versions: history.length,
  };
}

const CLOSED: readonly ProposalStage[] = ['exited', 'reviewed'];

/** Every closed trade a desk proposed, newest first. A person's trades aren't a desk's calls. */
export function callsOf(proposals: readonly Proposal[]): Call[] {
  const out: Call[] = [];
  for (const p of proposals) {
    if (!CLOSED.includes(p.stage) || p.pnl === undefined || p.author.kind !== 'agent' || !p.author.role) continue;
    // A filled qty is signed: a short's is negative.
    const put = Math.abs(p.qty ?? 0) * (p.entryPrice ?? 0);
    const at = p.history.find((h) => h.stage === 'exited')?.at ?? p.updatedAt;
    out.push({
      id: p.id,
      role: p.author.role,
      symbol: p.symbol,
      side: p.side,
      confidence: p.confidence,
      pnl: p.pnl,
      ...(put > 0 ? { returnPct: (p.pnl / put) * 100 } : {}),
      won: p.pnl > 0,
      at,
      ...(p.strategyId ? { strategyId: p.strategyId } : {}),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Each desk's calls taken together, the desk with the most first. */
export function calibration(calls: readonly Call[]): Calibration[] {
  const by = new Map<string, Call[]>();
  for (const c of calls) by.set(c.role, [...(by.get(c.role) ?? []), c]);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return [...by.entries()]
    .map(([role, cs]) => {
      const wins = cs.filter((c) => c.won).length;
      const rets = cs.flatMap((c) => (c.returnPct === undefined ? [] : [c.returnPct]));
      return {
        role,
        calls: cs.length,
        wins,
        hitRatePct: (wins / cs.length) * 100,
        avgConfidence: mean(cs.map((c) => c.confidence)),
        brier: mean(cs.map((c) => (c.confidence / 100 - (c.won ? 1 : 0)) ** 2)),
        ...(rets.length ? { avgReturnPct: mean(rets) } : {}),
        realizedPnl: cs.reduce((a, c) => a + c.pnl, 0),
      };
    })
    .sort((a, b) => b.calls - a.calls || a.brier - b.brier);
}

// ---- Coverage --------------------------------------------------------------------------------

/** What the fund knows and thinks about one asset. */
export interface Coverage {
  symbol: string;
  /** Notes on it, and the desks that wrote them. */
  notes: number;
  desks: string[];
  latest?: ResearchNote;
  /** Ideas still being filled in. */
  ideas: number;
  /** Proposals on their way or open, by side (ideas included). */
  long: number;
  short: number;
  live: number;
  position?: { side: Side; value: number; unrealizedPnl: number; weightPct: number };
  /** Market signals about it (funding, flows, filings…). */
  signals: number;
}

const LIVE: readonly ProposalStage[] = ['proposed', 'risk_review', 'cio_review', 'user_approval', 'executing', 'monitoring'];

/** Every asset the fund watches, holds, writes about or proposes, the ones it holds first, then the most talked about. */
export function coverage(watchlist: readonly string[], notes: readonly ResearchNote[], proposals: readonly Proposal[], positions: readonly PositionView[], signals: readonly Signal[]): Coverage[] {
  const rows = new Map<string, Coverage>();
  const row = (symbol: string) => {
    let r = rows.get(symbol);
    if (!r) rows.set(symbol, (r = { symbol, notes: 0, desks: [], ideas: 0, long: 0, short: 0, live: 0, signals: 0 }));
    return r;
  };
  for (const s of watchlist) row(s);
  for (const n of notes) {
    if (!n.symbol) continue;
    const r = row(n.symbol);
    r.notes++;
    if (!r.desks.includes(n.role)) r.desks.push(n.role);
    if (!r.latest || n.at > r.latest.at) r.latest = n;
  }
  for (const p of proposals) {
    const idea = p.stage === 'idea' || p.stage === 'research';
    if (!idea && !LIVE.includes(p.stage)) continue;
    const r = row(p.symbol);
    if (idea) r.ideas++;
    else r.live++;
    if (p.side === 'long') r.long++;
    else r.short++;
  }
  for (const p of positions) row(p.symbol).position = { side: p.side, value: p.value, unrealizedPnl: p.unrealizedPnl, weightPct: p.weightPct };
  for (const s of signals) if (s.symbol) row(s.symbol).signals++;
  const heat = (r: Coverage) => r.notes + 2 * (r.ideas + r.live) + r.signals;
  return [...rows.values()].sort((a, b) => Number(!!b.position) - Number(!!a.position) || heat(b) - heat(a) || a.symbol.localeCompare(b.symbol));
}
