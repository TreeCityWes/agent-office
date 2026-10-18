/**
 * The 💼 fund on the trading floor (docs/fund.md#the-trading-floor). While you're on a floor-style map
 * its big displays show the fund (floor-paint.ts paints them), the ticker runs its prices, the risk
 * beacon turns amber or red against the limits, and a placard over each staffed desk says which role
 * sits there. It finds the displays by the `feed` the world marks them with (world/floor/props.ts).
 * It only reads the fund, watching it while the floor's up just as the window does while it's open.
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { riskAlarm, tickerItems, type AlarmLevel } from '../../../shared/fund/floor';
import { DEPARTMENTS, ROLE_BY_ID } from '../../../shared/fund/roles';
import { store } from '../../state';
import { DISPLAY_RES, displayPixels, type FeedMark } from '../../world/floor/props';
import { textPlane } from '../../world/toon';
import type { World } from '../../world/world';
import { PAINTERS, paintTicker } from './floor-paint';

/** The soonest the screens follow a change to the fund, and the longest they go between paints (for the clock in their corner). */
const EVERY_MS = 1000;
const AT_MOST_MS = 30_000;
/** The beacon's level for each state of risk. */
const BEACON: Record<AlarmLevel, number> = { calm: 0, watch: 1, alarm: 2 };

/** A display or the ticker, and the canvas the fund's painted onto: shown on it from the first paint. */
interface Screen {
  mark: FeedMark;
  mat: THREE.MeshBasicMaterial;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture | null;
}

/** Drives the floor's screens from the fund. `watch` is the fund feature's shared watch (see index.ts). */
export function driveFloorScreens(ctx: Ctx, watch: (on: boolean) => void) {
  let world: World | null = null;
  let screens: Screen[] = [];
  let beacons: FeedMark[] = [];
  /** The placards up, by desk and role. */
  const placards = new Map<string, THREE.Group>();
  let watching = false;
  let dirty = true;
  let painted = -Infinity;
  let floorAt = store.floor;
  store.on('fund', () => (dirty = true));

  /** Finds what there is to drive in `w`, a world just put up, and watches the fund if there's any. */
  function attach(w: World) {
    world = w;
    screens = [];
    beacons = [];
    // The last world's placards went with it.
    placards.clear();
    const floor = w.plan.style === 'floor';
    if (floor !== watching) watch((watching = floor));
    if (!floor) return;
    w.group.traverse((o) => {
      const mark = o.userData.feed as FeedMark | undefined;
      if (!mark) return;
      if (mark.feed === 'beacon') return void beacons.push(mark);
      if (!mark.size || (mark.feed !== 'ticker' && !PAINTERS[mark.feed])) return;
      const canvas = document.createElement('canvas');
      [canvas.width, canvas.height] = displayPixels(mark.size);
      screens.push({ mark, mat: (o as THREE.Mesh).material as THREE.MeshBasicMaterial, canvas, tex: null });
    });
    dirty = true;
  }

  /** Puts `sc`'s canvas up on its screen the first time, then tells it the picture's changed; `repeat` for the ticker. */
  function show(sc: Screen, repeat?: number) {
    if (!sc.tex) {
      sc.tex = new THREE.CanvasTexture(sc.canvas);
      sc.tex.colorSpace = THREE.SRGBColorSpace;
      sc.tex.anisotropy = 8;
      if (repeat) sc.tex.wrapS = THREE.RepeatWrapping;
      sc.mat.map?.dispose();
      sc.mat.map = sc.tex;
      sc.mat.needsUpdate = true;
    }
    if (repeat) sc.tex.repeat.x = repeat;
    sc.tex.needsUpdate = true;
  }

  function paint(w: World) {
    const s = store.fund!;
    const now = Date.now();
    const risk = riskAlarm(s, now);
    for (const b of beacons) b.alarm = BEACON[risk.level];
    for (const sc of screens) {
      if (sc.mark.feed === 'ticker') {
        // As tall as the band's own picture, as long as the prices come to, and repeated along it.
        const [len, high] = sc.mark.size!;
        const was = sc.canvas.width;
        const wide = paintTicker(sc.canvas, Math.round(high * DISPLAY_RES * 2), tickerItems(s, now));
        // A canvas of another size needs its texture made afresh.
        if (sc.tex && wide !== was) sc.tex.dispose();
        show(sc, (len * DISPLAY_RES * 2) / wide);
      } else {
        PAINTERS[sc.mark.feed](sc.canvas.getContext('2d')!, sc.canvas.width, sc.canvas.height, s, risk, now);
        show(sc);
      }
    }
    hang(w);
  }

  /** A placard for `role`: its department's icon and its title, in the department's color, readable from both sides. */
  function placard(role: string): THREE.Group | null {
    const r = ROLE_BY_ID.get(role);
    if (!r) return null;
    const dep = DEPARTMENTS[r.department];
    const front = textPlane(`${dep.icon} ${r.title}`, { bg: '#0b0e13', color: '#f4f6f8', border: dep.color, size: 34 });
    const back = front.clone();
    back.rotation.y = Math.PI;
    back.position.z = -0.005;
    const g = new THREE.Group();
    g.add(front, back);
    // Over the seat's monitors.
    g.position.set(0, 1.55, -0.5);
    return g;
  }

  function drop(g: THREE.Group) {
    g.removeFromParent();
    const m = g.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    m.geometry.dispose();
    m.material.map?.dispose();
    m.material.dispose();
  }

  /** The placards over this floor's staffed desks, as the fund has them now. */
  function hang(w: World) {
    const want = new Map<string, { deskId: string; role: string }>();
    for (const d of store.fund?.desks.desks ?? []) if (d.floorId === store.floor && w.desks.has(d.deskId)) want.set(`${d.deskId} ${d.role}`, d);
    for (const [k, g] of placards) {
      if (want.has(k)) continue;
      drop(g);
      placards.delete(k);
    }
    for (const [k, d] of want) {
      if (placards.has(k)) continue;
      const g = placard(d.role);
      if (!g) continue;
      w.desks.get(d.deskId)!.group.add(g);
      placards.set(k, g);
    }
  }

  ctx.ticks.add('world', ({ now }) => {
    const w = ctx.world();
    if (w !== world) attach(w);
    if (store.floor !== floorAt) {
      floorAt = store.floor;
      dirty = true;
    }
    if (!watching || !store.fund) return;
    if ((dirty && now - painted >= EVERY_MS) || now - painted >= AT_MOST_MS) {
      dirty = false;
      painted = now;
      paint(w);
    }
  });
}
