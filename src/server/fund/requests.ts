// Research requests between the desks (docs/fund.md#research-requests-and-routines). A desk (fund_request),
// or a person from the Research tab, asks another desk a question: it's typed into the agent there, and
// stays open until whoever holds that desk answers it (fund_answer), when the asker hears the answer.
// One past its due time reminds the desk once. Each request is kept as its snapshots in requests.jsonl,
// a hash-chained journal like the committees', and every step is in the activity log.
import path from 'node:path';
import { deskName } from '../../shared/fund/desks.js';
import { ROLE_BY_ID } from '../../shared/fund/roles.js';
import type { Actor } from '../../shared/fund/types.js';
import { checkAnswer, checkRequest, requestIdOf, requestOrder, type ResearchRequest } from '../../shared/fund/work.js';
import type { DeskFund, Desks } from './desks.js';
import { Journal } from './journal.js';

type Result<T extends object = object> = ({ ok: true } & T) | { error: string };

const THE_FUND: Actor = { kind: 'system', id: 'requests', name: 'The fund' };
/** The most requests one desk may have waiting on others at once, so two agents can't flood each other. */
const OPEN_PER_DESK = 10;
/** The answered and withdrawn requests the window shows, after every open one. */
const CLOSED_SHOWN = 40;

const title = (role: string) => ROLE_BY_ID.get(role)?.title ?? role;
const about = (r: ResearchRequest) => ({ ...(r.proposalId ? { proposalId: r.proposalId } : {}), ...(r.symbol ? { symbol: r.symbol } : {}) });

export class Requests {
  private journal: Journal<ResearchRequest>;
  private byId = new Map<string, ResearchRequest>();
  private seq = 0;
  problem?: string;
  repaired?: string;

  constructor(
    private fund: DeskFund,
    private desks: Desks,
    dir: string,
  ) {
    this.journal = new Journal(path.join(dir, 'requests.jsonl'));
    const read = this.journal.read();
    for (const r of read.entries) this.byId.set(r.id, r);
    this.seq = Math.max(0, ...[...this.byId.keys()].map((id) => Number(id.slice(2)) || 0));
    if (!read.ok) console.error(`agent-office: fund: ${(this.problem = read.problem)}`);
    this.repaired = read.repaired;
  }

  private put(r: ResearchRequest) {
    this.byId.set(r.id, r);
    this.journal.append(r);
    this.fund.changed();
  }

  get(id: string): ResearchRequest | undefined {
    return this.byId.get(id);
  }

  list(): ResearchRequest[] {
    return [...this.byId.values()].sort(requestOrder);
  }

  /** What whoever takes `role` is told is waiting for it: the requests put to the desk while nobody held it, or before. */
  waiting(role: string): string {
    const open = this.list().filter((r) => r.status === 'open' && r.to === role);
    if (!open.length) return '';
    return `${open.length} research request${open.length === 1 ? ' is' : 's are'} waiting for your desk (${open.slice(0, 6).map((r) => r.id).join(', ')}): fund_requests mine=to lists them, and you answer each with fund_answer.`;
  }

  /** What the window shows: every open request, then the latest answered or withdrawn. */
  state(): ResearchRequest[] {
    const all = this.list();
    const open = all.filter((r) => r.status === 'open');
    return [...open, ...all.slice(open.length, open.length + CLOSED_SHOWN)];
  }

  /** What the desk asked reads, typed in as its next prompt. */
  private letter(r: ResearchRequest): string {
    const on = [r.proposalId, r.symbol].filter(Boolean).join(', ');
    const due = r.dueAt ? `, wanted within ${Math.round((r.dueAt - r.at) / 60_000)} min` : '';
    return (
      `🔎 Research request ${r.id} from ${deskName(r.from)}${on ? ` about ${on}` : ''}${due}:\n\n${r.question}\n\n` +
      `Look into it with the fund's data, keep what you learn with fund_observe, then answer with fund_answer (id ${r.id}: what you found, your confidence and your sources). ` +
      'It stays open, where the asker and the Research tab can see it, until you do.'
    );
  }

  /** A question for a desk, from a desk or a person: kept, logged, and typed into the agent holding it. */
  ask(from: Actor, raw: unknown): Result<{ request: ResearchRequest; delivered: boolean; note?: string }> {
    let mine: string | undefined;
    if (from.kind === 'agent') {
      const p = this.desks.mine(from);
      if ('error' in p) return p;
      mine = p.role;
    }
    const c = checkRequest(raw);
    if ('error' in c) return c;
    const t = this.desks.target(c.to);
    if ('error' in t) return t;
    if (t.role.id === mine) return { error: "That's your own desk: keep it in your memory with fund_observe instead" };
    if (mine && [...this.byId.values()].filter((r) => r.status === 'open' && r.from.role === mine).length >= OPEN_PER_DESK)
      return { error: `Your desk already has ${OPEN_PER_DESK} requests open: wait for answers, or withdraw some (fund_requests lists them)` };
    const at = this.fund.now();
    const r: ResearchRequest = {
      id: `R-${++this.seq}`,
      at,
      from,
      to: t.role.id,
      question: c.question,
      ...(c.proposalId ? { proposalId: c.proposalId } : {}),
      ...(c.symbol ? { symbol: c.symbol } : {}),
      ...(c.dueInMin ? { dueAt: at + c.dueInMin * 60_000 } : {}),
      status: 'open',
    };
    this.put(r);
    this.fund.log('request', from, `${r.id} to the ${t.role.title}: ${c.question.slice(0, 200)}`, about(r));
    // An idea someone wants looked into is under research from now.
    if (r.proposalId && this.fund.proposals.get(r.proposalId)?.stage === 'idea') void this.fund.research?.(r.proposalId, from, `research requested of the ${t.role.title} (${r.id})`);
    if (!t.profile) return { ok: true, request: r, delivered: false, note: `Nobody holds the ${t.role.title} desk yet: ${r.id} stays open for whoever takes it` };
    const delivered = this.desks.notify(from, t.role.id, `${r.id}: ${c.question}`, this.letter(r), 'request', r.proposalId);
    return { ok: true, request: r, delivered, ...(delivered ? {} : { note: `${r.id} is open, but couldn't be typed into the ${t.role.title}'s agent` }) };
  }

  /** The answer to an open request, from whoever holds the desk it's for (or a person): the asker hears it. */
  answer(by: Actor, raw: unknown): Result<{ request: ResearchRequest; told: boolean }> {
    const c = checkAnswer(raw);
    if ('error' in c) return c;
    const r = this.byId.get(c.id);
    if (!r) return { error: `There's no request ${c.id}` };
    if (r.status !== 'open') return { error: `${r.id} is already ${r.status}` };
    if (by.kind === 'agent') {
      const p = this.desks.mine(by);
      if ('error' in p) return p;
      if (p.role !== r.to) return { error: `${r.id} is for the ${title(r.to)}: only whoever holds that desk answers it` };
    }
    const { id: _, ...answer } = c;
    const next: ResearchRequest = { ...r, status: 'answered', answer: { at: this.fund.now(), by, ...answer } };
    this.put(next);
    this.fund.log('request', by, `Answered ${r.id} for ${deskName(r.from)}${c.confidence !== undefined ? ` (${c.confidence}%)` : ''}: ${c.text.slice(0, 200)}`, about(r));
    return { ok: true, request: next, told: this.tell(next) };
  }

  /** The asker hears the answer: whoever holds its desk now if a desk asked, everyone in the building if a person did. */
  private tell(r: ResearchRequest): boolean {
    const a = r.answer!;
    if (r.from.kind !== 'agent' || !r.from.role) {
      this.desks.announceToPeople(`📬 The ${title(r.to)} answered ${r.id}: see the Research tab in the 💼 Fund window`);
      return true;
    }
    const conf = a.confidence !== undefined ? `\n\nConfidence: ${a.confidence}%` : '';
    const src = a.sources?.length ? `\nSources: ${a.sources.join('; ')}` : '';
    return this.desks.notify(a.by, r.from.role, `Answer to ${r.id}: ${a.text}`, `📬 Answer to your research request ${r.id} ("${r.question.slice(0, 160)}") from ${deskName(a.by)}:\n\n${a.text}${conf}${src}`, 'request', r.proposalId);
  }

  /** An open request taken back by whoever asked it (or a person): the desk needn't answer. */
  withdraw(by: Actor, raw: unknown): Result<{ request: ResearchRequest }> {
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const id = requestIdOf(body.id);
    const r = id && this.byId.get(id);
    if (!r) return { error: `There's no request ${String(body.id ?? '')}` };
    if (r.status !== 'open') return { error: `${r.id} is already ${r.status}` };
    if (by.kind === 'agent' && !(r.from.id === by.id || (r.from.role && r.from.role === by.role))) return { error: 'Only whoever asked takes a request back' };
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
    this.put({ ...r, status: 'withdrawn', withdrawn: { at: this.fund.now(), by, ...(note ? { note } : {}) } });
    this.fund.log('request', by, `Withdrew ${r.id} to the ${title(r.to)}${note ? `: ${note}` : ''}`, about(r));
    return { ok: true, request: this.byId.get(r.id)! };
  }

  /** Every so often: a request past its due time reminds the desk once, and says so in the log. */
  tick() {
    const now = this.fund.now();
    for (const r of [...this.byId.values()]) {
      if (r.status !== 'open' || r.reminded || !r.dueAt || now < r.dueAt) continue;
      this.put({ ...r, reminded: true });
      this.fund.log('request', THE_FUND, `${r.id} to the ${title(r.to)} is past due`, { level: 'warn', ...about(r) });
      this.desks.notify(THE_FUND, r.to, `${r.id} is past due`, `⏰ Research request ${r.id} from ${deskName(r.from)} is past due:\n\n${r.question}\n\nAnswer it with fund_answer (id ${r.id}), even if only with what you have so far and what's missing.`, 'request', r.proposalId);
    }
  }
}
