// Stylized vector coastlines for the war-room map — deliberately coarse, the
// film's board is itself a stylization of real command displays
// (feasibility.md §Module 6). Coordinates are [lon, lat] polylines, drawn in
// one of two projections (fidelity-notes.md §3: the set's 12 wall maps
// included world AND polar): "world" is equirectangular, "polar" is
// azimuthal-equidistant centered on the North Pole — missiles come over the
// pole, the film's most iconic geometry. Fidelity iterates against
// docs/screenshots/.

export type Polyline = Array<[number, number]>;

export type MapMode = "world" | "polar";

export const CONTINENTS: Polyline[] = [
  // North America
  [[-166, 66], [-158, 71], [-130, 70], [-110, 68], [-95, 72], [-82, 68], [-75, 62],
   [-58, 60], [-55, 52], [-65, 47], [-70, 43], [-75, 38], [-80, 32], [-81, 26],
   [-84, 30], [-90, 29], [-97, 26], [-97, 22], [-92, 18], [-83, 14], [-80, 9],
   [-85, 12], [-95, 16], [-105, 20], [-110, 24], [-114, 30], [-121, 34],
   [-124, 40], [-124, 48], [-131, 54], [-140, 59], [-152, 59], [-165, 60], [-166, 66]],
  // South America
  [[-80, 9], [-76, 8], [-71, 12], [-63, 10], [-52, 5], [-44, -3], [-38, -6],
   [-35, -9], [-39, -14], [-40, -22], [-48, -26], [-53, -34], [-58, -39],
   [-65, -41], [-65, -47], [-69, -52], [-71, -54], [-73, -50], [-73, -44],
   [-71, -37], [-70, -30], [-70, -20], [-75, -15], [-81, -6], [-80, 1], [-77, 7], [-80, 9]],
  // Greenland
  [[-58, 76], [-40, 84], [-22, 82], [-20, 76], [-25, 70], [-33, 68], [-42, 60],
   [-48, 61], [-53, 66], [-58, 76]],
  // Europe
  [[-9, 43], [-2, 43], [3, 42], [8, 44], [12, 45], [15, 41], [19, 40], [23, 36],
   [28, 41], [30, 45], [40, 47], [48, 42], [50, 47], [40, 55], [30, 60], [24, 65],
   [28, 71], [18, 70], [12, 65], [5, 62], [5, 58], [8, 54], [1, 51], [-5, 48], [-9, 43]],
  // Africa
  [[-6, 35], [10, 37], [20, 32], [32, 31], [43, 12], [51, 12], [40, -2], [40, -15],
   [35, -24], [31, -30], [20, -35], [18, -32], [14, -22], [12, -9], [9, 4],
   [-8, 4], [-13, 9], [-17, 15], [-16, 22], [-10, 30], [-6, 35]],
  // Asia (with the USSR's long north coast)
  [[30, 60], [40, 66], [55, 69], [75, 72], [95, 76], [115, 74], [140, 72],
   [160, 70], [178, 66], [170, 60], [162, 58], [158, 52], [142, 47], [135, 43],
   [130, 42], [126, 39], [122, 37], [121, 31], [113, 22], [108, 12], [104, 2],
   [98, 8], [96, 16], [88, 22], [80, 15], [77, 8], [72, 20], [67, 24], [57, 25],
   [56, 27], [48, 30], [43, 36], [36, 36], [30, 45], [40, 47], [48, 42], [50, 47],
   [40, 55], [30, 60]],
  // Australia
  [[114, -22], [122, -18], [130, -12], [136, -12], [142, -11], [146, -19],
   [153, -27], [150, -37], [140, -38], [131, -32], [124, -33], [115, -34], [114, -22]],
  // Japan
  [[130, 31], [133, 34], [137, 35], [140, 36], [141, 40], [143, 43], [140, 43],
   [136, 37], [131, 34], [130, 31]],
  // UK
  [[-5, 50], [1, 51], [0, 53], [-2, 56], [-4, 58], [-6, 55], [-3, 53], [-5, 50]],
];

/** Equirectangular projection into an SVG viewBox. */
export function project(
  lon: number, lat: number, width = 1000, height = 500,
): [number, number] {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
}

// Polar orientation: the central-US meridian points straight down, so North
// America sits at the bottom of the disc and the USSR beyond the pole — the
// inbound tracks cross the center, as on the film's board.
const POLAR_LON0 = -100;
export const POLAR_LAT_RIM = -60; // disc edge; everything south is off-board

/** Azimuthal-equidistant projection, North Pole at center. */
export function projectPolar(
  lon: number, lat: number, width = 1000, height = 500,
): [number, number] {
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) / 2 - 10;
  const r = ((90 - lat) / (90 - POLAR_LAT_RIM)) * R;
  const phi = ((lon - POLAR_LON0) * Math.PI) / 180;
  return [cx + r * Math.sin(phi), cy + r * Math.cos(phi)];
}

export function projectFor(mode: MapMode) {
  return mode === "polar" ? projectPolar : project;
}

export function polylinePath(
  points: Polyline, mode: MapMode = "world", width = 1000, height = 500,
): string {
  const proj = projectFor(mode);
  return points
    .map(([lon, lat], i) => {
      const [x, y] = proj(lon, lat, width, height);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function toVec(lon: number, lat: number): [number, number, number] {
  const lo = (lon * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/** Point at fraction t along the great circle from→to, as [lon, lat]. */
export function greatCirclePoint(
  from: [number, number], to: [number, number], t: number,
): [number, number] {
  const a = toVec(from[0], from[1]);
  const b = toVec(to[0], to[1]);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return from;
  const s1 = Math.sin((1 - t) * omega) / Math.sin(omega);
  const s2 = Math.sin(t * omega) / Math.sin(omega);
  const x = s1 * a[0] + s2 * b[0];
  const y = s1 * a[1] + s2 * b[1];
  const z = s1 * a[2] + s2 * b[2];
  const lat = (Math.asin(Math.min(1, Math.max(-1, z))) * 180) / Math.PI;
  const lon = (Math.atan2(y, x) * 180) / Math.PI;
  return [lon, lat];
}

const GC_SEGMENTS = 32;

/** Trajectory arc. World mode keeps the stylized lifted Bezier; polar mode
 *  samples the true great circle, which carries US↔USSR strikes over the
 *  pole through the center of the disc. */
export function trajectoryPath(
  from: [number, number], to: [number, number],
  mode: MapMode = "world", width = 1000, height = 500,
): string {
  if (mode === "polar") {
    const parts: string[] = [];
    for (let i = 0; i <= GC_SEGMENTS; i++) {
      const [lon, lat] = greatCirclePoint(from, to, i / GC_SEGMENTS);
      const [x, y] = projectPolar(lon, lat, width, height);
      parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return parts.join(" ");
  }
  const [x1, y1] = project(from[0], from[1], width, height);
  const [x2, y2] = project(to[0], to[1], width, height);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const lift = Math.min(140, dist * 0.35);
  return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${(my - lift).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

/** Screen position of a missile at fraction t along its track — where the
 *  track label rides. Matches trajectoryPath's geometry in both modes. */
export function trajectoryPoint(
  from: [number, number], to: [number, number], t: number,
  mode: MapMode = "world", width = 1000, height = 500,
): [number, number] {
  if (mode === "polar") {
    const [lon, lat] = greatCirclePoint(from, to, t);
    return projectPolar(lon, lat, width, height);
  }
  const [x1, y1] = project(from[0], from[1], width, height);
  const [x2, y2] = project(to[0], to[1], width, height);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dist = Math.hypot(x2 - x1, y2 - y1);
  const lift = Math.min(140, dist * 0.35);
  const cx = mx;
  const cy = my - lift;
  const u = 1 - t;
  return [
    u * u * x1 + 2 * u * t * cx + t * t * x2,
    u * u * y1 + 2 * u * t * cy + t * t * y2,
  ];
}
