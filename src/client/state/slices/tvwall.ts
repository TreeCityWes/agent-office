import type { TvWallState } from '../../../shared/tvwall';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** What the screens up over the boards on your floor show (see shared/tvwall.ts). */
    tvwall: TvWallState;
  }
  interface Topics {
    tvwall: true;
  }
}

export const tvwall: Slice = {
  init(s) {
    s.tvwall = { screens: {} };
  },
  on: {
    tvwall(s, m) {
      s.tvwall = m.state;
      return ['tvwall'];
    },
  },
  enter(s, v) {
    s.tvwall = v.tvwall;
    return ['tvwall'];
  },
};
