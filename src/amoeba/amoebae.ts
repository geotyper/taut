/** No amoeba: the water they crawl in, where the food lies. */
export const MEDIUM = 0;

/** How hard an amoeba away from its area pushes or gives way, as the cells do. */
const PRESSURE_GAIN = 4;
const PRESSURE_LIMIT = 0.5;
/** Spread of the smell per substep; under a quarter, or the sums run away. */
const SMELL_SPREAD = 0.2;
/** Substeps of the smell for every step of the amoebae. */
const SMELL_SUBSTEPS = 4;
/** What food gives off, per unit and substep. */
const SMELL_GIVEN = 0.05;
/** Below this, there is nothing to smell. */
const SMELL_FLOOR = 1e-12;
/** How far a crumb reaches, in pixels. */
const CRUMB_RADIUS = 2.5;
/** An amoeba this share of its newborn area, or less, has starved and dies. */
const STARVED = 0.35;
/** A newborn amoeba's radius, in pixels. */
const BORN_RADIUS = 14;
/** How fast the way a blind amoeba reaches turns, in radians per step, as a random walk. */
const WANDER = 0.04;
/** The two daughters' colours part by this much round the hues. */
const TINT_PART = 0.08;

/** How an amoeba finds its food: by the smell of it, or blind, reaching out at random until it touches some. */
export type Sense = 'smell' | 'blind';

export interface AmoebaParams {
  /** Radius of the disc a pixel counts labels in, in pixels. */
  radius: number;
  /** Random part of every count, as a share of the disc. */
  noise: number;
  sense: Sense;
  /** How hard an amoeba's edge reaches out, to the smell or to where it wanders. */
  pull: number;
  /** How far the smell of food carries, in pixels. */
  carries: number;
  /** What a crumb is worth, as a share of a newborn amoeba's area. */
  feeds: number;
  /** Steps a newborn amoeba lives with nothing to eat. */
  starves: number;
}

/**
 * Amoebae as the bubbles of a 2D foam, on the rule of src/cells/tissue.ts:
 * each pixel takes the label with the most pixels in a disc round it, every
 * amoeba weighted by how far it is off the area it holds to, so its skin
 * pulls taut and it keeps its area. On top of that, the edge reaches out:
 * with `smell`, a pixel counts for an amoeba more where the food smells
 * stronger than on the rest of its edge, so it puts out a pseudopod that
 * way and draws in its back; blind, it reaches the way it wanders.
 *
 * Food lies in the water as crumbs. An amoeba over food eats it, and what
 * it eats is area to hold to; living burns it away. At twice its newborn
 * area it divides, across its long axis; starved down to a third, it dies.
 * Amoebae do not eat each other: between two there is a film, and they push.
 */
export class Amoebae {
  readonly w: number;
  readonly h: number;
  label: Uint16Array;
  /** Food on every pixel, in units of a crumb's worth over its pixels. */
  readonly food: Float32Array;
  /** The smell of the food, given off where it lies and spreading. */
  smell: Float32Array;
  steps = 0;
  divisions = 0;
  deaths = 0;
  /** Amoebae alive. */
  count = 0;
  /** Crumbs at the start, and food eaten so far, in crumbs. */
  crumbs = 0;
  eaten = 0;

  private next: Uint16Array;
  private smellNext: Float32Array;
  private labels = 0;
  private area = new Float64Array(2);
  private target = new Float64Array(2);
  private born = new Float64Array(2);
  private tint = new Float32Array(2);
  /** The way a blind amoeba reaches. */
  private heading = new Float64Array(2);
  /** Centre of every amoeba, x and y, and the mean log smell on its edge. */
  private centre = new Float64Array(4);
  private edgeSmell = new Float64Array(2);
  private disc = new Int8Array(0);
  private discRadius = -1;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.label = new Uint16Array(w * h);
    this.next = new Uint16Array(w * h);
    this.food = new Float32Array(w * h);
    this.smell = new Float32Array(w * h);
    this.smellNext = new Float32Array(w * h);
  }

  /** One amoeba in the middle, and crumbs scattered round it. */
  start(crumbs: number): void {
    const { w, h, label, food } = this;
    this.reset();
    label.fill(MEDIUM);
    food.fill(0);
    this.smell.fill(0);
    const mine = this.newLabel(Math.random());
    const r = BORN_RADIUS;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2 <= r * r) label[y * w + x] = mine;
      }
    }
    // A crumb is a small disc; its food is shared over its pixels, so every crumb is worth one.
    const offsets: number[] = [];
    const reach = Math.ceil(CRUMB_RADIUS);
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) if (dx * dx + dy * dy <= CRUMB_RADIUS ** 2) offsets.push(dx, dy);
    const share = 2 / offsets.length;
    const clear = (BORN_RADIUS + 6) ** 2;
    let laid = 0;
    for (let tries = 0; laid < crumbs && tries < crumbs * 20; tries++) {
      const cx = reach + Math.floor(Math.random() * (w - 2 * reach));
      const cy = reach + Math.floor(Math.random() * (h - 2 * reach));
      if ((cx - w / 2) ** 2 + (cy - h / 2) ** 2 < clear) continue;
      for (let d = 0; d < offsets.length; d += 2) food[(cy + offsets[d + 1]) * w + cx + offsets[d]] += share;
      laid++;
    }
    this.crumbs = laid;
    this.measure();
    this.target[mine] = this.area[mine];
    this.born[mine] = this.area[mine];
  }

  step(p: AmoebaParams): void {
    this.spreadSmell(p.carries);
    this.feed(p);
    this.look();
    const { w, h, label, next, smell } = this;
    if (this.discRadius !== p.radius) this.buildDisc(p.radius);
    const disc = this.disc;
    const half = disc.length / 2;
    const jitter = p.noise * half;
    const weight = this.weights();
    const reach = p.pull * half;
    const blind = p.sense === 'blind';
    const { centre, edgeSmell, heading } = this;
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
        const scent = Math.log(smell[i] + SMELL_FLOOR);
        let best = here;
        let bestScore = -Infinity;
        for (let k = 0; k < kinds; k++) {
          const l = seen[k];
          let score = count[k] * weight[l] + jitter * (Math.random() - 0.5);
          if (l !== MEDIUM && reach !== 0) {
            // Out where it smells more than the rest of the edge, or the way it wanders.
            let lean: number;
            if (blind) {
              const dx = x - centre[l * 2];
              const dy = y - centre[l * 2 + 1];
              const r = Math.hypot(dx, dy) || 1;
              lean = (dx * Math.cos(heading[l]) + dy * Math.sin(heading[l])) / r;
            } else {
              lean = Math.max(-1, Math.min(1, scent - edgeSmell[l]));
            }
            score += reach * lean;
          }
          if (score > bestScore) {
            bestScore = score;
            best = l;
          }
        }
        next[i] = best;
      }
    }
    this.label = next;
    this.next = label;
    this.steps++;
    this.measure();
    for (let l = 1; l <= this.labels; l++) heading[l] += WANDER * gauss();
  }

  /** The amoeba at a pixel divides. */
  divideAt(x: number, y: number): void {
    const l = this.label[y * this.w + x];
    if (l !== MEDIUM && this.target[l] > 0) this.divide([l]);
  }

  /** The amoeba at a pixel dies and shrinks away. */
  remove(x: number, y: number): void {
    const l = this.label[y * this.w + x];
    if (l !== MEDIUM && this.target[l] > 0) {
      this.target[l] = 0;
      this.deaths++;
    }
  }

  tintOf(l: number): number {
    return this.tint[l] ?? 0;
  }

  /** How fed an amoeba is: 0 starving, 1 newborn, 2 about to divide. */
  fedOf(l: number): number {
    return this.born[l] > 0 ? this.target[l] / this.born[l] : 0;
  }

  /** Food left, in crumbs. */
  get foodLeft(): number {
    return Math.max(0, this.crumbs - this.eaten);
  }

  centreOf(l: number): [number, number] {
    return [this.centre[l * 2], this.centre[l * 2 + 1]];
  }

  get labelCount(): number {
    return this.labels;
  }

  isAlive(l: number): boolean {
    return this.area[l] > 0 && this.target[l] > 0;
  }

  /** The smell spreads and fades; food gives it off where it lies. */
  private spreadSmell(carries: number): void {
    const { w, h, food } = this;
    const fade = SMELL_SPREAD / (carries * carries);
    for (let s = 0; s < SMELL_SUBSTEPS; s++) {
      const a = this.smell;
      const b = this.smellNext;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const c = a[i];
          // Walls give back what reaches them.
          const left = x > 0 ? a[i - 1] : c;
          const right = x + 1 < w ? a[i + 1] : c;
          const up = y > 0 ? a[i - w] : c;
          const down = y + 1 < h ? a[i + w] : c;
          b[i] = c + SMELL_SPREAD * (left + right + up + down - 4 * c) - fade * c + SMELL_GIVEN * food[i];
        }
      }
      this.smell = b;
      this.smellNext = a;
    }
  }

  /** Every amoeba eats the food under it, and burns some of what it holds to; one starved dies. */
  private feed(p: AmoebaParams): void {
    const { label, food, target, born } = this;
    let eaten = 0;
    for (let i = 0; i < label.length; i++) {
      const l = label[i];
      if (l === MEDIUM || food[i] === 0 || !(target[l] > 0)) continue;
      // A crumb's worth of food is worth `feeds` of the amoeba's newborn area.
      target[l] += food[i] * p.feeds * born[l];
      eaten += food[i];
      food[i] = 0;
    }
    this.eaten += eaten;
    const due: number[] = [];
    for (let l = 1; l <= this.labels; l++) {
      if (!(this.area[l] > 0) || !(target[l] > 0)) continue;
      target[l] -= ((1 - STARVED) * born[l]) / p.starves;
      if (target[l] <= STARVED * born[l]) {
        target[l] = 0;
        this.deaths++;
      } else if (target[l] >= 2 * born[l]) due.push(l);
    }
    if (due.length > 0) this.divide(due);
  }

  /** Every amoeba's centre, and the mean log smell along its edge. */
  private look(): void {
    const { w, h, label, smell } = this;
    const n = this.labels + 1;
    const sum = new Float64Array(n * 3);
    const edge = new Float64Array(n * 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = label[i];
        if (l === MEDIUM) continue;
        sum[l * 3]++;
        sum[l * 3 + 1] += x;
        sum[l * 3 + 2] += y;
        const rim = (x > 0 && label[i - 1] !== l) || (x + 1 < w && label[i + 1] !== l) || (y > 0 && label[i - w] !== l) || (y + 1 < h && label[i + w] !== l);
        if (rim) {
          edge[l * 2]++;
          edge[l * 2 + 1] += Math.log(smell[i] + SMELL_FLOOR);
        }
      }
    }
    for (let l = 1; l < n; l++) {
      if (sum[l * 3] === 0) continue;
      this.centre[l * 2] = sum[l * 3 + 1] / sum[l * 3];
      this.centre[l * 2 + 1] = sum[l * 3 + 2] / sum[l * 3];
      this.edgeSmell[l] = edge[l * 2] > 0 ? edge[l * 2 + 1] / edge[l * 2] : 0;
    }
  }

  /** One for the water; an amoeba weighted by how far it is off the area it holds to. */
  private weights(): Float32Array {
    const weight = new Float32Array(this.labels + 1).fill(1);
    for (let l = 1; l <= this.labels; l++) {
      const hold = this.target[l];
      if (!(this.area[l] > 0)) continue;
      // A dying amoeba gives way all it can.
      if (!(hold > 0)) {
        weight[l] = 1 - PRESSURE_LIMIT;
        continue;
      }
      const lack = (PRESSURE_GAIN * (hold - this.area[l])) / hold;
      weight[l] = 1 + Math.max(-PRESSURE_LIMIT, Math.min(PRESSURE_LIMIT, lack));
    }
    return weight;
  }

  /** The amoebae listed divide across their long axes; each half holds to half the area. */
  private divide(cells: number[]): void {
    const { w, h, label } = this;
    const n = this.labels + 1;
    const m = new Float64Array(n * 6);
    const listed = new Uint8Array(n);
    for (const l of cells) listed[l] = 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = label[y * w + x];
        if (!listed[l]) continue;
        const o = l * 6;
        m[o]++;
        m[o + 1] += x;
        m[o + 2] += y;
        m[o + 3] += x * x;
        m[o + 4] += y * y;
        m[o + 5] += x * y;
      }
    }
    const split = new Float64Array(n * 4);
    const daughter = new Uint16Array(n);
    for (const l of cells) {
      const o = l * 6;
      const count = m[o];
      if (count < 2 || this.labels + 1 >= 0xffff) continue;
      const cx = m[o + 1] / count;
      const cy = m[o + 2] / count;
      const xx = m[o + 3] / count - cx * cx;
      const yy = m[o + 4] / count - cy * cy;
      const xy = m[o + 5] / count - cx * cy;
      const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
      split.set([cx, cy, Math.cos(angle), Math.sin(angle)], l * 4);
      const child = this.newLabel(this.tint[l] + TINT_PART);
      this.tint[l] -= TINT_PART;
      daughter[l] = child;
      const half = this.target[l] / 2;
      this.target[l] = half;
      this.target[child] = half;
      this.born[child] = this.born[l];
      // The daughters crawl off apart.
      this.heading[l] = angle;
      this.heading[child] = angle + Math.PI;
      this.divisions++;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = label[i];
        if (!daughter[l]) continue;
        const o = l * 4;
        if ((x - split[o]) * split[o + 2] + (y - split[o + 1]) * split[o + 3] > 0) label[i] = daughter[l];
      }
    }
    this.measure();
  }

  private reset(): void {
    this.labels = 0;
    this.steps = 0;
    this.divisions = 0;
    this.deaths = 0;
    this.eaten = 0;
    this.area = new Float64Array(64);
    this.target = new Float64Array(64);
    this.born = new Float64Array(64);
    this.tint = new Float32Array(64);
    this.heading = new Float64Array(64);
    this.centre = new Float64Array(128);
    this.edgeSmell = new Float64Array(64);
  }

  private newLabel(tint: number): number {
    const mine = ++this.labels;
    if (mine >= this.area.length) {
      const grow = <T extends Float64Array | Float32Array>(a: T, make: (n: number) => T): T => {
        const b = make(a.length * 2);
        b.set(a);
        return b;
      };
      this.area = grow(this.area, (n) => new Float64Array(n));
      this.target = grow(this.target, (n) => new Float64Array(n));
      this.born = grow(this.born, (n) => new Float64Array(n));
      this.tint = grow(this.tint, (n) => new Float32Array(n));
      this.heading = grow(this.heading, (n) => new Float64Array(n));
      this.centre = grow(this.centre, (n) => new Float64Array(n));
      this.edgeSmell = grow(this.edgeSmell, (n) => new Float64Array(n));
    }
    this.tint[mine] = tint;
    this.heading[mine] = Math.random() * 2 * Math.PI;
    return mine;
  }

  private measure(): void {
    const { area, label } = this;
    area.fill(0);
    for (let i = 0; i < label.length; i++) area[label[i]]++;
    this.count = 0;
    for (let l = 1; l <= this.labels; l++) if (area[l] > 0 && this.target[l] > 0) this.count++;
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

function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}
