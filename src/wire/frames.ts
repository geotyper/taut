/**
 * Wire frames for soap films, and what the rule needs to know of them.
 *
 * A film on a wire has air on both sides, so it is not a border between two
 * labels: it is an open sheet, and it must end on the wire. The rule can
 * still treat it as a border by a twist in how cells read each other. Every
 * face of a frame, a loop of wire or a few, gets a cut: a surface spanning
 * its loops. A cell that reads a neighbour across the cut of face k swaps
 * the neighbour's labels 0 and k. Going once round a wire then always
 * crosses a cut, so somewhere on the way round two cells must disagree:
 * there is a film. Where it lies is up to the rule, which pulls it taut, so
 * the films come to rest as minimal surfaces spanning the wire. The cut
 * itself is not seen; it is only a bookkeeping of the labels.
 *
 * Whether the line between two cells crosses a cut is read from the solid
 * angle the face's loops subtend: it changes smoothly, except by 4π across
 * the cut, and by less than 2π along a short line that does not cross it,
 * however near the wire it passes.
 *
 * One face is enough for a single film, on a ring, two rings or the edge of
 * a Möbius strip. A frame whose films meet, a tetrahedron or a cube, has a
 * face for every opening between its wires, each with its own label: the
 * films that grow from the openings then meet along Plateau borders inside.
 */

export type FrameKind = 'ring' | 'rings' | 'mobius' | 'tetra' | 'cube' | 'gyroid';

export interface Face {
  /** Closed loops of wire, points in field cells. */
  loops: number[][][];
  /** The label the cut swaps with 0. */
  chamber: number;
}

export interface Frame {
  faces: Face[];
  /** Cells inside a closed frame, where a trapped bubble may start. */
  inside: ((p: number[]) => boolean) | null;
  /**
   * No wire, and the field wraps round on every side, as one cell of a
   * crystal: the gyroid, a film that splits space into two labyrinths.
   */
  periodic?: boolean;
}

export interface FrameField {
  /** 1 for a cell of wire: fixed, and not counted. */
  wire: Uint8Array;
  /** The solid angle of each face's loops at each cell, face fastest. */
  omega: Float32Array;
  /** A bit for each face whose cut passes within the rule's reach of the cell. */
  near: Uint8Array;
  faces: number;
}

/** The wire's radius, in cells. */
export const WIRE_RADIUS = 1.1;

/**
 * A frame centred in a field of n cells. `gap` is the distance between two
 * rings in ring radii.
 */
export function makeFrame(kind: FrameKind, n: number, gap: number): Frame {
  const c = n / 2;
  const at = (p: number[]) => [c + p[0], c + p[1], c + p[2]];
  const circle = (radius: number, y: number, segments = 72) =>
    Array.from({ length: segments }, (_, k) => {
      const t = (2 * Math.PI * k) / segments;
      return at([radius * Math.cos(t), y, radius * Math.sin(t)]);
    });
  if (kind === 'gyroid') return { faces: [], inside: null, periodic: true };
  if (kind === 'ring') return { faces: [{ loops: [circle(0.3 * n, 0)], chamber: 1 }], inside: null };
  if (kind === 'rings') {
    const r = 0.25 * n;
    const h = (gap * r) / 2;
    return { faces: [{ loops: [circle(r, -h), circle(r, h)], chamber: 1 }], inside: null };
  }
  if (kind === 'mobius') {
    // The edge of a strip with one half twist: a single loop, round twice.
    const r = 0.25 * n;
    const w = 0.12 * n;
    const segments = 160;
    const loop = Array.from({ length: segments }, (_, k) => {
      const t = (4 * Math.PI * k) / segments;
      const s = r + w * Math.cos(t / 2);
      return at([s * Math.cos(t), w * Math.sin(t / 2), s * Math.sin(t)]);
    });
    return { faces: [{ loops: [loop], chamber: 1 }], inside: null };
  }
  if (kind === 'tetra') {
    const s = 0.22 * n;
    const v = [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ].map((p) => at(p.map((x) => x * s)));
    const faces = [
      [1, 2, 3],
      [0, 3, 2],
      [0, 1, 3],
      [0, 2, 1],
    ].map((f, k) => ({ loops: [f.map((i) => v[i])], chamber: k + 1 }));
    const planes = faces.map((f) => planeOf(f.loops[0], at([0, 0, 0])));
    return { faces, inside: (p) => planes.every((pl) => pl(p) < 0) };
  }
  const s = 0.22 * n;
  const corner = (x: number, y: number, z: number) => at([x * s, y * s, z * s]);
  const quads = [
    [corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(1, -1, 1)],
    [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
    [corner(-1, 1, -1), corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1)],
    [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
    [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
    [corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), corner(1, -1, -1)],
  ];
  const faces = quads.map((q, k) => ({ loops: [q], chamber: k + 1 }));
  return { faces, inside: (p) => Math.max(Math.abs(p[0] - c), Math.abs(p[1] - c), Math.abs(p[2] - c)) < s };
}

/**
 * Where the films start. 'cut': on the cuts themselves, every cell 0.
 * 'catenoid': for two rings, the cells between them labelled 1, so the film
 * starts as a tube. 'chambers': inside a closed frame every cell takes the
 * label of the face it is nearest, so the films start from the middle.
 * 'bubble': the same, with a bubble of its own label in the middle.
 */
export type FrameStart = 'cut' | 'catenoid' | 'chambers' | 'bubble' | 'gyroid' | 'random';

export const WALL = 0xffffffff;

/** The label of a bubble trapped in a frame: after every chamber. */
export function bubbleLabel(frame: Frame): number {
  return frame.faces.length + 1;
}

/** The trapped bubble starts this share of a cube's size across. */
const BUBBLE_SIZE = 0.45;

export function startLabels(frame: Frame, field: FrameField, n: number, start: FrameStart, gap: number, across = 1): Uint32Array {
  if (start === 'gyroid' || start === 'random') return twoLabyrinths(n, start === 'gyroid' ? roughGyroid(n, across) : randomWaves(n, 0.5 * across, 2 * across));
  const labels = new Uint32Array(n * n * n);
  const c = n / 2;
  const planes = frame.faces.map((f) => planeOf(f.loops[0], [c, c, c]));
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (z * n + y) * n + x;
        const p = [x + 0.5, y + 0.5, z + 0.5];
        if (field.wire[i]) {
          labels[i] = WALL;
          continue;
        }
        if (start === 'catenoid') {
          const r = 0.25 * n;
          if (Math.hypot(p[0] - c, p[2] - c) < r && Math.abs(p[1] - c) < (gap * r) / 2) labels[i] = 1;
        } else if ((start === 'chambers' || start === 'bubble') && frame.inside?.(p)) {
          // The face whose plane is nearest, from inside.
          let best = 0;
          let nearest = Infinity;
          planes.forEach((plane, k) => {
            const d = -plane(p);
            if (d < nearest) [nearest, best] = [d, k];
          });
          labels[i] = frame.faces[best].chamber;
          const middle = Math.max(Math.abs(p[0] - c), Math.abs(p[1] - c), Math.abs(p[2] - c));
          if (start === 'bubble' && middle < 0.22 * n * BUBBLE_SIZE) labels[i] = bubbleLabel(frame);
        }
      }
    }
  }
  return labels;
}

/**
 * A function on a periodic field of n cells: label 1 where it is positive,
 * 0 elsewhere.
 */
function twoLabyrinths(n: number, f: (x: number, y: number, z: number) => number): Uint32Array {
  const labels = new Uint32Array(n * n * n);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) labels[(z * n + y) * n + x] = f(x + 0.5, y + 0.5, z + 0.5) > 0 ? 1 : 0;
    }
  }
  return labels;
}

/**
 * The gyroid's nodal approximation, sin x cos y + sin y cos z + sin z cos x,
 * with `across` periods over the field. Its zero set halves the volume and
 * lies close to Schoen's minimal surface, though it is not quite minimal.
 */
export function gyroid(n: number, across: number): (x: number, y: number, z: number) => number {
  const k = (2 * Math.PI * across) / n;
  return (x, y, z) => {
    const [a, b, c] = [x * k, y * k, z * k];
    return Math.sin(a) * Math.cos(b) + Math.sin(b) * Math.cos(c) + Math.sin(c) * Math.cos(a);
  };
}

/**
 * The gyroid with bumps on it, so the rule has something to pull taut: a
 * few waves that fit the field, none longer than the gyroid's period, so
 * that they do not already lean towards a coarser shape.
 */
function roughGyroid(n: number, across: number): (x: number, y: number, z: number) => number {
  const g = gyroid(n, across);
  const bumps = randomWaves(n, across, 2 * across, 6);
  return (x, y, z) => g(x, y, z) + 0.6 * bumps(x, y, z);
}

/**
 * A sum of waves at random, each fitting the field a whole number of times,
 * from `least` to `most` times: two phases mixed as at random, as when an
 * oil and water mixture parts. About 1 on the root mean square.
 */
function randomWaves(n: number, least: number, most: number, count = 40): (x: number, y: number, z: number) => number {
  const waves: { k: number[]; phase: number }[] = [];
  while (waves.length < count) {
    const k = [0, 1, 2].map(() => Math.round((Math.random() * 2 - 1) * most));
    const length = Math.hypot(k[0], k[1], k[2]);
    if (length < least || length > most) continue;
    waves.push({ k: k.map((v) => (2 * Math.PI * v) / n), phase: 2 * Math.PI * Math.random() });
  }
  const scale = Math.sqrt(2 / count);
  return (x, y, z) => {
    let sum = 0;
    for (const { k, phase } of waves) sum += Math.cos(k[0] * x + k[1] * y + k[2] * z + phase);
    return sum * scale;
  };
}

/**
 * The faces between cells of different labels on a periodic field, the
 * film's area as the lattice counts it.
 */
export function filmFaces(labels: Uint32Array, n: number): number {
  let faces = 0;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const here = labels[(z * n + y) * n + x];
        if (here !== labels[(z * n + y) * n + ((x + 1) % n)]) faces++;
        if (here !== labels[(z * n + ((y + 1) % n)) * n + x]) faces++;
        if (here !== labels[(((z + 1) % n) * n + y) * n + x]) faces++;
      }
    }
  }
  return faces;
}

/** The signed distance from a polygon's plane, positive away from a point inside. */
function planeOf(polygon: number[][], inside: number[]): (p: number[]) => number {
  const [a, b, c] = polygon;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(normal[0], normal[1], normal[2]);
  normal = normal.map((x) => x / l);
  const side = (p: number[]) => (p[0] - a[0]) * normal[0] + (p[1] - a[1]) * normal[1] + (p[2] - a[2]) * normal[2];
  const flip = side(inside) > 0 ? -1 : 1;
  return (p) => flip * side(p);
}

/**
 * The wire's cells, every face's solid angle at every cell and which cuts
 * pass near it, for a rule that reads `reach` cells away.
 */
export function frameField(frame: Frame, n: number, reach: number, angles = true): FrameField {
  const count = n * n * n;
  const faces = frame.faces.length;
  const wire = new Uint8Array(count);
  const omega = new Float32Array(angles ? count * faces : 0);

  // The wire: cells near any piece of any loop.
  for (const face of frame.faces) {
    for (const loop of face.loops) {
      for (let k = 0; k < loop.length; k++) {
        const a = loop[k];
        const b = loop[(k + 1) % loop.length];
        const lo = [0, 1, 2].map((i) => Math.max(0, Math.floor(Math.min(a[i], b[i]) - WIRE_RADIUS - 1)));
        const hi = [0, 1, 2].map((i) => Math.min(n - 1, Math.ceil(Math.max(a[i], b[i]) + WIRE_RADIUS + 1)));
        for (let z = lo[2]; z <= hi[2]; z++) {
          for (let y = lo[1]; y <= hi[1]; y++) {
            for (let x = lo[0]; x <= hi[0]; x++) {
              if (segmentDistance([x + 0.5, y + 0.5, z + 0.5], a, b) <= WIRE_RADIUS) wire[(z * n + y) * n + x] = 1;
            }
          }
        }
      }
    }
  }

  // The page works the angles out on the GPU (Wire3.setFrame).
  if (!angles) return { wire, omega, near: new Uint8Array(0), faces };

  // Solid angles, as the sum over a fan of triangles from the middle of each loop.
  for (let f = 0; f < faces; f++) {
    const fans = frame.faces[f].loops.map((loop) => {
      const centre = [0, 1, 2].map((i) => loop.reduce((s, p) => s + p[i], 0) / loop.length);
      return { centre, loop };
    });
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const p = [x + 0.5, y + 0.5, z + 0.5];
          let total = 0;
          for (const { centre, loop } of fans) {
            for (let k = 0; k < loop.length; k++) total += solidAngle(p, centre, loop[k], loop[(k + 1) % loop.length]);
          }
          omega[((z * n + y) * n + x) * faces + f] = total;
        }
      }
    }
  }

  // Cells next to a cut, then grown by the reach: a cube, as wide as the ball.
  const cut = new Uint8Array(count);
  const steps = [1, n, n * n];
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (z * n + y) * n + x;
        const c = [x, y, z];
        for (let a = 0; a < 3; a++) {
          if (c[a] + 1 >= n) continue;
          const j = i + steps[a];
          for (let f = 0; f < faces; f++) {
            if (Math.abs(omega[i * faces + f] - omega[j * faces + f]) > 2 * Math.PI) {
              cut[i] |= 1 << f;
              cut[j] |= 1 << f;
            }
          }
        }
      }
    }
  }
  let near = cut;
  for (let a = 0; a < 3; a++) {
    const grown = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const c = [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))];
      let bits = 0;
      for (let d = -reach; d <= reach; d++) {
        const q = c[a] + d;
        if (q < 0 || q >= n) continue;
        bits |= near[i + d * steps[a]];
      }
      grown[i] = bits;
    }
    near = grown;
  }
  return { wire, omega, near, faces };
}

/**
 * The fans the solid angles are summed over: for every loop, triangles from
 * its middle to each of its pieces. Three points a triangle, each x, y, z
 * and the index of its face.
 */
export function fanTriangles(frame: Frame): Float32Array {
  const out: number[] = [];
  frame.faces.forEach((face, f) => {
    for (const loop of face.loops) {
      const centre = [0, 1, 2].map((i) => loop.reduce((s, p) => s + p[i], 0) / loop.length);
      for (let k = 0; k < loop.length; k++) {
        for (const p of [centre, loop[k], loop[(k + 1) % loop.length]]) out.push(p[0], p[1], p[2], f);
      }
    }
  });
  return new Float32Array(out);
}

/** The signed solid angle of triangle abc seen from p (Van Oosterom and Strackee). */
function solidAngle(p: number[], a: number[], b: number[], c: number[]): number {
  const ax = a[0] - p[0], ay = a[1] - p[1], az = a[2] - p[2];
  const bx = b[0] - p[0], by = b[1] - p[1], bz = b[2] - p[2];
  const cx = c[0] - p[0], cy = c[1] - p[1], cz = c[2] - p[2];
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  const lc = Math.hypot(cx, cy, cz);
  const triple = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  const below = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (ax * cx + ay * cy + az * cz) * lb + (bx * cx + by * cy + bz * cz) * la;
  return 2 * Math.atan2(triple, below);
}

function segmentDistance(p: number[], a: number[], b: number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = l2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2)) : 0;
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
}

/** The label a cell sees at a neighbour, through any cut between them. */
export function seenThrough(
  label: number,
  field: FrameField,
  frame: Frame,
  from: number,
  to: number,
): number {
  const bits = field.near[from];
  if (bits === 0) return label;
  const f = field.faces;
  for (let k = 0; k < f; k++) {
    if (!(bits & (1 << k))) continue;
    // Crossings of the cut, which may fold over itself: only an odd count swaps.
    if (Math.round(Math.abs(field.omega[from * f + k] - field.omega[to * f + k]) / (4 * Math.PI)) % 2 === 1) {
      const chamber = frame.faces[k].chamber;
      if (label === 0) label = chamber;
      else if (label === chamber) label = 0;
    }
  }
  return label;
}
