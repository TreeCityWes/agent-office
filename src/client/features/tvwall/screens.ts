import type { WorkerStatus } from '../../../shared/protocol';
import type { TvChannel } from '../../../shared/tvwall';
import { isAsleep } from '../../../shared/status';
import { store } from '../../state';
import { paintScreen } from '../workers/laptop';
import { headlines } from './feeds';
import { SCREEN_PX } from './world';

// What the office paints onto a TV wall screen itself: a news ticker, a worker's terminal, or a "no
// signal" card for a screen that's off (or showing something it can't).

const { w: W, h: H } = SCREEN_PX;
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
const SANS = '"IBM Plex Sans Condensed", "Segoe UI", system-ui, sans-serif';
const BG = '#070a0f';
const INK = '#e6edf3';
const DIM = '#7d8796';
/** How long the agent channel stays on each worker, going round them all. */
const AGENT_TURN_MS = 15_000;
/** How fast the ticker's crawl goes, in canvas pixels a second. */
const CRAWL_PX_S = 140;

const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function frame(g: CanvasRenderingContext2D) {
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  // A fine grid, like a monitoring display.
  g.strokeStyle = 'rgba(80,120,170,0.07)';
  g.lineWidth = 1;
  for (let x = 0; x < W; x += 64) g.strokeRect(x + 0.5, -1, 0, H + 2);
  for (let y = 0; y < H; y += 64) g.strokeRect(-1, y + 0.5, W + 2, 0);
}

/** A band across the top: a tag in the channel's color, a title, and the time. */
function header(g: CanvasRenderingContext2D, tag: string, color: string, title: string) {
  g.fillStyle = 'rgba(14,19,27,0.96)';
  g.fillRect(0, 0, W, 64);
  g.fillStyle = color;
  g.fillRect(0, 62, W, 2);
  g.font = `700 26px ${MONO}`;
  g.textBaseline = 'middle';
  const tw = g.measureText(tag).width + 28;
  g.fillRect(20, 14, tw, 36);
  g.fillStyle = BG;
  g.fillText(tag, 34, 33);
  g.fillStyle = INK;
  g.font = `600 30px ${SANS}`;
  g.fillText(title, 20 + tw + 20, 33, W - tw - 260);
  g.fillStyle = DIM;
  g.font = `500 26px ${MONO}`;
  g.textAlign = 'right';
  g.fillText(clock(), W - 22, 33);
  g.textAlign = 'left';
}

/** Off, or something it can't show: a quiet card saying so. */
export function paintOff(g: CanvasRenderingContext2D, title: string, note?: string) {
  frame(g);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#2a3140';
  g.font = `700 92px ${MONO}`;
  g.fillText('NO SIGNAL', W / 2, H / 2 - 30);
  g.fillStyle = DIM;
  g.font = `500 30px ${MONO}`;
  g.fillText(note ?? title.toUpperCase(), W / 2, H / 2 + 50, W - 120);
  g.textAlign = 'left';
}

function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width <= maxW || !line) line = next;
    else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines;
}

const ago = (at?: number) => {
  if (!at) return '';
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/**
 * Headlines: the top story big, the next few listed under it, and all of them crawling along the
 * bottom. Every so often the next story takes the top. `t` is seconds.
 */
export function paintTicker(g: CanvasRenderingContext2D, url: string, label: string | undefined, t: number) {
  const feed = headlines(url);
  frame(g);
  header(g, 'NEWS', '#ffb020', label ?? feed?.title ?? new URL(url).hostname);
  const items = feed?.items ?? [];
  if (!items.length) {
    g.fillStyle = DIM;
    g.font = `500 32px ${MONO}`;
    g.textBaseline = 'middle';
    g.fillText(feed ? (feed.error ?? 'No headlines in that feed') : 'Fetching headlines…', 40, H / 2, W - 80);
    return;
  }
  const lead = Math.floor(t / 12) % items.length;
  const top = items[lead];
  g.textBaseline = 'top';
  g.fillStyle = '#ffb020';
  g.font = `600 24px ${MONO}`;
  g.fillText(`TOP STORY ${ago(top.at) && `· ${ago(top.at)} ago`}`, 40, 96);
  g.fillStyle = INK;
  g.font = `700 50px ${SANS}`;
  const big = wrap(g, top.title, W - 80, 3);
  big.forEach((l, i) => g.fillText(l, 40, 134 + i * 60));
  let y = 134 + big.length * 60 + 28;
  g.font = `500 30px ${SANS}`;
  for (let i = 1; i <= 4 && y < H - 130; i++) {
    const it = items[(lead + i) % items.length];
    g.fillStyle = '#ffb020';
    g.fillRect(40, y + 12, 10, 10);
    g.fillStyle = '#c3cbd6';
    g.fillText(wrap(g, it.title, W - 200, 1)[0] ?? '', 66, y, W - 200);
    g.fillStyle = DIM;
    g.textAlign = 'right';
    g.fillText(ago(it.at), W - 40, y);
    g.textAlign = 'left';
    y += 48;
  }
  // The crawl.
  const band = 70;
  g.fillStyle = '#ffb020';
  g.fillRect(0, H - band, W, band);
  g.fillStyle = BG;
  g.font = `700 32px ${SANS}`;
  g.textBaseline = 'middle';
  const sep = '   ◆   ';
  const all = items.map((i) => i.title).join(sep) + sep;
  const width = g.measureText(all).width;
  let x = -((t * CRAWL_PX_S) % width);
  while (x < W) {
    g.fillText(all, x, H - band / 2);
    x += width;
  }
}

/** Which worker the agent channel is on, going round the floor's workers awake first. */
function agentOn(c: Extract<TvChannel, { kind: 'agent' }>, now: number) {
  if (c.worker) return store.workers.get(c.worker);
  const all = [...store.workers.values()];
  const awake = all.filter((w) => !isAsleep(w.status));
  const pool = awake.length ? awake : all;
  return pool.length ? pool[Math.floor(now / AGENT_TURN_MS) % pool.length] : undefined;
}

const STATUS_COLOR: Partial<Record<WorkerStatus, string>> = { working: '#3ddc97', needs_input: '#ff3b4e', done: '#36d6ff', idle: '#ffb020', starting: '#ffb020' };

/** A worker's terminal, live, under a band naming it and saying what it's up to. */
export function paintAgent(g: CanvasRenderingContext2D, c: Extract<TvChannel, { kind: 'agent' }>, label: string | undefined, now: number) {
  const w = agentOn(c, now);
  frame(g);
  header(g, 'AGENT', '#3ddc97', w ? `${w.name}${label ? ` · ${label}` : ''}` : (label ?? 'Agents'));
  if (!w) {
    g.fillStyle = DIM;
    g.font = `500 32px ${MONO}`;
    g.textBaseline = 'middle';
    g.fillText(c.worker ? 'That worker has gone home' : 'No workers on this floor yet', 40, H / 2);
    return;
  }
  const color = STATUS_COLOR[w.status] ?? DIM;
  g.fillStyle = color;
  g.font = `700 22px ${MONO}`;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillText(`● ${w.status.replace('_', ' ').toUpperCase()}`, W - 180, 33);
  g.textAlign = 'left';
  g.save();
  g.translate(0, 66);
  paintScreen(g, W, H - 66, store.screens.get(w.id), 'waiting for output…', 26);
  g.restore();
}
