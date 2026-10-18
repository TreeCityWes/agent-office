// The fund's research gathered from every role's memory (docs/fund.md#research): each desk's thesis now,
// the latest notes across the desks, and how the desks' calls did against the confidence they gave. It
// reads the memory files the desks write (desks.ts); the Research tab and fund_research show it.
import path from 'node:path';
import type { Observation, ThesisEntry } from '../../shared/fund/desks.js';
import { calibration, callsOf, currentThesis, type DeskThesis, type ResearchNote, type ResearchView } from '../../shared/fund/research.js';
import { ROLES } from '../../shared/fund/roles.js';
import type { Proposal } from '../../shared/fund/types.js';
import { readJsonl } from './desks.js';
import type { Fund } from './fund.js';

/** The most notes read from each role's memory, and sent. */
const PER_ROLE = 200;
const NOTES_SHOWN = 120;
const CALLS_SHOWN = 40;

export interface ResearchQuery {
  symbol?: string;
  role?: string;
  limit?: number;
}

/** Everything the desks believe and noticed, newest first, narrowed to an asset or a role if asked. */
export function gatherResearch(memoryDir: (role: string) => string, proposals: readonly Proposal[], now: number, q: ResearchQuery = {}): ResearchView {
  const theses: DeskThesis[] = [];
  const notes: ResearchNote[] = [];
  for (const r of ROLES) {
    if (q.role && r.id !== q.role) continue;
    const dir = memoryDir(r.id);
    const t = currentThesis(r.id, readJsonl<ThesisEntry>(path.join(dir, 'thesis.jsonl')));
    if (t) theses.push(t);
    for (const o of readJsonl<Observation>(path.join(dir, 'observations.jsonl')).slice(-PER_ROLE)) if (!q.symbol || o.symbol === q.symbol) notes.push({ ...o, role: r.id });
  }
  const calls = callsOf(proposals).filter((c) => (!q.role || c.role === q.role) && (!q.symbol || c.symbol === q.symbol));
  return {
    theses: theses.sort((a, b) => b.at - a.at),
    notes: notes.sort((a, b) => b.at - a.at).slice(0, Math.min(NOTES_SHOWN, q.limit ?? NOTES_SHOWN)),
    calls: calls.slice(0, CALLS_SHOWN),
    calibration: calibration(calls),
    at: now,
  };
}

/** The fund's research, from its desks' memory and every proposal it has. */
export const fundResearch = (fund: Fund, q: ResearchQuery = {}) => gatherResearch((role) => fund.desks.memoryDir(role), fund.proposals.list(), fund.now(), q);
