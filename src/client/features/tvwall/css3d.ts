import * as THREE from 'three';
import { CSS3DObject, CSS3DRenderer } from 'three/examples/jsm/renderers/CSS3DRenderer.js';
import { SCREEN_PX, type TvView } from './world';

// The frames behind the TV wall's screens. A video, a chart or a web page comes from another site,
// which WebGL can't draw from, so each plays in a real <iframe>, laid out in 3D (CSS transforms) in a
// layer right behind the office's canvas, exactly where its screen is. The screen's glass writes
// "see-through" (HOLE in world.ts), so the frame shows through it, and whatever stands in front of the
// screen still covers it.

/** What a frame may do: play, run its own scripts on its own site, go full screen. */
const SANDBOX = 'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox';
const ALLOW = 'autoplay; encrypted-media; picture-in-picture; fullscreen';

/** Lays out an iframe for a page, the way every screen and the viewer want one. */
export function tvFrame(src: string): HTMLIFrameElement {
  const f = document.createElement('iframe');
  f.src = src;
  f.allow = ALLOW;
  f.setAttribute('sandbox', SANDBOX);
  // YouTube won't play an embed that doesn't say which site it's on.
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  f.loading = 'eager';
  f.title = 'TV';
  return f;
}

export interface FrameLayer {
  /** Plays `src` behind `tv` (the same src again does nothing); null takes its frame away. */
  show(tv: TvView, src: string | null): void;
  /** Lays the frames out for the camera as it is now. */
  render(scene: THREE.Camera, visible: boolean): void;
}

export function frameLayer(beforeCanvas: HTMLElement): FrameLayer {
  const renderer = new CSS3DRenderer();
  const el = renderer.domElement;
  el.className = 'tv-frames';
  beforeCanvas.before(el);
  const scene = new THREE.Scene();
  const frames = new Map<TvView, { obj: CSS3DObject; src: string }>();

  const fit = () => renderer.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', fit);
  fit();

  const at = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const size = new THREE.Vector3();

  return {
    show(tv, src) {
      const had = frames.get(tv);
      if (had?.src === src) return;
      if (had) {
        scene.remove(had.obj);
        had.obj.element.remove();
        frames.delete(tv);
      }
      if (!src) return;
      const box = document.createElement('div');
      box.className = 'tv-frame';
      box.style.width = `${SCREEN_PX.w}px`;
      box.style.height = `${SCREEN_PX.h}px`;
      box.append(tvFrame(src));
      const obj = new CSS3DObject(box);
      // Right where the screen is, at its size: SCREEN_PX across its width.
      tv.screen.updateWorldMatrix(true, false);
      tv.screen.matrixWorld.decompose(at, turn, size);
      obj.position.copy(at);
      obj.quaternion.copy(turn);
      obj.scale.setScalar(tv.place.width / SCREEN_PX.w);
      scene.add(obj);
      frames.set(tv, { obj, src });
    },
    render(camera, visible) {
      el.style.visibility = visible && frames.size ? 'visible' : 'hidden';
      if (visible && frames.size) renderer.render(scene, camera);
    },
  };
}
