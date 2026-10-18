import * as THREE from 'three';
import type { Bounds } from '../../../shared/nav';
import { canvasTexture, tilingCanvasTexture } from '../texture';
import { Batch, tileBox } from '../station/kit';
import { seeded } from '../station/textures';
import { facade } from './textures';

/*
 * What's through the trading floor's glass: the city it's high up over, towers all round, most of
 * them below you and a few taller, out to the haze, and the streets far down. By day their glass
 * takes the sky; at night they're dark but for the offices still at work. The sky itself is the
 * office's own (the real one, or the hour's), which shows through the glass as it does anywhere.
 */

/** How far down the street is, and how far out the towers go. */
const STREET = -150;
const NEAR = 34;
const FAR = 330;
/** One tile of a tower's face (four bays by four storeys). */
const TILE = 12;
const GLASS = ['#7fa7c9', '#8db3c7', '#9aa9bb', '#6f93b3'];

export interface Skyline {
  group: THREE.Group;
  /** By day or night: `daylight` 1 by day, 0 at night. */
  update(daylight: number): void;
  dispose(): void;
}

/** A tower's faces a little darker on two sides, its roof darker still, so the boxes read as boxes in unlit paint. */
function shadeFaces(geo: THREE.BufferGeometry) {
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(nor.count * 3);
  for (let i = 0; i < nor.count; i++) {
    const k = Math.abs(nor.getY(i)) > 0.5 ? 0.62 : Math.abs(nor.getX(i)) > 0.5 ? 0.8 : 1;
    colors.set([k, k, k], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Puts up the city round a floor of `b`, the same in everyone's browser. */
export function buildSkyline(b: Bounds): Skyline {
  const group = new THREE.Group();
  const rand = seeded(2026);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const reach = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
  const looks = GLASS.map((glass, i) => {
    const day = tilingCanvasTexture(256, 256, facade(100 + i, false, glass));
    const night = tilingCanvasTexture(256, 256, facade(200 + i, true, glass));
    const mat = new THREE.MeshBasicMaterial({ map: day, vertexColors: true });
    mat.userData.outlineParameters = { visible: false };
    return { day, night, mat };
  });
  const batch = new Batch();
  const placed: [number, number, number][] = [];
  for (let n = 0; n < 220 && placed.length < 90; n++) {
    const a = rand() * Math.PI * 2;
    const d = reach + NEAR + Math.pow(rand(), 0.8) * (FAR - reach - NEAR);
    const x = cx + Math.cos(a) * d;
    const z = cz + Math.sin(a) * d;
    const w = 14 + rand() * 22;
    // Room round each, for streets.
    if (placed.some(([px, pz, pw]) => Math.abs(px - x) < (pw + w) / 2 + 8 && Math.abs(pz - z) < (pw + w) / 2 + 8)) continue;
    placed.push([x, z, w]);
    // Most of them under you, the odd one far taller; the further off, the taller they can be and still show.
    const top = -70 + rand() * 80 + (rand() < 0.18 ? 40 + rand() * 60 : 0) + (d / FAR) * 25;
    const h = top - STREET;
    const geo = tileBox(w, h, w * (0.7 + rand() * 0.5), TILE, { x, y: STREET + h / 2, z });
    shadeFaces(geo);
    batch.add(geo, looks[Math.floor(rand() * looks.length)].mat);
  }
  group.add(batch.build(false));
  // The streets, far down: a grid of light by night, grey by day.
  const streets = new THREE.MeshBasicMaterial({
    map: canvasTexture(
      256,
      256,
      (g) => {
        g.fillStyle = '#2f343b';
        g.fillRect(0, 0, 256, 256);
        g.fillStyle = '#4a5059';
        g.fillRect(0, 118, 256, 20);
        g.fillRect(118, 0, 20, 256);
      },
      [24, 24],
    ),
  });
  streets.userData.outlineParameters = { visible: false };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(FAR * 4, FAR * 4).rotateX(-Math.PI / 2), streets);
  ground.position.set(cx, STREET, cz);
  group.add(ground);
  const day = new THREE.Color('#ffffff');
  const dusk = new THREE.Color('#b7a6c4');
  const dark = new THREE.Color('#ffffff');
  const groundDay = new THREE.Color('#9aa3ad');
  const groundNight = new THREE.Color('#1b1f26');
  let wasNight: boolean | null = null;
  return {
    group,
    update(daylight) {
      const night = daylight < 0.35;
      if (night !== wasNight) {
        for (const l of looks) l.mat.map = night ? l.night : l.day;
        wasNight = night;
      }
      for (const l of looks) l.mat.color.copy(night ? dark : dusk).lerp(day, night ? 1 : Math.min(1, (daylight - 0.35) / 0.4));
      streets.color.copy(groundNight).lerp(groundDay, daylight);
    },
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const l of looks) {
        l.day.dispose();
        l.night.dispose();
        l.mat.dispose();
      }
      streets.map?.dispose();
      streets.dispose();
    },
  };
}
