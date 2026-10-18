import * as THREE from 'three';
import type { FloorPalette } from '../../../shared/floors';
import type { MapPlan } from '../../../shared/maps';
import type { FloorPropKind } from '../../../shared/maps/floor-props';
import { NavGrid, type Pt } from '../../../shared/nav';
// The people first, as the castle's and the station's are: Person (and what it loads) before the
// rest, so the materials the modules make as they load keep their order.
import { buildHerald } from './people';
import { mergeByMaterial, textPlane } from '../toon';
import type { World } from '../world';
import { buildBoards } from '../station/boards';
import { materials } from '../station/kit';
import { agentConsole, buildBridge, buildBriefing } from '../station/seats';
import { buildDesks, placeSeat } from './desks';
import { buildSkyline } from './outside';
import { PROPS, type FeedMark, type FloorKit } from './props';
import { buildShell } from './shell';

/*
 * The trading floor's style of map (see shared/maps/floor.ts for the floor itself): an open-plan
 * floor high up a tower, glass down two sides with the city beyond, a video wall of the fund's
 * screens and a ticker at one end, desks a department to each, glass rooms, and the lifts. It's
 * built with the station's kit (its materials, seats, consoles, boards and briefing table) and its
 * own pieces, each in a file beside this one: the shell, the props, the desks, the chief of staff
 * and the city outside. Everything is placed from the map's plan, so another map in this style is
 * just other numbers.
 *
 * The big displays, the ticker and the risk beacon are the 💼 fund's to drive: it finds them by the
 * `feed` in their userData (see props.ts, and features/fund/floor.ts).
 */

/** Puts up the trading floor in `plan` (a floor-style map). */
export function buildFloor(plan: MapPlan): World {
  const c = plan.config!;
  const b = plan.bounds;
  const H = plan.height;
  const pal = { hull: '#2b313b', deck: '#262b33', panel: '#d5dae1', metal: '#3a4250', glow: '#ffb000', ...(c.palette ?? {}) };
  const group = new THREE.Group();
  const kit: FloorKit = {
    plan,
    group,
    still: new THREE.Group(),
    colliders: [],
    interactables: [],
    mats: materials(pal),
    height: H,
    desks: new Map(),
    lights: [],
    spinners: [],
    pulses: [],
    animate: [],
    floorAt(x, z) {
      let top = 0;
      for (const cc of kit.colliders) if (cc.top < 50 && !cc.fence && cc.top > top && x > cc.minX && x < cc.maxX && z > cc.minZ && z < cc.maxZ) top = cc.top;
      return top;
    },
  };
  // Glass you can see is there, a little.
  (kit.mats.glass as THREE.MeshBasicMaterial).opacity = 0.1;

  const shell = buildShell(kit, pal);
  // Your desk's dais before the props, so what stands on it stands on its top (see Kit.floorAt).
  buildBridge(kit);
  for (const p of c.props ?? []) PROPS[p.kind as FloorPropKind](kit, p);
  buildDesks(kit);
  let n = 0;
  for (const def of [...plan.desks, ...plan.overflow]) kit.desks.set(def.id, placeSeat(kit, def, plan.overflow.includes(def), n++).view);
  for (const def of plan.stations) kit.desks.set(def.id, agentConsole(kit, def));
  const briefing = buildBriefing(kit, '🗳️ Investment committee');
  const boardMeshes = buildBoards(kit);
  const herald = buildHerald(kit);
  group.add(mergeByMaterial(kit.still));
  const skyline = buildSkyline(b);
  group.add(skyline.group);
  // What runs along (the ticker): whatever picture the fund puts on it, it keeps running.
  const running: { face: THREE.Mesh; mark: FeedMark }[] = [];
  group.traverse((o) => {
    const mark = o.userData.feed as FeedMark | undefined;
    if (mark?.scroll && mark.size) running.push({ face: o as THREE.Mesh, mark });
  });

  // The project's name, on the wall behind your desk, over the screens.
  const nameAt = plan.throne ?? { x: (b.minX + b.maxX) / 2, z: b.minZ + 0.3, rotY: 0 };
  let nameplate: THREE.Mesh | null = null;
  let name = '';
  const christen = () => {
    if (nameplate) {
      nameplate.removeFromParent();
      nameplate.geometry.dispose();
      (nameplate.material as THREE.MeshBasicMaterial).map?.dispose();
      (nameplate.material as THREE.Material).dispose();
      nameplate = null;
    }
    if (!name) return;
    nameplate = textPlane(`📈 ${name.toUpperCase()} CAPITAL`, { bg: '#0b0e13', color: '#ffb000', border: '#3a4250', size: 56 });
    const [bx, bz] = [-Math.sin(nameAt.rotY), -Math.cos(nameAt.rotY)];
    const reach = (at: number, d: number, lo: number, hi: number) => (Math.abs(d) < 1e-6 ? Infinity : ((d > 0 ? hi : lo) - at) / d);
    const back = Math.min(reach(nameAt.x, bx, b.minX, b.maxX), reach(nameAt.z, bz, b.minZ, b.maxZ)) - 0.07;
    nameplate.position.set(nameAt.x + bx * back, 1.1, nameAt.z + bz * back);
    nameplate.rotation.y = nameAt.rotY;
    group.add(nameplate);
  };

  // Walking about: in from the lift lobby and out again, round what's in the way.
  const nav = new NavGrid(b, plan.obstacles!);
  const { doorAt, out } = shell;
  const inside: Pt = [plan.door.x, plan.door.z];
  const threshold: Pt = [doorAt.x + out[0] * 0.25, doorAt.z + out[1] * 0.25];
  const beyond: Pt = [doorAt.x + out[0] * 4.2, doorAt.z + out[1] * 4.2];
  let doorOpen = 0;

  // How it's lit: the panels overhead, and the day through the glass.
  const officeSky = new THREE.Color('#f4f1ea');
  const officeGround = new THREE.Color('#4a4f57');
  const hazeDay = new THREE.Color('#b9c8d8');
  const hazeNight = new THREE.Color('#0d1320');
  const gongAt = kit.gong?.top;
  const hsl = { h: 0, s: 0, l: 0 };

  return {
    plan,
    group,
    colliders: kit.colliders,
    interactables: kit.interactables,
    pickables: [group],
    desks: kit.desks,
    boardMeshes,
    meetingBoard: briefing.board,
    meetingSign: briefing.sign,
    gong: kit.gong,
    nav,
    ways: {
      home: (seat, from) => ({ way: [...(from ? nav.route(from, inside) : nav.wayFrom(seat, inside)), threshold, beyond], chute: false }),
      in: (seat) => [beyond, threshold, ...nav.wayTo(inside, seat)],
    },
    rain: [{ area: b, top: () => H - 0.5 }],
    device: 'laptop',
    room: { wall: 0.3, enclosed: true },
    acoustics: { gong: gongAt ? { x: gongAt.x, y: gongAt.y - 1.8, z: gongAt.z } : null, windows: [] },
    herald,
    // Every seat's out from the start (see placeSeat): there's nothing to bring out.
    setBeanbags() {
      return [];
    },
    setLook(p: FloorPalette) {
      // The lines of light take the floor's own color, bright, so each project's floor is its own.
      new THREE.Color(p.trim).getHSL(hsl);
      kit.mats.accent.color.setHSL(hsl.h, 0.85, 0.58);
      christen();
    },
    setProjectName(nm) {
      if (nm === name) return;
      name = nm;
      christen();
    },
    update(t, dt, people) {
      for (const s of kit.spinners) s.obj.rotation.y += s.speed * dt;
      for (const p of kit.pulses) p.set(0.5 + 0.5 * Math.sin((t * p.rate + p.phase) * Math.PI * 2));
      for (const a of kit.animate) a(t, dt);
      // The lift doors slide open for anyone coming up to them, from either side.
      let near = false;
      for (const q of people) if (Math.hypot(q.x - doorAt.x, q.z - doorAt.z) < 4) near = true;
      const want = near ? 1 : 0;
      if (doorOpen !== want) {
        doorOpen = want > doorOpen ? Math.min(1, doorOpen + dt * 1.6) : Math.max(0, doorOpen - dt * 1.1);
        shell.slide(doorOpen);
      }
      for (const { face, mark } of running) {
        const map = (face.material as THREE.MeshBasicMaterial).map;
        if (map) map.offset.x = (map.offset.x + (dt * mark.scroll! * map.repeat.x) / mark.size![0]) % 1;
      }
      for (const d of kit.desks.values()) {
        if (!d.vacancy.visible || !d.group.visible || d.def.station) continue;
        d.vacancy.position.y = d.vacancyY + Math.sin(t * 2 + d.def.x) * 0.06;
        d.vacancy.rotation.y = t * 1.2;
      }
      kit.gong?.update(dt);
      herald?.person.update(dt, t, false, false);
    },
    mood(lights, daylight) {
      // Lit from overhead whatever the hour, brighter by day through all that glass; the haze outside by the hour.
      skyline.update(daylight);
      lights.hemi.color.copy(officeSky);
      lights.hemi.groundColor.copy(officeGround);
      lights.hemi.intensity = 0.75 + 0.35 * daylight;
      lights.ambient.color.copy(officeSky);
      lights.ambient.intensity = 0.32 + 0.12 * daylight;
      lights.sun.intensity *= 0.7;
      const fog = lights.scene.fog as THREE.Fog | null;
      if (fog) {
        fog.color.copy(hazeNight).lerp(hazeDay, daylight);
        fog.near = 90;
        fog.far = 420;
      }
    },
    dispose() {
      skyline.group.removeFromParent();
      skyline.dispose();
      // Its geometry, and every material with a picture of its own (walls, signs, displays); the
      // cached toon materials and the monitors' pictures are everyone's, and stay.
      const freed = new Set<THREE.Material>();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) {
          const map = (mat as THREE.MeshBasicMaterial).map;
          if (!map || freed.has(mat) || mat.userData.shared) continue;
          map.dispose();
          mat.dispose();
          freed.add(mat);
        }
      });
    },
  };
}
