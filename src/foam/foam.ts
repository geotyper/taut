/** A cell that belongs to no bubble yet. */
export const AIR = 0;

/**
 * How much a cell of air counts for against a cell of a bubble. Below one, so
 * a bubble takes a cell where it holds less than half of the neighbourhood:
 * that is the growth.
 */
const AIR_WEIGHT = 0.6;

/** How hard a bubble away from its area pushes or gives way, with `keepArea`. */
const PRESSURE_GAIN = 4;
const PRESSURE_LIMIT = 0.5;

export interface FoamParams {
  /** Radius of the neighbourhood a cell counts labels in, in cells. */
  radius: number;
  /** Random part of every count, as a share of the neighbourhood. */
  noise: number;
  /**
   * Bubbles hold on to the area they had when the field filled up, as if the
   * gas could not leave them. Without it small bubbles shrink and vanish.
   */
  keepArea: boolean;
}

/**
 * Soap films on a cellular automaton. The state of a cell is a label: the
 * bubble it belongs to, or air. Bubbles grow from their centres until they
 * meet, and the borders between them are the films.
 *
 * One rule does both, applied by every cell at once: a cell counts the labels
 * in a disc around it and takes the one with the highest count, air counting
 * for less. Between two bubbles this is threshold dynamics with many phases
 * (Merriman, Bence and Osher): a film moves towards its centre of curvature,
 * and three films meet at equal angles.
 */
export class Foam {
  readonly w: number;
  readonly h: number;
  label: Uint16Array;
  steps = 0;
  /** Cells of air left. */
  air = 0;
  /** Bubbles with at least one cell. */
  bubbles = 0;

  private next: Uint16Array;
  /** Labels handed out so far; label 0 is air. */
  private labels = 0;
  private area = new Float64Array(1);
  /** The area each bubble holds on to; zero while there is still air. */
  private target = new Float64Array(1);
  /** The area a bubble started with: it holds on to that much while it grows. */
  private least = new Float64Array(1);
  private disc: Int8Array = new Int8Array(0);
  private discRadius = -1;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.label = new Uint16Array(w * h);
    this.next = new Uint16Array(w * h);
    this.clear();
  }

  clear(): void {
    this.label.fill(AIR);
    this.labels = 0;
    this.steps = 0;
    this.least.fill(0);
    this.measure();
  }

  /** Scatter centres of growth, kept apart from each other where there is room. */
  scatter(count: number, size: number): void {
    const apart = Math.sqrt((this.w * this.h) / Math.max(1, count)) * 0.6;
    const placed: number[][] = [];
    for (let c = 0; c < count; c++) {
      let x = 0;
      let y = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        // Clear of the walls, so that the centre starts as a whole disc.
        x = Math.floor(size + Math.random() * Math.max(1, this.w - 2 * size));
        y = Math.floor(size + Math.random() * Math.max(1, this.h - 2 * size));
        if (placed.every((p) => Math.hypot(p[0] - x, p[1] - y) >= apart)) break;
      }
      placed.push([x, y]);
      this.seed(x, y, size);
    }
  }

  /** A new bubble: a disc with a label of its own, over whatever was there. */
  seed(cx: number, cy: number, size: number): void {
    const { w, h, label } = this;
    if (this.labels >= 65535) return;
    const mine = ++this.labels;
    const r = Math.ceil(size);
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= size * size) label[y * w + x] = mine;
      }
    }
    this.measure();
    this.least[mine] = this.area[mine];
    this.retarget();
  }

  /** Burst the bubble at a cell: its cells turn to air and the neighbours grow in. */
  pop(x: number, y: number): void {
    const gone = this.label[y * this.w + x];
    if (gone === AIR) return;
    for (let i = 0; i < this.label.length; i++) if (this.label[i] === gone) this.label[i] = AIR;
    this.measure();
    this.retarget();
  }

  step(p: FoamParams): void {
    const { w, h, label, next, area, target, least } = this;
    if (this.discRadius !== p.radius) this.buildDisc(p.radius);
    const disc = this.disc;
    const jitter = p.noise * (disc.length / 2);
    // While there is air a bubble only defends the area it started with.
    const hold = this.air === 0 ? target : this.least;
    // The labels a cell may take are those in its 3x3 block, nine at most.
    const seen = new Uint16Array(9);
    const count = new Float64Array(9);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const here = label[i];
        let kinds = 1;
        seen[0] = here;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const other = label[ny * w + nx];
            let k = 0;
            while (k < kinds && seen[k] !== other) k++;
            if (k === kinds) seen[kinds++] = other;
          }
        }
        // A cell whose neighbours all agree with it stays as it is.
        if (kinds === 1) {
          next[i] = here;
          continue;
        }

        count.fill(0, 0, kinds);
        for (let d = 0; d < disc.length; d += 2) {
          const nx = x + disc[d];
          const ny = y + disc[d + 1];
          // Beyond the wall nothing is counted, so films meet it squarely.
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
          const kind = seen[k];
          let weight = 1;
          if (kind === AIR) weight = AIR_WEIGHT;
          else if (p.keepArea && hold[kind] > 0) {
            let lack = (PRESSURE_GAIN * (hold[kind] - area[kind])) / hold[kind];
            if (hold === least) lack = Math.max(0, lack);
            weight = 1 + Math.max(-PRESSURE_LIMIT, Math.min(PRESSURE_LIMIT, lack));
          }
          const score = count[k] * weight + jitter * (Math.random() - 0.5);
          if (score > bestScore) {
            bestScore = score;
            best = kind;
          }
        }
        next[i] = best;
      }
    }

    this.label = next;
    this.next = label;
    this.steps++;
    const hadAir = this.air > 0;
    this.measure();
    // The moment the field fills up, every bubble takes its area as its own.
    if (hadAir && this.air === 0) this.retarget();
  }

  /** Length of all films, in cell edges between unlike cells. */
  filmLength(): number {
    const { w, h, label } = this;
    let length = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const here = label[y * w + x];
        if (x + 1 < w && label[y * w + x + 1] !== here) length++;
        if (y + 1 < h && label[(y + 1) * w + x] !== here) length++;
      }
    }
    return length;
  }

  /** Cells of a bubble, by its label. */
  areaOf(label: number): number {
    return this.area[label] ?? 0;
  }

  private measure(): void {
    if (this.area.length <= this.labels) {
      const area = new Float64Array(this.labels * 2 + 2);
      const target = new Float64Array(area.length);
      const least = new Float64Array(area.length);
      target.set(this.target);
      least.set(this.least);
      this.area = area;
      this.target = target;
      this.least = least;
    }
    const { area, label } = this;
    area.fill(0);
    for (let i = 0; i < label.length; i++) area[label[i]]++;
    this.air = area[AIR];
    this.bubbles = 0;
    for (let l = 1; l <= this.labels; l++) if (area[l] > 0) this.bubbles++;
  }

  private retarget(): void {
    const { area, target, least } = this;
    if (this.air > 0) target.fill(0);
    else for (let l = 0; l < area.length; l++) target[l] = Math.max(area[l], least[l]);
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
