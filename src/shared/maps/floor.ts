import type { MapConfig, PropConfig } from './types.js';

/*
 * The trading floor: the 💼 fund's own map (docs/fund.md#the-trading-floor), high up a tower with
 * the city through the glass down both long sides. The north wall is the video wall: prices running
 * along the top, and under them the heatmap, the portfolio and the risk board, all live. Your desk is
 * on a low dais in front of it, facing the floor. The pit is rows of desks facing the wall, a
 * department to a row (trading, research, hot desks), and the corners are glass rooms: the CIO's
 * office and the risk room at the front, each with its own board, the quant lab and the investment
 * committee's room at the back. A beacon on the risk room's corner turns red when the fund's risk
 * needs looking at, and you see it from anywhere on the floor. The lifts are in the south wall, with
 * the office's own boards either side of them and their agents' consoles under each.
 *
 * Every table seats one department, so whoever you hire at "Quant lab, seat 3" sits with the quants;
 * the desks face their department's board. It's all data, like the castle and the station: a map of
 * your own can `extend: 'floor'` (docs/maps.md).
 *
 * North is -z (the video wall), south +z (the lifts); x is across the floor, west (-x) to east.
 */

const W = 44;
const L = 56;
const H = 6.6;
/** Just off the north and south walls, for what hangs on them. */
const NORTH = -L / 2 + 0.08;
const SOUTH = L / 2 - 0.08;
const ALONG_X = Math.PI / 2;
/** Where the rooms' partitions stand: the front rooms' south side, the back rooms' north and south sides, and how far in from the windows the rooms reach. */
const FRONT_ROOMS = -17;
const BACK_ROOMS: [number, number] = [8, 20];
const FRONT_ROOM_X = 12;
const BACK_ROOM_X = 11;
/** Where the back rooms' doors are, in their sides along the pit: south of the quants' table, toward the lifts. */
const BACK_DOOR: [number, number] = [16.6, 18.4];
/** The boards' and their consoles' places along the south wall. */
const BOARD_X = { issues: -15, queue: -8, pulls: 8, services: 15 } as const;

const glass = (x: number, z: number, length: number, rotY: number): PropConfig => ({ kind: 'glass', x, z, length, rotY });

/** A front room's south side, with a door near the pit, and its side along the pit. */
function frontRoom(side: -1 | 1): PropConfig[] {
  const inner = side * FRONT_ROOM_X;
  const outer = side * (W / 2);
  const door = inner + side * 2.7;
  return [
    glass(inner, (FRONT_ROOMS - L / 2) / 2, FRONT_ROOMS + L / 2, 0),
    glass((inner + door - side * 0.9) / 2, FRONT_ROOMS, Math.abs(door - side * 0.9 - inner), ALONG_X),
    glass((door + side * 0.9 + outer) / 2, FRONT_ROOMS, Math.abs(outer - door - side * 0.9), ALONG_X),
  ];
}

/** A back room: a solid wall on its north side (a display either face), glass along the pit with a door in it, glass to the south. */
function backRoom(side: -1 | 1): PropConfig[] {
  const inner = side * BACK_ROOM_X;
  const mid = side * ((BACK_ROOM_X + W / 2) / 2);
  const [n, s] = BACK_ROOMS;
  const [d0, d1] = BACK_DOOR;
  return [
    { kind: 'partition', x: mid, z: n, length: W / 2 - BACK_ROOM_X, rotY: ALONG_X },
    glass(inner, (n + d0) / 2, d0 - n, 0),
    glass(inner, (d1 + s) / 2, s - d1, 0),
    glass(mid, s, W / 2 - BACK_ROOM_X, ALONG_X),
  ];
}

const props: PropConfig[] = [
  // The video wall: prices along the top of the whole north wall, the three big boards under them.
  { kind: 'ticker', x: 0, z: NORTH, y: 5.95, length: W - 0.6, height: 0.55, rotY: 0 },
  { kind: 'wall', feed: 'heatmap', x: -7.6, z: NORTH, y: 3.6, width: 6.8, height: 3.8, rotY: 0 },
  { kind: 'wall', feed: 'portfolio', x: 0, z: NORTH, y: 3.6, width: 6.8, height: 3.8, rotY: 0 },
  { kind: 'wall', feed: 'risk', x: 7.6, z: NORTH, y: 3.6, width: 6.8, height: 3.8, rotY: 0 },
  // The rooms, and what each one's board shows.
  ...frontRoom(-1),
  ...frontRoom(1),
  ...backRoom(-1),
  ...backRoom(1),
  { kind: 'wall', feed: 'pipeline', x: -17, z: NORTH, y: 2.9, width: 7, height: 3, rotY: 0 },
  { kind: 'wall', feed: 'risk', x: 17, z: NORTH, y: 2.9, width: 7, height: 3, rotY: 0 },
  { kind: 'wall', feed: 'strategies', x: -16.5, z: BACK_ROOMS[0] + 0.08, y: 1.75, width: 5.6, height: 2.1, rotY: 0 },
  { kind: 'wall', feed: 'committee', x: 16.5, z: BACK_ROOMS[0] + 0.08, y: 1.75, width: 5.6, height: 2.1, rotY: 0 },
  // And on the back rooms' other faces, for the pit: the desks' theses, and who's at which desk doing what.
  { kind: 'wall', feed: 'research', x: -16.5, z: BACK_ROOMS[0] - 0.08, y: 1.75, width: 5.6, height: 2.1, rotY: Math.PI },
  { kind: 'wall', feed: 'desks', x: 16.5, z: BACK_ROOMS[0] - 0.08, y: 1.75, width: 5.6, height: 2.1, rotY: Math.PI },
  { kind: 'sign', text: '🏛️ CIO office', x: -(FRONT_ROOM_X + 2.7), z: FRONT_ROOMS, y: 2.62, rotY: 0 },
  { kind: 'sign', text: '🛡️ Risk room', x: FRONT_ROOM_X + 2.7, z: FRONT_ROOMS, y: 2.62, rotY: 0 },
  { kind: 'sign', text: '🧪 Quant lab', x: -BACK_ROOM_X, z: (BACK_DOOR[0] + BACK_DOOR[1]) / 2, y: 2.62, rotY: ALONG_X },
  { kind: 'sign', text: '🗳️ Investment committee', x: BACK_ROOM_X, z: (BACK_DOOR[0] + BACK_DOOR[1]) / 2, y: 2.62, rotY: -ALONG_X },
  // The risk room's beacon, on its corner nearest the pit.
  { kind: 'beacon', x: FRONT_ROOM_X, z: FRONT_ROOMS, y: 3.05 },
  // Light panels in the ceiling: six that light the floor, the rest that just glow.
  ...[-22, -14, -6, 2, 10, 18, 24].flatMap((z) =>
    [-17, -6, 6, 17].map((x) => ({ kind: 'panel', x, z, y: H, width: 1.2, length: 3.6, light: (x === -6 || x === 6) && (z === -14 || z === 2) ? true : (z === -22 && Math.abs(x) === 17) || undefined })),
  ),
  // Green in the corners, the drinks by the lifts, and the closing bell.
  ...[
    [-21.2, 27.2],
    [21.2, 27.2],
    [-10.4, 21],
    [10.4, 21],
    [-21.2, -16.4],
    [21.2, -16.4],
  ].map(([x, z]) => ({ kind: 'plant', x, z })),
  { kind: 'dispenser', x: 20.2, z: SOUTH - 0.4, rotY: Math.PI },
  { kind: 'gong', x: -20.6, z: 24, rotY: ALONG_X },
];

export const TRADING_FLOOR: MapConfig = {
  id: 'floor',
  name: 'Trading floor',
  icon: '📈',
  description:
    'The fund’s trading floor, high up a tower: a video wall of live prices, the heatmap, the portfolio and the risk board, rows of desks by department, and glass rooms for the CIO, risk, the quant lab and the investment committee. A beacon on the risk room turns red when the fund’s risk needs you.',
  style: 'floor',
  hall: { width: W, length: L, height: H },
  spawn: { x: 0, z: 22.5, rotY: Math.PI },
  door: { x: 0, z: L / 2 - 1.4 },
  throne: { x: 0, z: -22.5, rotY: 0, dais: { width: 10, depth: 4.6, height: 0.3, steps: 1 }, label: '🏛️ Principal’s desk' },
  herald: { x: 6.4, z: -20.6, rotY: -0.5, name: 'Chief of staff', says: 'Speak to me to staff a new desk', ask: 'What should they work on?', button: 'Hire them 💼' },
  lineup: { x: -4.2, z: -18.4, rotY: Math.PI, step: [1.4, 0], count: 7 },
  // A department to a table. Seats are numbered across the tables in this order, so the four that
  // are the office's back office (desk-17 to desk-20, only sat at once it's built out: see deskBuilt)
  // are the hot desks, and every department's seats are there from the start.
  tables: [
    { name: '🏛️ Executive', x: -17, z: -22, length: 5.4, seats: 3, rotY: ALONG_X, sides: 'inner' },
    { name: '🛡️ Risk', x: 16.5, z: -22, length: 7, seats: 5, rotY: ALONG_X, sides: 'inner' },
    { name: '🔎 Research', x: 0, z: -5.5, length: 16, seats: 8, rotY: ALONG_X, sides: 'inner' },
    // Facing the boards by the lifts.
    { name: '💻 Hot desks', x: 0, z: 1.5, length: 8, seats: 4, rotY: ALONG_X, sides: 'inner' },
    { name: '📈 Trading', x: 0, z: -12, length: 12, seats: 6, rotY: ALONG_X, sides: 'inner' },
    { name: '🧪 Quant lab', x: -17, z: 14, length: 8, seats: 6, rotY: ALONG_X, sides: 'outer' },
  ],
  stations: {
    issues: { x: BOARD_X.issues, z: SOUTH - 2.5, rotY: 0 },
    queue: { x: BOARD_X.queue, z: SOUTH - 2.5, rotY: 0 },
    pulls: { x: BOARD_X.pulls, z: SOUTH - 2.5, rotY: 0 },
  },
  // The investment committee's table, its head toward the door.
  council: { x: 16.5, z: 14, rotY: -ALONG_X },
  boards: {
    issues: { x: BOARD_X.issues, y: 3.4, z: SOUTH, rotY: Math.PI, width: 4.4, height: 2.6, label: '📡 Issues' },
    queue: { x: BOARD_X.queue, y: 3.4, z: SOUTH, rotY: Math.PI, width: 4.4, height: 2.6, label: '📋 Queue' },
    pulls: { x: BOARD_X.pulls, y: 3.4, z: SOUTH, rotY: Math.PI, width: 4.4, height: 2.6, label: '🔀 Pull requests' },
    services: { x: BOARD_X.services, y: 3.4, z: SOUTH, rotY: Math.PI, width: 4.4, height: 2.6, label: '🌐 Services' },
  },
  props,
  agents: { outfit: 'none', ageMinutes: 0 },
  palette: { hull: '#2b313b', deck: '#262b33', panel: '#d5dae1', metal: '#3a4250', glow: '#ffb000' },
};
