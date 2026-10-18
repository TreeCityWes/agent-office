import * as THREE from 'three';
import type { PropConfig } from '../../../shared/maps';
import { PARTITION, POT, STATION_BUILT, type FloorPropKind } from '../../../shared/maps/floor-props';
import type { StationPropKind } from '../../../shared/maps/station-props';
import { canvasTexture } from '../texture';
import { mesh, textPlane, toon } from '../toon';
import { MAX_LIGHTS, box, collide, lit, placed, type Kit } from '../station/kit';
import { PROPS as STATION_PROPS } from '../station/props';
import { idleDisplay, idleTicker } from './textures';

// The props a trading-floor-style map places (see shared/maps/floor-props.ts): light panels in the
// ceiling, the ticker band, the big displays, glass and solid partitions, signs, the risk beacon and
// plants, each put up by its entry in PROPS; the rest are the station's own (a display, a planter,
// the gong, the drinks dispenser, a table).
//
// The displays, the ticker and the beacon are left for the 💼 fund to drive (features/fund/floor.ts):
// each is marked in its userData with the `feed` it shows and its size, and shows something of its
// own until the fund paints it.

/** The station's Kit, and what moves on the floor each frame (the beacon). */
export interface FloorKit extends Kit {
  animate: ((t: number, dt: number) => void)[];
}

/** What a display, the ticker or the beacon carries for whoever drives it. */
export interface FeedMark {
  feed: string;
  /** Its face's size, in meters. */
  size?: [number, number];
  /** The ticker: how fast it runs, in meters a second. */
  scroll?: number;
  /** The beacon: 0 all's well, 1 something's close to a limit, 2 a limit's broken (or trading's halted). */
  alarm?: number;
}

/** Pixels a meter on a display's face. */
export const DISPLAY_RES = 150;
const FEED_TITLE: Record<string, string> = {
  portfolio: '💼 PORTFOLIO',
  heatmap: '🟩 HEATMAP',
  risk: '🛡️ RISK',
  pipeline: '🧭 TRADE PIPELINE',
  desks: '👥 DESKS',
  research: '🔎 THESES',
  strategies: '🧪 STRATEGIES',
  committee: '🗳️ COMMITTEE',
};

/** A light panel let into the ceiling; a few of them light the floor for real. */
function panel(kit: Kit, p: PropConfig) {
  const w = p.width ?? 1.2;
  const l = p.length ?? 3.6;
  const y = Math.min(p.y ?? kit.height, kit.height);
  const g = placed(p.x, y, p.z, p.rotY ?? 0);
  g.add(mesh(box(w + 0.08, 0.04, l + 0.08), kit.mats.metal, 0, -0.02, 0, false));
  g.add(mesh(box(w, 0.02, l), kit.mats.lamp, 0, -0.045, 0, false));
  kit.still.add(g);
  if (!p.light || kit.lights.length >= MAX_LIGHTS) return;
  const light = new THREE.PointLight('#fff6e8', 26, 24, 1.5);
  light.position.set(p.x, y - 0.6, p.z);
  kit.group.add(light);
  kit.lights.push(light);
}

/** A face for a display or the ticker: a plane showing `map`, unlit, marked with what it shows. */
function face(w: number, h: number, map: THREE.Texture, mark: FeedMark): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map, toneMapped: false }));
  m.userData.feed = mark;
  return m;
}

/** The ticker band: prices running along a wall, in amber on black, under a strip of light. */
function ticker(kit: Kit, p: PropConfig) {
  const len = p.length ?? p.width ?? 10;
  const h = p.height ?? 0.5;
  const g = placed(p.x, p.y ?? 3, p.z, p.rotY ?? 0);
  g.add(mesh(box(len + 0.2, h + 0.16, 0.1), kit.mats.black, 0, 0, 0.05, false));
  g.add(mesh(box(len + 0.2, 0.03, 0.03), kit.mats.accent, 0, h / 2 + 0.09, 0.1, false));
  g.add(mesh(box(len + 0.2, 0.03, 0.03), kit.mats.accent, 0, -h / 2 - 0.09, 0.1, false));
  // A stretch of it the texture repeats along, so the text keeps its shape however long the band.
  const px = Math.round(h * DISPLAY_RES * 2);
  const repeat = Math.max(1, Math.round(len / 12));
  const map = canvasTexture(Math.round((len / repeat) * DISPLAY_RES * 2), px, idleTicker(Math.round((len / repeat) * DISPLAY_RES * 2), px), [repeat, 1]);
  const f = face(len, h, map, { feed: 'ticker', size: [len, h], scroll: 1.6 });
  f.position.z = 0.105;
  g.add(f);
  kit.group.add(g);
}

/** A big display on a wall, framed, a line of light under it: the fund's `feed`, live. */
function wall(kit: Kit, p: PropConfig) {
  const w = p.width ?? 4;
  const h = p.height ?? 2.4;
  const g = placed(p.x, p.y ?? 2.5, p.z, p.rotY ?? 0);
  g.add(mesh(box(w + 0.22, h + 0.22, 0.1), kit.mats.black, 0, 0, 0.05, false));
  g.add(mesh(box(w * 0.6, 0.03, 0.03), kit.mats.accent, 0, -h / 2 - 0.2, 0.06, false));
  const feed = p.feed ?? 'portfolio';
  const [pw, ph] = [Math.round(w * DISPLAY_RES), Math.round(h * DISPLAY_RES)];
  const f = face(w, h, canvasTexture(pw, ph, idleDisplay(FEED_TITLE[feed] ?? feed.toUpperCase(), pw, ph)), { feed, size: [w, h] });
  f.position.z = 0.105;
  g.add(f);
  kit.group.add(g);
}

/** A glass partition, framed top and bottom, a post at each end. */
function glass(kit: Kit, p: PropConfig) {
  const len = p.length ?? 3;
  const h = p.height ?? PARTITION.height;
  const g = placed(p.x, 0, p.z, p.rotY ?? 0);
  const { metal, metalDark } = kit.mats;
  g.add(mesh(box(PARTITION.depth, 0.1, len), metalDark, 0, 0.05, 0, false));
  g.add(mesh(box(PARTITION.depth, 0.08, len), metal, 0, h - 0.04, 0, false));
  for (const s of [-1, 1]) g.add(mesh(box(PARTITION.depth + 0.02, h, 0.08), metal, 0, h / 2, s * (len / 2 - 0.04), false));
  kit.still.add(g);
  const pane = new THREE.PlaneGeometry(len - 0.08, h - 0.18).rotateY(Math.PI / 2 + (p.rotY ?? 0));
  pane.translate(p.x, h / 2 + 0.01, p.z);
  const m = new THREE.Mesh(pane, kit.mats.glass);
  kit.group.add(m);
  // A frosted band at eye height, so you see there's glass there.
  const band = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.08, 0.32).rotateY(Math.PI / 2 + (p.rotY ?? 0)), frost);
  band.position.set(p.x, 1.3, p.z);
  kit.group.add(band);
  collide(kit, p.x, p.z, PARTITION.depth, len, p.rotY ?? 0, 99, { fence: true });
}

const frost = lit('#e8f1fa', { opacity: 0.22, side: THREE.DoubleSide });

/** A solid partition, a wall for a room, something to hang a display on either side. */
function partition(kit: Kit, p: PropConfig) {
  const len = p.length ?? 3;
  const h = p.height ?? PARTITION.height;
  const g = placed(p.x, 0, p.z, p.rotY ?? 0);
  g.add(mesh(box(PARTITION.depth, h, len), kit.mats.hull, 0, h / 2, 0));
  g.add(mesh(box(PARTITION.depth + 0.02, 0.06, len), kit.mats.metal, 0, h - 0.03, 0, false));
  kit.still.add(g);
  collide(kit, p.x, p.z, PARTITION.depth, len, p.rotY ?? 0, 99, { fence: true });
}

/** A sign hung from the ceiling on two rods, the same both sides. */
function sign(kit: Kit, p: PropConfig) {
  const y = p.y ?? 2.6;
  const g = placed(p.x, y, p.z, p.rotY ?? 0);
  const front = textPlane(p.text ?? '', { bg: '#11161d', color: '#f4f6f8', border: '#ffb000', size: 56 });
  front.scale.multiplyScalar(p.scale ?? 0.8);
  front.position.z = 0.01;
  const back = front.clone();
  back.rotation.y = Math.PI;
  back.position.z = -0.01;
  g.add(front, back);
  const half = ((front.geometry.parameters.width * front.scale.x) / 2) * 0.8;
  const top = kit.height - y;
  for (const s of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, top, 4), kit.mats.metalDark, s * half, top / 2, 0, false));
  kit.group.add(g);
}

/** The risk beacon: a dome on a stalk, steady green while all's well, amber and pulsing near a limit, red and turning past one. */
function beacon(kit: FloorKit, p: PropConfig) {
  const y = p.y ?? 3;
  const g = placed(p.x, y, p.z);
  g.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, kit.height - y, 6), kit.mats.metalDark, 0, (kit.height - y) / 2, 0, false));
  g.add(mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.12, 16), kit.mats.metalDark, 0, -0.06, 0, false));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), lit('#1f9d55', { opacity: 0.85 }));
  dome.rotation.x = Math.PI;
  dome.position.y = -0.12;
  g.add(dome);
  // The beam it throws round when it turns: a wedge of light, out to either side.
  const spin = new THREE.Group();
  spin.position.y = -0.22;
  const beam = lit('#ff2a2a', { opacity: 0.0, additive: true, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.2, 16, 1, true).rotateZ((s * Math.PI) / 2), beam);
    cone.position.x = s * 1.6;
    spin.add(cone);
  }
  g.add(spin);
  const light = new THREE.PointLight('#ff2a2a', 0, 16, 1.4);
  light.position.y = -0.4;
  g.add(light);
  const mark: FeedMark = { feed: 'beacon', alarm: 0 };
  g.userData.feed = mark;
  kit.group.add(g);
  const colors = [new THREE.Color('#1f9d55'), new THREE.Color('#ffb000'), new THREE.Color('#ff2a2a')];
  kit.animate.push((t) => {
    const level = Math.max(0, Math.min(2, Math.round(mark.alarm ?? 0)));
    const flash = level === 2 ? 0.55 + 0.45 * Math.sin(t * 12) : level === 1 ? 0.6 + 0.4 * Math.sin(t * 3) : 0.55;
    (dome.material as THREE.MeshBasicMaterial).color.copy(colors[level]).multiplyScalar(flash);
    spin.rotation.y = level === 2 ? t * 5 : 0;
    beam.opacity = level === 2 ? 0.16 : 0;
    light.intensity = level === 2 ? 14 * flash : level === 1 ? 3 * flash : 0;
    light.color.copy(colors[level]);
  });
}

const LEAVES = ['#2f7d45', '#3f9b4d', '#57b85a'];

/** A tall plant in a pot. */
function plant(kit: Kit, p: PropConfig) {
  const s = p.scale ?? 1;
  const g = placed(p.x, 0, p.z, p.rotY ?? 0);
  g.scale.setScalar(s);
  g.add(mesh(new THREE.CylinderGeometry(POT / 2, POT / 2.6, 0.62, 16), kit.mats.metalDark, 0, 0.31, 0));
  g.add(mesh(new THREE.CylinderGeometry(POT / 2 - 0.04, POT / 2 - 0.04, 0.03, 16), toon('#3a2a20'), 0, 0.6, 0, false));
  g.add(mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.3, 6), toon('#6b4f36'), 0, 1.2, 0, false));
  for (let i = 0; i < 7; i++) {
    const a = i * 2.4;
    const yy = 1.1 + (i % 4) * 0.28;
    g.add(mesh(new THREE.SphereGeometry(0.3 - (i % 3) * 0.04, 8, 6), toon(LEAVES[i % LEAVES.length]), Math.cos(a) * 0.2, yy, Math.sin(a) * 0.2));
  }
  g.add(mesh(new THREE.SphereGeometry(0.26, 8, 6), toon(LEAVES[0]), 0, 2.15, 0));
  kit.still.add(g);
  collide(kit, p.x, p.z, POT * s, POT * s, 0, 2 * s);
}

const OWN: Record<Exclude<FloorPropKind, (typeof STATION_BUILT)[number]>, (kit: FloorKit, p: PropConfig) => void> = { panel, ticker, wall, glass, partition, sign, beacon, plant };

/** Each kind of prop, put up (every kind there is has one: see FLOOR_PROP_KINDS). */
export const PROPS: Record<FloorPropKind, (kit: FloorKit, p: PropConfig) => void> = {
  ...OWN,
  ...(Object.fromEntries(STATION_BUILT.map((k) => [k, STATION_PROPS[k as StationPropKind]])) as Record<(typeof STATION_BUILT)[number], (kit: Kit, p: PropConfig) => void>),
};

/** A display's face size in pixels, for whoever paints it. */
export const displayPixels = (size: [number, number]): [number, number] => [Math.round(size[0] * DISPLAY_RES), Math.round(size[1] * DISPLAY_RES)];
