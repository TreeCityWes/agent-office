// What the fund's desks need of the office (see desks.ts): the workers holding its roles, wherever in
// the building they sit, a way to type into their agents, the signs over their desks, and toasts.
import type { Ctx } from '../office/context.js';
import type { Department } from '../../shared/fund/roles.js';
import type { FundOffice } from './desks.js';

/** Who hangs the fund's signs, so it only ever takes down its own. */
const SIGNER = '💼 The fund';
/** A sign's paint by department (SIGN_COLORS in shared/floorplan.ts). */
const PAINT: Record<Department, string> = { executive: '#ffd166', trading: '#06d6a0', research: '#118ab2', quant: '#9b5de5', risk: '#f78c6b' };

export function fundOffice(ctx: Ctx): FundOffice {
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
      const err = workers.prompt(id, text, by);
      return err === 'Worker is not running' ? workers.resume(id, text) : err;
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
