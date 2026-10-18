import type { Circle, Rect } from '../nav.js';
import { boxFootprint } from './props.js';
import { STATION_PROP_KINDS, stationFootprint, stationTop } from './station-props.js';
import type { PropConfig } from './types.js';

/*
 * The pieces a trading-floor-style map can put up (MapConfig.props), and how much floor each takes,
 * as ./props.ts has the castle's. A few are the station's own (a display, a planter, the gong, the
 * drinks dispenser, a table), built the station's way; the rest are the floor's. How each one looks
 * is the floor builder's (world/floor/).
 */

/** What a `wall` display can show (painted live by the 💼 fund: see docs/fund.md#the-trading-floor). */
export const FLOOR_FEEDS = ['portfolio', 'heatmap', 'risk', 'pipeline', 'desks', 'research', 'strategies', 'committee'] as const;
export type FloorFeed = (typeof FLOOR_FEEDS)[number];

export const FLOOR_PROP_KINDS = {
  /** A light panel let into the ceiling, `width` by `length`; with `light`, it lights the floor for real (a few at most). */
  panel: 'A light panel in the ceiling',
  /** A band of lights on a wall with prices running along it, its middle at `y`, `length` long (it can run the whole wall) and `height` high, facing `rotY`. */
  ticker: 'A ticker band of running prices on a wall',
  /** A big display on a wall showing the fund live: `feed` is portfolio, heatmap, risk, pipeline, desks, research, strategies or committee. */
  wall: 'A display showing the fund live',
  /** A glass partition `length` long along `rotY`, `height` high (3 m unless you say): walls for a room on the floor. */
  glass: 'A glass partition',
  /** A solid partition, like `glass`: something to hang a display on, either side. */
  partition: 'A solid partition',
  /** A sign saying `text`, its middle at `y`, facing `rotY` (and the other way too, hung in the open). */
  sign: 'A sign',
  /** A warning light, at `y`: it turns and glows when the fund's risk needs looking at. */
  beacon: 'A risk beacon',
  /** A tall plant in a pot. */
  plant: 'A plant in a pot',
  screen: STATION_PROP_KINDS.screen,
  planter: STATION_PROP_KINDS.planter,
  gong: STATION_PROP_KINDS.gong,
  dispenser: STATION_PROP_KINDS.dispenser,
  table: STATION_PROP_KINDS.table,
} as const;
export type FloorPropKind = keyof typeof FLOOR_PROP_KINDS;

/** The kinds the station's builder puts up for the floor. */
export const STATION_BUILT = ['screen', 'planter', 'gong', 'dispenser', 'table'] as const satisfies readonly FloorPropKind[];

/** How thick a partition is, how high unless it says, and how big a pot is. */
export const PARTITION = { depth: 0.12, height: 3 } as const;
export const POT = 0.7;

/** How much floor a trading floor's prop takes: a box, a circle, or none (it's on a wall or in the ceiling). */
export function floorFootprint(p: PropConfig): { rect?: Rect; circle?: Circle } | null {
  const s = p.scale ?? 1;
  switch (p.kind) {
    case 'glass':
    case 'partition':
      return { rect: boxFootprint(p.x, p.z, PARTITION.depth, p.length ?? 3, p.rotY ?? 0) };
    case 'plant':
      return { circle: [p.x, p.z, (POT / 2) * s] };
    case 'screen':
    case 'planter':
    case 'gong':
    case 'dispenser':
    case 'table':
      return stationFootprint(p);
    default:
      return null;
  }
}

/** How high up a trading floor's prop reaches. */
export function floorTop(p: PropConfig): number {
  switch (p.kind) {
    case 'ticker':
    case 'wall':
    case 'sign':
      return (p.y ?? 3) + (p.height ?? 1) / 2;
    case 'glass':
    case 'partition':
      return p.height ?? PARTITION.height;
    case 'beacon':
      return (p.y ?? 3) + 0.5;
    case 'screen':
      return stationTop(p);
    default:
      return 0;
  }
}
