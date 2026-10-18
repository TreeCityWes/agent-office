import * as THREE from 'three';
import type { WallSide } from '../../../shared/maps';
import type { Pt } from '../../../shared/nav';
import { tilingCanvasTexture } from '../texture';
import { mesh, textPlane } from '../toon';
import { Batch, box, placed, shade, tileBox, type Kit } from '../station/kit';
import { wallFrame } from '../station/shell';
import { toonMap } from '../station/textures';
import { carpet, ceilingTiles, wallPanels } from './textures';

// The trading floor's shell: the carpet, the ceiling, a solid wall where the lifts are and another
// facing it, glass floor to ceiling down the other two sides with the city beyond, and the lifts:
// a pair of doors that slide apart, and the lobby behind them that workers come and go by.

/** How thick the outside walls are, and how big the way in is. */
export const SHELL = { wall: 0.3, doorWidth: 2.6, doorHeight: 2.9, sill: 0.32, head: 0.42, mullion: 3 } as const;

/** The wall nearest (x, z), where the way in is. */
function nearestWall(kit: Kit, x: number, z: number): WallSide {
  const b = kit.plan.bounds;
  const gaps: [WallSide, number][] = [
    ['west', x - b.minX],
    ['east', b.maxX - x],
    ['north', z - b.minZ],
    ['south', b.maxZ - z],
  ];
  return gaps.sort((p, q) => p[1] - q[1])[0][0];
}

const OPPOSITE: Record<WallSide, WallSide> = { west: 'east', east: 'west', north: 'south', south: 'north' };

/**
 * Puts up the shell. Returns where the way in is, which way is out through it, and how to slide its
 * doors (0 shut, 1 open).
 */
export function buildShell(kit: Kit, pal: { hull: string; deck: string; panel: string }): { doorAt: THREE.Vector3; out: Pt; slide(open: number): void } {
  const { plan, group, still, mats } = kit;
  const b = plan.bounds;
  const H = plan.height;
  const T = SHELL.wall;
  const W = b.maxX - b.minX;
  const L = b.maxZ - b.minZ;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const pieces = new Batch();
  const panes = new Batch();
  const walls = toonMap(tilingCanvasTexture(256, 256, wallPanels(pal.hull)));

  pieces.add(tileBox(W + 2 * T, T, L + 2 * T, 2, { x: cx, y: -T / 2, z: cz }), toonMap(tilingCanvasTexture(512, 512, carpet(pal.deck))));
  pieces.add(tileBox(W + 2 * T, T, L + 2 * T, 2.4, { x: cx, y: H + T / 2, z: cz }), toonMap(tilingCanvasTexture(256, 256, ceilingTiles('#c9ccd1'))));
  kit.colliders.push({ minX: b.minX - 8, maxX: b.maxX + 8, minZ: b.minZ - 8, maxZ: b.maxZ + 8, top: 0 });

  const doorSide = nearestWall(kit, plan.door.x, plan.door.z);
  const doorF = wallFrame(b, doorSide);
  const doorU = doorF.alongX ? plan.door.x : plan.door.z;
  for (const side of ['west', 'east', 'north', 'south'] as const) {
    const f = wallFrame(b, side);
    // The side walls run past the end walls, to close the corners.
    const [lo, hi] = f.alongX ? [b.minX, b.maxX] : [b.minZ - T, b.maxZ + T];
    const [x0, z0] = f.at(lo, 0);
    const [x1, z1] = f.at(hi, T);
    kit.colliders.push({ minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1), top: 99, fence: true });
    const solid = side === doorSide || side === OPPOSITE[doorSide];
    if (solid) {
      const piece = (u0: number, u1: number, y0: number, y1: number) => {
        if (u1 - u0 < 0.01 || y1 - y0 < 0.01) return;
        const [x, z] = f.at((u0 + u1) / 2, T / 2);
        const [w, d] = f.alongX ? [u1 - u0, T] : [T, u1 - u0];
        pieces.add(tileBox(w, y1 - y0, d, 3, { x, y: (y0 + y1) / 2, z }), walls);
      };
      const skirt = (u0: number, u1: number) => {
        if (u1 - u0 < 0.05) return;
        const [x, z] = f.at((u0 + u1) / 2, -0.04);
        still.add(mesh(f.box(u1 - u0, 0.14, 0.08), mats.metalDark, x, 0.07, z, false));
      };
      if (side === doorSide) {
        const a = doorU - SHELL.doorWidth / 2;
        const z = doorU + SHELL.doorWidth / 2;
        piece(lo, a, 0, H);
        piece(a, z, SHELL.doorHeight, H);
        piece(z, hi, 0, H);
        skirt(f.alongX ? b.minX : b.minZ, a - 0.2);
        skirt(z + 0.2, f.alongX ? b.maxX : b.maxZ);
      } else {
        piece(lo, hi, 0, H);
        skirt(f.alongX ? b.minX : b.minZ, f.alongX ? b.maxX : b.maxZ);
      }
      // A line of light along the top, in the floor's color.
      const [lx, lz] = f.at(f.alongX ? cx : cz, -0.03);
      still.add(mesh(f.box(f.alongX ? W : L, 0.05, 0.03), mats.accent, lx, H - 0.12, lz, false));
      continue;
    }
    // Glass from a low sill to a deep head, mullions every few meters, and the city through it.
    const run = f.alongX ? W : L;
    const mid = f.alongX ? cx : cz;
    const [sx, sz] = f.at(mid, T / 2);
    still.add(mesh(f.box(run + 2 * T, SHELL.sill, T), mats.metalDark, sx, SHELL.sill / 2, sz));
    still.add(mesh(f.box(run + 2 * T, SHELL.head, T + 0.1), mats.hullDark, sx, H - SHELL.head / 2, sz));
    const [ix, iz] = f.at(mid, -0.12);
    still.add(mesh(f.box(run, 0.05, 0.24), mats.metal, ix, SHELL.sill + 0.025, iz, false));
    const n = Math.max(2, Math.round(run / SHELL.mullion));
    for (let i = 0; i <= n; i++) {
      const [mx, mz] = f.at(mid - run / 2 + (i * run) / n, T / 2);
      still.add(mesh(f.box(0.09, H - SHELL.sill - SHELL.head, 0.2), mats.metal, mx, (H + SHELL.sill - SHELL.head) / 2, mz, false));
    }
    const pane = new THREE.PlaneGeometry(run, H - SHELL.sill - SHELL.head);
    pane.rotateY(f.rotY);
    pane.translate(sx, (H + SHELL.sill - SHELL.head) / 2, sz);
    panes.add(pane, mats.glass);
  }
  group.add(pieces.build());
  group.add(panes.build(false));

  // The way in: two steel doors that slide apart, a sign over them, and the lift lobby beyond.
  const [dx, dz] = doorF.at(doorU, 0);
  const doorAt = new THREE.Vector3(dx, 0, dz);
  const frame = placed(dx, 0, dz, doorF.rotY);
  const w = SHELL.doorWidth;
  const h = SHELL.doorHeight;
  for (const s of [-1, 1]) frame.add(mesh(box(0.22, h + 0.22, T + 0.2), mats.metal, s * (w / 2 + 0.07), (h + 0.22) / 2, T / 2));
  frame.add(mesh(box(w + 0.36, 0.22, T + 0.2), mats.metal, 0, h + 0.07, T / 2));
  const sign = textPlane('🛗 Lifts', { bg: '#11161d', color: '#f4f6f8', border: '#ffb000', size: 56 });
  sign.scale.multiplyScalar(0.85);
  sign.position.set(0, h + 0.6, -0.06);
  sign.rotation.y = Math.PI;
  frame.add(sign);
  const leaves: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const leaf = new THREE.Group();
    leaf.add(mesh(box(w / 2, h, 0.08), mats.panel, 0, h / 2, 0));
    leaf.add(mesh(box(0.03, h - 0.4, 0.1), mats.metalDark, (-s * w) / 4 + s * 0.03, h / 2, 0, false));
    leaf.position.set((s * w) / 4, 0, T / 2);
    frame.add(leaf);
    leaves.push(leaf);
  }
  group.add(frame);
  lobby(kit, dx, dz, doorF.rotY, pal);

  return {
    doorAt,
    out: doorF.out,
    slide(open) {
      const e = open * open * (3 - 2 * open);
      leaves.forEach((leaf, i) => (leaf.position.x = (i ? 1 : -1) * (w / 4 + e * (w / 2 - 0.06))));
    },
  };
}

/** The lift lobby behind the doors: somewhere for workers to walk off to and come in from, with the lifts on its far wall. */
function lobby(kit: Kit, dx: number, dz: number, rotY: number, pal: { hull: string; panel: string }) {
  const { mats } = kit;
  const T = SHELL.wall;
  const g = placed(dx, 0, dz, rotY);
  const wide = 7;
  const deep = 5.4;
  const high = 3.4;
  const stone = toonMap(tilingCanvasTexture(256, 256, wallPanels(shade(pal.panel, -0.25))));
  g.add(mesh(box(wide, 0.2, deep), stone, 0, -0.1, T + deep / 2, false));
  g.add(mesh(box(wide, 0.2, deep), mats.hullDark, 0, high + 0.1, T + deep / 2));
  g.add(mesh(box(wide - 1.2, 0.04, 0.4), mats.lamp, 0, high - 0.02, T + deep / 2, false));
  for (const s of [-1, 1]) g.add(mesh(box(0.2, high, deep), mats.hull, s * (wide / 2 + 0.1), high / 2, T + deep / 2));
  g.add(mesh(box(wide + 0.4, high, 0.2), mats.hull, 0, high / 2, T + deep + 0.1));
  // Two lifts, their doors shut, a light over each.
  for (const s of [-1, 1]) {
    g.add(mesh(box(1.5, 2.4, 0.06), mats.panel, s * 1.6, 1.2, T + deep - 0.03, false));
    g.add(mesh(box(0.02, 2.3, 0.08), mats.metalDark, s * 1.6, 1.2, T + deep - 0.04, false));
    g.add(mesh(box(0.5, 0.12, 0.04), mats.glow, s * 1.6, 2.62, T + deep - 0.03, false));
  }
  g.add(mesh(box(0.14, 0.26, 0.04), mats.metalDark, 0, 1.2, T + deep - 0.03, false));
  g.add(mesh(new THREE.CircleGeometry(0.035, 12), mats.glow, 0, 1.24, T + deep - 0.075, false).rotateY(Math.PI));
  kit.still.add(g);
}
