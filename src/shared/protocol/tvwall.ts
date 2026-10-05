// The TV wall: the big screens up over the boards (see shared/tvwall.ts).

import type { TvWallState } from '../tvwall.js';

export type TvWallClientMsg =
  /** Tune screen `tv` to `channel` (a TvChannel, checked by the office), captioned `label`. */
  { t: 'tv.set'; tv: string; channel: unknown; label?: string };

export type TvWallServerMsg =
  /** What every screen on your floor shows now. */
  { t: 'tvwall'; state: TvWallState };
