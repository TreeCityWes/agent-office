// The paper book's arithmetic: a fill applied to the book (average cost), and the book valued at the
// latest quotes. Pure: the server replays its fills through applyFill, and both sides value with
// valuePortfolio, so the dashboard shows exactly what risk measured.
import type { Asset, BookState, Exposure, Fill, NavMarks, PortfolioView, Position, PositionView, Quote } from './types.js';

/** Smaller than this, a quantity is nothing: floating point leaves crumbs when a position closes. */
const DUST = 1e-9;

const round = (n: number, places: number) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

export function emptyBook(startingCapital: number): BookState {
  return { startingCapital, cash: startingCapital, positions: {}, realizedPnl: 0, fees: 0, fills: 0 };
}

/**
 * The book with `fill` applied, at average cost: adding to a position (or opening one) moves its
 * average to the blend; reducing it realizes the difference to the average on what closed; going
 * through flat closes it all and opens the rest at the fill's price. Fees come out of cash and are
 * counted apart from realized P&L.
 */
export function applyFill(book: BookState, fill: Fill): BookState {
  const was: Position | undefined = book.positions[fill.symbol];
  const held = was?.qty ?? 0;
  const q = fill.qty;
  let pos: Position | undefined;
  let realized = 0;
  if (Math.abs(held) < DUST || Math.sign(held) === Math.sign(q)) {
    const qty = held + q;
    const avgCost = Math.abs(held) < DUST ? fill.price : (Math.abs(held) * was!.avgCost + Math.abs(q) * fill.price) / Math.abs(qty);
    pos = { symbol: fill.symbol, qty, avgCost, realizedPnl: was?.realizedPnl ?? 0, openedAt: Math.abs(held) < DUST ? fill.at : was!.openedAt, updatedAt: fill.at };
  } else {
    const closing = Math.min(Math.abs(q), Math.abs(held));
    realized = closing * (fill.price - was!.avgCost) * Math.sign(held);
    const qty = held + q;
    const realizedPnl = was!.realizedPnl + realized;
    if (Math.abs(qty) < DUST) pos = undefined;
    else if (Math.sign(qty) === Math.sign(held)) pos = { ...was!, qty, realizedPnl, updatedAt: fill.at };
    else pos = { symbol: fill.symbol, qty, avgCost: fill.price, realizedPnl, openedAt: fill.at, updatedAt: fill.at };
  }
  const positions = { ...book.positions };
  if (pos) positions[fill.symbol] = { ...pos, qty: round(pos.qty, 10) };
  else delete positions[fill.symbol];
  return {
    ...book,
    cash: round(book.cash - q * fill.price - fill.fee, 6),
    positions,
    realizedPnl: round(book.realizedPnl + realized, 6),
    fees: round(book.fees + fill.fee, 6),
    fills: book.fills + 1,
  };
}

/** The book with cash paid in (positive) or taken out (negative): capital, not P&L. */
export function applyCash(book: BookState, amount: number): BookState {
  return { ...book, startingCapital: round(book.startingCapital + amount, 6), cash: round(book.cash + amount, 6) };
}

/** The UTC day of `ms`, as YYYY-MM-DD: the fund's day turns over at midnight UTC. */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The marks after seeing the NAV at `nav` now: a new day starts from it, and the peak only goes up. */
export function rollMarks(marks: NavMarks | undefined, nav: number, now: number): NavMarks {
  const day = utcDay(now);
  if (!marks) return { day, dayStartNav: nav, peakNav: nav };
  return { day, dayStartNav: marks.day === day ? marks.dayStartNav : nav, peakNav: Math.max(marks.peakNav, nav) };
}

const zero = (): Exposure => ({ long: 0, short: 0, gross: 0, net: 0, grossPct: 0, netPct: 0 });

function addTo(table: Record<string, Exposure>, key: string, value: number) {
  const e = (table[key] ??= zero());
  if (value >= 0) e.long += value;
  else e.short += -value;
  e.gross += Math.abs(value);
  e.net += value;
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/** What a position is, when the fund no longer has the asset in its table. */
const unknownAsset = (symbol: string): Asset => ({ symbol, name: symbol, class: 'equity', sector: 'Other', group: symbol.toLowerCase(), feeds: {} });

/**
 * The book valued at `quotes` (by symbol), measured from `marks`. A position with no quote is valued
 * at its cost and listed in `unpriced`, so a missing price never reads as a profit or a loss.
 */
export function valuePortfolio(book: BookState, quotes: ReadonlyMap<string, Quote>, assets: ReadonlyMap<string, Asset>, marks: NavMarks | undefined, now: number): PortfolioView {
  const unpriced: string[] = [];
  const rows = Object.values(book.positions).map((p) => {
    const asset = assets.get(p.symbol) ?? unknownAsset(p.symbol);
    const q = quotes.get(p.symbol);
    if (!q) unpriced.push(p.symbol);
    const price = q?.price ?? p.avgCost;
    const value = p.qty * price;
    return { p, asset, q, price, value };
  });
  const nav = book.cash + rows.reduce((s, r) => s + r.value, 0);
  const byClass: Record<string, Exposure> = {};
  const bySector: Record<string, Exposure> = {};
  const byGroup: Record<string, Exposure> = {};
  let gross = 0;
  let net = 0;
  let unrealizedPnl = 0;
  const positions: PositionView[] = rows.map(({ p, asset, q, price, value }) => {
    gross += Math.abs(value);
    net += value;
    const unrealized = (price - p.avgCost) * p.qty;
    unrealizedPnl += unrealized;
    addTo(byClass, asset.class, value);
    addTo(bySector, asset.sector, value);
    addTo(byGroup, asset.group, value);
    return {
      ...p,
      name: asset.name,
      class: asset.class,
      sector: asset.sector,
      group: asset.group,
      side: p.qty >= 0 ? 'long' : 'short',
      price,
      ...(q ? { priceAt: q.at, source: q.source } : {}),
      value,
      unrealizedPnl: unrealized,
      unrealizedPct: p.avgCost > 0 ? (price / p.avgCost - 1) * 100 * Math.sign(p.qty) : 0,
      weightPct: pct(Math.abs(value), nav),
    };
  });
  positions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  for (const table of [byClass, bySector, byGroup])
    for (const e of Object.values(table)) {
      e.grossPct = pct(e.gross, nav);
      e.netPct = pct(e.net, nav);
    }
  const m = rollMarks(marks, nav, now);
  const dayPnl = nav - m.dayStartNav;
  const totalPnl = nav - book.startingCapital;
  return {
    at: now,
    startingCapital: book.startingCapital,
    nav,
    cash: book.cash,
    cashPct: pct(book.cash, nav),
    gross,
    net,
    leverage: nav > 0 ? gross / nav : gross > 0 ? Infinity : 0,
    unrealizedPnl,
    realizedPnl: book.realizedPnl,
    fees: book.fees,
    dayPnl,
    dayPnlPct: pct(dayPnl, m.dayStartNav),
    totalPnl,
    totalPnlPct: pct(totalPnl, book.startingCapital),
    peakNav: m.peakNav,
    drawdownPct: m.peakNav > 0 ? Math.max(0, ((m.peakNav - nav) / m.peakNav) * 100) : 0,
    positions,
    byClass,
    bySector,
    byGroup,
    unpriced,
  };
}
