import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkMessage, checkObservation, checkStatus, checkThesis, deskName, deskRecord, deskSign, findRole, type Decision, type DecisionKind, type DeskMemory, type DesksState, type DeskView, type FundMessage, type MessageKind, type Observation, type ThesisEntry } from '../../shared/fund/desks.js';
import { DESK_STATUS_LABEL, ROLE_BY_ID, ROLES, roleBrief, type Department, type DeskProfile, type RoleDef } from '../../shared/fund/roles.js';
import type { ActivityEvent, Actor, Proposal } from '../../shared/fund/types.js';
import type { AgentProvider } from '../../shared/providers.js';
import type { WorkerStatus } from '../../shared/protocol/workers.js';

/** A worker as the desks need to know it, wherever in the building it sits. */
export interface DeskWorker {
  id: string;
  name: string;
  kind: 'agent' | 'shell';
  floorId: string;
  floorName: string;
  deskId: string;
  provider?: AgentProvider;
  model?: string;
  status: WorkerStatus;
}

/** What the desks need of the office around them (server/fund/office.ts). */
export interface FundOffice {
  worker(id: string): DeskWorker | undefined;
  /** Types `text` into the worker's agent as its next prompt, waking it if it's stopped; why not, if it couldn't. */
  tell(id: string, text: string, by: string): string | undefined;
  /** Hangs a sign over the worker's desk, or takes the fund's down (no text). */
  sign(id: string, text: string | undefined, department?: Department): void;
  /** Tells everyone in the building, as a toast. */
  announce(text: string, level: 'info' | 'warn'): void;
}

/** What the desks need of the fund. */
export interface DeskFund {
  readonly now: () => number;
  readonly proposals: { list(): Proposal[]; get(id: string): Proposal | undefined };
  log(kind: ActivityEvent['kind'], by: Actor, text: string, extra?: Pick<ActivityEvent, 'proposalId' | 'symbol' | 'level'>): void;
  changed(): void;
}

type Result<T extends object = object> = ({ ok: true } & T) | { error: string };

const MESSAGES_KEPT = 200;
const MEMORY_SHOWN = 40;
/** The end of every brief: where to start. */
const START =
  'Start now: read your role’s memory (fund_memory), see who holds the other desks (fund_desks) and what’s in your inbox (fund_inbox), set your status (fund_status), then get on with your role. ' +
  'If no fund_* tools are listed for you, the office-fund command on your PATH does the same (office-fund help).';
/** How long the fund's news about a proposal gathers before its author hears it all at once. */
const SETTLE_MS = 1500;

function readJsonl<T>(file: string): T[] {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a line cut short: skip it
    }
  }
  return out;
}

/**
 * The fund's desks: which worker holds which role, what each says it's doing, each role's memory
 * (agents/<role>/: thesis.md, thesis.jsonl, observations.jsonl, decisions.jsonl, which outlive the
 * agent so the next one in the role picks up from them), the messages between desks, and escalations
 * to the people running the fund. Every one of those also goes in the fund's activity log, whose
 * chain is what makes them auditable. A worker sent home simply stops counting; its role's memory stays.
 */
export class Desks {
  private profiles = new Map<string, DeskProfile>();
  private messages: FundMessage[] = [];
  private pending = new Map<string, { events: ActivityEvent[]; timer: NodeJS.Timeout }>();
  /** Proposals the CIO's been asked about, and the people told of, so nobody hears it twice. */
  private asked = new Set<string>();
  private file: string;

  constructor(
    private fund: DeskFund,
    private dir: string,
    private office?: FundOffice,
  ) {
    this.file = path.join(dir, 'desks.json');
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { profiles?: DeskProfile[] };
      for (const p of raw.profiles ?? []) if (p && typeof p.workerId === 'string' && ROLE_BY_ID.has(p.role)) this.profiles.set(p.workerId, p);
    } catch {
      // no desks staffed yet
    }
    this.messages = readJsonl<FundMessage>(path.join(dir, 'messages.jsonl')).slice(-MESSAGES_KEPT).reverse();
  }

  stop() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  private save() {
    for (const id of [...this.profiles.keys()]) if (this.office && !this.office.worker(id)) this.profiles.delete(id);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ profiles: [...this.profiles.values()] }, null, 1), { mode: 0o600 });
  }

  /** The desks staffed before the fund started over, which carry on in the new one. */
  snapshot(): DeskProfile[] {
    return [...this.profiles.values()];
  }

  adopt(profiles: DeskProfile[]) {
    for (const p of profiles) this.profiles.set(p.workerId, p);
    if (profiles.length) this.save();
  }

  // ---- Who's who -------------------------------------------------------------------------------

  /** The desk a worker holds, while it still works in the building. */
  profile(workerId: string): DeskProfile | undefined {
    const p = this.profiles.get(workerId);
    return p && (!this.office || this.office.worker(workerId)) ? p : undefined;
  }

  /** Who a worker is to the fund: an agent, with its role when it holds one. */
  actor(w: { id: string; name: string }): Actor {
    const p = this.profile(w.id);
    return { kind: 'agent', id: w.id, name: w.name, ...(p ? { role: p.role } : {}) };
  }

  holder(role: string): DeskProfile | undefined {
    for (const p of this.profiles.values()) if (p.role === role && this.profile(p.workerId)) return p;
    return undefined;
  }

  /** Whether a CIO or PM is at a desk to rule on a proposal before a person does: one who isn't its author. */
  hasRuler(authorId?: string): boolean {
    return [this.holder('cio'), this.holder('pm')].some((d) => d && d.workerId !== authorId);
  }

  private nameOf(workerId: string): string {
    return this.office?.worker(workerId)?.name ?? workerId;
  }

  memoryDir(role: string): string {
    return path.join(this.dir, 'agents', role);
  }

  /** What an agent taking `role` is told: its brief, and to get going. */
  brief(role: RoleDef): string {
    return `${roleBrief(role, this.memoryDir(role.id))}

${START}`;
  }

  state(): DesksState {
    const proposals = this.fund.proposals.list();
    const desks: DeskView[] = [];
    for (const p of this.profiles.values()) {
      const w = this.office?.worker(p.workerId);
      if (this.office && !w) continue;
      desks.push({ ...p, name: w?.name ?? p.workerId, floorId: w?.floorId ?? '', floorName: w?.floorName ?? '', deskId: w?.deskId ?? '', provider: w?.provider, model: w?.model, process: w?.status ?? 'idle' });
    }
    return { desks, records: Object.fromEntries(ROLES.map((r) => [r.id, deskRecord(proposals, r.id)])), messages: this.messages.slice(0, 60) };
  }

  // ---- Staffing --------------------------------------------------------------------------------

  /** Gives a worker a role: its sign goes up, and it starts from the role's memory. */
  staff(worker: { id: string; name: string }, roleId: string, by: Actor): Result<{ profile: DeskProfile; brief: string }> {
    const role = ROLE_BY_ID.get(roleId);
    if (!role) return { error: `There's no ${roleId} role` };
    const held = this.holder(role.id);
    if (held && held.workerId !== worker.id) return { error: `${this.nameOf(held.workerId)} is already the ${role.title}` };
    const had = this.profile(worker.id);
    if (had && had.role !== role.id) return { error: `${worker.name} is already the ${ROLE_BY_ID.get(had.role)?.title}` };
    const now = this.fund.now();
    const last = this.theses(role.id).at(-1);
    const profile: DeskProfile = { workerId: worker.id, role: role.id, status: 'idle', since: now, updatedAt: now, ...(last ? { thesis: last.thesis, ...(last.confidence !== undefined ? { confidence: last.confidence } : {}) } : {}) };
    this.profiles.set(worker.id, profile);
    this.save();
    this.office?.sign(worker.id, deskSign(role), role.department);
    this.fund.log('assignment', by, `${worker.name} took the ${role.title} desk`);
    return { ok: true, profile, brief: this.brief(role) };
  }

  release(workerId: string, by: Actor): Result<{ role: string }> {
    const p = this.profiles.get(workerId);
    if (!p) return { error: 'That worker holds no fund role' };
    const role = ROLE_BY_ID.get(p.role)!;
    const name = this.nameOf(workerId);
    this.profiles.delete(workerId);
    this.save();
    this.office?.sign(workerId, undefined);
    this.office?.tell(workerId, `[Agent Office fund] You no longer hold the ${role.title} desk: leave the fund's tools alone from here on.`, by.name);
    this.fund.log('assignment', by, `${name} left the ${role.title} desk`);
    return { ok: true, role: role.id };
  }

  // ---- What a desk says ------------------------------------------------------------------------

  private mine(by: Actor): DeskProfile | { error: string } {
    return this.profile(by.id) ?? { error: 'You hold no desk at the fund: a person staffs its roles from the 💼 Fund window' };
  }

  setStatus(by: Actor, raw: unknown): Result<{ profile: DeskProfile }> {
    const p = this.mine(by);
    if ('error' in p) return p;
    const c = checkStatus(raw);
    if ('error' in c) return c;
    const changed = p.status !== c.status;
    p.status = c.status;
    if (c.note) p.note = c.note;
    else delete p.note;
    p.updatedAt = this.fund.now();
    this.save();
    if (changed) this.fund.log('status', by, `${DESK_STATUS_LABEL[c.status]}${c.note ? `: ${c.note}` : ''}`);
    else this.fund.changed();
    return { ok: true, profile: p };
  }

  private remember(role: string, file: string, entry: object) {
    const dir = this.memoryDir(role);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(dir, file), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  private theses(role: string): ThesisEntry[] {
    return readJsonl<ThesisEntry>(path.join(this.memoryDir(role), 'thesis.jsonl'));
  }

  thesis(by: Actor, raw: unknown): Result<{ entry: ThesisEntry }> {
    const p = this.mine(by);
    if ('error' in p) return p;
    const c = checkThesis(raw);
    if ('error' in c) return c;
    const role = ROLE_BY_ID.get(p.role)!;
    const entry: ThesisEntry = { at: this.fund.now(), by, ...c };
    this.remember(p.role, 'thesis.jsonl', entry);
    const conf = c.confidence !== undefined ? `\n\nConfidence: ${c.confidence}%` : '';
    writeFileSync(path.join(this.memoryDir(p.role), 'thesis.md'), `# ${role.title}: current thesis\n\n${c.thesis}${conf}${c.why ? `\n\nWhy it changed: ${c.why}` : ''}\n\n_${new Date(entry.at).toISOString()}, ${by.name}_\n`, { mode: 0o600 });
    const was = p.confidence;
    p.thesis = c.thesis;
    if (c.confidence !== undefined) p.confidence = c.confidence;
    p.updatedAt = entry.at;
    this.save();
    const moved = c.confidence !== undefined ? ` (${c.confidence}%${was !== undefined && was !== c.confidence ? `, was ${was}%` : ''})` : '';
    this.fund.log('thesis', by, `New thesis${moved}: ${c.thesis.slice(0, 200)}`);
    return { ok: true, entry };
  }

  observe(by: Actor, raw: unknown): Result<{ entry: Observation }> {
    const p = this.mine(by);
    if ('error' in p) return p;
    const c = checkObservation(raw);
    if ('error' in c) return c;
    const entry: Observation = { at: this.fund.now(), by, ...c };
    this.remember(p.role, 'observations.jsonl', entry);
    this.fund.log('observation', by, c.text.slice(0, 240), { ...(c.proposalId ? { proposalId: c.proposalId } : {}), ...(c.symbol ? { symbol: c.symbol } : {}) });
    return { ok: true, entry };
  }

  /** Something a desk decided (proposed, ruled, reviewed…), for its role's track record. */
  decided(by: Actor, kind: DecisionKind, text: string, proposalId?: string) {
    if (by.kind !== 'agent' || !by.role) return;
    const entry: Decision = { at: this.fund.now(), by, kind, text: text.slice(0, 500), ...(proposalId ? { proposalId } : {}) };
    this.remember(by.role, 'decisions.jsonl', entry);
  }

  /** A role's memory, for whoever holds it and anyone else who wants to read it. */
  memory(key: string): DeskMemory | { error: string } {
    const role = findRole(key);
    if (!role) return { error: `There's no role called ${key}: fund_desks lists them` };
    const dir = this.memoryDir(role.id);
    const theses = this.theses(role.id).slice(-MEMORY_SHOWN).reverse();
    return {
      role: role.id,
      ...(theses[0] ? { thesis: theses[0].thesis } : {}),
      theses,
      observations: readJsonl<Observation>(path.join(dir, 'observations.jsonl')).slice(-MEMORY_SHOWN).reverse(),
      decisions: readJsonl<Decision>(path.join(dir, 'decisions.jsonl')).slice(-MEMORY_SHOWN).reverse(),
      record: deskRecord(this.fund.proposals.list(), role.id),
    };
  }

  // ---- Messages --------------------------------------------------------------------------------

  /** The desk `key` names: a role, by id or title, or the name of the worker holding one. */
  private target(key: string): { role: RoleDef; profile?: DeskProfile } | { error: string } {
    const role = findRole(key);
    if (role) return { role, profile: this.holder(role.id) };
    const k = key.trim().toLowerCase();
    for (const p of this.profiles.values()) if (this.profile(p.workerId) && this.nameOf(p.workerId).toLowerCase() === k) return { role: ROLE_BY_ID.get(p.role)!, profile: p };
    return { error: `There's no desk called ${key}: name a role (cio, pm, macro, quant…) or the worker holding one, as fund_desks lists them` };
  }

  private record(m: FundMessage) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(this.dir, 'messages.jsonl'), `${JSON.stringify(m)}\n`, { mode: 0o600 });
    this.messages.unshift(m);
    this.messages.length = Math.min(this.messages.length, MESSAGES_KEPT);
  }

  private nextId(): string {
    return `M-${this.fund.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** What the agent a message is for reads, typed in as its next prompt. */
  private letter(m: FundMessage): string {
    const about = m.proposalId ? ` about ${m.proposalId}` : '';
    const reply = m.from.kind === 'agent' && m.from.role ? `fund_message to "${m.from.role}"` : 'fund_escalate (it was a person running the fund)';
    if (m.kind === 'assignment') return `📋 New assignment from ${deskName(m.from)}${about}:\n\n${m.text}\n\nSet fund_status as you work on it, keep what you learn with fund_observe and fund_thesis, and report back with ${reply} when it's done.`;
    return `📨 Fund message from ${deskName(m.from)}${about}:\n\n${m.text}\n\n(Answer with ${reply}.)`;
  }

  /**
   * A message to a desk (or, with kind `assignment`, a task for it): kept in messages.jsonl, logged,
   * and typed into the agent at that desk. People write to desks from the window; agents with fund_message.
   */
  message(from: Actor, raw: unknown, kind: MessageKind = 'message'): Result<{ message: FundMessage; delivered: boolean; note?: string }> {
    if (from.kind === 'agent') {
      const mine = this.mine(from);
      if ('error' in mine) return mine;
      if (kind === 'assignment' && !ROLE_BY_ID.get(mine.role)?.can.includes('assign')) return { error: `A ${ROLE_BY_ID.get(mine.role)?.title} doesn't assign work: message the desk instead` };
    }
    const c = checkMessage(raw);
    if ('error' in c) return c;
    const t = this.target(c.to);
    if ('error' in t) return t;
    if (!t.profile) return { error: `Nobody holds the ${t.role.title} desk right now` };
    if (t.profile.workerId === from.id) return { error: "That's your own desk" };
    const at = this.fund.now();
    const m: FundMessage = { id: this.nextId(), at, kind, from, to: t.role.id, text: c.text, ...(c.proposalId ? { proposalId: c.proposalId } : {}) };
    this.record(m);
    if (kind === 'assignment') {
      t.profile.assignment = { text: c.text.slice(0, 500), by: from.name, at };
      t.profile.updatedAt = at;
      this.save();
    }
    this.fund.log(kind === 'assignment' ? 'assignment' : 'message', from, `${kind === 'assignment' ? 'Assigned the' : 'To the'} ${t.role.title}: ${c.text.slice(0, 200)}`, c.proposalId ? { proposalId: c.proposalId } : {});
    const err = this.office?.tell(t.profile.workerId, this.letter(m), from.name);
    return { ok: true, message: m, delivered: !err, ...(err ? { note: `It's in their inbox, but couldn't be typed in: ${err}` } : {}) };
  }

  /** The messages for a desk's role, newest first. */
  inbox(by: Actor): Result<{ messages: FundMessage[] }> {
    const p = this.mine(by);
    if ('error' in p) return p;
    return { ok: true, messages: this.messages.filter((m) => m.to === p.role).slice(0, 30) };
  }

  /** Something the people running the fund (and the CIO) need to hear: a toast to everyone, and the log. */
  escalate(from: Actor, raw: unknown): Result<{ message: FundMessage }> {
    if (from.kind === 'agent') {
      const mine = this.mine(from);
      if ('error' in mine) return mine;
    }
    const c = checkMessage({ ...(raw && typeof raw === 'object' ? raw : {}), to: 'people' });
    if ('error' in c) return c;
    const m: FundMessage = { id: this.nextId(), at: this.fund.now(), kind: 'escalation', from, to: 'people', text: c.text, ...(c.proposalId ? { proposalId: c.proposalId } : {}) };
    this.record(m);
    this.fund.log('escalation', from, c.text.slice(0, 240), { level: 'warn', ...(c.proposalId ? { proposalId: c.proposalId } : {}) });
    this.office?.announce(`🚨 ${deskName(from)}: ${c.text.slice(0, 160)}`, 'warn');
    const cio = this.holder('cio');
    if (cio && cio.workerId !== from.id) this.office?.tell(cio.workerId, `🚨 Escalation from ${deskName(from)}${m.proposalId ? ` about ${m.proposalId}` : ''} (the people running the fund heard it too):\n\n${c.text}`, from.name);
    return { ok: true, message: m };
  }

  // ---- Keeping desks in the loop ---------------------------------------------------------------

  /**
   * The fund's log, as it's written: news about a proposal gathers for a moment, then its author hears
   * what others did to it (backed, approved and filled, exited), the CIO hears what waits on its
   * ruling, and everyone hears when an agent's trade waits on a person.
   */
  heard(e: ActivityEvent) {
    if (!e.proposalId || !['risk', 'ruling', 'fill', 'exit'].includes(e.kind)) return;
    const id = e.proposalId;
    const was = this.pending.get(id);
    if (was) return void was.events.push(e);
    const timer = setTimeout(() => this.settle(id), SETTLE_MS);
    timer.unref?.();
    this.pending.set(id, { events: [e], timer });
  }

  private settle(id: string) {
    const events = this.pending.get(id)?.events ?? [];
    this.pending.delete(id);
    const p = this.fund.proposals.get(id);
    if (!p || !this.office) return;
    const what = `${p.id} (${p.side} ${p.symbol})`;
    const news = events.filter((e) => e.kind !== 'risk' && e.actor.id !== p.author.id);
    if (p.author.kind === 'agent' && news.length && this.profile(p.author.id)) {
      const next = p.stage === 'monitoring' ? '\n\nIt’s open: watch it, and propose an exit or message the desk if the thesis breaks.' : p.stage === 'exited' ? '\n\nIt’s closed: write your post-trade review with fund_review (did the thesis hold, and what did you learn?).' : '';
      this.office.tell(p.author.id, `💼 News on your ${what}:\n${news.map((e) => `- ${deskName(e.actor)}: ${e.text}`).join('\n')}${next}`, 'The fund');
    }
    if (this.asked.has(`${id}:${p.stage}`)) return;
    if (p.stage === 'cio_review') {
      this.asked.add(`${id}:${p.stage}`);
      const ruler = [this.holder('cio'), this.holder('pm')].find((d) => d && d.workerId !== p.author.id);
      if (ruler) this.office.tell(ruler.workerId, `⚖️ ${what}, ${p.sizeUsd ? `$${Math.round(p.risk?.approvedUsd ?? p.sizeUsd).toLocaleString('en-US')} ` : ''}from ${deskName(p.author)}, passed risk and waits on your ruling. Read it with fund_proposals (id ${p.id}), then fund_rule: back it or turn it down, with your reasons.`, 'The fund');
    } else if (p.stage === 'user_approval' && p.author.kind === 'agent') {
      this.asked.add(`${id}:${p.stage}`);
      this.office.announce(`💼 ${what} from ${deskName(p.author)} waits on a person’s approval in the 💼 Fund window`, 'info');
    }
  }
}
