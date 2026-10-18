// The pieces every tab of the 💼 Fund window is made of: numbers coloured by sign, stat tiles, tables,
// the NAV chart and a button that asks twice.
import type { ClientMsg } from '../../../shared/protocol';
import type { FundState, NavPoint } from '../../../shared/fund/state';
import type { ActivityEvent } from '../../../shared/fund/types';
import { pct, signedUsd } from '../../../shared/fund/format';
import { h } from '../../ui/dom';

/** What a tab gets: a way to send, and whether you may act (an admin) or only look. */
export interface TabDeps {
  send(msg: ClientMsg): void;
  admin(): boolean;
  /** Turns the window to another tab. */
  go(tab: TabId): void;
}

/** A tab: made once when it's first shown, then told each time the fund changes. */
export interface FundTab {
  el: HTMLElement;
  update(s: FundState, activity: readonly ActivityEvent[]): void;
}

export const TABS = [
  { id: 'overview', label: 'Portfolio' },
  { id: 'agents', label: 'Agents' },
  { id: 'research', label: 'Research' },
  { id: 'proposals', label: 'Proposals' },
  { id: 'committee', label: 'Committee' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'backtests', label: 'Backtests' },
  { id: 'risk', label: 'Risk' },
  { id: 'market', label: 'Market' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

/** Up, down or flat, for colouring a number. */
export const tone = (n: number) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

/** A signed amount, green or red. */
export const money = (n: number, compact = false) => h('span', { class: `num ${tone(n)}` }, signedUsd(n, { compact }));
/** A signed percentage, green or red. */
export const change = (n: number | undefined, digits = 2) => (n === undefined ? h('span.num.flat', {}, '—') : h('span', { class: `num ${tone(n)}` }, pct(n, digits, true)));

/** A figure with its label above it. */
export function stat(label: string, value: Node | string, sub?: Node | string, warn?: boolean): HTMLElement {
  return h('div', { class: `fd-stat${warn ? ' warn' : ''}` }, h('div.fd-label', {}, label), h('div.fd-value', {}, value), sub ? h('div.fd-sub', {}, sub) : null);
}

/** A section with an amber heading. */
export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section.fd-section', {}, h('h3', {}, title), ...children);
}

/** A table: a header row, then a row per item. */
export function table(head: string[], rows: (Node | string)[][], opts: { right?: number[]; empty?: string } = {}): HTMLElement {
  if (!rows.length) return h('div.fd-empty', {}, opts.empty ?? 'Nothing yet');
  const align = (i: number) => (opts.right?.includes(i) ? 'r' : undefined);
  return h(
    'table.fd-table',
    {},
    h('thead', {}, h('tr', {}, ...head.map((t, i) => h('th', { class: align(i) }, t)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c, i) => h('td', { class: align(i) }, c))))),
  );
}

/** A bar for how much of a limit is used: amber past 75%, red at it. */
export function gauge(used: number, limit: number): HTMLElement {
  const f = limit > 0 ? Math.min(1, Math.max(0, used / limit)) : used > 0 ? 1 : 0;
  const level = f >= 1 ? 'bad' : f >= 0.75 ? 'warn' : 'ok';
  const bar = h('div', { class: `fd-gauge ${level}` }, h('i', { style: `width:${(f * 100).toFixed(1)}%` }));
  return bar;
}

/**
 * The NAV over time as a line, with the capital paid in as a dashed baseline: green while above it,
 * red below. Inline SVG, so it scales with the window.
 */
export function navChart(points: readonly NavPoint[], base: number): HTMLElement {
  const W = 600;
  const H = 120;
  const wrap = h('div.fd-chart');
  if (points.length < 2) {
    wrap.append(h('div.fd-empty', {}, 'The NAV is drawn here once the fund has traded: every 15 minutes and at every fill.'));
    return wrap;
  }
  const navs = points.map((p) => p.nav);
  const lo = Math.min(base, ...navs);
  const hi = Math.max(base, ...navs);
  const span = hi - lo || 1;
  const t0 = points[0].at;
  const t1 = points[points.length - 1].at || t0 + 1;
  const x = (at: number) => ((at - t0) / (t1 - t0 || 1)) * W;
  const y = (v: number) => H - 6 - ((v - lo) / span) * (H - 12);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.nav).toFixed(1)}`).join('');
  const up = navs[navs.length - 1] >= base;
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="NAV over time">
    <line x1="0" x2="${W}" y1="${y(base).toFixed(1)}" y2="${y(base).toFixed(1)}" class="base" />
    <path d="${line}L${W},${H}L0,${H}Z" class="fill ${up ? 'up' : 'down'}" />
    <path d="${line}" class="line ${up ? 'up' : 'down'}" />
  </svg>`;
  return wrap;
}

/**
 * A button that asks again before it does something hard to undo: the first click turns it into
 * "Sure?", the second does it, and it turns back by itself after a few seconds.
 */
export function confirmButton(label: string, sure: string, run: () => void, cls = 'danger'): HTMLButtonElement {
  let armed = false;
  let timer = 0;
  const btn = h('button', { type: 'button', class: `fd-btn ${cls}` }, label) as HTMLButtonElement;
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = sure;
      btn.classList.add('armed');
      timer = window.setTimeout(() => {
        armed = false;
        btn.textContent = label;
        btn.classList.remove('armed');
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    btn.textContent = label;
    btn.classList.remove('armed');
    run();
  });
  return btn;
}

/** A number input's value, or undefined when it's empty or not a number. */
export function numberOf(input: HTMLInputElement): number | undefined {
  if (input.value.trim() === '') return undefined;
  const n = Number(input.value);
  return Number.isFinite(n) ? n : undefined;
}

/** Hours and minutes, on the browser's clock. */
export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
