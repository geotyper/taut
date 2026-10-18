import { WALL } from '../foam/lines.ts';

/** No cell: the medium round a colony. */
export const MEDIUM = 0;

/** How hard a cell away from its area pushes or gives way, as in the foam. */
const PRESSURE_GAIN = 4;
const PRESSURE_LIMIT = 0.5;
/** Cells smaller than this many squared kernel radii push more gently, as in the foam. */
const GENTLE_BELOW = 50;
/** How hard a cell pushes back once squeezed below its least area, with that option on. */
const FLOOR_PUSH = 1.5;
/**
 * A cell rounder than this, its long axis over its short one, has no long
 * axis to speak of and divides in a direction at random. A round egg would
 * otherwise take the axis its pixels happen to favour, along the lattice,
 * and films along the lattice are held there.
 */
const ROUND = 1.05;
/** The two daughters' colours part by this much round the hues, less with every generation. */
const TINT_PART = 0.2;
/** A growing cell divides at twice the area it was born with, give or take this share. */
const DIVIDE_SPREAD = 0.15;
/**
 * A cell pressed by its neighbours to less than this share of the area it
 * holds to stops growing until it has room again: contact inhibition.
 */
const SQUEEZED = 0.85;
/**
 * The cells together hold to no more than this share of the field inside
 * the margin: past it there is no room, they would only crush each other.
 */
const ROOM = 0.97;

export interface TissueParams {
  /** Radius of the disc a pixel counts labels in, in pixels. */
  radius: number;
  /** Random part of every count, as a share of the disc. */
  noise: number;
  /**
   * How many times the tension of a film is when an outer cell is on
   * either side of it: one, and the outer cells are as the inner.
   */
  stiffer: number;
  /**
   * The least share of the area it was born with that a cell lets itself
   * be squeezed to; below it, the cell pushes back hard. Zero, no least area.
   */
  least: number;
}

/**
 * What a cell is to become, as an early embryo's cells are told apart by
 * where they are (the inside-outside model): a cell born on the shell, or on
 * the medium, is outer, one born with cells all round is inner. Inner cells
 * have only inner daughters; an outer cell's daughters are told apart again.
 */
export const INNER = 1;
export const OUTER = 2;

/** Where a cell divides. */
export type Plane = 'long' | 'random';

/**
 * Cells as the bubbles of a 2D foam: each pixel holds the label of a cell,
 * or the medium, and takes the label with the most pixels in a disc round
 * it, every cell weighted by how far it is off the area it holds to (the
 * rule of src/foam/foam.ts). The films between cells pull taut, three meet
 * at 120°, and a cell keeps its area as a bubble keeps its gas. On top of
 * that a cell can grow, its area held to more and more, and divide: a
 * straight line through its middle gives half of it a label of its own and
 * both halves hold to half the area. The rule then pulls the new film and
 * its neighbours taut.
 *
 * Pixels beyond the shell, a round wall, are WALL: fixed and not counted,
 * so films meet it at right angles.
 */
export class Tissue {
  readonly w: number;
  readonly h: number;
  label: Uint16Array;
  steps = 0;
  /** Cells with at least one pixel. */
  cells = 0;
  /** Divisions so far. */
  divisions = 0;
  /** Whether a tissue grown to fill the field has filled it. */
  full = false;

  private next: Uint16Array;
  private labels = 0;
  private area = new Float64Array(2);
  /** The area each cell holds to. */
  private target = new Float64Array(2);
  /** The area each cell held to when it was born. */
  private born = new Float64Array(2);
  /** The area it holds to when it divides next, with a growing tissue. */
  private divideAt = new Float64Array(2);
  /** Divisions from the egg or the first cell. */
  private generation = new Uint8Array(2);
  /** INNER or OUTER, by label; 0 for the medium. */
  private fate = new Uint8Array(2);
  /** A colour per cell, inherited with a little drift, so a clone shows as a patch. */
  private tint = new Float32Array(2);
  private disc = new Int8Array(0);
  private discRadius = -1;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.label = new Uint16Array(w * h);
    this.next = new Uint16Array(w * h);
  }

  /** One cell, an egg filling a round shell of this radius. */
  egg(shell: number): void {
    const { w, h, label } = this;
    this.reset();
    const mine = this.newLabel(0, Math.random());
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        label[y * w + x] = (x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2 <= shell * shell ? mine : WALL;
      }
    }
    this.measure();
    this.target[mine] = this.area[mine];
    this.born[mine] = this.area[mine];
    this.divideAt[mine] = Infinity;
    this.fate[mine] = OUTER;
  }

  /** One cell of this radius in the middle of the medium, to grow from. */
  seed(radius: number): void {
    const { w, h, label } = this;
    this.reset();
    const mine = this.newLabel(0, Math.random());
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        label[y * w + x] = (x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2 <= radius * radius ? mine : MEDIUM;
      }
    }
    this.measure();
    this.target[mine] = this.area[mine];
    this.born[mine] = this.area[mine];
    this.divideAt[mine] = this.spread(2 * this.area[mine]);
    this.fate[mine] = OUTER;
  }

  step(p: TissueParams): void {
    const { w, h, label, next } = this;
    if (this.discRadius !== p.radius) this.buildDisc(p.radius);
    const disc = this.disc;
    const jitter = p.noise * (disc.length / 2);
    const weight = this.weights(p);
    const fate = this.fate;
    // Every film costs one, and more with an outer cell on it: a pixel takes the label of least cost (Esedoglu and Otto).
    const extra = p.stiffer - 1;
    const seen = new Uint16Array(9);
    const count = new Float64Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const here = label[i];
        if (here === WALL) {
          next[i] = here;
          continue;
        }
        let kinds = 1;
        seen[0] = here;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const other = label[ny * w + nx];
            if (other === WALL) continue;
            let k = 0;
            while (k < kinds && seen[k] !== other) k++;
            if (k === kinds) seen[kinds++] = other;
          }
        }
        if (kinds === 1) {
          next[i] = here;
          continue;
        }
        count.fill(0, 0, kinds);
        for (let d = 0; d < disc.length; d += 2) {
          const nx = x + disc[d];
          const ny = y + disc[d + 1];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const other = label[ny * w + nx];
          for (let k = 0; k < kinds; k++) {
            if (seen[k] === other) {
              count[k]++;
              break;
            }
          }
        }
        let best = here;
        let bestScore = -Infinity;
        for (let k = 0; k < kinds; k++) {
          let score = count[k] * weight[seen[k]] + jitter * (Math.random() - 0.5);
          if (extra !== 0) {
            const outer = fate[seen[k]] === OUTER;
            for (let j = 0; j < kinds; j++) if (j !== k && (outer || fate[seen[j]] === OUTER)) score -= extra * count[j];
          }
          if (score > bestScore) {
            bestScore = score;
            best = seen[k];
          }
        }
        next[i] = best;
      }
    }
    this.label = next;
    this.next = label;
    this.steps++;
    this.measure();
  }

  /**
   * Every cell grows: the area it holds to doubles in this many steps. A
   * cell that has grown to what it divides at divides. A cell stops
   * growing while it is within `margin` pixels of the field's edge, or
   * squeezed by its neighbours; the rest of the colony grows on, until
   * the field is full. With `fill`, the cells grow up to the field's edge
   * and into its corners, until no medium is left.
   */
  grow(doubling: number, plane: Plane, margin: number, fill = false): void {
    let held = 0;
    for (let l = 1; l <= this.labels; l++) if (this.area[l] > 0) held += this.target[l];
    if (fill && this.area[MEDIUM] === 0) {
      // Full: once, every cell settles for the area it has, so none crushes another.
      if (!this.full) for (let l = 1; l <= this.labels; l++) if (this.area[l] > 0) this.target[l] = this.area[l];
      this.full = true;
      return;
    }
    if (!fill && held >= ROOM * (this.w - 2 * margin) * (this.h - 2 * margin)) return;
    const edge = this.atEdge(fill ? 0 : margin);
    const factor = 2 ** (1 / doubling);
    const due: number[] = [];
    for (let l = 1; l <= this.labels; l++) {
      if (!(this.area[l] > 0) || edge[l] || this.area[l] < SQUEEZED * this.target[l]) continue;
      this.target[l] *= factor;
      if (this.target[l] >= this.divideAt[l]) due.push(l);
    }
    if (due.length > 0) this.divide(due, plane);
  }

  /** Every cell divides at once, as in the cleavage of an egg. */
  divideAll(plane: Plane): void {
    const all: number[] = [];
    for (let l = 1; l <= this.labels; l++) if (this.area[l] > 0) all.push(l);
    this.divide(all, plane);
  }

  /** The cell at a pixel divides. */
  divideCell(x: number, y: number, plane: Plane): void {
    const l = this.label[y * this.w + x];
    if (l !== MEDIUM && l !== WALL) this.divide([l], plane);
  }

  /** The cell at a pixel dies and shrinks away; its neighbours, or the medium, close over it. */
  remove(x: number, y: number): void {
    const l = this.label[y * this.w + x];
    if (l === MEDIUM || l === WALL) return;
    this.target[l] = 0;
    this.divideAt[l] = Infinity;
  }

  /**
   * The cells listed divide, each by a straight line through its centre of
   * area: across its longest axis (Hertwig's rule, as most cells do), or in
   * a direction at random. The pixels on one side take a new label.
   */
  divide(cells: number[], plane: Plane): void {
    const { w, h, label } = this;
    const n = this.labels + 1;
    const m = new Float64Array(n * 6);
    const listed = new Uint8Array(n);
    for (const l of cells) listed[l] = 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = label[y * w + x];
        if (l >= n || !listed[l]) continue;
        const o = l * 6;
        m[o]++;
        m[o + 1] += x;
        m[o + 2] += y;
        m[o + 3] += x * x;
        m[o + 4] += y * y;
        m[o + 5] += x * y;
      }
    }
    // For each cell, its centre, the normal of the dividing line, and its daughter's label.
    const split = new Float64Array(n * 4);
    const daughter = new Uint16Array(n);
    for (const l of cells) {
      const o = l * 6;
      const count = m[o];
      if (count < 2 || this.labels + 1 >= WALL) continue;
      const cx = m[o + 1] / count;
      const cy = m[o + 2] / count;
      const xx = m[o + 3] / count - cx * cx;
      const yy = m[o + 4] / count - cy * cy;
      const xy = m[o + 5] / count - cx * cy;
      // The long axis is the normal of the line: the cell is cut across it.
      const spread = Math.hypot(xx - yy, 2 * xy);
      const elongation = Math.sqrt((xx + yy + spread) / Math.max(1e-9, xx + yy - spread));
      const angle = plane === 'long' && elongation > ROUND ? 0.5 * Math.atan2(2 * xy, xx - yy) : Math.random() * Math.PI;
      split.set([cx, cy, Math.cos(angle), Math.sin(angle)], l * 4);
      const half = this.target[l] / 2;
      const part = TINT_PART / (1 + this.generation[l]);
      const child = this.newLabel(this.generation[l] + 1, this.tint[l] + part);
      this.generation[l]++;
      this.tint[l] -= part;
      daughter[l] = child;
      this.fate[child] = this.fate[l];
      this.target[l] = half;
      this.target[child] = half;
      this.born[l] = half;
      this.born[child] = half;
      // In a shell nothing grows, so nothing divides of itself.
      const grows = Number.isFinite(this.divideAt[l]);
      this.divideAt[l] = grows ? this.spread(2 * half) : Infinity;
      this.divideAt[child] = grows ? this.spread(2 * half) : Infinity;
      this.divisions++;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = label[i];
        if (l >= n || !daughter[l]) continue;
        const o = l * 4;
        if ((x - split[o]) * split[o + 2] + (y - split[o + 1]) * split[o + 3] > 0) label[i] = daughter[l];
      }
    }
    this.measure();
    // The daughters of an outer cell: outer if they touch the shell or the medium, inner if not.
    const parted = new Uint8Array(this.labels + 1);
    for (let l = 1; l < n; l++) {
      if (!daughter[l] || this.fate[l] !== OUTER) continue;
      parted[l] = 1;
      parted[daughter[l]] = 1;
    }
    const open = new Uint8Array(this.labels + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = label[y * w + x];
        if (l === WALL || !parted[l] || open[l]) continue;
        const by = (nx: number, ny: number) => nx >= 0 && nx < w && ny >= 0 && ny < h && (label[ny * w + nx] === WALL || label[ny * w + nx] === MEDIUM);
        if (by(x - 1, y) || by(x + 1, y) || by(x, y - 1) || by(x, y + 1)) open[l] = 1;
      }
    }
    for (let l = 1; l <= this.labels; l++) if (parted[l]) this.fate[l] = open[l] ? OUTER : INNER;
  }

  fateOf(l: number): number {
    return this.fate[l] ?? 0;
  }

  /** Cells of either fate. */
  get fates(): { inner: number; outer: number } {
    let inner = 0;
    let outer = 0;
    for (let l = 1; l <= this.labels; l++) {
      if (!(this.area[l] > 0)) continue;
      if (this.fate[l] === INNER) inner++;
      else outer++;
    }
    return { inner, outer };
  }

  generationOf(l: number): number {
    return this.generation[l] ?? 0;
  }

  /** The cell's colour, from 0 to 1 round the hues. */
  tintOf(l: number): number {
    return this.tint[l] ?? 0;
  }

  areaOf(l: number): number {
    return this.area[l] ?? 0;
  }

  /** The largest label handed out. */
  get labelCount(): number {
    return this.labels;
  }

  /** The greatest number of divisions from the first cell among the cells there are. */
  get deepest(): number {
    let most = 0;
    for (let l = 1; l <= this.labels; l++) if (this.area[l] > 0) most = Math.max(most, this.generation[l]);
    return most;
  }

  /** Which cells have come within `margin` pixels of the field's edge. */
  atEdge(margin: number): Uint8Array {
    const { w, h, label } = this;
    const near = new Uint8Array(this.labels + 1);
    for (let y = 0; y < h; y++) {
      const edge = y < margin || y >= h - margin;
      for (let x = 0; x < w; x++) {
        if (!edge && x === margin) x = w - margin;
        const l = label[y * w + x];
        if (l !== MEDIUM && l !== WALL) near[l] = 1;
      }
    }
    return near;
  }

  /** One for the medium; a cell weighted by how far it is off the area it holds to. */
  private weights(p: TissueParams): Float32Array {
    const weight = new Float32Array(this.labels + 1).fill(1);
    for (let l = 1; l <= this.labels; l++) {
      const hold = this.target[l];
      if (!(this.area[l] > 0)) continue;
      // A dying cell gives way all it can.
      if (!(hold > 0)) {
        weight[l] = 1 - PRESSURE_LIMIT;
        continue;
      }
      if (this.area[l] < p.least * this.born[l]) {
        weight[l] = 1 + FLOOR_PUSH;
        continue;
      }
      const gentle = Math.min(1, Math.sqrt(hold / (GENTLE_BELOW * p.radius * p.radius)));
      const lack = (gentle * PRESSURE_GAIN * (hold - this.area[l])) / hold;
      weight[l] = 1 + Math.max(-PRESSURE_LIMIT, Math.min(PRESSURE_LIMIT, lack));
    }
    return weight;
  }

  private spread(area: number): number {
    return area * (1 + DIVIDE_SPREAD * (2 * Math.random() - 1));
  }

  private reset(): void {
    this.labels = 0;
    this.steps = 0;
    this.full = false;
    this.divisions = 0;
    this.area = new Float64Array(64);
    this.target = new Float64Array(64);
    this.born = new Float64Array(64);
    this.divideAt = new Float64Array(64);
    this.generation = new Uint8Array(64);
    this.fate = new Uint8Array(64);
    this.tint = new Float32Array(64);
  }

  private newLabel(generation: number, tint: number): number {
    const mine = ++this.labels;
    if (mine >= this.area.length) {
      const grow = <T extends Float64Array | Float32Array | Uint8Array>(a: T, make: (n: number) => T): T => {
        const b = make(a.length * 2);
        b.set(a);
        return b;
      };
      this.area = grow(this.area, (n) => new Float64Array(n));
      this.target = grow(this.target, (n) => new Float64Array(n));
      this.born = grow(this.born, (n) => new Float64Array(n));
      this.divideAt = grow(this.divideAt, (n) => new Float64Array(n));
      this.generation = grow(this.generation, (n) => new Uint8Array(n));
      this.fate = grow(this.fate, (n) => new Uint8Array(n));
      this.tint = grow(this.tint, (n) => new Float32Array(n));
    }
    this.generation[mine] = generation;
    this.tint[mine] = tint;
    return mine;
  }

  private measure(): void {
    const { area, label } = this;
    area.fill(0);
    for (let i = 0; i < label.length; i++) {
      const l = label[i];
      if (l !== WALL) area[l]++;
    }
    this.cells = 0;
    for (let l = 1; l <= this.labels; l++) if (area[l] > 0) this.cells++;
  }

  private buildDisc(radius: number): void {
    const offsets: number[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy <= radius * radius + radius) offsets.push(dx, dy);
      }
    }
    this.disc = Int8Array.from(offsets);
    this.discRadius = radius;
  }
}
