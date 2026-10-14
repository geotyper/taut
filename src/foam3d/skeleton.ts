/** A line of the foam's skeleton: points in field cells, and a hue from 0 to 1. */
export interface SkeletonLine {
  points: number[][];
  hue: number;
}

export interface Skeleton {
  lines: SkeletonLine[];
  /** Where four films' edges meet, in field cells. */
  points: number[][];
}

/** Points of a line further apart than this, in cells, belong to two lines. */
const GAP = 5;
/** A line is averaged into one point per this many cells along it. */
const BIN = 2;
/** A line with fewer cells than this is taken for noise. */
const FEWEST = 3;
/** An end of a line is joined to a point where four meet within this many cells. */
const REACH = 6;

/**
 * The skeleton of a foam from its labels (n*n*n, x fastest): the lines where
 * three bubbles meet, the Plateau borders, and the points where four do.
 *
 * Every 2x2x2 block holding three labels lies on the line of those three, so
 * the blocks are grouped by their three labels, one group a line. A group is
 * put in order along its longest extent, averaged into a point every couple
 * of cells, split where it jumps, and its ends are joined to the points where
 * four labels meet that include its three. A line bent by more than a half
 * turn would be put in the wrong order; the borders of a foam are gentler.
 */
export function extractSkeleton(labels: Uint32Array, n: number): Skeleton {
  const n2 = n * n;
  const triples = new Map<string, number[]>();
  const quads = new Map<string, number[]>();
  const block = new Uint32Array(8);
  const kinds: number[] = [];
  for (let z = 0; z + 1 < n; z++) {
    for (let y = 0; y + 1 < n; y++) {
      for (let x = 0; x + 1 < n; x++) {
        const i = z * n2 + y * n + x;
        block[0] = labels[i];
        block[1] = labels[i + 1];
        block[2] = labels[i + n];
        block[3] = labels[i + n + 1];
        block[4] = labels[i + n2];
        block[5] = labels[i + n2 + 1];
        block[6] = labels[i + n2 + n];
        block[7] = labels[i + n2 + n + 1];
        const first = block[0];
        let same = true;
        for (let k = 1; k < 8 && same; k++) same = block[k] === first;
        if (same) continue;
        kinds.length = 0;
        for (let k = 0; k < 8; k++) if (!kinds.includes(block[k])) kinds.push(block[k]);
        if (kinds.length < 3) continue;
        kinds.sort((a, b) => a - b);
        const group = kinds.length === 3 ? triples : quads;
        const key = kinds.slice(0, 4).join(',');
        let cells = group.get(key);
        if (!cells) group.set(key, (cells = []));
        // The centre of the block, in cells.
        cells.push(x + 1, y + 1, z + 1);
      }
    }
  }

  const points: number[][] = [];
  const ends = new Map<string, number[][]>();
  for (const [key, cells] of quads) {
    const centre = mean(cells);
    points.push(centre);
    const four = key.split(',');
    for (let skip = 0; skip < four.length; skip++) {
      const three = four.filter((_, k) => k !== skip).join(',');
      let list = ends.get(three);
      if (!list) ends.set(three, (list = []));
      list.push(centre);
    }
  }

  const lines: SkeletonLine[] = [];
  for (const [key, cells] of triples) {
    if (cells.length < FEWEST * 3) continue;
    const hue = hueOf(key);
    const axis = principalAxis(cells);
    const order: number[] = [];
    for (let k = 0; k < cells.length; k += 3) order.push(k);
    const along = (k: number) => cells[k] * axis[0] + cells[k + 1] * axis[1] + cells[k + 2] * axis[2];
    order.sort((a, b) => along(a) - along(b));

    // Average into bins along the axis, then split where the line jumps.
    const binned: number[][] = [];
    let start = along(order[0]);
    let sum = [0, 0, 0];
    let count = 0;
    for (const k of order) {
      if (along(k) - start > BIN && count > 0) {
        binned.push(sum.map((v) => v / count));
        sum = [0, 0, 0];
        count = 0;
        start = along(k);
      }
      sum[0] += cells[k];
      sum[1] += cells[k + 1];
      sum[2] += cells[k + 2];
      count++;
    }
    if (count > 0) binned.push(sum.map((v) => v / count));

    let piece: number[][] = [];
    const pieces: number[][][] = [];
    for (const p of binned) {
      if (piece.length > 0 && distance(piece[piece.length - 1], p) > GAP) {
        pieces.push(piece);
        piece = [];
      }
      piece.push(p);
    }
    pieces.push(piece);

    const corners = ends.get(key) ?? [];
    for (const line of pieces) {
      join(line, corners);
      if (line.length >= 2) lines.push({ points: line, hue });
    }
  }
  return { lines, points };
}

/** Put the nearest point where four meet at each end of a line, if one is close. */
function join(line: number[][], corners: number[][]): void {
  for (const atStart of [true, false]) {
    const end = atStart ? line[0] : line[line.length - 1];
    let best: number[] | null = null;
    let bestDistance = REACH;
    for (const c of corners) {
      const d = distance(c, end);
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    if (best) {
      if (atStart) line.unshift(best);
      else line.push(best);
    }
  }
}

/** The colour of a line: from the first of its three labels that is a bubble. */
function hueOf(key: string): number {
  const labels = key.split(',').map(Number);
  // Air is 0 and the glass the largest label; either would give every line on
  // them one colour.
  const bubble = labels.find((l) => l > 0 && l < 0xffffffff) ?? 0;
  return (Math.imul(bubble, 0x9e3779b1) >>> 24) / 256;
}

function mean(cells: number[]): number[] {
  const sum = [0, 0, 0];
  for (let k = 0; k < cells.length; k += 3) {
    sum[0] += cells[k];
    sum[1] += cells[k + 1];
    sum[2] += cells[k + 2];
  }
  return sum.map((v) => v / (cells.length / 3));
}

/** The direction in which the points spread most, by power iteration. */
function principalAxis(cells: number[]): number[] {
  const m = mean(cells);
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < cells.length; k += 3) {
    const d = [cells[k] - m[0], cells[k + 1] - m[1], cells[k + 2] - m[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) c[a * 3 + b] += d[a] * d[b];
  }
  let v = [1, 0.7, 0.4];
  for (let iteration = 0; iteration < 16; iteration++) {
    const w = [0, 1, 2].map((a) => c[a * 3] * v[0] + c[a * 3 + 1] * v[1] + c[a * 3 + 2] * v[2]);
    const length = Math.hypot(w[0], w[1], w[2]) || 1;
    v = w.map((x) => x / length);
  }
  return v;
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * The glass, and the air around an open cluster: a ray crosses into a bubble
 * from either without it counting as a film. The outer skin of an open
 * cluster is what one looks at, as the glass is; counted, it hid every line
 * in a groove between two bulging bubbles from all but straight on.
 */
const GLASS = 0xffffffff;
const AIR = 0;
/** A ray stops this many cells short of its point: the point's own films meet there. */
const STOP_SHORT = 2.5;
/** How far a ray goes between two looks at the labels, in cells. */
const RAY_STEP = 0.5;

/**
 * The parts of a line seen from `eye` through at most `films` films: for each
 * point, a ray from the eye counts the films it crosses on the way, where the
 * label changes from one bubble to another. The glass and the outer skin of
 * an open cluster are not counted.
 * Points seen in a row make one part; a part of a single point is dropped.
 */
export function visibleParts(
  points: number[][],
  labels: Uint32Array,
  n: number,
  eye: number[],
  films: number,
): number[][][] {
  const parts: number[][][] = [];
  let part: number[][] = [];
  for (const p of points) {
    if (inSight(p, labels, n, eye, films)) part.push(p);
    else {
      if (part.length >= 2) parts.push(part);
      part = [];
    }
  }
  if (part.length >= 2) parts.push(part);
  return parts;
}

/** For each point of a line, the films in front of it seen from the eye, counted up to `most`. */
export function filmsInFront(points: number[][], labels: Uint32Array, n: number, eye: number[], most: number): number[] {
  return points.map((p) => Math.min(most, filmsBefore(p, labels, n, eye, most)));
}

/** Whether p is seen from the eye through at most `films` films. */
export function inSight(p: number[], labels: Uint32Array, n: number, eye: number[], films: number): boolean {
  return filmsBefore(p, labels, n, eye, films) <= films;
}

/** Films a ray from the eye crosses before it nears p; stops counting past `enough`. */
function filmsBefore(p: number[], labels: Uint32Array, n: number, eye: number[], enough: number): number {
  const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const length = Math.hypot(d[0], d[1], d[2]);
  const dir = d.map((v) => v / length);
  // Start where the ray enters the field.
  let start = 0;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-9) continue;
    const t0 = (0 - eye[a]) / dir[a];
    const t1 = (n - eye[a]) / dir[a];
    start = Math.max(start, Math.min(t0, t1));
  }
  const end = length - STOP_SHORT;
  let crossed = 0;
  let previous = -1;
  for (let t = start; t < end; t += RAY_STEP) {
    const x = Math.floor(eye[0] + dir[0] * t);
    const y = Math.floor(eye[1] + dir[1] * t);
    const z = Math.floor(eye[2] + dir[2] * t);
    if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) continue;
    const label = labels[(z * n + y) * n + x];
    const outer = label === GLASS || label === AIR || previous === GLASS || previous === AIR;
    if (previous !== -1 && !outer && label !== previous) {
      if (++crossed > enough) return crossed;
    }
    previous = label;
  }
  return crossed;
}

/** Lines drawn across the films; see extractContours. */
export type ContourShape = 'level' | 'round';

/** Short pieces of lines across the films: x1, y1, z1, x2, y2, z2 each, with a hue each. */
export interface Contours {
  pieces: Float32Array;
  hues: Float32Array;
}

/** A face more nearly facing the surfaces than this is left out; see extractContours. */
const FACING = 0.75;
/** Two points of a contour this close, in cells, are joined. */
const LINK = 1.5;

/**
 * Lines across the films, as the lines of equal height on a map: every film
 * is cut by a family of surfaces `spacing` cells apart, level planes or
 * spheres round the centre, and where a film meets one a line runs. They
 * show how a film bends, where the edges alone show only its outline.
 *
 * A film is the face between two cells of different labels, bubbles or a
 * bubble and the air; the glass is not one. A face whose centre lies within
 * half a cell of a surface is on that line, unless it faces along the
 * surfaces: a film lying along them would come out as a patch. The faces of one film on one
 * surface are joined where they lie close together; they are not put in order.
 */
export function extractContours(labels: Uint32Array, n: number, shape: ContourShape, spacing: number): Contours {
  const groups = new Map<string, number[]>();
  const half = n / 2;
  const n2 = n * n;
  const steps = [1, n, n2];
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = z * n2 + y * n + x;
        const a = labels[i];
        if (a === GLASS) continue;
        const at = [x, y, z];
        for (let axis = 0; axis < 3; axis++) {
          if (at[axis] + 1 >= n) continue;
          const b = labels[i + steps[axis]];
          if (b === a || b === GLASS || (a === AIR && b === AIR)) continue;
          // The skin of an open cluster is itself near a sphere round the
          // centre, so round surfaces would only cut it into patches.
          if (shape === 'round' && (a === AIR || b === AIR)) continue;
          // The centre of the face between the two cells.
          const p = [x + 0.5, y + 0.5, z + 0.5];
          p[axis] += 0.5;
          // A face turned towards the surfaces' own direction belongs to a
          // film lying along them, which a band half a cell thick would
          // fill as a whole patch rather than cross in a line.
          const gradient = shape === 'level' ? [0, 1, 0] : [p[0] - half, p[1] - half, p[2] - half];
          if (Math.abs(gradient[axis]) > FACING * Math.hypot(gradient[0], gradient[1], gradient[2])) continue;
          // Level planes run through the middle of a layer of cells: through
          // their boundaries, the side faces of a layer, all at its middle
          // height, would never come within half a cell.
          const value = shape === 'level' ? p[1] - 0.5 : Math.hypot(p[0] - half, p[1] - half, p[2] - half);
          const level = Math.round(value / spacing);
          if (Math.abs(value - level * spacing) >= 0.5) continue;
          const key = `${Math.min(a, b)},${Math.max(a, b)},${level}`;
          let group = groups.get(key);
          if (!group) groups.set(key, (group = []));
          group.push(p[0], p[1], p[2]);
        }
      }
    }
  }

  const pieces: number[] = [];
  const hues: number[] = [];
  for (const [key, points] of groups) {
    const hue = hueOf(key.split(',').slice(0, 2).join(','));
    // Points binned by the cell they fall in, so each looks only at its
    // neighbours' bins: where a film lies along a surface, a group is a whole
    // patch of faces, not a line.
    const count = points.length / 3;
    const bins = new Map<number, number[]>();
    const binOf = (x: number, y: number, z: number) => (Math.floor(x) * n + Math.floor(y)) * n + Math.floor(z);
    for (let a = 0; a < count; a++) {
      const key = binOf(points[a * 3], points[a * 3 + 1], points[a * 3 + 2]);
      let bin = bins.get(key);
      if (!bin) bins.set(key, (bin = []));
      bin.push(a);
    }
    for (let a = 0; a < count; a++) {
      const [ax, ay, az] = [points[a * 3], points[a * 3 + 1], points[a * 3 + 2]];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const b of bins.get(binOf(ax + dx, ay + dy, az + dz)) ?? []) {
              if (b <= a) continue;
              const ex = ax - points[b * 3];
              const ey = ay - points[b * 3 + 1];
              const ez = az - points[b * 3 + 2];
              if (ex * ex + ey * ey + ez * ez > LINK * LINK) continue;
              pieces.push(ax, ay, az, points[b * 3], points[b * 3 + 1], points[b * 3 + 2]);
              hues.push(hue);
            }
          }
        }
      }
    }
  }
  return { pieces: Float32Array.from(pieces), hues: Float32Array.from(hues) };
}
