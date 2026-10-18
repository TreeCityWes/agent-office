/**
 * What the trading floor's big displays show, each painted onto its canvas from the fund's state
 * (docs/fund.md#the-trading-floor): the portfolio, the heatmap, risk against its limits, the trade
 * pipeline, the desks, their theses, the strategies and the committee. Amber on black, like a
 * terminal; green up, red down. They only ever read the fund.
 */
import { tally, COMMITTEE_STATUS_LABEL } from '../../../shared/fund/committee';
import { desksByDepartment, fmtPrice, heatTiles, pipeline, treemap, type RiskAlarm, type TickerItem } from '../../../shared/fund/floor';
import { DEPARTMENTS, DESK_STATUS_LABEL, ROLE_BY_ID } from '../../../shared/fund/roles';
import type { FundState } from '../../../shared/fund/state';
import { STRATEGY_STAGE_LABEL } from '../../../shared/fund/strategy';

export const INK = { bg: '#05070b', panel: '#0c1118', line: '#1c2633', amber: '#ffb000', text: '#e6edf5', dim: '#8b98a9', up: '#22c55e', down: '#ef4444', warn: '#f59e0b' } as const;
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';

type G = CanvasRenderingContext2D;
/** A display's painter: onto `g`, `w` by `h` pixels, the fund as `s` has it, `risk` as the beacon sees it. */
export type Painter = (g: G, w: number, h: number, s: FundState, risk: RiskAlarm, now: number) => void;

const font = (g: G, px: number, weight = 600, family = MONO) => (g.font = `${weight} ${Math.round(px)}px ${family}`);
const signed = (n: number, places = 2) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(places)}`;
const money = (n: number) => `${n < 0 ? '−' : ''}$${fmtPrice(Math.abs(n))}`;
const tone = (n: number) => (Math.abs(n) < 1e-9 ? INK.dim : n > 0 ? INK.up : INK.down);

/** `text` cut to fit `max` pixels, with an ellipsis. */
function fit(g: G, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** `text` wrapped to `max` pixels, at most `lines` lines (the last cut short). */
function wrap(g: G, text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width <= max || !line) line = next;
    else {
      out.push(line);
      line = word;
      if (out.length === lines) break;
    }
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines) out[lines - 1] = fit(g, out[lines - 1] + (text.length > out.join(' ').length ? ' …' : ''), max);
  return out;
}

/** The black, the title bar across the top with the time and PAPER, and what's left for the rest. */
function chrome(g: G, w: number, h: number, title: string, now: number, alert = false): { top: number; pad: number; u: number } {
  const u = h / 20;
  const bar = Math.max(22, u * 1.7);
  g.fillStyle = INK.bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = alert ? '#3a0b0b' : INK.panel;
  g.fillRect(0, 0, w, bar);
  g.fillStyle = alert ? INK.down : INK.amber;
  g.fillRect(0, bar - 2, w, 2);
  g.textBaseline = 'middle';
  font(g, bar * 0.56, 800);
  g.fillStyle = alert ? '#ffd5d5' : INK.amber;
  g.textAlign = 'left';
  g.fillText(title, u * 0.6, bar / 2);
  font(g, bar * 0.46, 600);
  g.fillStyle = INK.dim;
  g.textAlign = 'right';
  g.fillText(`PAPER · ${new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, w - u * 0.6, bar / 2);
  g.textAlign = 'left';
  return { top: bar + u * 0.6, pad: u * 0.6, u };
}

/** Nothing to show yet: a line saying so, in the middle. */
function empty(g: G, w: number, top: number, h: number, text: string, u: number) {
  font(g, u * 0.9, 600, SANS);
  g.fillStyle = INK.dim;
  g.textAlign = 'center';
  g.fillText(text, w / 2, (top + h) / 2);
  g.textAlign = 'left';
}

const portfolio: Painter = (g, w, h, s, _risk, now) => {
  const { top, pad, u } = chrome(g, w, h, `💼 ${s.config.name.toUpperCase()}`, now);
  const p = s.portfolio;
  const half = w * 0.46;
  g.textBaseline = 'top';
  font(g, u * 0.8, 600, SANS);
  g.fillStyle = INK.dim;
  g.fillText('NET ASSET VALUE', pad, top);
  font(g, u * 2.6, 800);
  g.fillStyle = INK.text;
  g.fillText(money(p.nav), pad, top + u * 1.1);
  const stat = (label: string, value: string, color: string, i: number) => {
    const y = top + u * 4.4 + Math.floor(i / 2) * u * 2.2;
    const x = pad + (i % 2) * (half / 2);
    font(g, u * 0.7, 600, SANS);
    g.fillStyle = INK.dim;
    g.fillText(label, x, y);
    font(g, u * 1.05, 700);
    g.fillStyle = color;
    g.fillText(value, x, y + u * 0.8);
  };
  stat('TODAY', `${signed(p.dayPnl, 0)} (${signed(p.dayPnlPct)}%)`, tone(p.dayPnl), 0);
  stat('SINCE INCEPTION', `${signed(p.totalPnlPct)}%`, tone(p.totalPnl), 1);
  stat('CASH', `${p.cashPct.toFixed(1)}%`, INK.text, 2);
  stat('GROSS · NET', `${((p.gross / (p.nav || 1)) * 100).toFixed(0)}% · ${((p.net / (p.nav || 1)) * 100).toFixed(0)}%`, INK.text, 3);
  stat('LEVERAGE', `${p.leverage.toFixed(2)}×`, INK.text, 4);
  stat('DRAWDOWN', `${p.drawdownPct.toFixed(2)}%`, p.drawdownPct > 0 ? INK.down : INK.dim, 5);
  // The NAV over its history, under the numbers.
  const navs = s.nav.map((n) => n.nav);
  const cy = top + u * 11.4;
  const ch = h - cy - pad;
  if (navs.length > 1 && ch > u) {
    const lo = Math.min(...navs);
    const hi = Math.max(...navs);
    const span = hi - lo || 1;
    g.strokeStyle = tone(navs[navs.length - 1] - navs[0]);
    g.lineWidth = Math.max(2, u * 0.12);
    g.beginPath();
    navs.forEach((v, i) => {
      const x = pad + (i / (navs.length - 1)) * (half - pad);
      const y = cy + ch - ((v - lo) / span) * ch;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
  }
  // The positions, biggest first.
  const x0 = half + pad;
  const cols = [x0, x0 + (w - x0) * 0.3, x0 + (w - x0) * 0.55, x0 + (w - x0) * 0.78];
  font(g, u * 0.7, 700, SANS);
  g.fillStyle = INK.dim;
  ['POSITION', 'WEIGHT', 'VALUE', 'P&L'].forEach((t, i) => g.fillText(t, cols[i], top));
  const rows = [...p.positions].sort((a, b) => b.weightPct - a.weightPct);
  if (!rows.length) return empty(g, w + half, top, h, 'No positions: all cash', u);
  const rh = u * 1.25;
  const fits = Math.floor((h - top - u * 1.2 - pad) / rh);
  rows.slice(0, fits).forEach((r, i) => {
    const y = top + u * 1.2 + i * rh;
    font(g, u * 0.9, 700);
    g.fillStyle = r.side === 'short' ? INK.down : INK.text;
    g.fillText(`${r.side === 'short' ? '▼' : '▲'} ${r.symbol}`, cols[0], y);
    g.fillStyle = INK.text;
    g.fillText(`${r.weightPct.toFixed(1)}%`, cols[1], y);
    g.fillText(money(r.value), cols[2], y);
    g.fillStyle = tone(r.unrealizedPnl);
    g.fillText(`${signed(r.unrealizedPct, 1)}%`, cols[3], y);
  });
  if (rows.length > fits) {
    font(g, u * 0.7, 600, SANS);
    g.fillStyle = INK.dim;
    g.fillText(`+${rows.length - fits} more`, cols[0], h - pad - u * 0.8);
  }
};

/** A day's change as a color: red through dark to green, as strong as the move, full at ±5%. */
function heat(changePct: number): string {
  const k = Math.min(1, Math.abs(changePct) / 5);
  const [r, gg, b] = changePct >= 0 ? [22, 163, 74] : [220, 38, 38];
  const base = [24, 30, 38];
  const mix = (a: number, c: number) => Math.round(a + (c - a) * (0.25 + 0.75 * k));
  return `rgb(${mix(base[0], r)}, ${mix(base[1], gg)}, ${mix(base[2], b)})`;
}

const heatmap: Painter = (g, w, h, s, _risk, now) => {
  const { top, pad, u } = chrome(g, w, h, '🟩 HEATMAP · TODAY', now);
  const tiles = heatTiles(s);
  if (!tiles.length) return empty(g, w, top, h, 'No prices yet', u);
  const rects = treemap(
    tiles.map((t) => t.weight),
    { x: pad, y: top, w: w - 2 * pad, h: h - top - pad },
  );
  tiles.forEach((t, i) => {
    const r = rects[i];
    g.fillStyle = heat(t.changePct);
    g.fillRect(r.x + 1.5, r.y + 1.5, Math.max(0, r.w - 3), Math.max(0, r.h - 3));
    if (t.held) {
      g.strokeStyle = INK.amber;
      g.lineWidth = Math.max(2, u * 0.12);
      g.strokeRect(r.x + 3, r.y + 3, Math.max(0, r.w - 6), Math.max(0, r.h - 6));
    }
    const big = Math.min(r.w / 4.2, r.h / 2.6, u * 2.2);
    if (big < u * 0.45) return;
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    font(g, big, 800);
    g.fillText(fit(g, t.symbol, r.w - 8), r.x + r.w / 2, r.y + r.h / 2 - big * 0.42);
    font(g, big * 0.62, 700);
    g.fillText(`${signed(t.changePct)}%`, r.x + r.w / 2, r.y + r.h / 2 + big * 0.5);
    g.textAlign = 'left';
  });
};

const riskBoard: Painter = (g, w, h, s, risk, now) => {
  const alarm = risk.level === 'alarm';
  const { top, pad, u } = chrome(g, w, h, alarm ? '🚨 RISK · LIMIT BROKEN' : risk.level === 'watch' ? '🛡️ RISK · WATCH' : '🛡️ RISK · WITHIN LIMITS', now, alarm);
  const rows = risk.limits;
  const banner = risk.reasons.length ? Math.min(3, risk.reasons.length) : 0;
  const rh = (h - top - pad - banner * u * 1.1) / rows.length;
  const label = w * 0.3;
  const bar = w - label - pad * 2 - w * 0.2;
  rows.forEach((r, i) => {
    const y = top + i * rh;
    g.textBaseline = 'middle';
    font(g, Math.min(u * 0.95, rh * 0.4), 600, SANS);
    g.fillStyle = INK.text;
    g.fillText(r.label, pad, y + rh / 2);
    const k = Math.min(1, r.use);
    const color = r.use >= 1 ? INK.down : r.use >= 0.8 ? INK.warn : INK.up;
    g.fillStyle = INK.line;
    g.fillRect(pad + label, y + rh * 0.28, bar, rh * 0.44);
    g.fillStyle = color;
    g.fillRect(pad + label, y + rh * 0.28, bar * k, rh * 0.44);
    // The limit, and where 80% of it is.
    g.fillStyle = INK.dim;
    g.fillRect(pad + label + bar * 0.8 - 1, y + rh * 0.2, 2, rh * 0.6);
    font(g, Math.min(u * 0.9, rh * 0.38), 700);
    g.fillStyle = color;
    const fmt = (n: number) => (r.unit === '×' ? `${n.toFixed(2)}×` : `${n.toFixed(1)}%`);
    g.fillText(`${fmt(r.now)} / ${fmt(r.limit)}`, pad + label + bar + pad, y + rh / 2);
  });
  risk.reasons.slice(0, banner).forEach((reason, i) => {
    const y = h - pad - (banner - i) * u * 1.1;
    g.fillStyle = alarm ? '#3a0b0b' : '#2e2208';
    g.fillRect(pad, y, w - 2 * pad, u);
    font(g, u * 0.66, 700, SANS);
    g.fillStyle = alarm ? '#fecaca' : '#fde68a';
    g.textBaseline = 'middle';
    g.fillText(fit(g, `⚠ ${reason}`, w - 4 * pad), pad * 2, y + u / 2);
  });
};

const pipelineBoard: Painter = (g, w, h, s, _risk, now) => {
  const { top, pad, u } = chrome(g, w, h, '🧭 TRADE PIPELINE', now);
  const stages = pipeline(s);
  const cw = (w - 2 * pad) / stages.length;
  stages.forEach((st, i) => {
    const x = pad + i * cw;
    const live = st.count > 0 && st.stage !== 'stopped';
    g.fillStyle = live ? '#13202e' : INK.panel;
    g.fillRect(x + 2, top, cw - 4, h - top - pad);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    font(g, Math.min(u * 0.62, cw / 6.5), 700, SANS);
    g.fillStyle = INK.dim;
    for (const [k, line] of wrap(g, st.label.toUpperCase(), cw - 8, 2).entries()) g.fillText(line, x + cw / 2, top + u * 0.3 + k * u * 0.7);
    font(g, Math.min(u * 2.2, cw / 2.2), 800);
    g.fillStyle = st.stage === 'stopped' ? INK.dim : live ? INK.amber : INK.line;
    g.fillText(String(st.count), x + cw / 2, top + u * 1.9);
    font(g, Math.min(u * 0.6, cw / 7), 600);
    g.fillStyle = INK.text;
    const room = Math.floor((h - pad - (top + u * 4.6)) / (u * 0.75));
    st.items.slice(0, room).forEach((it, k) => g.fillText(fit(g, it, cw - 8), x + cw / 2, top + u * 4.6 + k * u * 0.75));
    if (i < stages.length - 1) {
      g.fillStyle = INK.amber;
      g.fillText('›', x + cw, top + u * 2.4);
    }
  });
  g.textAlign = 'left';
};

const desksBoard: Painter = (g, w, h, s, _risk, now) => {
  const { top, pad, u } = chrome(g, w, h, '👥 DESKS', now);
  const groups = desksByDepartment(s);
  if (!groups.length) return empty(g, w, top, h, 'No desks staffed: staff them from the 💼 Fund window', u);
  const rows = groups.flatMap((gr) => gr.desks.map((d) => ({ d, dep: DEPARTMENTS[gr.department] })));
  const cols = rows.length > 8 ? 2 : 1;
  const per = Math.ceil(rows.length / cols);
  const rh = Math.min(u * 1.6, (h - top - pad) / per);
  const cw = (w - 2 * pad) / cols;
  rows.forEach(({ d, dep }, i) => {
    const x = pad + Math.floor(i / per) * cw;
    const y = top + (i % per) * rh;
    g.fillStyle = dep.color;
    g.fillRect(x, y + rh * 0.15, u * 0.22, rh * 0.7);
    g.textBaseline = 'middle';
    font(g, rh * 0.42, 700, SANS);
    g.fillStyle = INK.text;
    const title = ROLE_BY_ID.get(d.role)?.title ?? d.role;
    g.fillText(fit(g, `${dep.icon} ${title}`, cw * 0.48), x + u * 0.5, y + rh / 2);
    font(g, rh * 0.36, 600);
    g.fillStyle = d.status === 'blocked' ? INK.down : d.status === 'proposing' ? INK.amber : INK.dim;
    g.fillText(fit(g, `${DESK_STATUS_LABEL[d.status]}${d.note ? ` · ${d.note}` : ''}`, cw * 0.48 - u), x + cw * 0.5, y + rh / 2);
  });
};

const research: Painter = (g, w, h, s, _risk, now) => {
  const { top, pad, u } = chrome(g, w, h, '🔎 THESES', now);
  const desks = s.desks.desks.filter((d) => d.thesis).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!desks.length) return empty(g, w, top, h, 'No theses yet', u);
  const rh = Math.max(u * 2.6, (h - top - pad) / Math.min(desks.length, 4));
  const fits = Math.max(1, Math.floor((h - top - pad) / rh));
  desks.slice(0, fits).forEach((d, i) => {
    const y = top + i * rh;
    const role = ROLE_BY_ID.get(d.role);
    const dep = role ? DEPARTMENTS[role.department] : undefined;
    g.textBaseline = 'top';
    font(g, u * 0.8, 800, SANS);
    g.fillStyle = dep?.color ?? INK.text;
    g.fillText(fit(g, `${dep?.icon ?? ''} ${role?.title ?? d.role}`, w * 0.6), pad, y);
    if (d.confidence !== undefined) {
      const bw = w * 0.25;
      g.fillStyle = INK.line;
      g.fillRect(w - pad - bw, y + u * 0.15, bw, u * 0.5);
      g.fillStyle = INK.amber;
      g.fillRect(w - pad - bw, y + u * 0.15, (bw * d.confidence) / 100, u * 0.5);
      font(g, u * 0.6, 700);
      g.textAlign = 'right';
      g.fillText(`${Math.round(d.confidence)}%`, w - pad - bw - u * 0.3, y + u * 0.1);
      g.textAlign = 'left';
    }
    font(g, u * 0.72, 500, SANS);
    g.fillStyle = INK.text;
    for (const [k, line] of wrap(g, d.thesis!, w - 2 * pad, Math.max(1, Math.floor((rh - u * 1.3) / (u * 0.85)))).entries()) g.fillText(line, pad, y + u * 1.05 + k * u * 0.85);
  });
};

const strategies: Painter = (g, w, h, s, _risk, now) => {
  const { top, pad, u } = chrome(g, w, h, '🧪 STRATEGIES', now);
  const list = s.strategies.filter((x) => x.stage !== 'retired');
  if (!list.length) return empty(g, w, top, h, 'No strategies in the lab yet', u);
  const sharpe = new Map(s.backtests.map((b) => [b.id, b.metrics?.sharpe]));
  const cols = [pad, w * 0.42, w * 0.64, w * 0.82];
  font(g, u * 0.7, 700, SANS);
  g.fillStyle = INK.dim;
  g.textBaseline = 'top';
  ['STRATEGY', 'STAGE', 'SHARPE', 'PAPER P&L'].forEach((t, i) => g.fillText(t, cols[i], top));
  const rh = u * 1.4;
  list.slice(0, Math.floor((h - top - u * 1.2 - pad) / rh)).forEach((x, i) => {
    const y = top + u * 1.2 + i * rh;
    font(g, u * 0.85, 700, SANS);
    g.fillStyle = INK.text;
    g.fillText(fit(g, x.name, cols[1] - cols[0] - u), cols[0], y);
    font(g, u * 0.8, 600);
    g.fillStyle = x.stage === 'paper' || x.stage === 'approved' ? INK.up : INK.amber;
    g.fillText(STRATEGY_STAGE_LABEL[x.stage], cols[1], y);
    const sh = x.backtestId ? sharpe.get(x.backtestId) : undefined;
    g.fillStyle = INK.text;
    g.fillText(sh === undefined || sh === null ? '—' : sh.toFixed(2), cols[2], y);
    g.fillStyle = tone(x.record.realizedPnl);
    g.fillText(x.record.closed ? `${signed(x.record.realizedPnl, 0)} (${x.record.wins}/${x.record.closed})` : '—', cols[3], y);
  });
};

const committee: Painter = (g, w, h, s, _risk, now) => {
  const { top, pad, u } = chrome(g, w, h, '🗳️ INVESTMENT COMMITTEE', now);
  const list = [...s.committees].sort((a, b) => Number(b.status === 'voting' || b.status === 'open') - Number(a.status === 'voting' || a.status === 'open') || b.updatedAt - a.updatedAt);
  if (!list.length) return empty(g, w, top, h, 'No committee has sat yet', u);
  const rh = u * 2.6;
  list.slice(0, Math.max(1, Math.floor((h - top - pad) / rh))).forEach((c, i) => {
    const y = top + i * rh;
    const t = tally(c);
    g.textBaseline = 'top';
    font(g, u * 0.78, 700, SANS);
    g.fillStyle = INK.text;
    g.fillText(fit(g, `${c.id} · ${c.question}`, w * 0.62), pad, y);
    font(g, u * 0.62, 600, SANS);
    g.fillStyle = c.status === 'decided' ? INK.up : c.status === 'lapsed' ? INK.dim : INK.amber;
    const sealed = c.status === 'voting';
    g.fillText(`${COMMITTEE_STATUS_LABEL[c.status]}${c.decision ? ` · ${c.decision.vote}` : ''} · ${c.ballots.length}/${c.seats.length} voted`, pad, y + u * 1.0);
    // The vote, once it's open: BUY, HOLD and SELL as a bar.
    const bx = w * 0.66;
    const bw = w - bx - pad;
    const total = t.BUY + t.HOLD + t.SELL;
    g.fillStyle = INK.line;
    g.fillRect(bx, y + u * 0.3, bw, u * 0.9);
    if (!sealed && total) {
      let x = bx;
      for (const [k, color] of [
        ['BUY', INK.up],
        ['HOLD', INK.dim],
        ['SELL', INK.down],
      ] as const) {
        const part = (bw * t[k]) / total;
        g.fillStyle = color;
        g.fillRect(x, y + u * 0.3, part, u * 0.9);
        x += part;
      }
    }
    font(g, u * 0.55, 700);
    g.fillStyle = INK.text;
    g.fillText(sealed ? 'SEALED' : `B ${t.BUY} · H ${t.HOLD} · S ${t.SELL}`, bx, y + u * 1.4);
  });
};

/** Each display's painter, by its `feed`. */
export const PAINTERS: Record<string, Painter> = { portfolio, heatmap, risk: riskBoard, pipeline: pipelineBoard, desks: desksBoard, research, strategies, committee };

/** The widest the ticker's strip gets, in pixels: what's past it is left off. */
const TICKER_MAX = 8192;

/**
 * The ticker's strip onto `c`, `h` pixels high: `items` one after another, once round, the canvas made
 * as wide as they come to (the ticker repeats it along the band). Returns that width.
 */
export function paintTicker(c: HTMLCanvasElement, h: number, items: TickerItem[]): number {
  let g = c.getContext('2d')!;
  font(g, h * 0.58, 800);
  const gap = h * 1.2;
  const span = Math.max(h, Math.min(TICKER_MAX, Math.ceil(items.reduce((a, i) => a + g.measureText(i.text).width + gap, 0))));
  if (c.width !== span || c.height !== h) {
    c.width = span;
    c.height = h;
    // A canvas sized afresh forgets how it was drawing.
    g = c.getContext('2d')!;
  }
  const alarm = items.some((i) => i.tone === 'alarm');
  g.fillStyle = alarm ? '#1a0505' : '#050505';
  g.fillRect(0, 0, span, h);
  font(g, h * 0.58, 800);
  g.textBaseline = 'middle';
  const color = { up: INK.up, down: INK.down, flat: INK.text, alarm: '#ff5252', info: INK.amber } as const;
  let at = gap / 2;
  for (const i of items) {
    g.fillStyle = color[i.tone];
    g.fillText(i.text, at, h / 2);
    at += g.measureText(i.text).width;
    g.fillStyle = INK.line;
    g.fillText('·', at + gap * 0.4, h / 2);
    at += gap;
  }
  return span;
}
