import * as THREE from 'three';
import { Person } from '../character';
import type { Interactable } from '../types';
import { mesh, toon } from '../toon';
import type { World } from '../world';
import { box, type Kit } from '../station/kit';

// The trading floor's one person who isn't a worker: the chief of staff (the map's herald), in a
// dark suit by your desk, who staffs new desks.

const SUIT = '#1f2937';

/** The herald, in a suit and tie, where the plan has them. */
export function buildHerald(kit: Kit): World['herald'] {
  const hd = kit.plan.herald;
  if (!hd) return undefined;
  const person = new Person(hd.name, SUIT, { skin: 2, hair: 3, style: 2 });
  const y = kit.floorAt(hd.x, hd.z);
  person.root.position.set(hd.x, y, hd.z);
  person.root.rotation.y = hd.rotY;
  person.setLabel(hd.name, null);
  person.setDoing(hd.says);
  const jacket = mesh(
    new THREE.LatheGeometry(
      [
        [0.32, 0.36],
        [0.31, 0.7],
        [0.29, 1.0],
      ].map(([r, yy]) => new THREE.Vector2(r, yy)),
      20,
    ),
    toon(SUIT),
  );
  person.wear(jacket, 'body');
  // The shirt at the collar, and the tie down it.
  person.wear(mesh(box(0.16, 0.2, 0.02), toon('#f4f6f8'), 0, 0.9, 0.29, false), 'body');
  person.wear(mesh(box(0.05, 0.36, 0.025), toon('#b91c1c'), 0, 0.78, 0.3, false), 'body');
  kit.group.add(person.root);
  const interactable: Interactable = { kind: 'herald', x: hd.x + Math.sin(hd.rotY) * 0.9, y, z: hd.z + Math.cos(hd.rotY) * 0.9, radius: 1.9 };
  person.root.userData.interact = interactable;
  kit.interactables.push(interactable);
  kit.colliders.push({ minX: hd.x - 0.35, maxX: hd.x + 0.35, minZ: hd.z - 0.35, maxZ: hd.z + 0.35, top: 99 });
  return { person, interactable };
}
