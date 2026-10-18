// The fund's research for the agents at its desks (docs/fund.md#research): every desk's thesis now, the
// latest notes across the desks, what covers each asset, and how each desk's calls did against the
// confidence it gave. hooks/fund.ts serves it with the rest of the fund's tools; anyone may read it.
import { cleanSymbol } from '../../shared/fund/assets.js';
import { findRole } from '../../shared/fund/desks.js';
import { coverage } from '../../shared/fund/research.js';
import { ROLE_BY_ID } from '../../shared/fund/roles.js';
import { fundResearch } from '../fund/research.js';
import type { Answer, Ask } from './fund.js';

const title = (role: string) => ROLE_BY_ID.get(role)?.title ?? role;

export const RESEARCH_READS: Record<string, (a: Ask) => Answer> = {
  research({ ctx, q }) {
    const symbol = q.get('symbol') ? cleanSymbol(q.get('symbol')) : undefined;
    if (q.get('symbol') && !symbol) return { error: 'symbol: an asset, like BTC or SPY' };
    const role = q.get('role') ? findRole(q.get('role')!) : undefined;
    if (q.get('role') && !role) return { error: `There's no role called ${q.get('role')}: fund_desks lists them` };
    const limit = Math.min(120, Math.max(1, Number(q.get('limit')) || 40));
    const r = fundResearch(ctx.fund, { symbol, role: role?.id, limit });
    const s = ctx.fund.state();
    const cover = coverage(s.config.watchlist, r.notes, s.proposals, s.portfolio.positions, s.market.signals).filter((c) => !symbol || c.symbol === symbol);
    return {
      theses: r.theses.map((t) => ({ desk: title(t.role), role: t.role, thesis: t.thesis, confidence: t.confidence, was: t.was, why: t.why, by: t.by.name, at: new Date(t.at).toISOString(), versions: t.versions })),
      notes: r.notes.map((n) => ({ desk: title(n.role), text: n.text, symbol: n.symbol, sources: n.sources, proposalId: n.proposalId, by: n.by.name, at: new Date(n.at).toISOString() })),
      coverage: cover.slice(0, 30).map((c) => ({ symbol: c.symbol, notes: c.notes, desks: c.desks.map(title), ideas: c.ideas, live: c.live, long: c.long, short: c.short, position: c.position, signals: c.signals })),
      calibration: r.calibration.map((c) => ({ desk: title(c.role), ...c, hitRatePct: Math.round(c.hitRatePct), avgConfidence: Math.round(c.avgConfidence), brier: Math.round(c.brier * 1000) / 1000 })),
      calls: r.calls.slice(0, 20),
      note: 'Brier is the mean squared gap between the confidence a desk gave (as a chance) and whether the trade made money: 0 is perfect, 0.25 is always saying 50%. Lower beats higher.',
    };
  },
};
