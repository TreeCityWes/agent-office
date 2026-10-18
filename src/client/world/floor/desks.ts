import * as THREE from 'three';
import type { DeskDef } from '../../../shared/layout';
import { canvasTexture } from '../texture';
import { mesh, roundedBox, textPlane, toon } from '../toon';
import type { DeskView, Interactable } from '../types';
import { BENCH_TOP, TABLE_TOP, box, collide, type Kit } from '../station/kit';
import { placeSetting } from '../station/seats';
import { monitor } from './textures';

// Where the workers sit on the trading floor: long dark desks, a department to each (its name hung
// over it), and at every seat a chair and a pair of monitors facing it. Every seat is out from the
// start, a "+" over each free one: who you hire at "Trading, seat 3" sits with the traders.

const TOP = toon('#232a33');
const EDGE = toon('#11151b');
/** A handful of monitor pictures, shared round the floor. */
let screens: THREE.MeshBasicMaterial[] | null = null;
function screenMats(): THREE.MeshBasicMaterial[] {
  return (screens ??= Array.from({ length: 8 }, (_, i) => {
    const m = new THREE.MeshBasicMaterial({ map: canvasTexture(256, 160, monitor(i, 256, 160)), toneMapped: false });
    m.userData.outlineParameters = { visible: false };
    // Everyone's, kept when a world's taken down (see buildFloor's dispose).
    m.userData.shared = true;
    return m;
  }));
}

/** The desks, as the plan's tables have them: a dark top with a lit edge, panels for legs, and the department's sign over it. */
export function buildDesks(kit: Kit) {
  const { mats } = kit;
  for (const t of kit.plan.tables) {
    const g = new THREE.Group();
    g.position.set(t.x, 0, t.z);
    g.rotation.y = t.rotY;
    g.add(mesh(roundedBox(t.width, 0.06, t.length, 0.03), TOP, 0, TABLE_TOP - 0.03, 0));
    g.add(mesh(box(t.width - 0.1, 0.12, t.length - 0.1), EDGE, 0, TABLE_TOP - 0.12, 0, false));
    // A cable spine down the middle for the monitors to stand on.
    g.add(mesh(box(0.16, 0.05, t.length - 0.3), mats.metalDark, 0, TABLE_TOP + 0.025, 0, false));
    const legs = Math.max(2, Math.round(t.length / 3) + 1);
    for (let i = 0; i < legs; i++) {
      const lz = -t.length / 2 + 0.15 + (i * (t.length - 0.3)) / (legs - 1);
      g.add(mesh(box(t.width - 0.2, TABLE_TOP - 0.18, 0.06), mats.metalDark, 0, (TABLE_TOP - 0.18) / 2, lz));
    }
    // A strip of light under each seated edge, in the floor's color.
    for (const s of t.sides) g.add(mesh(box(0.02, 0.02, t.length - 0.2), mats.accent, s * (t.width / 2 - 0.02), TABLE_TOP - 0.065, 0, false));
    kit.still.add(g);
    collide(kit, t.x, t.z, t.width, t.length, t.rotY, TABLE_TOP);
    if (t.name) tableSign(kit, t.name, t.x, t.z, t.rotY);
  }
}

/** A department's sign over its desk, hung from the ceiling, facing the way its seats face (and back). */
function tableSign(kit: Kit, name: string, x: number, z: number, rotY: number) {
  const y = Math.min(kit.height - 0.6, 3.1);
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = rotY - Math.PI / 2;
  const front = textPlane(name, { bg: '#11161d', color: '#f4f6f8', border: '#ffb000', size: 64 });
  front.position.z = 0.01;
  const back = front.clone();
  back.rotation.y = Math.PI;
  back.position.z = -0.01;
  g.add(front, back);
  const half = (front.geometry.parameters.width / 2) * 0.8;
  for (const s of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.008, 0.008, kit.height - y, 4), kit.mats.metalDark, s * half, (kit.height - y) / 2, 0, false));
  kit.group.add(g);
}

/** An office chair: five feet on a column, a seat and a back. Its middle is where it turns. */
function chair(kit: Kit): THREE.Group {
  const g = new THREE.Group();
  const { metalDark, metal, black } = kit.mats;
  for (let i = 0; i < 5; i++) {
    const foot = mesh(box(0.05, 0.04, 0.3), metalDark, 0, 0.06, 0, false);
    foot.rotation.y = (i * Math.PI * 2) / 5;
    foot.translateZ(0.15);
    g.add(foot);
  }
  g.add(mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.3, 8), metal, 0, 0.23, 0, false));
  g.add(mesh(roundedBox(0.5, 0.08, 0.48, 0.04), black, 0, BENCH_TOP - 0.04, 0));
  g.add(mesh(roundedBox(0.46, 0.62, 0.07, 0.04), black, 0, BENCH_TOP + 0.36, 0.25));
  g.add(mesh(box(0.06, 0.3, 0.04), metalDark, 0, BENCH_TOP + 0.08, 0.27, false));
  return g;
}

/** A seat: the station's place setting (the worker, its laptop, the "+"), with a chair and two monitors facing it. Out from the start. */
export function placeSeat(kit: Kit, def: DeskDef, overflow: boolean, n: number): { view: DeskView; it: Interactable } {
  const { view, it } = placeSetting(kit, def, overflow);
  view.group.visible = true;
  it.off = false;
  const c = chair(kit);
  // Its back away from the desk.
  c.position.set(0, 0, 0.85);
  view.group.add(c);
  const mats = screenMats();
  for (const s of [-1, 1]) {
    const m = new THREE.Group();
    m.position.set(s * 0.3, TABLE_TOP + 0.05, -0.42);
    m.rotation.y = -s * 0.22;
    m.add(mesh(box(0.05, 0.3, 0.05), kit.mats.metalDark, 0, 0.15, -0.04, false));
    m.add(mesh(box(0.58, 0.36, 0.035), kit.mats.black, 0, 0.42, 0, false));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.54, 0.32), mats[(n * 2 + (s > 0 ? 1 : 0)) % mats.length]);
    screen.position.set(0, 0.42, 0.019);
    m.add(screen);
    view.group.add(m);
  }
  collide(kit, def.x + Math.sin(def.rotY) * 0.85, def.z + Math.cos(def.rotY) * 0.85, 0.55, 0.55, def.rotY, BENCH_TOP);
  return { view: { ...view, chair: c }, it };
}
