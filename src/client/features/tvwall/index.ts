/**
 * The TV wall: the screens up over the boards. Each shows what someone on the floor tuned it to, and
 * E at one (or Y anywhere in the office) opens the window to change them, or to watch one up close.
 */
import { tvEmbedUrl, tvTitle, type TvKind, type TvScreen } from '../../../shared/tvwall';
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { store } from '../../state';
import { clip, modalOpen } from '../../ui/dom';
import { frameLayer } from './css3d';
import { paintAgent, paintOff, paintTicker } from './screens';
import { openTvWall, sameSite } from './ui';
import type { TvView } from './world';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    tvwall: true;
  }
}

/** Each kind's color: the light under its screen, and its caption's stripe. */
const KIND_COLOR: Record<TvKind, string> = { youtube: '#ff3b4e', chart: '#36d6ff', ticker: '#ffb020', agent: '#3ddc97', web: '#a78bfa', off: '#3a3f4b' };
/** How often a painted screen is painted again: the crawl wants it smooth, a terminal less so. */
const REPAINT_MS: Partial<Record<TvKind, number>> = { ticker: 1000 / 30, agent: 250 };

const OFF: TvScreen = { channel: { kind: 'off' } };

export function installTvWall(ctx: Ctx) {
  const tvs = (): readonly TvView[] => ctx.office.tvwall.tvs;
  const layer = frameLayer(ctx.renderer.domElement);
  /** What each screen was last set up for, so a change that isn't one leaves its frame playing. */
  const shown = new Map<TvView, string>();
  const painted = new Map<TvView, { screen: TvScreen; next: number }>();

  const screenOf = (tv: TvView): TvScreen => store.tvwall.screens[tv.place.id] ?? OFF;

  /** Sets every screen up for what it shows now. */
  function tune() {
    for (const tv of tvs()) {
      const s = screenOf(tv);
      const k = JSON.stringify(s);
      if (shown.get(tv) === k) continue;
      shown.set(tv, k);
      const c = s.channel;
      const src = tvEmbedUrl(c);
      const live = (c.kind === 'youtube' && !!c.channel) || c.kind === 'ticker' || c.kind === 'agent';
      tv.caption(s.label ?? tvTitle(c), KIND_COLOR[c.kind], live);
      if (src && !sameSite(src)) {
        layer.show(tv, src);
        tv.painted(false);
        painted.delete(tv);
      } else {
        layer.show(tv, null);
        tv.painted(true);
        painted.set(tv, { screen: src ? { channel: { kind: 'off' }, label: "Can't show the office in itself" } : s, next: 0 });
      }
    }
  }
  store.on('tvwall', tune);
  tune();

  function paint(tv: TvView, s: TvScreen, now: number) {
    const g = tv.canvas.getContext('2d')!;
    const c = s.channel;
    if (c.kind === 'ticker') paintTicker(g, c.url, s.label, now / 1000);
    else if (c.kind === 'agent') paintAgent(g, c, s.label, now);
    else paintOff(g, s.label ?? tvTitle(c), c.kind === 'off' ? undefined : s.label);
    tv.texture.needsUpdate = true;
  }

  ctx.ticks.add('render', (f) => {
    const here = ctx.inOffice() && !ctx.upTop();
    if (here)
      for (const [tv, p] of painted) {
        if (f.now < p.next) continue;
        paint(tv, p.screen, f.now);
        // Off, it stays as it is until it's tuned again.
        p.next = f.now + (REPAINT_MS[p.screen.channel.kind] ?? Infinity);
      }
    layer.render(ctx.camera, here);
  });

  const ids = () => tvs().map((t) => t.place.id);
  const tvAt = (it: unknown) => tvs().find((t) => t.interactable === it);

  ctx.interactions.define('tvwall', {
    reach: 9,
    hint: (it) => {
      const tv = tvAt(it);
      const s = tv ? screenOf(tv) : OFF;
      const what = s.label ?? tvTitle(s.channel);
      return { k: `${tv?.place.id}|${what}`, parts: [hintTitle(`📺 TV ${tv ? ids().indexOf(tv.place.id) + 1 : ''}`), aside(clip(what, 40)), key('E', 'Change the channel')] };
    },
    use: onE((it) => openTvWall(ctx.net, ids(), tvAt(it)?.place.id)),
  });

  // Y anywhere in the office opens the TV wall's window.
  ctx.keys.bind({
    code: 'KeyY',
    when: () => ctx.inOffice() && !modalOpen() && tvs().length > 0,
    run: () => openTvWall(ctx.net, ids()),
  });
}
