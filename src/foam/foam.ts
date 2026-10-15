/** A cell that belongs to no bubble yet. */
export const AIR = 0;

/** The most bubbles a field hands out labels for. */
export const MAX_LABELS = 65535;

/**
 * How much a cell of air counts for against a cell of a bubble. Below one, so
 * a bubble takes a cell where it holds less than half of the neighbourhood:
 * that is the growth.
 */
export const AIR_WEIGHT = 0.6;

/** How hard a bubble away from its area pushes or gives way, with `keepArea`. */
const PRESSURE_GAIN = 4;
const PRESSURE_LIMIT = 0.5;
/**
 * Bubbles smaller than this many squared kernel radii push back more gently.
 * At full strength a small bubble overshoots: a few cells short, its whole
 * rim takes a cell at once and it ends up as far over, and the next step
 * back, so the foam flickers every other step. The cells a step moves go as
 * the rim, the square root of the area, so the push goes as it too.
 */
const GENTLE_BELOW = 50;

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
  /** Goes up whenever cells are changed from outside the rule. */
  edits = 0;
  /**
   * Radius of a round wall about the middle of the field, in cells, or zero
   * for none. Cells beyond it stay air and are not counted, as beyond the
   * edge of the field, so the foam grows only inside it.
   */
  fence = 0;

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
  /** Cells beyond the round wall, which are air but not air left to fill. */
  private fenced = 0;

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
    this.edits++;
    this.least.fill(0);
    this.measure();
  }

  /** Whether a cell lies inside the round wall, when there is one. */
  inside(x: number, y: number): boolean {
    if (!(this.fence > 0)) return true;
    return (x + 0.5 - this.w / 2) ** 2 + (y + 0.5 - this.h / 2) ** 2 <= this.fence * this.fence;
  }

  /**
   * Put up a round wall of this radius, or take it down with zero. Whatever
   * lies beyond a new wall turns to air. Taken down, the air beyond it is air
   * to fill again and the bubbles grow on out to the edges.
   */
  setFence(radius: number): void {
    this.fence = radius;
    const { w, h, label } = this;
    this.fenced = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (this.inside(x, y)) continue;
        label[y * w + x] = AIR;
        this.fenced++;
      }
    }
    this.measure();
    // A bubble cut by the wall holds on to what it has left.
    for (let l = 1; l <= this.labels; l++) this.least[l] = Math.min(this.least[l], this.area[l]);
    this.retarget();
    this.edits++;
  }

  /** Scatter centres of growth, kept apart from each other where there is room. */
  scatter(count: number, size: number): void {
    const room = this.fence > 0 ? Math.min(this.w * this.h, Math.PI * this.fence * this.fence) : this.w * this.h;
    const apart = Math.sqrt(room / Math.max(1, count)) * 0.6;
    const placed: number[][] = [];
    for (let c = 0; c < count; c++) {
      let x = 0;
      let y = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        // Clear of the walls, so that the centre starts as a whole disc.
        if (this.fence > 0) {
          const r = Math.sqrt(Math.random()) * Math.max(0, this.fence - size);
          const angle = Math.random() * 2 * Math.PI;
          x = Math.floor(this.w / 2 + r * Math.cos(angle));
          y = Math.floor(this.h / 2 + r * Math.sin(angle));
        } else {
          x = Math.floor(size + Math.random() * Math.max(1, this.w - 2 * size));
          y = Math.floor(size + Math.random() * Math.max(1, this.h - 2 * size));
        }
        if (placed.every((p) => Math.hypot(p[0] - x, p[1] - y) >= apart)) break;
      }
      placed.push([x, y]);
      this.seed(x, y, size);
    }
  }

  /** A new bubble: a disc with a label of its own, over whatever was there. */
  seed(cx: number, cy: number, size: number): void {
    const { w, h, label } = this;
    if (this.labels >= MAX_LABELS) return;
    const mine = ++this.labels;
    const r = Math.ceil(size);
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= size * size && this.inside(x, y)) label[y * w + x] = mine;
      }
    }
    this.measure();
    this.least[mine] = this.area[mine];
    this.retarget();
    this.edits++;
  }

  /**
   * A whole new field of labels, numbered from 1 to `count`. Every bubble
   * holds on to the area it has now, as if it had grown to it.
   */
  replace(label: Uint16Array, count: number): void {
    this.label.set(label);
    if (this.fence > 0) {
      for (let i = 0; i < label.length; i++) if (!this.inside(i % this.w, Math.floor(i / this.w))) this.label[i] = AIR;
    }
    this.labels = Math.min(count, MAX_LABELS);
    this.least.fill(0);
    this.measure();
    for (let l = 1; l <= this.labels; l++) this.least[l] = this.area[l];
    this.retarget();
    this.edits++;
  }

  /** Burst the bubble at a cell: its cells turn to air and the neighbours grow in. */
  pop(x: number, y: number): void {
    const gone = this.label[y * this.w + x];
    if (gone === AIR) return;
    for (let i = 0; i < this.label.length; i++) if (this.label[i] === gone) this.label[i] = AIR;
    this.measure();
    this.retarget();
    this.edits++;
  }

  step(p: FoamParams): void {
    const { w, h, label, next } = this;
    if (this.discRadius !== p.radius) this.buildDisc(p.radius);
    const disc = this.disc;
    const jitter = p.noise * (disc.length / 2);
    // The labels a cell may take are those in its 3x3 block, nine at most.
    const seen = new Uint16Array(9);
    const count = new Float64Array(9);
    const fence = this.fence > 0;
    const cx = w / 2 - 0.5;
    const cy = h / 2 - 0.5;
    const reach = this.fence * this.fence;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const here = label[i];
        // Beyond the round wall nothing changes.
        if (fence && (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > reach) {
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
            if (fence && (nx - cx) ** 2 + (ny - cy) ** 2 > reach) continue;
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
          if (fence && (nx - cx) ** 2 + (ny - cy) ** 2 > reach) continue;
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
          const score = count[k] * this.weightOf(kind, p) + jitter * (Math.random() - 0.5);
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
    this.stepped(1);
  }

  /** Take up the labels after steps made elsewhere, on the GPU. */
  adopt(label: Uint32Array, steps: number): void {
    this.label.set(label);
    this.stepped(steps);
  }

  /**
   * How much a cell of this label counts for: air less, a bubble off its
   * area more or less. `lag` is the steps the weight is kept for before it is
   * worked out again; a weight kept longer pushes for longer and has to be
   * the gentler.
   */
  weightOf(kind: number, p: FoamParams, lag = 1): number {
    if (kind === AIR) return AIR_WEIGHT;
    // While there is air a bubble only defends the area it started with.
    const hold = this.air === 0 ? this.target[kind] : this.least[kind];
    if (!p.keepArea || !(hold > 0)) return 1;
    const gentle = Math.min(1, Math.sqrt(hold / (GENTLE_BELOW * p.radius * p.radius)) / lag);
    let lack = (gentle * PRESSURE_GAIN * (hold - this.area[kind])) / hold;
    if (this.air > 0) lack = Math.max(0, lack);
    return 1 + Math.max(-PRESSURE_LIMIT, Math.min(PRESSURE_LIMIT, lack));
  }

  /** Labels handed out so far, so the largest label in use. */
  get labelCount(): number {
    return this.labels;
  }

  private stepped(steps: number): void {
    this.steps += steps;
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

  /**
   * A film ruptures and its two bubbles become one. The film is found by
   * picking cells at random until one lies on a film between two bubbles, so
   * a longer film is the likelier to go. The larger bubble takes in the other
   * and keeps the area of both. Returns false when no film was found.
   */
  burstFilm(): boolean {
    const { w, h, label } = this;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const x = Math.floor(Math.random() * (w - 1));
      const y = Math.floor(Math.random() * (h - 1));
      const i = y * w + x;
      const a = label[i];
      const b = Math.random() < 0.5 ? label[i + 1] : label[i + w];
      if (a === b || a === AIR || b === AIR) continue;
      const [keep, gone] = this.area[a] >= this.area[b] ? [a, b] : [b, a];
      for (let j = 0; j < label.length; j++) if (label[j] === gone) label[j] = keep;
      this.least[keep] += this.least[gone];
      this.measure();
      this.retarget();
      this.edits++;
      return true;
    }
    return false;
  }

  /** A bubble chosen at random bursts, as one clicked on does. */
  popAny(): boolean {
    if (this.air > 0 || this.bubbles === 0) return false;
    const i = Math.floor(Math.random() * this.label.length);
    this.pop(i % this.w, Math.floor(i / this.w));
    return true;
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
    this.air = area[AIR] - (this.fence > 0 ? this.fenced : 0);
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
