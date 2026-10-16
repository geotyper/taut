/**
 * The films of a 3D foam as a mesh, rebuilt from its labels: surface nets
 * for many labels, smoothed under constraints, so the lines where three
 * films meet come out as chains of the mesh's own edges, not as an
 * estimate beside it.
 *
 * A vertex sits in every 2x2x2 block of cells holding more than one label,
 * at first at the block's centre, which is a corner of the cell grid. Every
 * two neighbouring cells with different labels give a quad, joining the four
 * blocks round the edge between them; the quad is a piece of the film
 * between those two labels. The films are not a manifold: three meet along
 * every Plateau border. So there are no half-edges; each film is a patch of
 * its own, and the borders are the chains shared by three patches.
 *
 * A vertex is smoothed only towards the neighbours whose blocks hold every
 * label its own does. A vertex of a film (two labels) so moves towards all
 * its neighbours, one on a border (three) only along the border, and one
 * where four meet stays where it is, or follows its borders. Each stays
 * within its block, a little widened: the mesh is as near to the labels as
 * the voxels allow, but its films are smooth and its borders straight.
 */

/** Air and the glass are one: what is outside every bubble. */
export const OUTSIDE = 0;
const WALL = 0xffffffff;

/** A vertex may move this far from its block's centre on each axis, in cells. */
const REACH = 0.7;
/** Smoothing passes, and how far each moves a vertex to its neighbours' mean. */
const PASSES = 24;
const LAMBDA = 0.5;

export interface Patch {
  /** The two labels on its sides, a < b; its triangles face from a to b. */
  a: number;
  b: number;
}

export interface Border {
  /** Points along it, in field cells, from junction to junction; first equals last for a closed loop. */
  points: number[][];
  /** The mesh's vertices along it, the junctions left out. */
  vertices: number[];
  /** The three labels that meet along it, sorted. */
  labels: number[];
}

export interface Films {
  /** x, y, z of each vertex, in field cells (a cell k spans k to k+1). */
  positions: Float32Array;
  /** How many labels each vertex's block holds: 2 on a film, 3 on a border, more where borders meet. */
  kinds: Uint8Array;
  /** Three vertex ids a triangle, facing from its patch's a to its b. */
  triangles: Uint32Array;
  /** The patch of each triangle. */
  patchOf: Uint32Array;
  patches: Patch[];
  borders: Border[];
  /** Where four or more films' borders meet, in field cells. */
  corners: number[][];
}

/**
 * The films of the labels (n*n*n, x fastest). Cells outside the field count
 * as outside, so an open cluster is closed off by its skin.
 */
export function buildFilms(source: Uint32Array, n: number): Films {
  // Padded by one cell of outside on every side.
  const p = n + 2;
  const p2 = p * p;
  const labels = new Uint32Array(p * p2);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      const from = (z * n + y) * n;
      const to = ((z + 1) * p + y + 1) * p + 1;
      for (let x = 0; x < n; x++) {
        const l = source[from + x];
        labels[to + x] = l === WALL ? OUTSIDE : l;
      }
    }
  }

  // A vertex in every block with more than one label. Block (x, y, z) holds
  // the padded cells x..x+1 on each axis, so its centre is the field's
  // point (x, y, z).
  const b = p - 1;
  const b2 = b * b;
  const vertexOf = new Int32Array(b * b2).fill(-1);
  const positions: number[] = [];
  const kinds: number[] = [];
  /** Up to eight labels a vertex, unused ones OUTSIDE after the count. */
  const sets: number[] = [];
  const block = new Uint32Array(8);
  const seen: number[] = [];
  for (let z = 0; z < b; z++) {
    for (let y = 0; y < b; y++) {
      for (let x = 0; x < b; x++) {
        const i = (z * p + y) * p + x;
        block[0] = labels[i];
        block[1] = labels[i + 1];
        block[2] = labels[i + p];
        block[3] = labels[i + p + 1];
        block[4] = labels[i + p2];
        block[5] = labels[i + p2 + 1];
        block[6] = labels[i + p2 + p];
        block[7] = labels[i + p2 + p + 1];
        const first = block[0];
        let same = true;
        for (let k = 1; k < 8 && same; k++) same = block[k] === first;
        if (same) continue;
        seen.length = 0;
        for (let k = 0; k < 8; k++) if (!seen.includes(block[k])) seen.push(block[k]);
        seen.sort((u, v) => u - v);
        vertexOf[(z * b + y) * b + x] = kinds.length;
        positions.push(x, y, z);
        kinds.push(seen.length);
        for (let k = 0; k < 8; k++) sets.push(k < seen.length ? seen[k] : OUTSIDE);
      }
    }
  }

  // A quad round every edge between two cells of different labels, as two
  // triangles later; its patch by the two labels.
  const patchIndex = new Map<number, number>();
  const patches: Patch[] = [];
  const quads: number[] = [];
  const quadPatch: number[] = [];
  const step = [1, p, p2];
  for (let axis = 0; axis < 3; axis++) {
    // u and v follow the axis round, so u x v points along it.
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const c = [0, 0, 0];
    // Edges between two padding cells are skipped as alike, so the loops
    // can take in the field's own faces, against the padding.
    for (c[2] = 0; c[2] <= n; c[2]++) {
      for (c[1] = 0; c[1] <= n; c[1]++) {
        for (c[0] = 0; c[0] <= n; c[0]++) {
          const i = (c[2] * p + c[1]) * p + c[0];
          const here = labels[i];
          const there = labels[i + step[axis]];
          if (here === there) continue;
          const corner = (du: number, dv: number): number => {
            const q = [c[0], c[1], c[2]];
            q[u] += du;
            q[v] += dv;
            return vertexOf[(q[2] * b + q[1]) * b + q[0]];
          };
          const ring = [corner(-1, -1), corner(0, -1), corner(0, 0), corner(-1, 0)];
          // Facing from the lower label to the higher.
          if (here > there) ring.reverse();
          const lo = Math.min(here, there);
          const hi = Math.max(here, there);
          const key = lo * 4294967296 + hi;
          let patch = patchIndex.get(key);
          if (patch === undefined) {
            patch = patches.length;
            patchIndex.set(key, patch);
            patches.push({ a: lo, b: hi });
          }
          quads.push(...ring);
          quadPatch.push(patch);
        }
      }
    }
  }

  const count = kinds.length;
  const pos = new Float32Array(positions);
  const kindArray = new Uint8Array(kinds);
  const neighbours = edgesOf(quads, count);

  // The neighbours each vertex is smoothed towards: those holding all its
  // labels, or, where none do, the borders that run into a corner.
  const contains = (outer: number, inner: number): boolean => {
    for (let k = 0; k < kindArray[inner]; k++) {
      const l = sets[inner * 8 + k];
      let found = false;
      for (let m = 0; m < kindArray[outer] && !found; m++) found = sets[outer * 8 + m] === l;
      if (!found) return false;
    }
    return true;
  };
  const pullStart = new Uint32Array(count + 1);
  const pulls: number[] = [];
  for (let v = 0; v < count; v++) {
    pullStart[v] = pulls.length;
    const from = neighbours.start[v];
    const to = neighbours.start[v + 1];
    for (let k = from; k < to; k++) {
      const w = neighbours.list[k];
      if (contains(w, v)) pulls.push(w);
    }
    if (pulls.length === pullStart[v] && kindArray[v] > 3) {
      for (let k = from; k < to; k++) {
        const w = neighbours.list[k];
        if (kindArray[w] >= 3 && contains(v, w)) pulls.push(w);
      }
    }
  }
  pullStart[count] = pulls.length;

  const next = new Float32Array(pos.length);
  for (let pass = 0; pass < PASSES; pass++) {
    for (let v = 0; v < count; v++) {
      const from = pullStart[v];
      const to = pullStart[v + 1];
      for (let a = 0; a < 3; a++) {
        const here = pos[v * 3 + a];
        if (to === from) {
          next[v * 3 + a] = here;
          continue;
        }
        let sum = 0;
        for (let k = from; k < to; k++) sum += pos[pulls[k] * 3 + a];
        const moved = here + LAMBDA * (sum / (to - from) - here);
        const centre = positions[v * 3 + a];
        next[v * 3 + a] = Math.max(centre - REACH, Math.min(centre + REACH, moved));
      }
    }
    pos.set(next);
  }

  // Each quad as two triangles, cut along its shorter diagonal.
  const triangles = new Uint32Array((quads.length / 4) * 6);
  const patchOf = new Uint32Array((quads.length / 4) * 2);
  for (let q = 0; q < quads.length / 4; q++) {
    const [v0, v1, v2, v3] = quads.slice(q * 4, q * 4 + 4);
    const t = q * 6;
    if (distance2(pos, v0, v2) <= distance2(pos, v1, v3)) triangles.set([v0, v1, v2, v0, v2, v3], t);
    else triangles.set([v0, v1, v3, v1, v2, v3], t);
    patchOf[q * 2] = patchOf[q * 2 + 1] = quadPatch[q];
  }

  const { borders, corners } = bordersOf(neighbours, kindArray, sets, positions, labels, p, pos);
  return { positions: pos, kinds: kindArray, triangles, patchOf, patches, borders, corners };
}

/** The mesh's edges, each once, as a neighbour list per vertex. */
export function edgesOf(quads: number[], count: number): { start: Uint32Array; list: Uint32Array } {
  const degree = new Uint32Array(count + 1);
  const pairs = new Set<number>();
  const add = (a: number, b: number) => {
    const key = a < b ? a * count + b : b * count + a;
    if (pairs.has(key)) return;
    pairs.add(key);
    degree[a]++;
    degree[b]++;
  };
  for (let q = 0; q < quads.length; q += 4) {
    for (let k = 0; k < 4; k++) add(quads[q + k], quads[q + ((k + 1) % 4)]);
  }
  const start = new Uint32Array(count + 1);
  for (let v = 0; v < count; v++) start[v + 1] = start[v] + degree[v];
  const fill = start.slice(0, count);
  const list = new Uint32Array(start[count]);
  for (const key of pairs) {
    const a = Math.floor(key / count);
    const b = key - a * count;
    list[fill[a]++] = b;
    list[fill[b]++] = a;
  }
  return { start, list };
}

/**
 * The Plateau borders. Two vertices with a triple of labels in common are
 * linked if the four cells their blocks share hold all three: the border
 * passes through that square. In voxels a border is a staircase, sometimes
 * two blocks thick, so the links of one triple form a strip rather than a
 * chain; and where four films' borders meet, several neighbouring blocks
 * hold four labels. So those blocks are gathered into junctions, and a
 * border is the shortest path through its strip from one junction to the
 * other: a closed loop if it touches none.
 */
function bordersOf(
  neighbours: { start: Uint32Array; list: Uint32Array },
  kinds: Uint8Array,
  sets: number[],
  blocks: number[],
  labels: Uint32Array,
  p: number,
  pos: Float32Array,
): { borders: Border[]; corners: number[][] } {
  const count = kinds.length;
  const point = (v: number): number[] => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];

  // Junctions: neighbouring blocks of four labels or more, one union.
  const parent = new Int32Array(count).fill(-1);
  const root = (v: number): number => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]];
    return v;
  };
  for (let v = 0; v < count; v++) if (kinds[v] >= 4) parent[v] = v;
  for (let v = 0; v < count; v++) {
    if (kinds[v] < 4) continue;
    for (let k = neighbours.start[v]; k < neighbours.start[v + 1]; k++) {
      const w = neighbours.list[k];
      if (kinds[w] >= 4) parent[root(w)] = root(v);
    }
  }
  const junctionSums = new Map<number, number[]>();
  for (let v = 0; v < count; v++) {
    if (kinds[v] < 4) continue;
    const r = root(v);
    let sum = junctionSums.get(r);
    if (!sum) junctionSums.set(r, (sum = [0, 0, 0, 0]));
    sum[0] += pos[v * 3];
    sum[1] += pos[v * 3 + 1];
    sum[2] += pos[v * 3 + 2];
    sum[3]++;
  }
  const junctionAt = new Map<number, number[]>();
  for (const [r, sum] of junctionSums) junctionAt.set(r, [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]]);

  const tripleOf = (v: number): number[] => [sets[v * 8], sets[v * 8 + 1], sets[v * 8 + 2]];
  const holds = (w: number, triple: number[]): boolean =>
    triple.every((l) => {
      for (let m = 0; m < kinds[w]; m++) if (sets[w * 8 + m] === l) return true;
      return false;
    });
  // The four cells two neighbouring blocks share.
  const square: number[] = [0, 0, 0, 0];
  const shared = (v: number, w: number): number[] => {
    const lo = [0, 1, 2].map((a) => Math.min(blocks[v * 3 + a], blocks[w * 3 + a]));
    const axis = [0, 1, 2].find((a) => blocks[v * 3 + a] !== blocks[w * 3 + a])!;
    lo[axis] += 1;
    const u = (axis + 1) % 3;
    const t = (axis + 2) % 3;
    let k = 0;
    for (let du = 0; du < 2; du++) {
      for (let dt = 0; dt < 2; dt++) {
        const c = [lo[0], lo[1], lo[2]];
        c[u] += du;
        c[t] += dt;
        square[k++] = labels[(c[2] * p + c[1]) * p + c[0]];
      }
    }
    return square;
  };

  // The strips, by triple. A node is a vertex of three labels, or a
  // junction, as -1 - its root.
  const strips = new Map<string, Map<number, number[]>>();
  for (let v = 0; v < count; v++) {
    if (kinds[v] !== 3) continue;
    const triple = tripleOf(v);
    const key = triple.join(',');
    let strip = strips.get(key);
    if (!strip) strips.set(key, (strip = new Map()));
    const here = strip.get(v) ?? [];
    strip.set(v, here);
    for (let k = neighbours.start[v]; k < neighbours.start[v + 1]; k++) {
      const w = neighbours.list[k];
      if (kinds[w] < 3 || !holds(w, triple)) continue;
      const cells = shared(v, w);
      if (!triple.every((l) => cells.includes(l))) continue;
      const node = kinds[w] === 3 ? w : -1 - root(w);
      if (!here.includes(node)) here.push(node);
      if (node < 0) {
        const back = strip.get(node) ?? [];
        if (!back.includes(v)) back.push(v);
        strip.set(node, back);
      }
    }
  }

  const borders: Border[] = [];
  const at = (node: number): number[] => (node >= 0 ? point(node) : junctionAt.get(-1 - node)!);
  for (const [key, strip] of strips) {
    const triple = key.split(',').map(Number);
    const left = new Set(strip.keys());
    while (left.size > 0) {
      // One connected piece of the strip.
      const first = left.values().next().value!;
      const piece: number[] = [];
      const stack = [first];
      left.delete(first);
      while (stack.length > 0) {
        const node = stack.pop()!;
        piece.push(node);
        for (const next of strip.get(node) ?? []) {
          if (left.has(next)) {
            left.delete(next);
            stack.push(next);
          }
        }
      }
      const ends = piece.filter((node) => node < 0);
      const paths: number[][] = [];
      if (ends.length >= 2) {
        // From the first junction to each of the others, each path stopping
        // where it reaches one already drawn.
        const { from } = shortest(strip, ends[0], at);
        const drawn = new Set<number>([ends[0]]);
        for (const end of ends.slice(1)) {
          const path = [end];
          let node = end;
          while (!drawn.has(node) && from.has(node)) {
            node = from.get(node)!;
            path.push(node);
          }
          if (path.length > 1) paths.push(path);
          for (const n of path) drawn.add(n);
        }
      } else if (piece.length >= 3) {
        // Loose at one end, or a loop: out to the farthest node and back
        // round the other side.
        const start = ends.length === 1 ? ends[0] : piece[0];
        const out = shortest(strip, start, at);
        const far = farthest(out.dist);
        const path = trace(out.from, far);
        if (ends.length === 0) {
          const blocked = new Set(path.slice(1, -1));
          const back = shortest(strip, far, at, blocked);
          if (back.from.has(start) && path.length > 3) paths.push([...path, ...trace(back.from, start).reverse().slice(1)]);
          else paths.push(path);
        } else paths.push(path);
      }
      for (const path of paths) {
        if (path.length < 2) continue;
        borders.push({ points: path.map(at), vertices: path.filter((n) => n >= 0), labels: triple });
      }
    }
  }
  return { borders, corners: [...junctionAt.values()] };
}

/** Shortest paths through a strip from one node, by length, avoiding the blocked nodes. */
function shortest(
  strip: Map<number, number[]>,
  start: number,
  at: (node: number) => number[],
  blocked?: Set<number>,
): { dist: Map<number, number>; from: Map<number, number> } {
  const dist = new Map<number, number>([[start, 0]]);
  const from = new Map<number, number>();
  const heap = new MinHeap();
  const ids: number[] = [start];
  heap.push(0, 0);
  while (heap.size > 0) {
    const [i, d] = heap.pop();
    const node = ids[i];
    if (d > dist.get(node)!) continue;
    const here = at(node);
    for (const next of strip.get(node) ?? []) {
      if (blocked?.has(next)) continue;
      const there = at(next);
      const nd = d + Math.hypot(there[0] - here[0], there[1] - here[1], there[2] - here[2]);
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        from.set(next, node);
        ids.push(next);
        heap.push(ids.length - 1, nd);
      }
    }
  }
  return { dist, from };
}

function farthest(dist: Map<number, number>): number {
  let best = 0;
  let far = -Infinity;
  for (const [node, d] of dist) if (d > far) [far, best] = [d, node];
  return best;
}

/** The path back from a node to the start, start last. */
function trace(from: Map<number, number>, node: number): number[] {
  const path = [node];
  while (from.has(node)) path.push((node = from.get(node)!));
  return path;
}

function distance2(pos: Float32Array, a: number, b: number): number {
  const dx = pos[a * 3] - pos[b * 3];
  const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
  const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * How far each vertex is from the nearest border, over the films: the
 * shortest path along the mesh's edges first, then made straighter by
 * letting the distance cross triangles as a flat front would, a few sweeps.
 * The borders' vertices are at 0; a film is reached only through its own
 * border, so each film gets the distance within itself.
 */
export function distanceFromBorders(films: Films): Float64Array {
  const { positions: pos, kinds, triangles } = films;
  const count = kinds.length;
  const dist = new Float64Array(count).fill(Infinity);
  const quads: number[] = [];
  // The triangles' edges as a neighbour list.
  for (let t = 0; t < triangles.length; t += 3) quads.push(triangles[t], triangles[t + 1], triangles[t + 2], triangles[t]);
  const edges = edgesOf(quads, count);
  const heap = new MinHeap();
  for (let v = 0; v < count; v++) {
    if (kinds[v] >= 3) {
      dist[v] = 0;
      heap.push(v, 0);
    }
  }
  while (heap.size > 0) {
    const [v, d] = heap.pop();
    if (d > dist[v]) continue;
    for (let k = edges.start[v]; k < edges.start[v + 1]; k++) {
      const w = edges.list[k];
      const nd = d + Math.sqrt(distance2(pos, v, w));
      if (nd < dist[w]) {
        dist[w] = nd;
        heap.push(w, nd);
      }
    }
  }
  // A front crossing each triangle: the third corner's distance from the
  // line through the other two at their distances, where it falls inside.
  for (let sweep = 0; sweep < 6; sweep++) {
    for (let t = 0; t < triangles.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const c = triangles[t + k];
        if (kinds[c] >= 3) continue;
        const a = triangles[t + ((k + 1) % 3)];
        const bb = triangles[t + ((k + 2) % 3)];
        const d = frontAcross(pos, a, bb, c, dist[a], dist[bb]);
        if (d < dist[c]) dist[c] = d;
      }
    }
  }
  return dist;
}

/** The distance at c of a flat front that is at da at a and db at b. */
function frontAcross(pos: Float32Array, a: number, b: number, c: number, da: number, db: number): number {
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Infinity;
  const ab = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]];
  const ac = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]];
  const l = Math.hypot(ab[0], ab[1], ab[2]);
  if (l < 1e-6) return Infinity;
  const e = [ab[0] / l, ab[1] / l, ab[2] / l];
  // c in the plane of the triangle: x along ab, y across.
  const x = ac[0] * e[0] + ac[1] * e[1] + ac[2] * e[2];
  const y = Math.sqrt(Math.max(0, ac[0] ** 2 + ac[1] ** 2 + ac[2] ** 2 - x * x));
  const g = (db - da) / l;
  if (Math.abs(g) >= 1) return Infinity;
  // The front's normal makes da grow by g along ab and by sqrt(1 - g²) across.
  const across = Math.sqrt(1 - g * g);
  // Where the front's ray to c starts on ab must lie between a and b.
  const foot = x - (y * g) / across;
  if (foot < 0 || foot > l) return Infinity;
  return da + g * x + across * y;
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      ids[i] = ids[parent];
      keys[i] = keys[parent];
      i = parent;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): [number, number] {
    const ids = this.ids;
    const keys = this.keys;
    const top: [number, number] = [ids[0], keys[0]];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    if (ids.length > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= ids.length) break;
        const r = l + 1;
        const c = r < ids.length && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}
