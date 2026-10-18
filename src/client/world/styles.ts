import type { MapPlan, MapStyle } from '../../shared/maps';
import { buildCastle } from './castle';
import { buildFloor } from './floor';
import { buildStation } from './station';
import type { World } from './world';

/*
 * How each style of map is put up (see shared/maps): the castle's stone hall, the station's deck in
 * orbit, the fund's trading floor high up a tower. A new style is a builder here, taking a map's plan to a World, and its name in MAP_STYLES:
 * every map in that style can then be picked, and main.ts shows it like any other.
 */
export const BUILDERS: Record<MapStyle, (plan: MapPlan) => World> = {
  castle: buildCastle,
  station: buildStation,
  floor: buildFloor,
};
