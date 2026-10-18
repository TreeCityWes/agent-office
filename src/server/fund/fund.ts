import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { assetTable, cleanSymbol } from '../../shared/fund/assets.js';
import { rollMarks, valuePortfolio } from '../../shared/fund/book.js';
import { price, usd } from '../../shared/fund/format.js';
import { checkProposalInput, moveProposal, STAGE_LABEL } from '../../shared/fund/proposals.js';
import { checkLimits, evaluateRisk } from '../../shared/fund/risk.js';
import { ROLE_BY_ID, type Permission } from '../../shared/fund/roles.js';
import { checkConfig, type FundState } from '../../shared/fund/state.js';
import type { ActivityEvent, Actor, Asset, NavMarks, PortfolioView, PostTradeReview, Proposal, ProposalStage, RiskVerdict, Side } from '../../shared/fund/types.js';
import { MarketData, type MarketOptions } from './market/index.js';
import { ActivityLog, Ledger, NavHistory, ProposalRecords } from './records.js';
import { closePosition as runClose, exitProposal as runExit } from './exits.js';
import { PaperVenue, type ExecutionVenue } from './venue.js';

export type Result<T extends object = object> = ({ ok: true } & T) | { error: string };

export interface FundOptions {
  /** Where the fund keeps its journals: <dataDir>/fund. */
  dir: string;
  venue?: ExecutionVenue;
  /** Stand-ins for the market data sources (tests). */
  marketAdapters?: MarketOptions['adapters'];
  now?: () => number;
  /** Whether a CIO or PM is at a desk to rule on proposals before a person does. */
  hasRuler?: () => boolean;
  /** Something the dashboards show changed (at most every 250 ms). */
  onChange?: () => void;
  onActivity?: (e: ActivityEvent) => void;
}

const RISK: Actor = { kind: 'system', id: 'risk', name: 'Risk engine' };
const OFFICE: Actor = { kind: 'system', id: 'office', name: 'The office' };
/** Stages that need live prices: something about to be checked, decided on or watched. */
const WATCHED: readonly ProposalStage[] = ['proposed', 'risk_review', 'cio_review', 'user_approval', 'executing', 'monitoring'];
/** Stages a proposal can sit in waiting on someone, and so expire from. */
const WAITING: readonly ProposalStage[] = ['idea', 'research', 'cio_review', 'user_approval'];
const FINISHED_SHOWN = 30;

/** Who someone is, in a log line: "Ada (Macro Analyst)". */
export const who = (a: Actor) => (a.role && ROLE_BY_ID.get(a.role) ? `${a.name} (${ROLE_BY_ID.get(a.role)!.title})` : a.name);

/**
 * The fund: its paper book, its proposals and their way through risk and approval to a fill, the
 * market data everyone reads, and the activity log (see docs/fund.md). One per building. Agents and
 * people both act through it, and it's the only thing that writes the fund's records: no agent
 * touches a balance, and nothing reaches the venue but through the risk engine and a person's
 * approval. Everything that changes anything runs one at a time.
 */
export class Fund {
  ledger!: Ledger;
  proposals!: ProposalRecords;
  nav!: NavHistory;
  activity!: ActivityLog;
  readonly market: MarketData;
  readonly venue: ExecutionVenue;
  readonly now: () => number;
  private marks?: NavMarks;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private changeTimer?: NodeJS.Timeout;
  private exiting = new Set<string>();
  private tableFor?: { assets: readonly Asset[]; table: Map<string, Asset> };

  constructor(private opts: FundOptions) {
    this.now = opts.now ?? Date.now;
    this.load();
    this.venue = opts.venue ?? new PaperVenue(() => this.ledger.config);
    if (this.venue.live) throw new Error("This version of the fund trades on paper only: it won't run on a live venue");
    this.market = new MarketData({ mode: this.ledger.config.market, assets: () => this.assets(), mustWatch: () => this.mustWatch(), onQuotes: () => this.tick(), adapters: opts.marketAdapters, now: this.now });
  }

  private load() {
    this.ledger = new Ledger(this.opts.dir, this.now());
    this.proposals = new ProposalRecords(this.opts.dir);
    this.nav = new NavHistory(this.opts.dir);
    this.activity = new ActivityLog(this.opts.dir, (e) => this.opts.onActivity?.(e));
    this.marks = this.nav.marks;
    this.recover();
  }

  /** A proposal caught mid-fill when the office stopped: it filled if the ledger has its fill. */
  private recover() {
    if (this.halted()) return;
    for (const p of this.proposals.list()) {
      if (p.stage !== 'executing') continue;
      const fill = this.ledger.fills.find((f) => f.proposalId === p.id && f.reason === 'entry');
      const next = fill
        ? { ...this.move(p, 'monitoring', OFFICE, 'Filled before the office stopped'), qty: fill.qty, entryPrice: fill.price, entryFill: fill.id, fees: fill.fee }
        : this.move(p, 'failed', OFFICE, 'The office stopped before it filled');
      this.proposals.put(next);
    }
  }

  start() {
    this.market.start();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  stop() {
    this.market.stop();
    clearInterval(this.timer);
    clearTimeout(this.changeTimer);
  }

  // ---- What it shows ---------------------------------------------------------------------------

  /** Why the fund isn't trading, when one of its journals doesn't check out. */
  halted(): string | undefined {
    for (const [name, r] of [['ledger', this.ledger], ['proposals', this.proposals], ['NAV', this.nav], ['activity', this.activity]] as const)
      if (r.problem) return `The fund's ${name} journal doesn't check out (${r.problem}), so trading has stopped. See docs/fund.md#audit.`;
    return undefined;
  }

  assets(): Map<string, Asset> {
    const extra = this.ledger.config.assets;
    if (this.tableFor?.assets !== extra) this.tableFor = { assets: extra, table: assetTable(extra) };
    return this.tableFor.table;
  }

  portfolio(): PortfolioView {
    return valuePortfolio(this.ledger.book, this.market.all(), this.assets(), this.marks, this.now());
  }

  get config() {
    return this.ledger.config;
  }

  get limits() {
    return this.ledger.limits;
  }

  state(): FundState {
    const all = this.proposals.list();
    const live = all.filter((p) => WATCHED.includes(p.stage) || p.stage === 'idea' || p.stage === 'research' || p.stage === 'exited');
    const done = all.filter((p) => !live.includes(p)).slice(0, FINISHED_SHOWN);
    const halted = this.halted();
    return {
      paper: true,
      venue: this.venue.label,
      config: this.ledger.config,
      limits: this.ledger.limits,
      portfolio: this.portfolio(),
      proposals: [...live, ...done],
      market: this.market.state(),
      nav: this.nav.points.slice(-500),
      ...(halted ? { halted } : {}),
      notes: [this.ledger, this.proposals, this.nav, this.activity].flatMap((r) => (r.repaired ? [r.repaired] : [])),
    };
  }

  private mustWatch(): boolean {
    return Object.keys(this.ledger.book.positions).length > 0 || this.proposals.list().some((p) => WATCHED.includes(p.stage));
  }

  /** Lets the dashboards know, a quarter second later at most, however much changed meanwhile. */
  changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.opts.onChange?.();
    }, 250);
    this.changeTimer.unref?.();
  }

  // ---- The workflow ----------------------------------------------------------------------------

  /** Runs `fn` after everything before it: nothing that changes the fund ever overlaps. */
  serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * An action someone asked for, run in turn. A fund that's halted refuses it (unless `evenHalted`),
   * and anything that goes wrong inside comes back as an error rather than taking the office down.
   */
  private act<T extends object>(fn: () => Promise<Result<T>> | Result<T>, evenHalted = false): Promise<Result<T>> {
    return this.serial(async () => {
      const halted = evenHalted ? undefined : this.halted();
      if (halted) return { error: halted };
      try {
        return await fn();
      } catch (err) {
        console.error('agent-office: fund:', err);
        return { error: `The fund couldn't do that: ${err instanceof Error ? err.message : String(err)}` };
      }
    });
  }

  private can(by: Actor, perm: Permission): boolean {
    if (by.kind !== 'agent') return true;
    return !!by.role && !!ROLE_BY_ID.get(by.role)?.can.includes(perm);
  }

  private refuse(by: Actor, what: string): { error: string } {
    const role = by.role && ROLE_BY_ID.get(by.role);
    return { error: role ? `A ${role.title} doesn't ${what}.` : `Only a desk with a fund role may ${what}: a person gives it one in the 💼 Fund window.` };
  }

  /** `p` moved on to `to`. The workflow is fixed (proposals.ts), so a move it doesn't allow is a bug. */
  move(p: Proposal, to: ProposalStage, by: Actor, note?: string): Proposal {
    const r = moveProposal(p, to, by, this.now(), note);
    if ('error' in r) throw new Error(r.error);
    return r.proposal;
  }

  private find(id: unknown): Proposal | { error: string } {
    const p = typeof id === 'string' ? this.proposals.get(id.trim().toUpperCase()) : undefined;
    return p ?? { error: `There's no proposal ${String(id)}` };
  }

  /** The risk engine's verdict on a trade, against the book and prices as they are right now. */
  verdict(t: { symbol: string; side: Side; sizeUsd: number; stop?: number; target?: number }): RiskVerdict {
    return evaluateRisk({ ...t, portfolio: this.portfolio(), asset: this.assets().get(t.symbol), quote: this.market.quote(t.symbol), limits: this.ledger.limits, now: this.now() });
  }

  log(kind: ActivityEvent['kind'], by: Actor, text: string, extra: Pick<ActivityEvent, 'proposalId' | 'symbol' | 'level'> = {}) {
    this.activity.add(kind, by, text, extra, this.now());
    this.changed();
  }

  /** A trade checked by the risk engine without proposing it: what would go ahead, and why. */
  riskCheck(raw: unknown): Result<{ verdict: RiskVerdict }> {
    this.market.touch();
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const symbol = cleanSymbol(r.symbol ?? r.asset);
    if (!symbol) return { error: 'Which asset? Give its symbol, like BTC or NVDA' };
    const dir = String(r.side ?? r.direction ?? '').toLowerCase();
    const side: Side | undefined = dir === 'long' || dir === 'buy' ? 'long' : dir === 'short' || dir === 'sell' ? 'short' : undefined;
    if (!side) return { error: 'The direction is long or short' };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
    return { ok: true, verdict: this.verdict({ symbol, side, sizeUsd: num(r.sizeUsd ?? r.size) ?? 0, stop: num(r.stop), target: num(r.target) }) };
  }

  /** A trade put forward, by an agent or a person. A full proposal goes straight to risk review; an idea waits for research. */
  propose(raw: unknown, by: Actor, opts: { idea?: boolean } = {}): Promise<Result<{ proposal: Proposal }>> {
    return this.act(() => {
      if (!this.can(by, 'propose')) return this.refuse(by, 'propose trades');
      const c = checkProposalInput(raw, this.assets(), opts);
      if ('error' in c) return c;
      this.market.touch();
      const now = this.now();
      const id = `P-${this.proposals.list().length + 1}`;
      const stage: ProposalStage = opts.idea ? 'idea' : 'proposed';
      let p: Proposal = { ...c.input, id, author: by, createdAt: now, updatedAt: now, stage, history: [{ at: now, stage, by }] };
      const size = p.sizeUsd ? ` ${usd(p.sizeUsd, { compact: true })}` : '';
      this.log('proposal', by, `${opts.idea ? 'Idea' : 'Proposed'} ${id}: ${p.side} ${p.symbol}${size}. ${p.thesis.slice(0, 160)}`, { proposalId: id, symbol: p.symbol });
      if (!opts.idea) p = this.riskReview(p);
      this.proposals.put(p);
      return { ok: true, proposal: p };
    });
  }

  /** An idea (or one under research) filled in as a full proposal by its author, or a person: off to risk review. */
  promote(id: unknown, raw: unknown, by: Actor): Promise<Result<{ proposal: Proposal }>> {
    return this.act(() => {
      const found = this.find(id);
      if ('error' in found) return found;
      if (found.stage !== 'idea' && found.stage !== 'research') return { error: `${found.id} is ${STAGE_LABEL[found.stage]}, not an idea` };
      if (by.kind === 'agent' && by.id !== found.author.id && !this.can(by, 'propose')) return this.refuse(by, 'propose trades');
      const c = checkProposalInput({ ...found, ...(raw && typeof raw === 'object' ? raw : {}) }, this.assets());
      if ('error' in c) return c;
      let p = this.move({ ...found, ...c.input }, 'proposed', by);
      this.log('proposal', by, `Proposed ${p.id}: ${p.side} ${p.symbol} ${usd(p.sizeUsd, { compact: true })}`, { proposalId: p.id, symbol: p.symbol });
      p = this.riskReview(p);
      this.proposals.put(p);
      return { ok: true, proposal: p };
    });
  }

  /** Risk review, which is the risk engine's call alone: rejected there, or on to the CIO or a person. */
  private riskReview(p: Proposal): Proposal {
    p = this.move(p, 'risk_review', RISK);
    const v = this.verdict(p);
    p = { ...p, risk: v };
    const said = v.decision === 'approved' ? `approved at ${usd(v.approvedUsd)}` : v.decision === 'resized' ? `resized to ${usd(v.approvedUsd)}` : 'rejected';
    this.log('risk', RISK, `${p.id} ${said}${v.reasons.length ? `: ${v.reasons.join('; ')}` : ''}`, { proposalId: p.id, symbol: p.symbol, level: v.decision === 'approved' ? 'good' : v.decision === 'resized' ? 'warn' : 'bad' });
    if (v.decision === 'rejected') return this.move(p, 'rejected', RISK, v.reasons.join('; '));
    if (this.ledger.config.requireCio && this.opts.hasRuler?.()) return this.move(p, 'cio_review', RISK);
    return this.move(p, 'user_approval', RISK);
  }

  /** The CIO or PM (or a person) rules on a proposal waiting for them: on to a person, or rejected. */
  rule(id: unknown, decision: 'approve' | 'reject', note: string | undefined, by: Actor): Promise<Result<{ proposal: Proposal }>> {
    return this.act(() => {
      const found = this.find(id);
      if ('error' in found) return found;
      if (!this.can(by, 'rule')) return this.refuse(by, 'rule on proposals');
      if (found.stage !== 'cio_review') return { error: `${found.id} is ${STAGE_LABEL[found.stage]}: only a proposal at CIO review is ruled on` };
      if (by.kind === 'agent' && found.author.id === by.id) return { error: `You proposed ${found.id}: someone else rules on it` };
      const ruling = { by, decision, at: this.now(), ...(note ? { note: note.slice(0, 500) } : {}) };
      const p = { ...this.move(found, decision === 'approve' ? 'user_approval' : 'rejected', by, note), cio: ruling };
      this.proposals.put(p);
      this.log('ruling', by, `${decision === 'approve' ? 'Backed' : 'Turned down'} ${p.id} (${p.side} ${p.symbol})${note ? `: ${note.slice(0, 200)}` : ''}`, { proposalId: p.id, symbol: p.symbol, level: decision === 'approve' ? 'good' : 'bad' });
      return { ok: true, proposal: p };
    });
  }

  /**
   * A person approves: risk runs again on the prices of the moment, and what it allows goes to the
   * venue. Only a person approves, never an agent; from CIO review it skips the CIO, on the record.
   */
  approve(id: unknown, note: string | undefined, by: Actor): Promise<Result<{ proposal: Proposal }>> {
    return this.act(async () => {
      if (by.kind !== 'user') return { error: 'Only a person approves a trade' };
      const found = this.find(id);
      if ('error' in found) return found;
      if (found.stage !== 'user_approval' && found.stage !== 'cio_review') return { error: `${found.id} is ${STAGE_LABEL[found.stage]}: it isn't waiting for approval` };
      const ruling = { by, decision: 'approve' as const, at: this.now(), ...(note ? { note: note.slice(0, 500) } : {}) };
      let p: Proposal = found.stage === 'cio_review' ? this.move(found, 'user_approval', by, 'Approved without waiting for the CIO') : found;
      p = { ...this.move(p, 'executing', by, note), user: ruling };
      this.log('ruling', by, `Approved ${p.id} (${p.side} ${p.symbol})${note ? `: ${note.slice(0, 200)}` : ''}`, { proposalId: p.id, symbol: p.symbol, level: 'good' });
      return this.enter(p, by);
    });
  }

  /** An approved proposal goes in: checked by risk once more, then filled at what risk allows now. */
  private async enter(p: Proposal, by: Actor): Promise<Result<{ proposal: Proposal }>> {
    const v = this.verdict(p);
    p = { ...p, risk: v };
    if (v.decision === 'rejected') {
      p = this.move(p, 'rejected', RISK, `At approval: ${v.reasons.join('; ')}`);
      this.proposals.put(p);
      this.log('risk', RISK, `${p.id} rejected at approval: ${v.reasons.join('; ')}`, { proposalId: p.id, symbol: p.symbol, level: 'bad' });
      return { error: `Risk rejected ${p.id} on today's numbers: ${v.reasons.join('; ')}` };
    }
    const quote = this.market.quote(p.symbol)!;
    // Sized at the price after slippage, so what fills is what risk allowed, not a little over.
    const side = p.side === 'long' ? 1 : -1;
    // Rounded as the book rounds it, so the trade and the position agree on what it holds.
    const qty = Math.round(((side * v.approvedUsd) / (quote.price * (1 + (side * this.ledger.config.slippageBps) / 10_000))) * 1e10) / 1e10;
    try {
      const fill = await this.venue.execute({ symbol: p.symbol, qty, reason: 'entry', proposalId: p.id, by }, quote, this.now());
      this.ledger.append({ kind: 'fill', ...fill });
      p = { ...this.move(p, 'monitoring', OFFICE, v.decision === 'resized' ? `Resized to ${usd(v.approvedUsd)}` : undefined), qty: fill.qty, entryPrice: fill.price, entryFill: fill.id, fees: fill.fee };
      this.proposals.put(p);
      this.notedFill();
      this.log('fill', OFFICE, `${fill.qty > 0 ? 'Bought' : 'Sold short'} ${Math.abs(fill.qty).toPrecision(6)} ${p.symbol} at ${price(fill.price)} (${usd(Math.abs(fill.qty * fill.price))}) for ${p.id}, on ${this.venue.label.toLowerCase()}`, { proposalId: p.id, symbol: p.symbol, level: 'good' });
      return { ok: true, proposal: p };
    } catch (err) {
      p = this.move(p, 'failed', OFFICE, err instanceof Error ? err.message : String(err));
      this.proposals.put(p);
      this.log('fill', OFFICE, `${p.id} didn't fill: ${err instanceof Error ? err.message : String(err)}`, { proposalId: p.id, symbol: p.symbol, level: 'bad' });
      return { error: `${p.id} didn't fill: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** A person turns down a proposal waiting on a decision. */
  reject(id: unknown, note: string | undefined, by: Actor): Promise<Result<{ proposal: Proposal }>> {
    return this.act(() => {
      if (by.kind !== 'user') return { error: 'Only a person rejects a trade outright; the CIO rules with fund_rule' };
      const found = this.find(id);
      if ('error' in found) return found;
      if (found.stage !== 'user_approval' && found.stage !== 'cio_review') return { error: `${found.id} is ${STAGE_LABEL[found.stage]}: it isn't waiting on a decision` };
      const p = { ...this.move(found, 'rejected', by, note), user: { by, decision: 'reject' as const, at: this.now(), ...(note ? { note: note.slice(0, 500) } : {}) } };
      this.proposals.put(p);
      this.log('ruling', by, `Rejected ${p.id} (${p.side} ${p.symbol})${note ? `: ${note.slice(0, 200)}` : ''}`, { proposalId: p.id, symbol: p.symbol, level: 'bad' });
      return { ok: true, proposal: p };
    });
  }

  /** Its author (or a person) takes a proposal back before it trades. */
  withdraw(id: unknown, note: string | undefined, by: Actor): Promise<Result<{ proposal: Proposal }>> {
    return this.act(() => {
      const found = this.find(id);
      if ('error' in found) return found;
      if (by.kind === 'agent' && found.author.id !== by.id) return { error: `${found.id} is ${found.author.name}'s to withdraw` };
      if (!['idea', 'research', 'proposed', 'cio_review', 'user_approval'].includes(found.stage)) return { error: `${found.id} is ${STAGE_LABEL[found.stage]}: too late to withdraw` };
      const p = this.move(found, 'withdrawn', by, note);
      this.proposals.put(p);
      this.log('proposal', by, `Withdrew ${p.id}${note ? `: ${note.slice(0, 200)}` : ''}`, { proposalId: p.id, symbol: p.symbol });
      return { ok: true, proposal: p };
    });
  }

  /** What a trade taught, once it's out: whether the thesis held, whatever the P&L did. */
  review(id: unknown, raw: { thesisHeld?: unknown; lessons?: unknown }, by: Actor): Promise<Result<{ proposal: Proposal }>> {
    return this.act(() => {
      const found = this.find(id);
      if ('error' in found) return found;
      if (found.stage !== 'exited') return { error: `${found.id} is ${STAGE_LABEL[found.stage]}: a trade is reviewed once it's exited` };
      if (typeof raw.thesisHeld !== 'boolean') return { error: 'thesisHeld: did the thesis play out, true or false?' };
      const lessons = typeof raw.lessons === 'string' ? raw.lessons.trim().slice(0, 2000) : '';
      if (lessons.length < 10) return { error: 'lessons: what it taught, in a sentence or more' };
      const review: PostTradeReview = { by, at: this.now(), thesisHeld: raw.thesisHeld, lessons };
      const p = { ...this.move(found, 'reviewed', by), review };
      this.proposals.put(p);
      this.log('review', by, `Reviewed ${p.id}: the thesis ${review.thesisHeld ? 'held' : "didn't hold"}. ${lessons.slice(0, 200)}`, { proposalId: p.id, symbol: p.symbol });
      return { ok: true, proposal: p };
    });
  }

  // ---- Exits -----------------------------------------------------------------------------------

  /** A person takes one trade off, at the market. */
  exit(id: unknown, by: Actor): Promise<Result<{ proposal: Proposal }>> {
    return this.act(() => {
      if (by.kind !== 'user') return { error: 'Only a person closes a trade by hand; stops and targets close by themselves' };
      const found = this.find(id);
      if ('error' in found) return found;
      return runExit(this, found, 'exit', by);
    });
  }

  /** A person closes a whole position, every trade in it with it. */
  close(symbol: unknown, by: Actor): Promise<Result<{ symbol: string }>> {
    return this.act(() => {
      if (by.kind !== 'user') return { error: 'Only a person closes a position by hand' };
      const s = cleanSymbol(symbol);
      if (!s || !this.ledger.book.positions[s]) return { error: `The fund holds no ${String(symbol)}` };
      return runClose(this, s, by);
    });
  }

  /** Written down after a fill, so the NAV chart and the marks have it. */
  notedFill() {
    const p = this.portfolio();
    this.marks = rollMarks(this.marks, p.nav, this.now());
    this.nav.note(p.nav, this.marks, this.now(), true);
  }

  /**
   * On every new price and once a minute: the marks move on, stops and targets are checked on fresh
   * prices, and proposals nobody decided on expire.
   */
  tick() {
    // A fund nobody has used yet has nothing to watch or write down, but its prices still show.
    if (!this.ledger.used && !this.proposals.list().length) return this.changed();
    if (this.halted()) return this.changed();
    const now = this.now();
    const p = this.portfolio();
    this.marks = rollMarks(this.marks, p.nav, now);
    this.nav.note(p.nav, this.marks, now);
    const maxAge = this.ledger.limits.maxQuoteAgeMin * 60_000;
    for (const prop of this.proposals.list()) {
      if (prop.stage === 'monitoring' && !this.exiting.has(prop.id)) {
        const q = this.market.quote(prop.symbol);
        if (!q || now - q.at > maxAge) continue;
        const long = prop.side === 'long';
        const reason = prop.stop && (long ? q.price <= prop.stop : q.price >= prop.stop) ? 'stop' : prop.target && (long ? q.price >= prop.target : q.price <= prop.target) ? 'target' : undefined;
        if (!reason) continue;
        this.exiting.add(prop.id);
        void this.serial(async () => {
          const cur = this.proposals.get(prop.id);
          if (cur?.stage === 'monitoring') await runExit(this, cur, reason, OFFICE);
        })
          .catch((err) => console.error(`agent-office: fund: exiting ${prop.id}:`, err))
          .finally(() => this.exiting.delete(prop.id));
      } else if (WAITING.includes(prop.stage) && now - prop.updatedAt > this.ledger.config.proposalTtlHours * 3_600_000) {
        void this.serial(() => {
          const cur = this.proposals.get(prop.id);
          if (!cur || !WAITING.includes(cur.stage) || now - cur.updatedAt <= this.ledger.config.proposalTtlHours * 3_600_000) return;
          this.proposals.put(this.move(cur, 'expired', OFFICE, `Nobody decided in ${this.ledger.config.proposalTtlHours}h`));
          this.log('proposal', OFFICE, `${cur.id} expired: nobody decided on it in ${this.ledger.config.proposalTtlHours}h`, { proposalId: cur.id, symbol: cur.symbol });
        }).catch((err) => console.error(`agent-office: fund: expiring ${prop.id}:`, err));
      }
    }
    this.changed();
  }

  // ---- Settings (people only) ------------------------------------------------------------------

  setLimits(raw: unknown, by: Actor): Promise<Result> {
    return this.act(() => {
      if (by.kind !== 'user') return { error: 'Only a person changes the risk limits' };
      const r = checkLimits(raw, this.ledger.limits);
      if ('error' in r) return r;
      const before = this.ledger.limits;
      const changed = (Object.keys(r.limits) as (keyof typeof before)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(r.limits[k]));
      if (!changed.length) return { ok: true };
      this.ledger.append({ kind: 'limits', id: randomUUID(), at: this.now(), limits: r.limits, by });
      this.log('limits', by, `Changed the risk limits: ${changed.map((k) => `${k} ${JSON.stringify(before[k])} → ${JSON.stringify(r.limits[k])}`).join(', ')}`, { level: 'warn' });
      return { ok: true };
    });
  }

  setConfig(raw: unknown, by: Actor): Promise<Result> {
    return this.act(() => {
      if (by.kind !== 'user') return { error: "Only a person changes the fund's settings" };
      const r = checkConfig(raw, this.ledger.config);
      if ('error' in r) return r;
      const before = this.ledger.config;
      const changed = (Object.keys(r.config) as (keyof typeof before)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(r.config[k]));
      if (!changed.length) return { ok: true };
      this.ledger.append({ kind: 'config', id: randomUUID(), at: this.now(), config: r.config, by });
      if (r.config.market !== before.market) this.market.setMode(r.config.market);
      this.log('system', by, `Changed the fund's settings: ${changed.join(', ')}${r.config.market !== before.market ? ` (market data is now ${r.config.market === 'mock' ? 'the MOCK market' : 'public sources'})` : ''}`);
      return { ok: true };
    });
  }

  /** A person pays capital in (positive) or takes it out: it moves the NAV, but isn't profit or loss. */
  adjustCash(amount: unknown, note: string | undefined, by: Actor): Promise<Result> {
    return this.act<object>(() => {
      if (by.kind !== 'user') return { error: 'Only a person moves capital in or out' };
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1e12) return { error: 'amount is the USD paid in (positive) or taken out (negative)' };
      if (amount < 0 && -amount > this.ledger.book.cash) return { error: `Only ${usd(this.ledger.book.cash)} is in cash` };
      this.ledger.append({ kind: 'cash', id: randomUUID(), at: this.now(), amount, ...(note ? { note: note.slice(0, 200) } : {}), by });
      // Capital isn't performance: the day's start and the high-water mark move with it.
      if (this.marks) this.marks = { ...this.marks, dayStartNav: this.marks.dayStartNav + amount, peakNav: this.marks.peakNav + amount };
      this.notedFill();
      this.log('system', by, `${amount > 0 ? 'Paid in' : 'Took out'} ${usd(Math.abs(amount))}${note ? `: ${note.slice(0, 200)}` : ''}`);
      return { ok: true };
    });
  }

  /** Starts a new fund from nothing, the old one's records moved aside (fund-<time>), not deleted. */
  reset(by: Actor): Promise<Result<{ archived: string }>> {
    return this.act<{ archived: string }>(() => {
      if (by.kind !== 'user') return { error: 'Only a person starts the fund over' };
      const archived = `${this.opts.dir}-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
      if (existsSync(this.opts.dir)) renameSync(this.opts.dir, archived);
      this.load();
      this.market.setMode(this.ledger.config.market);
      this.log('system', by, `Started the fund over; the old one's records are in ${archived}`, { level: 'warn' });
      return { ok: true, archived };
    }, true);
  }
}
