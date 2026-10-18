import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Fund } from '../src/server/fund/fund.js';
import type { DeskWorker, FundOffice } from '../src/server/fund/desks.js';
import type { PriceAdapter } from '../src/server/fund/market/types.js';
import { fundTools } from '../src/server/hooks/fund.js';
import type { Ctx } from '../src/server/office/context.js';
import type { Actor } from '../src/shared/fund/types.js';
import { main as officeFund } from '../bin/office-fund.js';

// A fund for the fund tests whose desks sit in a pretend office: workers that exist until they go
// home, what each was told, the signs over their desks and the toasts people saw.

export const PEOPLE: Actor = { kind: 'user', id: 'account:wes', name: 'Wes' };
export const trade = { symbol: 'BTC', side: 'long', sizeUsd: 50_000, stop: 95_000, target: 120_000, thesis: 'ETF inflows and a funding reset point higher.', confidence: 70, horizon: '2w', evidence: ['ETF inflows 5 days running'] };
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `prices` is the test's to change: the fund sees them at its next market refresh. */
export function fundOffice(opts: { dir?: string; now?: () => number; prices?: Record<string, number> } = {}) {
  const prices = opts.prices ?? { BTC: 100_000 };
  const workers = new Map<string, DeskWorker>();
  const told: { id: string; text: string }[] = [];
  const signs = new Map<string, string>();
  const toasts: string[] = [];
  const office: FundOffice = {
    worker: (id) => workers.get(id),
    tell: (id, text) => (workers.has(id) ? void told.push({ id, text }) : 'That worker has gone home'),
    sign: (id, text) => (text ? signs.set(id, text) : signs.delete(id)),
    announce: (text) => void toasts.push(text),
  };
  const source: PriceAdapter = { id: 'mock', label: 'Test prices', everyMs: 60_000, mock: true, quotes: async (ls) => ls.filter((l) => prices[l.symbol]).map((l) => ({ symbol: l.symbol, price: prices[l.symbol], volumeUsd: 1e10, at: opts.now?.() ?? Date.now(), source: 'test' })) };
  const dir = opts.dir ?? path.join(mkdtempSync(path.join(os.tmpdir(), 'fund-desks-')), 'fund');
  const fund = new Fund({ dir, office, now: opts.now, marketAdapters: () => ({ prices: [source], signals: [] }) });
  const hire = (id: string, name: string) => {
    const w: DeskWorker = { id, name, kind: 'agent', floorId: 'f1', floorName: 'Trading floor', deskId: `desk-${workers.size + 1}`, provider: 'claude', status: 'working' };
    workers.set(id, w);
    return w;
  };
  const as = (id: string) => fund.desks.actor(workers.get(id)!);
  /** Each worker's last note, by id. */
  const last = (id: string) => told.filter((t) => t.id === id).at(-1)?.text ?? '';
  return { fund, dir, workers, told, signs, toasts, hire, as, last, prices };
}

/**
 * The fund's hook endpoints on a real http server, and office-fund (what an agent runs) pointed at
 * them as a worker with its token. Close the server when done.
 */
export async function toolServer(fund: Fund, workers: Map<string, DeskWorker>, tokens: Record<string, string>) {
  const ctx = {
    fund,
    workerFloor: (id: string) => (tokens[id] ? { workers: { authenticate: (wid: string, token: string) => (tokens[wid] === token ? workers.get(wid) : undefined) } } : undefined),
  } as unknown as Ctx;
  const server = http.createServer((req, res) => void fundTools(ctx, req, res, new URL(req.url ?? '/', 'http://127.0.0.1')));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const env = (id: string) => ({ AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, AGENT_OFFICE_WORKER_ID: id, AGENT_OFFICE_HOOK_TOKEN: tokens[id] });
  const run = async (id: string, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await officeFund(argv, { env: env(id), out: (s: string) => out.push(s), err: (s: string) => err.push(s), stdin: { isTTY: true } });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { server, env, run };
}
