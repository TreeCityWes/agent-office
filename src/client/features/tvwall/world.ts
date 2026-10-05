import * as THREE from 'three';
import { OFFICE_TVS, type TvPlace } from '../../../shared/tvwall';
import { noOutline } from '../../core/outline';
import { mesh, roundedBox, toon } from '../../world/toon';
import type { Interactable } from '../../world/types';
import type { Fixture } from '../../world/office/fixture';

// The TV wall's screens: slim black panels up over the boards, each with a strip of light under it and
// a caption bar. What's on them is drawn one of two ways (see screens.ts and css3d.ts): the office
// paints the ticker, the terminals and "no signal" onto the screen itself, and for a video, a chart or
// a web page the screen turns see-through, onto a frame laid out right behind the 3D view.

/** Canvas size for what the office paints on a screen (16:9), and for its caption bar. */
export const SCREEN_PX = { w: 1280, h: 720 } as const;
const CAPTION_PX = { w: 1024, h: 64 } as const;
const BEZEL = 0.06;
const CAPTION_H = 0.14;

/** One screen on the wall. */
export interface TvView {
  readonly place: TvPlace;
  readonly group: THREE.Group;
  /** The glass: painted, or see-through onto its frame. */
  readonly screen: THREE.Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  /** Shows the painted canvas (true) or makes the glass see-through for a frame (false). */
  painted(on: boolean): void;
  /** What the bar under it says, and the color of its light (the channel's). */
  caption(text: string, color: string, live: boolean): void;
  readonly interactable: Interactable;
}

export interface TvWallView {
  readonly tvs: readonly TvView[];
}

/**
 * Writes nothing but "see-through" where it shows: no color and no alpha, so the frame laid out
 * behind the canvas shows there. Anything in front of it still covers it, by the depth it writes.
 */
export const HOLE = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0, blending: THREE.NoBlending, toneMapped: false });

function buildTv(place: TvPlace): TvView {
  const { width, height } = place;
  const group = new THREE.Group();
  group.position.set(place.x, place.y, place.z);
  group.rotation.y = place.rotY;

  const shell = toon('#14161c');
  group.add(mesh(roundedBox(width + BEZEL * 2, height + BEZEL * 2, 0.08, 0.025), shell, 0, 0, 0.04));
  // The wall mount: a short arm into the wall.
  group.add(mesh(new THREE.BoxGeometry(0.5, 0.3, 0.1), shell, 0, 0, -0.03, false));

  const canvas = document.createElement('canvas');
  canvas.width = SCREEN_PX.w;
  canvas.height = SCREEN_PX.h;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const paint = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(width, height), paint);
  screen.position.z = 0.085;
  group.add(screen);

  // A strip of light along the bottom edge, in the channel's color, glowing onto the wall.
  const stripMat = new THREE.MeshBasicMaterial({ color: '#36d6ff', toneMapped: false });
  const strip = new THREE.Mesh(new THREE.BoxGeometry(width * 0.92, 0.025, 0.02), stripMat);
  strip.position.set(0, -height / 2 - BEZEL - 0.02, 0.07);
  group.add(strip);

  // The caption bar under it.
  const capCanvas = document.createElement('canvas');
  capCanvas.width = CAPTION_PX.w;
  capCanvas.height = CAPTION_PX.h;
  const capTex = new THREE.CanvasTexture(capCanvas);
  capTex.colorSpace = THREE.SRGBColorSpace;
  const cap = new THREE.Mesh(new THREE.PlaneGeometry(CAPTION_H * 16, CAPTION_H), new THREE.MeshBasicMaterial({ map: capTex, transparent: true, toneMapped: false }));
  cap.position.set(-width / 2 + CAPTION_H * 8, -height / 2 - BEZEL - 0.04 - CAPTION_H / 2, 0.05);
  group.add(cap);
  noOutline(group);
  // Nothing to outline on the glass, and none for the mount either: it's flat to the wall.
  HOLE.userData.outlineParameters = { visible: false };

  const interactable: Interactable = { kind: 'tvwall', x: place.x + Math.sin(place.rotY) * 3, z: place.z + Math.cos(place.rotY) * 3, radius: 1.4 };
  group.userData.interact = interactable;

  return {
    place,
    group,
    screen,
    canvas,
    texture,
    painted(on) {
      screen.material = on ? paint : HOLE;
    },
    caption(text, color, live) {
      stripMat.color.set(color);
      const g = capCanvas.getContext('2d')!;
      const { w, h } = CAPTION_PX;
      g.clearRect(0, 0, w, h);
      g.fillStyle = 'rgba(8,10,14,0.88)';
      g.fillRect(0, 0, w, h);
      g.fillStyle = color;
      g.fillRect(0, 0, 8, h);
      g.font = '600 34px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
      g.textBaseline = 'middle';
      let x = 28;
      if (live) {
        g.fillStyle = '#ff3b4e';
        g.beginPath();
        g.arc(x + 9, h / 2, 9, 0, Math.PI * 2);
        g.fill();
        g.fillText('LIVE', x + 26, h / 2 + 2);
        x += 26 + g.measureText('LIVE').width + 24;
      }
      g.fillStyle = '#e6edf3';
      g.fillText(text.toUpperCase(), x, h / 2 + 2, w - x - 20);
      capTex.needsUpdate = true;
    },
    interactable,
  };
}

declare module '../../world/types' {
  interface OfficeHandles {
    /** The screens up over the boards on the north wall. */
    tvwall: TvWallView;
  }
}

/** The office's screens: one over each board along the north wall. */
export const tvwall: Fixture<'tvwall'> = (site) => {
  const tvs = OFFICE_TVS.map(buildTv);
  const group = new THREE.Group();
  for (const tv of tvs) {
    group.add(tv.group);
    site.wall('north', tv.place.x, tv.place.y - 0.15, tv.place.width + 0.3, tv.place.height + 0.6);
  }
  return {
    group,
    interactables: tvs.map((t) => t.interactable),
    handle: { tvwall: { tvs } },
  };
};
