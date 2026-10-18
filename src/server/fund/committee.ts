import path from 'node:path';
import { checkBallot, checkConvene, checkDecision, COMMITTEE_STATUS_LABEL, MAX_SEATS, MIN_SEATS, tally, type Ballot, type Committee, type Tally } from '../../shared/fund/committee.js';
import { deskName } from '../../shared/fund/desks.js';
import { price, usd } from '../../shared/fund/format.js';
import { ROLE_BY_ID } from '../../shared/fund/roles.js';
import type { ActivityEvent, Actor, Proposal } from '../../shared/fund/types.js';
import type { Desks } from './desks.js';
import { Journal } from './journal.js';

/** What the committee needs of the fund. */
export interface CommitteeFund {
  readonly now: () => number;
  readonly proposals: { get(id: string): Proposal | undefined };
  readonly desks: Desks;
  log(kind: ActivityEvent['kind'], by: Actor, text: string, extra?: Pick<ActivityEvent, 'proposalId' | 'symbol' | 'level'>): void;
  changed(): void;
}

type Result<T extends object = object> = ({ ok: true } & T) | { error: string };

const CHAIR: Actor = { kind: 'system', id: 'committee', name: 'The committee' };
const SHOWN = 20;
const TICK_MS = 15_000;
/** However short the vote, the chair has at least this long to decide once the ballots are open. */
const DECIDE_MIN_MS = 10 * 60_000;

const title = (role: string) => ROLE_BY_ID.get(role)?.title ?? role;
const pct = (n: number) => `${n > 0 ? '+' : ''}${n}`;
const tallyLine = (t: Tally) => `BUY ${t.BUY} · HOLD ${t.HOLD} · SELL ${t.SELL}, score ${pct(t.score)}, leaning ${t.lean}`;
const ballotLine = (b: Ballot) =>
  `- ${title(b.role)} (${b.by.name}): ${b.vote} at ${b.confidence}%${b.revised ? ' (revised)' : ''}. ${b.argument}${b.evidence.length ? `\n  Evidence: ${b.evidence.join('; ')}` : ''}\n  Risks: ${b.risks.join('; ')}`;

/** A proposal as the committee is asked about it. */
function brief(p: Proposal): string {
  const risk = p.risk ? ` Risk engine: ${p.risk.decision}${p.risk.decision === 'rejected' ? '' : ` at ${usd(p.risk.approvedUsd)}`}.` : '';
  return (
    `${p.id} from ${deskName(p.author)}: ${p.side} ${p.symbol} ${usd(p.sizeUsd)}${p.entry ? ` at ${price(p.entry)}` : ''}, stop ${p.stop ? price(p.stop) : 'none'}, target ${p.target ? price(p.target) : 'none'}, ` +
    `${p.horizon}, confidence ${p.confidence}%.${risk}\nThesis: ${p.thesis}${p.catalyst ? `\nCatalyst: ${p.catalyst}` : ''}${p.evidence?.length ? `\nEvidence: ${p.evidence.join('; ')}` : ''}${p.dissent ? `\nDissent: ${p.dissent}` : ''}`
  );
}

/**
 * The investment committee (docs/fund.md#the-investment-committee). The CIO or PM (fund_committee),
 * or a person from the window, puts a question to the desks: each seat casts a sealed BUY / HOLD /
 * SELL ballot with its confidence, argument, evidence and risks, and the Skeptic always sits. When
 * every seat has voted, or time's up, the ballots open: seats may revise, and the chair decides with a
 * summary. A committee advises; it never places a trade. Each one is kept as its snapshots in
 * committees.jsonl, a hash-chained journal like the proposals', and every step is in the activity log.
 */
export class Committees {
  private journal: Journal<Committee>;
  private byId = new Map<string, Committee>();
  private timer: NodeJS.Timeout;
  problem?: string;
  repaired?: string;

  constructor(
    private fund: CommitteeFund,
    dir: string,
  ) {
    this.journal = new Journal(path.join(dir, 'committees.jsonl'));
    const read = this.journal.read();
    for (const c of read.entries) this.byId.set(c.id, c);
    this.problem = read.problem;
    this.repaired = read.repaired;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  get(id: unknown): Committee | undefined {
    return this.byId.get(String(id ?? '').trim().toUpperCase());
  }

  /** Newest first. */
  list(): Committee[] {
    return [...this.byId.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  /** What the window shows: every committee still sitting, then the latest finished. */
  state(): Committee[] {
    const all = this.list();
    const sitting = all.filter((c) => c.status === 'voting' || c.status === 'open');
    return [...sitting, ...all.filter((c) => !sitting.includes(c)).slice(0, SHOWN)];
  }

  /** The latest decision on a proposal, if a committee reached one. */
  decidedFor(proposalId: string): Committee | undefined {
    return this.list().find((c) => c.proposalId === proposalId && c.status === 'decided');
  }

  /** A committee as an agent may see it: while voting, only its own ballot and who else has voted. */
  view(c: Committee, by: Actor) {
    const t = tally(c);
    const sealed = c.status === 'voting';
    return {
      ...c,
      status: COMMITTEE_STATUS_LABEL[c.status],
      chair: c.chair ? title(c.chair) : 'the people running the fund',
      seats: c.seats.map((s) => ({ role: s, title: title(s), voted: c.ballots.some((b) => b.role === s) })),
      ballots: sealed ? c.ballots.filter((b) => b.by.id === by.id) : c.ballots,
      ...(sealed ? { sealed: 'Ballots are sealed until every seat has voted or voting closes' } : { tally: t }),
      closesAt: new Date(c.closesAt).toISOString(),
      ...(c.decideBy ? { decideBy: new Date(c.decideBy).toISOString() } : {}),
    };
  }

  private put(c: Committee) {
    if (this.problem) throw new Error(this.problem);
    c.updatedAt = this.fund.now();
    this.journal.append(c);
    this.byId.set(c.id, c);
    this.fund.changed();
  }

  private extra(c: Committee, level?: ActivityEvent['level']) {
    return { ...(c.proposalId ? { proposalId: c.proposalId } : {}), ...(c.symbol ? { symbol: c.symbol } : {}), ...(level ? { level } : {}) };
  }

  /** Types a note into the agent at each of these desks, and keeps it with the messages between desks. */
  private tell(c: Committee, roles: string[], summary: string, text: (role: string) => string) {
    for (const role of roles) this.fund.desks.notify(CHAIR, role, `${c.id}: ${summary}`, text(role), 'committee', c.proposalId);
  }

  /** Calls a committee: the CIO or PM (with fund_committee), or a person from the window. */
  convene(by: Actor, raw: unknown): Result<{ committee: Committee }> {
    const desks = this.fund.desks;
    let chair: string | undefined;
    if (by.kind === 'agent') {
      const mine = desks.profile(by.id);
      if (!mine) return { error: 'You hold no desk at the fund' };
      if (!ROLE_BY_ID.get(mine.role)?.can.includes('committee')) return { error: `A ${title(mine.role)} doesn't call the committee: ask the CIO (fund_message to "cio")` };
      chair = mine.role;
    }
    const r = checkConvene(raw);
    if ('error' in r) return r;
    const p = r.proposalId ? this.fund.proposals.get(r.proposalId) : undefined;
    if (r.proposalId && !p) return { error: `There's no proposal ${r.proposalId}` };
    if (p && this.list().some((c) => c.proposalId === p.id && (c.status === 'voting' || c.status === 'open'))) return { error: `A committee is already sitting on ${p.id}` };
    if (!desks.holder('skeptic')) return { error: 'The committee always seats the Skeptic, and nobody holds that desk: staff it first' };
    const staffed = desks.state().desks.map((d) => d.role);
    const asked = r.seats ?? staffed;
    const vacant = asked.filter((s) => !desks.holder(s));
    if (r.seats && vacant.length) return { error: `Nobody holds ${vacant.map(title).join(', ')} right now: seat staffed desks (fund_desks lists them)` };
    const seats = [...new Set([...asked.filter((s) => s !== chair && desks.holder(s)), 'skeptic'])].slice(-MAX_SEATS);
    if (seats.length < MIN_SEATS) return { error: `A committee needs at least ${MIN_SEATS} seats besides its chair, the Skeptic one of them: staff more desks` };
    const now = this.fund.now();
    const c: Committee = {
      id: `C-${this.byId.size + 1}`,
      question: r.question,
      ...(p ? { proposalId: p.id } : {}),
      ...((r.symbol ?? p?.symbol) ? { symbol: r.symbol ?? p?.symbol } : {}),
      calledBy: by,
      ...(chair ? { chair } : {}),
      seats,
      status: 'voting',
      ballots: [],
      openedAt: now,
      closesAt: now + r.minutes * 60_000,
      updatedAt: now,
    };
    this.put(c);
    this.fund.log('committee', by, `Called committee ${c.id}: ${c.question} (${seats.map(title).join(', ')}; ${r.minutes} min)`, this.extra(c));
    const others = (role: string) => seats.filter((s) => s !== role).map(title).join(', ');
    this.tell(c, seats, `called by ${by.name}: ${c.question}`, (role) =>
      [
        `🏛️ Investment committee ${c.id}, called by ${deskName(by)}:`,
        '',
        c.question,
        ...(p ? ['', brief(p)] : []),
        '',
        `At the table with you: ${others(role)}. ${c.chair ? `The ${title(c.chair)} chairs and decides.` : 'The people running the fund decide.'} Voting closes in ${r.minutes} minutes, and ballots are sealed until everyone has voted.`,
        `Cast yours with fund_ballot: {"id":"${c.id}","vote":"BUY|HOLD|SELL","confidence":0-100,"argument":"…","evidence":["…"],"risks":["…"]}. fund_committees {"id":"${c.id}"} shows it again.`,
        ...(role === 'skeptic' ? ['', 'You are the Skeptic: make the strongest case against, whatever you privately think. If everyone agrees, that is when you are needed most.'] : []),
      ].join('\n'),
    );
    if (!c.chair) this.fund.desks.announceToPeople(`🏛️ ${c.id} is sitting: ${c.question}`);
    return { ok: true, committee: c };
  }

  /** A seat's ballot: sealed while voting; after the ballots open, a revision. */
  ballot(by: Actor, raw: unknown): Result<{ committee: Committee; ballot: Ballot }> {
    const c = this.get((raw as { id?: unknown } | null)?.id);
    if (!c) return { error: 'id: the committee (C-1…), as fund_committees lists them' };
    const role = by.kind === 'agent' ? this.fund.desks.profile(by.id)?.role : undefined;
    if (!role || !c.seats.includes(role)) return { error: `You don't sit on ${c.id}: its seats are ${c.seats.map(title).join(', ')}` };
    if (c.status !== 'voting' && c.status !== 'open') return { error: `${c.id} is ${COMMITTEE_STATUS_LABEL[c.status].toLowerCase()}: too late to vote` };
    const b = checkBallot(raw);
    if ('error' in b) return b;
    const had = c.ballots.find((x) => x.role === role);
    const ballot: Ballot = { role, by, ...b, at: this.fund.now(), ...(c.status === 'open' ? { revised: true } : {}) };
    const next: Committee = { ...c, ballots: [...c.ballots.filter((x) => x.role !== role), ballot] };
    this.put(next);
    // While sealed, the log (which any desk can read) says who voted, not how.
    const said = c.status === 'voting' ? `${had ? 'Changed its sealed ballot' : 'Cast a sealed ballot'} on ${c.id}` : `${had ? 'Revised' : 'Cast'} its ballot on ${c.id}: ${b.vote} at ${b.confidence}%`;
    this.fund.log('committee', by, said, this.extra(c));
    if (next.status === 'voting' && next.seats.every((s) => next.ballots.some((x) => x.role === s))) return { ok: true, committee: this.open(next, 'everyone voted'), ballot };
    return { ok: true, committee: next, ballot };
  }

  /** Opens the ballots now: the chair or a person cutting the vote short. */
  close(by: Actor, id: unknown): Result<{ committee: Committee }> {
    const c = this.get(id);
    if (!c) return { error: `There's no committee ${String(id ?? '')}` };
    if (c.status !== 'voting') return { error: `${c.id} isn't voting` };
    if (by.kind === 'agent' && this.fund.desks.profile(by.id)?.role !== c.chair) return { error: `Only ${c.id}'s chair closes its vote` };
    return { ok: true, committee: this.open(c, `${by.name} closed the vote`) };
  }

  private open(c: Committee, why: string): Committee {
    const now = this.fund.now();
    const next: Committee = { ...c, status: 'open', decideBy: now + Math.max(DECIDE_MIN_MS, c.closesAt - c.openedAt) };
    this.put(next);
    const t = tally(next);
    const missing = t.abstained.length ? `; no ballot from ${t.abstained.map(title).join(', ')}` : '';
    this.fund.log('committee', CHAIR, `${c.id}'s ballots are open (${why}${missing}): ${tallyLine(t)}`, this.extra(c, 'info'));
    const ballots = next.ballots.map(ballotLine).join('\n') || '(none)';
    const until = new Date(next.decideBy!).toISOString();
    this.tell(next, next.seats, `ballots open, ${tallyLine(t)}`, () => `🏛️ ${c.id}'s ballots are open (${why}${missing}).\n\n${ballots}\n\nTally: ${tallyLine(t)}.\nYou may revise your ballot with fund_ballot until the decision.`);
    if (next.chair)
      this.tell(next, [next.chair], 'waits on your decision', () => `🏛️ You chair ${c.id}: ${c.question}\n\n${ballots}\n\nTally: ${tallyLine(t)}.\nDecide with fund_decide {"id":"${c.id}","vote":"BUY|HOLD|SELL","summary":"…what the committee found, the dissent, and why"} by ${until}.`);
    else this.fund.desks.announceToPeople(`🏛️ ${c.id}'s ballots are open (${tallyLine(t)}): it waits on a person's decision in the 💼 Fund window`);
    return next;
  }

  /** The chair's decision (or a person's, who may decide any committee): on the record, with its summary. */
  decide(by: Actor, raw: unknown): Result<{ committee: Committee }> {
    const c = this.get((raw as { id?: unknown } | null)?.id);
    if (!c) return { error: 'id: the committee (C-1…), as fund_committees lists them' };
    if (by.kind === 'agent' && (!c.chair || this.fund.desks.profile(by.id)?.role !== c.chair)) return { error: `Only ${c.id}'s chair decides it${c.chair ? `: the ${title(c.chair)}` : ', and a person chairs this one'}` };
    if (c.status === 'voting' && by.kind === 'agent') return { error: `${c.id} is still voting: wait for the ballots, or open them now with fund_committee_close` };
    if (c.status !== 'voting' && c.status !== 'open') return { error: `${c.id} is ${COMMITTEE_STATUS_LABEL[c.status].toLowerCase()} already` };
    const d = checkDecision(raw);
    if ('error' in d) return d;
    const t = tally(c);
    const next: Committee = { ...c, status: 'decided', decision: { ...d, by, at: this.fund.now() } };
    this.put(next);
    const against = d.vote !== t.lean ? ` (against the ballots' ${t.lean})` : '';
    this.fund.log('committee', by, `Decided ${c.id}: ${d.vote}${against}. ${d.summary.slice(0, 300)}`, this.extra(c, d.vote === 'HOLD' ? 'warn' : 'good'));
    // The seats hear it, and so does the desk whose proposal it was, wherever it sat.
    const p = c.proposalId ? this.fund.proposals.get(c.proposalId) : undefined;
    const author = p?.author.kind === 'agent' ? this.fund.desks.profile(p.author.id)?.role : undefined;
    const told = [...new Set([...next.seats, ...(author && author !== c.chair ? [author] : [])])];
    this.tell(next, told, `decided ${d.vote}`, () => `🏛️ ${c.id} decided: ${d.vote}${against}, by ${deskName(by)}.\n\n${d.summary}\n\nFinal tally: ${tallyLine(t)}.`);
    return { ok: true, committee: next };
  }

  /** Voting that ran out of time opens; a decision that never came lapses. */
  tick() {
    if (this.problem) return;
    const now = this.fund.now();
    for (const c of this.list()) {
      if (c.status === 'voting' && now >= c.closesAt) this.open(c, 'time ran out');
      else if (c.status === 'open' && c.decideBy && now >= c.decideBy) {
        this.put({ ...c, status: 'lapsed' });
        this.fund.log('committee', CHAIR, `${c.id} lapsed: nobody decided in time. The ballots stand: ${tallyLine(tally(c))}`, this.extra(c, 'warn'));
      }
    }
  }
}
