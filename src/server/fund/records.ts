// The fund's records, each a hash-chained journal under <dataDir>/fund/ (see journal.ts): the ledger
// (cash, fills, limits, settings), the proposals, the NAV history and the activity log. Each reads
// its journal back on start and says whether the chain held; the fund stops trading if one didn't.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { applyCash, applyFill, emptyBook } from '../../shared/fund/book.js';
import { positionEvent, type PositionEvent } from '../../shared/fund/positions.js';
import { DEFAULT_LIMITS, checkLimits } from '../../shared/fund/risk.js';
import { DEFAULT_CAPITAL, DEFAULT_CONFIG, checkConfig, type FundConfig, type LedgerEntry, type NavPoint } from '../../shared/fund/state.js';
import type { ActivityEvent, ActivityKind, Actor, BookState, Fill, NavMarks, Proposal, RiskLimits } from '../../shared/fund/types.js';
import { Journal } from './journal.js';

/** What reading a record found wrong, or put right. */
export interface Readback {
  problem?: string;
  repaired?: string;
}

const SYSTEM: Actor = { kind: 'system', id: 'office', name: 'The office' };

/** The book, the limits and the settings, replayed from the ledger journal. */
export class Ledger implements Readback {
  private journal: Journal<LedgerEntry>;
  book: BookState = emptyBook(0);
  limits: RiskLimits = DEFAULT_LIMITS;
  config: FundConfig = DEFAULT_CONFIG;
  /** The latest fills, newest last. */
  fills: Fill[] = [];
  /** What each of the latest fills did to its position, newest last. */
  history: PositionEvent[] = [];
  problem?: string;
  repaired?: string;
  /** Whether anything has been written: false for a fund nobody has used yet. */
  used = false;
  /** A new fund's first entries, kept back until it's first used, so an office that never opens the fund has no trace of it. */
  private seed: LedgerEntry[] = [];

  constructor(dir: string, now: number) {
    this.journal = new Journal(path.join(dir, 'ledger.jsonl'));
    const read = this.journal.read();
    for (const e of read.entries) this.apply(e);
    this.problem = read.problem;
    this.repaired = read.repaired;
    // A new fund: the office pays in its capital and writes down the settings it starts on.
    if (read.ok && !read.entries.length) {
      this.seed = [
        { kind: 'cash', id: randomUUID(), at: now, amount: DEFAULT_CAPITAL, note: 'Starting capital', by: SYSTEM },
        { kind: 'config', id: randomUUID(), at: now, config: DEFAULT_CONFIG, by: SYSTEM },
        { kind: 'limits', id: randomUUID(), at: now, limits: DEFAULT_LIMITS, by: SYSTEM },
      ];
      for (const e of this.seed) this.apply(e);
    }
    this.used = read.entries.length > 0;
  }

  private apply(e: LedgerEntry) {
    if (e.kind === 'cash') this.book = applyCash(this.book, e.amount);
    else if (e.kind === 'fill') {
      const { kind: _, ...fill } = e;
      const before = this.book;
      this.book = applyFill(this.book, fill);
      this.fills.push(fill);
      this.history.push(positionEvent(before, this.book, fill));
      for (const kept of [this.fills, this.history]) if (kept.length > 500) kept.splice(0, kept.length - 500);
    } else if (e.kind === 'limits') {
      // Checked again on the way in: a ledger from an older version keeps whatever is still valid.
      const r = checkLimits(e.limits);
      this.limits = 'limits' in r ? r.limits : this.limits;
    } else if (e.kind === 'config') {
      const r = checkConfig(e.config);
      this.config = 'config' in r ? r.config : this.config;
    }
  }

  /** Writes an entry down and applies it. Refused while the journal doesn't check out. */
  append(e: LedgerEntry) {
    if (this.problem) throw new Error(this.problem);
    for (const s of this.seed.splice(0)) this.journal.append(s);
    this.journal.append(e);
    this.used = true;
    this.apply(e);
  }
}

/** Every proposal, kept as the snapshots it went through: the last one for each id is where it stands. */
export class ProposalRecords implements Readback {
  private journal: Journal<Proposal>;
  private byId = new Map<string, Proposal>();
  problem?: string;
  repaired?: string;

  constructor(dir: string) {
    this.journal = new Journal(path.join(dir, 'proposals.jsonl'));
    const read = this.journal.read();
    for (const p of read.entries) this.byId.set(p.id, p);
    this.problem = read.problem;
    this.repaired = read.repaired;
  }

  get(id: string): Proposal | undefined {
    return this.byId.get(id);
  }

  /** Newest first. */
  list(): Proposal[] {
    return [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  put(p: Proposal) {
    if (this.problem) throw new Error(this.problem);
    this.journal.append(p);
    this.byId.set(p.id, p);
  }
}

/** How often the NAV is written down, besides at every fill and every new day. */
const NAV_EVERY_MS = 15 * 60_000;
const NAV_KEPT = 2_000;

/** The NAV over time, and the marks (the day's start, the high-water mark) the last point carries. */
export class NavHistory implements Readback {
  private journal: Journal<NavPoint>;
  points: NavPoint[] = [];
  marks?: NavMarks;
  problem?: string;
  repaired?: string;

  constructor(dir: string) {
    this.journal = new Journal(path.join(dir, 'nav.jsonl'));
    const read = this.journal.read();
    this.points = read.entries.slice(-NAV_KEPT);
    const last = this.points.at(-1);
    if (last) this.marks = { day: last.day, dayStartNav: last.dayStartNav, peakNav: last.peakNav };
    this.problem = read.problem;
    this.repaired = read.repaired;
  }

  /** Takes the marks as they are now, and writes a point down when it's time (or `force`). */
  note(nav: number, marks: NavMarks, now: number, force = false) {
    const last = this.points.at(-1);
    this.marks = marks;
    if (this.problem) return;
    if (!force && last && last.day === marks.day && now - last.at < NAV_EVERY_MS) return;
    const p: NavPoint = { at: now, nav, day: marks.day, dayStartNav: marks.dayStartNav, peakNav: marks.peakNav };
    this.journal.append(p);
    this.points.push(p);
    if (this.points.length > NAV_KEPT) this.points.splice(0, this.points.length - NAV_KEPT);
  }
}

const ACTIVITY_KEPT = 500;

/** What happened in the fund, who did it and to what: every proposal, verdict, ruling, fill and change. */
export class ActivityLog implements Readback {
  private journal: Journal<ActivityEvent>;
  private recent: ActivityEvent[];
  problem?: string;
  repaired?: string;

  constructor(
    dir: string,
    private onEvent: (e: ActivityEvent) => void = () => {},
  ) {
    this.journal = new Journal(path.join(dir, 'activity.jsonl'));
    const read = this.journal.read();
    this.recent = read.entries.slice(-ACTIVITY_KEPT);
    this.problem = read.problem;
    this.repaired = read.repaired;
  }

  add(kind: ActivityKind, actor: Actor, text: string, extra: Pick<ActivityEvent, 'proposalId' | 'symbol' | 'level'> = {}, at = Date.now()): ActivityEvent {
    const e: ActivityEvent = { id: randomUUID(), at, kind, actor, text, ...extra };
    // A broken activity chain stops trading (the fund checks), but what happened is still shown.
    if (!this.problem) this.journal.append(e);
    this.recent.push(e);
    if (this.recent.length > ACTIVITY_KEPT) this.recent.splice(0, this.recent.length - ACTIVITY_KEPT);
    this.onEvent(e);
    return e;
  }

  /** The latest `limit`, newest last, optionally only about one proposal or symbol, or by one actor. */
  list(filter: { limit?: number; proposalId?: string; symbol?: string; actorId?: string; kind?: ActivityKind } = {}): ActivityEvent[] {
    const out = this.recent.filter(
      (e) => (!filter.proposalId || e.proposalId === filter.proposalId) && (!filter.symbol || e.symbol === filter.symbol) && (!filter.actorId || e.actor.id === filter.actorId) && (!filter.kind || e.kind === filter.kind),
    );
    return out.slice(-(filter.limit ?? 100));
  }
}
