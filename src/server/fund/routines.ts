// Routines (docs/fund.md#research-requests-and-routines): standing prompts a person, or the CIO, PM or CRO
// (fund_routine), sets for a desk, which the office types into the agent there every so often, so the
// desks pick up work on a schedule without anyone asking each time. A routine that comes due while its
// agent is busy, asking someone something or still on the brief it took the desk with waits (up to one
// more interval, then skips), so it never lands mid-turn or answers a prompt by mistake; while nobody
// holds the desk it skips. Each is kept as
// its snapshots in routines.jsonl, a hash-chained journal, and every change and every run is in the log.
import path from 'node:path';
import { findRole } from '../../shared/fund/desks.js';
import { ROLE_BY_ID } from '../../shared/fund/roles.js';
import type { Actor } from '../../shared/fund/types.js';
import { checkRoutine, everyLabel, routineIdOf, routineNext, type Routine } from '../../shared/fund/work.js';
import type { WorkerStatus } from '../../shared/protocol/workers.js';
import type { DeskFund, Desks } from './desks.js';
import { Journal } from './journal.js';

type Result<T extends object = object> = ({ ok: true } & T) | { error: string };

const ROUTINE: Actor = { kind: 'system', id: 'routines', name: 'Routine' };
const PER_ROLE = 3;
const MAX = 30;
/** When an agent can take a prompt: not mid-turn, and not with a question or permission prompt open. */
const READY: readonly WorkerStatus[] = ['idle', 'done', 'exited', 'offline'];
/**
 * How long a routine leaves an agent that's just taken its desk to read its brief and report in: some
 * runtimes (OpenCode) read as idle before their first turn has got going.
 */
const SETTLE_IN_MS = 5 * 60_000;

const title = (role: string) => ROLE_BY_ID.get(role)?.title ?? role;

export class Routines {
  private journal: Journal<Routine>;
  private byId = new Map<string, Routine>();
  private seq = 0;
  problem?: string;
  repaired?: string;

  constructor(
    private fund: DeskFund,
    private desks: Desks,
    dir: string,
  ) {
    this.journal = new Journal(path.join(dir, 'routines.jsonl'));
    const read = this.journal.read();
    for (const r of read.entries) {
      this.seq = Math.max(this.seq, Number(r.id.slice(3)) || 0);
      if (r.removed) this.byId.delete(r.id);
      else this.byId.set(r.id, r);
    }
    if (!read.ok) console.error(`agent-office: fund: ${(this.problem = read.problem)}`);
    this.repaired = read.repaired;
  }

  private put(r: Routine) {
    if (r.removed) this.byId.delete(r.id);
    else this.byId.set(r.id, r);
    this.journal.append(r);
    this.fund.changed();
  }

  list(): Routine[] {
    return [...this.byId.values()].sort((a, b) => a.role.localeCompare(b.role) || a.at - b.at);
  }

  /** People set routines; of the agents, only a desk that assigns work (the CIO, PM and CRO). */
  private allowed(by: Actor): { error: string } | undefined {
    if (by.kind !== 'agent') return undefined;
    const p = this.desks.mine(by);
    if ('error' in p) return p;
    return ROLE_BY_ID.get(p.role)?.can.includes('assign') ? undefined : { error: `A ${title(p.role)} doesn't set routines: ask the CIO, PM or CRO, or a person` };
  }

  /** A new routine for a desk, or a change to one (`id`): its prompt, how often, or switched on or off. */
  set(by: Actor, raw: unknown): Result<{ routine: Routine }> {
    const no = this.allowed(by);
    if (no) return no;
    const c = checkRoutine(raw);
    if ('error' in c) return c;
    const role = c.role ? findRole(c.role) : undefined;
    if (c.role && !role) return { error: `There's no role called ${c.role}: fund_desks lists them` };
    const now = this.fund.now();
    if (c.id) {
      const had = this.byId.get(c.id);
      if (!had) return { error: `There's no routine ${c.id}` };
      const next: Routine = { ...had, ...(role ? { role: role.id } : {}), ...(c.prompt ? { prompt: c.prompt } : {}), ...(c.everyMin ? { everyMin: c.everyMin } : {}), ...(c.on !== undefined ? { on: c.on } : {}), by, at: now };
      this.put(next);
      const what = c.on === false ? 'Paused' : c.on && !had.on ? 'Resumed' : 'Changed';
      this.fund.log('routine', by, `${what} ${next.id} for the ${title(next.role)}, ${everyLabel(next.everyMin)}: ${next.prompt.slice(0, 160)}`);
      return { ok: true, routine: next };
    }
    if (this.byId.size >= MAX) return { error: `The fund already has ${MAX} routines: remove one first` };
    if ([...this.byId.values()].filter((r) => r.role === role!.id).length >= PER_ROLE) return { error: `The ${role!.title} already has ${PER_ROLE} routines: change or remove one` };
    const r: Routine = { id: `RT-${++this.seq}`, role: role!.id, prompt: c.prompt!, everyMin: c.everyMin!, on: c.on ?? true, by, at: now, runs: 0 };
    this.put(r);
    this.fund.log('routine', by, `Set ${r.id} for the ${role!.title}, ${everyLabel(r.everyMin)}: ${r.prompt.slice(0, 160)}`);
    return { ok: true, routine: r };
  }

  private find(raw: unknown): Routine | { error: string } {
    const id = routineIdOf(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).id : undefined);
    return (id && this.byId.get(id)) || { error: 'id: one of the fund’s routines, like RT-2 (fund_routines lists them)' };
  }

  remove(by: Actor, raw: unknown): Result<{ routine: Routine }> {
    const no = this.allowed(by);
    if (no) return no;
    const r = this.find(raw);
    if ('error' in r) return r;
    const gone: Routine = { ...r, removed: true, by, at: this.fund.now() };
    this.put(gone);
    this.fund.log('routine', by, `Removed ${r.id} for the ${title(r.role)}: ${r.prompt.slice(0, 160)}`);
    return { ok: true, routine: gone };
  }

  /** A routine now, whenever it's next due: typed in unless nobody holds the desk or its agent is asking something. */
  run(by: Actor, raw: unknown): Result<{ routine: Routine }> {
    const no = this.allowed(by);
    if (no) return no;
    const r = this.find(raw);
    if ('error' in r) return r;
    const process = this.desks.processOf(r.role);
    if (!process) return { error: `Nobody holds the ${title(r.role)} desk` };
    if (process === 'needs_input') return { error: `The ${title(r.role)}'s agent is asking someone something: answer it first` };
    return { ok: true, routine: this.fire(r, by) };
  }

  /** Every so often: each routine that's come due is typed in, waits, or skips. */
  tick() {
    const now = this.fund.now();
    for (const r of [...this.byId.values()]) {
      if (!r.on || now < routineNext(r)) continue;
      const process = this.desks.processOf(r.role);
      const settling = this.desks.settlingIn(r.role, SETTLE_IN_MS);
      if (!process) this.skip(r, 'nobody holds the desk');
      else if (READY.includes(process) && !settling) this.fire(r, ROUTINE);
      // Busy, asking someone something or still on its brief: wait, but not past another whole interval.
      else if (now - routineNext(r) >= r.everyMin * 60_000) this.skip(r, process === 'working' ? 'the agent was busy the whole time' : READY.includes(process) ? 'the agent was still on its brief' : `the agent was ${process.replace('_', ' ')}`);
    }
  }

  private skip(r: Routine, why: string) {
    const last = `Skipped: ${why}`;
    this.put({ ...r, lastAt: this.fund.now(), last });
    // The same reason again and again is one line in the log, not one a run.
    if (r.last !== last) this.fund.log('routine', ROUTINE, `${r.id} for the ${title(r.role)} skipped: ${why}`, { level: 'warn' });
  }

  private fire(r: Routine, by: Actor): Routine {
    const letter =
      `⏰ Routine ${r.id}, ${everyLabel(r.everyMin)} (set by ${r.by.name}):\n\n${r.prompt}\n\n` +
      'Do it now with your fund tools: set fund_status as you go, keep what you find with fund_observe and fund_thesis, and message, request or escalate whatever needs someone else.';
    const delivered = this.desks.notify(by, r.role, `${r.id}: ${r.prompt}`, letter, 'routine');
    const next: Routine = { ...r, lastAt: this.fund.now(), last: delivered ? 'Typed in' : "Couldn't be typed in", runs: r.runs + (delivered ? 1 : 0) };
    this.put(next);
    this.fund.log('routine', by, `Ran ${r.id} for the ${title(r.role)}${by === ROUTINE ? `, ${everyLabel(r.everyMin)}` : ''}: ${r.prompt.slice(0, 160)}`, delivered ? {} : { level: 'warn' });
    return next;
  }
}
