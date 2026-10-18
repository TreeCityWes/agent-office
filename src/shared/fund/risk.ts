// The risk engine: deterministic code, not anyone's judgment. Given a proposed trade, the portfolio,
// the asset, its quote and the limits, it says whether the trade may go ahead, at what size, and
// shows its working: every check, with the numbers. Agents explain its verdicts; they can't change
// them (see docs/fund.md#risk).
import { usd, pct } from './format.js';
import { ASSET_CLASSES, type Asset, type AssetClass, type PortfolioView, type Quote, type RiskCheck, type RiskLimits, type RiskVerdict, type Side } from './types.js';

export const DEFAULT_LIMITS: RiskLimits = {
  maxPositionPct: 10,
  maxClassPct: { crypto: 35, equity: 60, etf: 80, index: 50, commodity: 20, rates: 40, fx: 20 },
  defaultClassPct: 30,
  maxGroupPct: 30,
  maxTop3Pct: 25,
  maxLeverage: 1.5,
  maxDrawdownPct: 15,
  maxDailyLossPct: 3,
  minLiquidityUsd: 5_000_000,
  maxParticipationPct: 1,
  maxLossPerTradePct: 1,
  requireStop: true,
  allowShorts: true,
  allowedClasses: [...ASSET_CLASSES],
  minTradeUsd: 1000,
  maxQuoteAgeMin: 30,
};

/** Each numeric limit's sane range: a limit outside it is a typo, not a policy. */
const RANGES: { [K in keyof RiskLimits]?: [number, number] } = {
  maxPositionPct: [0.1, 100],
  defaultClassPct: [0, 300],
  maxGroupPct: [0.1, 300],
  maxTop3Pct: [0.1, 300],
  maxLeverage: [0.1, 10],
  maxDrawdownPct: [0.1, 100],
  maxDailyLossPct: [0.1, 100],
  minLiquidityUsd: [0, 1e13],
  maxParticipationPct: [0.01, 100],
  maxLossPerTradePct: [0.01, 100],
  minTradeUsd: [0, 1e9],
  maxQuoteAgeMin: [1, 60 * 24 * 7],
};

/**
 * Limits as someone sent them, checked against `base` (the limits now): any field left out keeps its
 * value there, and the first one that's wrong says so.
 */
export function checkLimits(raw: unknown, base: RiskLimits = DEFAULT_LIMITS): { limits: RiskLimits } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Limits are an object' };
  const r = raw as Record<string, unknown>;
  const out: RiskLimits = { ...base, maxClassPct: { ...base.maxClassPct }, allowedClasses: [...base.allowedClasses] };
  for (const [key, [lo, hi]] of Object.entries(RANGES) as [keyof RiskLimits, [number, number]][]) {
    if (!(key in r)) continue;
    const v = r[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return { error: `${key} must be a number from ${lo} to ${hi}` };
    (out as unknown as Record<string, number>)[key] = v;
  }
  for (const key of ['requireStop', 'allowShorts'] as const) {
    if (!(key in r)) continue;
    if (typeof r[key] !== 'boolean') return { error: `${key} is true or false` };
    out[key] = r[key] as boolean;
  }
  if ('maxClassPct' in r) {
    const m = r.maxClassPct;
    if (!m || typeof m !== 'object') return { error: 'maxClassPct is an object of asset class → %' };
    const next: Partial<Record<AssetClass, number>> = {};
    for (const [cls, v] of Object.entries(m as Record<string, unknown>)) {
      if (!ASSET_CLASSES.includes(cls as AssetClass)) return { error: `maxClassPct: ${cls} isn't an asset class` };
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 300) return { error: `maxClassPct.${cls} must be a number from 0 to 300` };
      next[cls as AssetClass] = v;
    }
    out.maxClassPct = next;
  }
  if ('allowedClasses' in r) {
    const a = r.allowedClasses;
    if (!Array.isArray(a) || a.some((c) => !ASSET_CLASSES.includes(c as AssetClass))) return { error: `allowedClasses is a list of ${ASSET_CLASSES.join(', ')}` };
    out.allowedClasses = [...new Set(a as AssetClass[])];
  }
  return { limits: out };
}

export interface RiskInput {
  symbol: string;
  side: Side;
  sizeUsd: number;
  stop?: number;
  target?: number;
  portfolio: PortfolioView;
  asset?: Asset;
  quote?: Quote;
  limits: RiskLimits;
  now: number;
}

/**
 * The most a trade of direction `s` (+1 buys, -1 sells) may be, in USD, for a bucket now at signed
 * `e` that may reach `room` either way: back to flat is always allowed (it only takes risk off), and
 * past flat, or further out, only within the room.
 */
function absCap(e: number, s: number, room: number): number {
  return s * e < 0 ? Math.abs(e) + Math.max(0, room) : Math.max(0, room - Math.abs(e));
}

/** The top three positions' share of NAV, with `symbol` at signed value `v`. */
function top3Pct(p: PortfolioView, symbol: string, v: number): number {
  const sizes = p.positions.filter((x) => x.symbol !== symbol).map((x) => Math.abs(x.value));
  sizes.push(Math.abs(v));
  sizes.sort((a, b) => b - a);
  return ((sizes[0] ?? 0) + (sizes[1] ?? 0) + (sizes[2] ?? 0)) / p.nav * 100;
}

/** The largest x in [lo, hi] with ok(x) true, for ok true at lo and staying false once it turns false. */
function largest(lo: number, hi: number, ok: (x: number) => boolean): number {
  if (ok(hi)) return hi;
  let a = lo;
  let b = hi;
  for (let i = 0; i < 60 && b - a > 0.5; i++) {
    const m = (a + b) / 2;
    if (ok(m)) a = m;
    else b = m;
  }
  return a;
}

/** Runs every check on a proposed trade and says what may go ahead (see the file's header). */
export function evaluateRisk(input: RiskInput): RiskVerdict {
  const { symbol, side, portfolio: p, asset, quote, limits: L, now } = input;
  const requested = Number.isFinite(input.sizeUsd) ? Math.max(0, input.sizeUsd) : 0;
  const checks: RiskCheck[] = [];
  const hard = (id: string, label: string, pass: boolean, detail: string) => checks.push({ id, label, pass, detail });
  const cap = (id: string, label: string, capUsd: number, detail: string) => checks.push({ id, label, pass: capUsd >= requested, capUsd: Math.max(0, Math.floor(capUsd)), detail });
  const s = side === 'long' ? 1 : -1;
  const nav = p.nav;

  hard('size', 'Size', requested > 0, requested > 0 ? `${usd(requested)} requested` : 'The size must be more than $0');
  hard('nav', 'Capital', nav > 0, nav > 0 ? `NAV ${usd(nav)}` : `NAV is ${usd(nav)}: there's no capital to risk`);
  hard('asset', 'Universe', !!asset, asset ? `${symbol} is ${asset.name} (${asset.class}, ${asset.sector})` : `${symbol} isn't in the fund's universe`);
  const ageMin = quote ? (now - quote.at) / 60_000 : Infinity;
  const fresh = !!quote && quote.price > 0 && ageMin <= L.maxQuoteAgeMin;
  hard(
    'price',
    'Fresh price',
    fresh,
    !quote ? `No price for ${symbol}` : fresh ? `${quote.price} from ${quote.source}, ${Math.max(0, Math.round(ageMin))} min old` : `The last price is ${Math.round(ageMin)} min old (the limit is ${L.maxQuoteAgeMin}): is its market closed?`,
  );
  if (asset) hard('allowed', 'Asset class', L.allowedClasses.includes(asset.class), L.allowedClasses.includes(asset.class) ? `${asset.class} is allowed` : `${asset.class} isn't on the fund's list of allowed classes`);
  if (side === 'short') hard('shorts', 'Shorts', L.allowShorts, L.allowShorts ? 'Shorts are allowed' : "The fund doesn't allow shorts");

  const px = quote?.price ?? 0;
  const stop = input.stop;
  if (stop === undefined) hard('stop', 'Stop', !L.requireStop, L.requireStop ? 'Every proposal needs a stop: where is it wrong?' : 'No stop (the fund allows that)');
  else if (px > 0) {
    const right = s > 0 ? stop < px : stop > px;
    hard('stop', 'Stop', right && stop > 0, right ? `Stop ${stop}, ${pct((Math.abs(px - stop) / px) * 100)} from ${px}` : `A ${side}'s stop goes ${s > 0 ? 'under' : 'over'} the price (${px}); ${stop} doesn't`);
  }
  if (input.target !== undefined && px > 0) {
    const right = s > 0 ? input.target > px : input.target < px;
    hard('target', 'Target', right, right ? `Target ${input.target}` : `A ${side}'s target goes ${s > 0 ? 'over' : 'under'} the price (${px}); ${input.target} doesn't`);
  }

  hard('drawdown', 'Drawdown halt', p.drawdownPct < L.maxDrawdownPct, `Drawdown ${pct(p.drawdownPct)} from the high of ${usd(p.peakNav)}; new risk stops at ${pct(L.maxDrawdownPct)}`);
  const dayLoss = Math.max(0, -p.dayPnlPct);
  hard('daily', 'Daily loss halt', dayLoss < L.maxDailyLossPct, `Down ${pct(dayLoss)} today; new risk stops at ${pct(L.maxDailyLossPct)}`);
  const vol = quote?.volumeUsd;
  if (L.minLiquidityUsd > 0)
    hard('liquidity', 'Liquidity', vol !== undefined && vol >= L.minLiquidityUsd, vol === undefined ? `No traded volume for ${symbol} to check liquidity against` : `${usd(vol, { compact: true })} traded in a day; the floor is ${usd(L.minLiquidityUsd, { compact: true })}`);

  // The caps: each is the most the trade may be.
  if (nav > 0 && asset) {
    const held = p.positions.find((x) => x.symbol === symbol);
    const e = held?.value ?? 0;
    const posLimit = (L.maxPositionPct / 100) * nav;
    const posCap = absCap(e, s, posLimit);
    cap('position', 'Position size', posCap, `${symbol} at most ${pct(L.maxPositionPct)} of NAV (${usd(posLimit)}); it's ${usd(e)} now, so up to ${usd(posCap)} more`);

    const classLimitPct = L.maxClassPct[asset.class] ?? L.defaultClassPct;
    const cls = p.byClass[asset.class];
    const classRoom = (classLimitPct / 100) * nav - ((cls?.gross ?? 0) - Math.abs(e));
    const classCap = absCap(e, s, classRoom);
    cap('class', `${asset.class} exposure`, classCap, `${asset.class} at most ${pct(classLimitPct)} of NAV gross; it's ${pct(cls?.grossPct ?? 0)}, so up to ${usd(classCap)}`);

    const grp = p.byGroup[asset.group];
    const groupNet = grp?.net ?? 0;
    const groupCap = absCap(groupNet, s, (L.maxGroupPct / 100) * nav);
    cap('group', `Correlation (${asset.group})`, groupCap, `${asset.group} at most ${pct(L.maxGroupPct)} of NAV net; it's ${pct(grp?.netPct ?? 0, 1, true)}, so up to ${usd(groupCap)}`);

    const levRoom = L.maxLeverage * nav - (p.gross - Math.abs(e));
    const levCap = absCap(e, s, levRoom);
    cap('leverage', 'Leverage', levCap, `Gross at most ${L.maxLeverage}× NAV (${usd(L.maxLeverage * nav)}); it's ${p.leverage.toFixed(2)}×, so up to ${usd(levCap)}`);

    if (vol !== undefined && vol > 0) {
      const partCap = (L.maxParticipationPct / 100) * vol;
      cap('participation', 'Participation', partCap, `At most ${pct(L.maxParticipationPct, 2)} of the day's ${usd(vol, { compact: true })} traded: ${usd(partCap)}`);
    }

    if (stop !== undefined && px > 0 && stop !== px) {
      const dist = Math.abs(px - stop) / px;
      const lossCap = ((L.maxLossPerTradePct / 100) * nav) / dist;
      cap('loss', 'Loss at stop', lossCap, `At most ${pct(L.maxLossPerTradePct, 2)} of NAV (${usd((L.maxLossPerTradePct / 100) * nav)}) lost at the stop, ${pct(dist * 100)} away: up to ${usd(lossCap)}`);
    }

    // The top three: monotone past flat, so the most is found by bisection. A book already over the
    // limit may still take a trade that leaves the top three no bigger (a small new position).
    const lo = s * e < 0 ? Math.abs(e) : 0;
    const topLimit = Math.max(L.maxTop3Pct, top3Pct(p, symbol, e));
    const ok = (x: number) => x <= lo || top3Pct(p, symbol, e + s * x) <= topLimit + 1e-9;
    const topCap = requested <= lo ? requested : ok(lo) ? largest(lo, Math.max(lo, requested), ok) : lo;
    cap('top3', 'Concentration', topCap, `The three largest positions at most ${pct(L.maxTop3Pct)} of NAV together: up to ${usd(topCap)}`);
  }

  const failed = checks.filter((c) => !c.pass && c.capUsd === undefined);
  const caps = checks.filter((c) => c.capUsd !== undefined);
  const allowed = Math.floor(Math.min(requested, ...caps.map((c) => c.capUsd!)));
  const reasons: string[] = failed.map((c) => `${c.label}: ${c.detail}`);
  let decision: RiskVerdict['decision'];
  if (failed.length) decision = 'rejected';
  else if (allowed < L.minTradeUsd) {
    decision = 'rejected';
    const binding = caps.filter((c) => c.capUsd! < L.minTradeUsd).map((c) => c.label);
    reasons.push(`Cut to ${usd(allowed)} (${binding.join(', ') || 'the caps'}), under the ${usd(L.minTradeUsd)} minimum trade`);
  } else if (allowed < Math.floor(requested)) {
    decision = 'resized';
    for (const c of caps) if (c.capUsd! < requested) reasons.push(`${c.label}: ${c.detail}`);
  } else decision = 'approved';
  return {
    decision,
    requestedUsd: requested,
    approvedUsd: decision === 'rejected' ? 0 : allowed,
    checks,
    reasons,
    ...(px > 0 ? { price: px } : {}),
    at: now,
  };
}
