// What the fund's desks need of the office (see desks.ts): the workers holding its roles, wherever in
// the building they sit, a way to type into their agents, the signs over their desks, and toasts.
import type { Ctx } from '../office/context.js';
import type { Department } from '../../shared/fund/roles.js';
import type { WorkerStatus } from '../../shared/protocol/workers.js';
import type { FundOffice } from './desks.js';

/** Who hangs the fund's signs, so it only ever takes down its own. */
const SIGNER = '💼 The fund';
/** A sign's paint by department (SIGN_COLORS in shared/floorplan.ts). */
const PAINT: Record<Department, string> = { executive: '#ffd166', trading: '#06d6a0', research: '#118ab2', quant: '#9b5de5', risk: '#f78c6b' };
/** How often held letters look to see whether their agent has answered its terminal, ms. */
const HELD_EVERY_MS = 2_000;
/** After this long held, people are told the agent is still waiting on an answer, ms. */
const HELD_TOO_LONG_MS = 10 * 60_000;

export interface HeldLettersOptions {
  status(id: string): WorkerStatus | undefined;
  type(id: string, text: string, by: string): string | undefined;
  /** Letters have been held for `id` too long: once each time it's left waiting. */
  stuck?(id: string, count: number): void;
  now?: () => number;
  every?: number;
}

/**
 * Letters for agents waiting on an answer in their terminal (a permission prompt, a question, a
 * menu). Typed in there, a letter would answer it, or be lost in the menu, so it's held, behind any
 * already waiting, and they're typed in together once the agent is back; dropped if it's gone home.
 */
export class HeldLetters {
  private held = new Map<string, { letters: { text: string; by: string }[]; since: number; told?: boolean }>();
  private timer?: NodeJS.Timeout;
  private now: () => number;

  constructor(private opts: HeldLettersOptions) {
    this.now = opts.now ?? Date.now;
  }

  tell(id: string, text: string, by: string): string | undefined {
    const wait = this.held.get(id);
    if (!wait && this.opts.status(id) !== 'needs_input') return this.opts.type(id, text, by);
    if (wait) wait.letters.push({ text, by });
    else this.held.set(id, { letters: [{ text, by }], since: this.now() });
    if (!this.timer) {
      this.timer = setInterval(() => this.deliver(), this.opts.every ?? HELD_EVERY_MS);
      this.timer.unref();
    }
    return undefined;
  }

  /** How many letters are held for `id`. */
  waiting(id: string): number {
    return this.held.get(id)?.letters.length ?? 0;
  }

  /** Types in the letters held for every agent no longer waiting on an answer. */
  deliver() {
    for (const [id, wait] of this.held) {
      const status = this.opts.status(id);
      if (status === 'needs_input') {
        if (!wait.told && this.now() - wait.since >= HELD_TOO_LONG_MS) {
          wait.told = true;
          this.opts.stuck?.(id, wait.letters.length);
        }
        continue;
      }
      this.held.delete(id);
      const { letters } = wait;
      const by = letters.every((l) => l.by === letters[0].by) ? letters[0].by : SIGNER;
      if (status) this.opts.type(id, letters.map((l) => l.text).join('\n\n---\n\n'), by);
    }
    if (!this.held.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export function fundOffice(ctx: Ctx): FundOffice {
  const letters = new HeldLetters({
    status: (id) => ctx.workerFloor(id)?.workers.get(id)?.status,
    type(id, text, by) {
      const workers = ctx.workerFloor(id)?.workers;
      if (!workers) return 'That worker has gone home';
      const err = workers.prompt(id, text, by);
      return err === 'Worker is not running' ? workers.resume(id, text) : err;
    },
    stuck(id, count) {
      const name = ctx.workerFloor(id)?.workers.get(id)?.name ?? 'An agent';
      ctx.toastAll(`✉️ ${name} has had ${count === 1 ? 'a letter' : `${count} letters`} from the fund waiting ten minutes: its terminal is asking something. Answer it there and they'll be typed in.`, 'warn');
    },
  });
  return {
    worker(id) {
      const floor = ctx.workerFloor(id);
      const w = floor?.workers.get(id);
      if (!floor || !w) return undefined;
      return { id, name: w.name, kind: w.kind, floorId: floor.id, floorName: floor.def.name, deskId: w.deskId, provider: w.provider, model: w.model, status: w.status };
    },
    tell(id, text, by) {
      const workers = ctx.workerFloor(id)?.workers;
      if (!workers) return 'That worker has gone home';
      if (workers.get(id)?.kind !== 'agent') return "That desk's worker is a shell, not an agent";
      return letters.tell(id, text, by);
    },
    sign(id, text, department) {
      const floor = ctx.workerFloor(id);
      const deskId = floor?.workers.get(id)?.deskId;
      if (!floor || !deskId) return;
      const had = floor.plan.state().labels[deskId];
      // A sign someone else hung stays: the fund only takes down its own.
      if (!text && had?.by !== SIGNER) return;
      const r = floor.plan.label(deskId, text ?? '', department ? PAINT[department] : undefined, SIGNER);
      if (typeof r === 'string' || (!r.label && !r.old)) return;
      ctx.toFloor(floor, { t: 'plan', plan: floor.plan.state() });
      ctx.floorsChanged();
    },
    announce(text, level) {
      ctx.toastAll(text, level);
    },
  };
}
