// What the trading floor's screens make of the fund (docs/fund.md#the-trading-floor): how worried
// the risk beacon is, what runs along the ticker, the heatmap's tiles and where each goes, the trade
// pipeline stage by stage, and who's at which desk by department. Pure, so the tests check exactly
// what the screens show; the floor only ever reads the fund, never changes it. And where a new
// hire for a role sits on a map with a table for each department.
import type { DeskDef } from '../layout.js';
import { DEPARTMENTS, ROLE_BY_ID, type Department } from './roles.js';
import type { DeskView } from './desks.js';
import type { FundState } from './state.js';
import { STAGE_LABEL } from './proposals.js';
import type { ProposalStage } from './types.js';

// ---- Risk --------------------------------------------------------------------------------------

/** How a limit's used: what it is now, the limit, and the share of it (1 is at the limit). */
export interface LimitUse {
  key: 'position' | 'top3' | 'leverage' | 'drawdown' | 'dayLoss';
  label: string;
  now: number;
  limit: number;
  use: number;
  unit: '%' | '×';
}

export type AlarmLevel = 'calm' | 'watch' | 'alarm';

export interface RiskAlarm {
  level: AlarmLevel;
  /** Why, worst first, a line each. */
  reasons: string[];
  limits: LimitUse[];
}

/** At this share of a limit the beacon turns amber. */
export const WATCH_AT = 0.8;
/** A proposal risk turned down this recently keeps the beacon amber. */
export const RECENT_REJECTION_MS = 60 * 60 * 1000;

/** The limits the risk tab shows, used as much as they are now (the same five, in the same order). */
export function limitUse(s: Pick<FundState, 'portfolio' | 'limits'>): LimitUse[] {
  const p = s.portfolio;
  const l = s.limits;
  const weights = p.positions.map((x) => x.weightPct).sort((a, b) => b - a);
  const row = (key: LimitUse['key'], label: string, now: number, limit: number, unit: LimitUse['unit'] = '%'): LimitUse => ({ key, label, now, limit, unit, use: limit > 0 ? now / limit : now > 0 ? Infinity : 0 });
  return [
    row('position', 'Largest position', weights[0] ?? 0, l.maxPositionPct),
    row('top3', 'Top three positions', weights.slice(0, 3).reduce((a, b) => a + b, 0), l.maxTop3Pct),
    row('leverage', 'Leverage', p.leverage, l.maxLeverage, '×'),
    row('drawdown', 'Drawdown', p.drawdownPct, l.maxDrawdownPct),
    row('dayLoss', 'Today’s loss', Math.max(0, -p.dayPnlPct), l.maxDailyLossPct),
  ];
}

const fmtUse = (u: LimitUse, n: number) => (u.unit === '×' ? `${n.toFixed(2)}×` : `${n.toFixed(1)}%`);

/**
 * How worried the risk beacon should be, worked out the way the risk engine would, never by an
 * agent: `alarm` when trading's halted, a loss limit is hit or any limit's broken; `watch` when one
 * is at WATCH_AT of its limit or risk turned a proposal down in the last hour; `calm` otherwise.
 */
export function riskAlarm(s: Pick<FundState, 'portfolio' | 'limits' | 'proposals' | 'halted'>, now: number): RiskAlarm {
  const limits = limitUse(s);
  const alarm: string[] = [];
  const watch: string[] = [];
  if (s.halted) alarm.push(`Trading halted: ${s.halted}`);
  for (const u of [...limits].sort((a, b) => b.use - a.use)) {
    const loss = u.key === 'drawdown' || u.key === 'dayLoss';
    if (u.use >= 1 && (u.use > 1 || loss)) alarm.push(`${u.label} ${fmtUse(u, u.now)} ${loss ? 'has hit' : 'is over'} its ${fmtUse(u, u.limit)} limit`);
    else if (u.use >= WATCH_AT) watch.push(`${u.label} is at ${Math.round(u.use * 100)}% of its limit`);
  }
  for (const p of s.proposals) if (p.risk?.decision === 'rejected' && now - p.risk.at < RECENT_REJECTION_MS) watch.push(`Risk turned down ${p.side} ${p.symbol}`);
  return { level: alarm.length ? 'alarm' : watch.length ? 'watch' : 'calm', reasons: [...alarm, ...watch], limits };
}

// ---- The ticker --------------------------------------------------------------------------------

export type Tone = 'up' | 'down' | 'flat' | 'alarm' | 'info';

/** One thing running along the ticker. */
export interface TickerItem {
  text: string;
  tone: Tone;
}

/** A price as a ticker shows it: more places the smaller it is. */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const places = Math.abs(n) < 1 ? 4 : Math.abs(n) < 10000 ? 2 : 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
}

const signed = (n: number, places = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(places)}`;
const toneOf = (n: number | undefined): Tone => (n === undefined || Math.abs(n) < 0.005 ? 'flat' : n > 0 ? 'up' : 'down');

/**
 * What runs along the ticker, in order: a warning when the beacon isn't calm, the fund's NAV and
 * its day, then every price the fund watches or holds, held ones first.
 */
export function tickerItems(s: Pick<FundState, 'portfolio' | 'limits' | 'proposals' | 'halted' | 'market' | 'config' | 'paper'>, now: number): TickerItem[] {
  const out: TickerItem[] = [];
  const risk = riskAlarm(s, now);
  if (risk.level !== 'calm') out.push({ text: `⚠ RISK: ${risk.reasons[0]}`, tone: risk.level === 'alarm' ? 'alarm' : 'info' });
  const p = s.portfolio;
  out.push({ text: `${s.config.name.toUpperCase()} NAV ${fmtPrice(p.nav)}`, tone: 'info' });
  out.push({ text: `DAY ${signed(p.dayPnl, 0)} (${signed(p.dayPnlPct)}%)`, tone: toneOf(p.dayPnl) });
  if (s.paper) out.push({ text: 'PAPER', tone: 'info' });
  const held = new Set(p.positions.map((x) => x.symbol));
  const quotes = [...s.market.quotes].sort((a, b) => Number(held.has(b.symbol)) - Number(held.has(a.symbol)));
  for (const q of quotes) {
    const ch = q.changePct;
    out.push({ text: `${held.has(q.symbol) ? '●' : ''}${q.symbol} ${fmtPrice(q.price)} ${ch === undefined ? '' : `${ch >= 0 ? '▲' : '▼'}${Math.abs(ch).toFixed(2)}%`}`.trim(), tone: toneOf(ch) });
  }
  if (s.market.mode === 'mock') out.push({ text: 'MOCK MARKET: SIMULATED PRICES', tone: 'info' });
  return out;
}

// ---- The heatmap -------------------------------------------------------------------------------

/** One tile: an asset, how big a share of the map it takes, and how it's done today. */
export interface HeatTile {
  symbol: string;
  /** What it's sized by: |value| for what's held, a small share of the rest for what's only watched. */
  weight: number;
  /** % change on the day (or on the position, when there's no day change). */
  changePct: number;
  held: boolean;
}

/** Where a tile goes, in the map's own units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The heatmap's tiles: everything held, sized by its value, then everything else watched, sharing
 * a quarter of the map (or all of it when nothing's held), biggest first.
 */
export function heatTiles(s: Pick<FundState, 'portfolio' | 'market'>): HeatTile[] {
  const quote = new Map(s.market.quotes.map((q) => [q.symbol, q]));
  const held: HeatTile[] = s.portfolio.positions
    .filter((x) => x.value !== 0)
    .map((x) => ({ symbol: x.symbol, weight: Math.abs(x.value), changePct: quote.get(x.symbol)?.changePct ?? x.unrealizedPct, held: true }));
  const heldSet = new Set(held.map((t) => t.symbol));
  const watched = s.market.quotes.filter((q) => !heldSet.has(q.symbol));
  const total = held.reduce((a, t) => a + t.weight, 0);
  const each = watched.length ? (total > 0 ? total / 3 : 1) / watched.length : 0;
  const rest: HeatTile[] = watched.map((q) => ({ symbol: q.symbol, weight: each, changePct: q.changePct ?? 0, held: false }));
  return [...held, ...rest].sort((a, b) => b.weight - a.weight || a.symbol.localeCompare(b.symbol));
}

/** The worst a row's tiles are, longest side over shortest, laid along a side `side` long. */
function worst(row: number[], side: number): number {
  const sum = row.reduce((a, b) => a + b, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/**
 * Lays `weights` (biggest first) out over `area`, each tile's area its share: squarified, so they
 * come out as near square as they'll go (Bruls, Huizing and van Wijk).
 */
export function treemap(weights: readonly number[], area: Rect): Rect[] {
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!weights.length || total <= 0 || area.w <= 0 || area.h <= 0) return weights.map(() => ({ x: area.x, y: area.y, w: 0, h: 0 }));
  const scale = (area.w * area.h) / total;
  const sizes = weights.map((w) => Math.max(0, w) * scale);
  const out: Rect[] = [];
  let free = { ...area };
  let row: number[] = [];
  const lay = (r: number[]) => {
    const sum = r.reduce((a, b) => a + b, 0);
    if (free.w >= free.h) {
      // A column down the left of what's free.
      const w = free.h > 0 ? sum / free.h : 0;
      let y = free.y;
      for (const s of r) {
        const h = w > 0 ? s / w : 0;
        out.push({ x: free.x, y, w, h });
        y += h;
      }
      free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h };
    } else {
      // A row along the top.
      const h = free.w > 0 ? sum / free.w : 0;
      let x = free.x;
      for (const s of r) {
        const w = h > 0 ? s / h : 0;
        out.push({ x, y: free.y, w, h });
        x += w;
      }
      free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h };
    }
  };
  for (const s of sizes) {
    const side = Math.min(free.w, free.h);
    if (row.length && worst([...row, s], side) > worst(row, side)) {
      lay(row);
      row = [];
    }
    row.push(s);
  }
  if (row.length) lay(row);
  return out;
}

// ---- The pipeline ------------------------------------------------------------------------------

/** The stages a trade goes through, in order, as the pipeline board shows them; the rest are where trades stop short. */
export const PIPELINE: readonly ProposalStage[] = ['idea', 'research', 'proposed', 'risk_review', 'cio_review', 'user_approval', 'executing', 'monitoring', 'exited', 'reviewed'];
const STOPPED: readonly ProposalStage[] = ['rejected', 'withdrawn', 'expired', 'failed'];

export interface PipelineStage {
  stage: ProposalStage | 'stopped';
  label: string;
  count: number;
  /** What's at it, newest first: "long BTC". */
  items: string[];
}

/** How many of the fund's proposals are at each stage of the workflow, and which, with the ones stopped short at the end. */
export function pipeline(s: Pick<FundState, 'proposals'>): PipelineStage[] {
  const newest = [...s.proposals].sort((a, b) => b.updatedAt - a.updatedAt);
  const at = (stages: readonly ProposalStage[]) => newest.filter((p) => stages.includes(p.stage)).map((p) => `${p.side} ${p.symbol}`);
  const rows: PipelineStage[] = PIPELINE.map((stage) => {
    const items = at([stage]);
    return { stage, label: STAGE_LABEL[stage], count: items.length, items };
  });
  const stopped = at(STOPPED);
  rows.push({ stage: 'stopped', label: 'Stopped', count: stopped.length, items: stopped });
  return rows;
}

// ---- The desks ---------------------------------------------------------------------------------

/** The fund's desks by department, in the departments' order, each department's by role title. */
export function desksByDepartment(s: Pick<FundState, 'desks'>): { department: Department; desks: DeskView[] }[] {
  const by = new Map<Department, DeskView[]>();
  for (const d of s.desks.desks) {
    const dep = ROLE_BY_ID.get(d.role)?.department;
    if (!dep) continue;
    by.set(dep, [...(by.get(dep) ?? []), d]);
  }
  return (Object.keys(DEPARTMENTS) as Department[])
    .filter((dep) => by.has(dep))
    .map((department) => ({ department, desks: by.get(department)!.sort((a, b) => (ROLE_BY_ID.get(a.role)?.title ?? '').localeCompare(ROLE_BY_ID.get(b.role)?.title ?? '')) }));
}

/** The table a seat's at, from its label ("🛡️ Risk, seat 2"), on a map whose tables have names. */
const tableOf = (label: string) => /^(.+), seat \d+$/.exec(label)?.[1];

/**
 * A free seat at the table named for `department` on a map (the trading floor's "🛡️ Risk", or
 * plain "Risk"), the first along it; none when the map has no such table or it's full. A new hire
 * for a role sits with its department this way.
 */
export function departmentSeat(plan: { desks: readonly DeskDef[]; overflow: readonly DeskDef[] }, department: Department, taken: (id: string) => boolean): string | undefined {
  const dep = DEPARTMENTS[department];
  const names = [`${dep.icon} ${dep.label}`, dep.label].map((n) => n.toLowerCase());
  return [...plan.desks, ...plan.overflow].find((d) => names.includes(tableOf(d.label)?.toLowerCase() ?? '') && !taken(d.id))?.id;
}
