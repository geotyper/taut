/** No amoeba: the water they crawl in, where the food lies. */
export const MEDIUM = 0;

/** How hard an amoeba away from its area pushes or gives way, as the cells do. */
const PRESSURE_GAIN = 4;
const PRESSURE_LIMIT = 0.5;
/**
 * The smell is smooth, so it is worked out on a coarser grid, of squares
 * this many pixels across, and read between them.
 */
export const SMELL_CELL = 4;
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
/** Crumbs fall no nearer the field's edge than this, in pixels. */
const CRUMB_MARGIN = 16;
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
  /**
   * What a pixel beyond the field's edge counts for, as water: zero, it
   * counts for nothing and an amoeba sticks to the edge, which spares it
   * a stretch of skin; one, the edge is as the water; more, it pushes away.
   */
  walls: number;
  /** Crumbs falling in, every thousand steps. */
  inflow: number;
  /**
   * Count only the pixels by a membrane, the only ones that can change: a
   * pixel takes a label from round it, so one with its own label all round
   * keeps it. The same result, for much less work on a large field.
   */
  banded: boolean;
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
 *
 * The pixels by a membrane, with another label in the 3×3 round them, are
 * kept as a band, and the areas and centres are kept up as pixels change,
 * so a step costs what its membranes are long, not what the field is big.
 */
export class Amoebae {
  readonly w: number;
  readonly h: number;
  readonly label: Uint16Array;
  /** Food on every pixel, in units of a crumb's worth over its pixels. */
  readonly food: Float32Array;
  /** The size of the smell's grid, and the smell on it. */
  readonly sw: number;
  readonly sh: number;
  smell: Float32Array;
  steps = 0;
  divisions = 0;
  deaths = 0;
  /** Amoebae alive. */
  count = 0;
  /** Crumbs laid so far, and food eaten so far, in crumbs. */
  crumbs = 0;
  eaten = 0;

  /** Food on the smell's grid, which gives it off. */
  private readonly foodCell: Float32Array;
  private smellNext: Float32Array;
  /** The pixels by a membrane, `bandSize` of them, and room for the next band. */
  private band: Int32Array;
  private bandSize = 0;
  private spare: Int32Array;
  /** Pixels looked at since the band was last made, a stamp per round. */
  private stamp: Uint32Array;
  private round = 0;
  /** Pixels that change this step, and to what. */
  private changed: Int32Array;
  private changedTo: Uint16Array;
  /** Crumbs due to fall, short of a whole one. */
  private owed = 0;
  private labels = 0;
  private area = new Float64Array(2);
  /** Sums of x and of y over each amoeba's pixels, for its centre. */
  private sum = new Float64Array(4);
  private target = new Float64Array(2);
  private born = new Float64Array(2);
  private tint = new Float32Array(2);
  /** The way a blind amoeba reaches. */
  private heading = new Float64Array(2);
  /** The mean log smell along every amoeba's edge. */
  private edgeSmell = new Float64Array(2);
  private disc = new Int8Array(0);
  private discRadius = -1;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.label = new Uint16Array(w * h);
    this.food = new Float32Array(w * h);
    this.sw = Math.ceil(w / SMELL_CELL);
    this.sh = Math.ceil(h / SMELL_CELL);
    this.smell = new Float32Array(this.sw * this.sh);
    this.smellNext = new Float32Array(this.sw * this.sh);
    this.foodCell = new Float32Array(this.sw * this.sh);
    this.band = new Int32Array(w * h);
    this.spare = new Int32Array(w * h);
    this.stamp = new Uint32Array(w * h);
    this.changed = new Int32Array(w * h);
    this.changedTo = new Uint16Array(w * h);
  }

  /** One amoeba in the middle, and crumbs scattered round it. */
  start(crumbs: number): void {
    const { w, h, label } = this;
    this.reset();
    label.fill(MEDIUM);
    this.food.fill(0);
    this.foodCell.fill(0);
    this.smell.fill(0);
    const mine = this.newLabel(Math.random());
    const r = BORN_RADIUS;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if ((x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2 <= r * r) label[y * w + x] = mine;
      }
    }
    this.rebuild();
    this.target[mine] = this.area[mine];
    this.born[mine] = this.area[mine];
    this.count = 1;
    for (let laid = 0, tries = 0; laid < crumbs && tries < crumbs * 20; tries++) if (this.drop()) laid++;
  }

  /**
   * A crumb at random, away from the field's edge and not on an amoeba;
   * false when the place drawn would not do. A crumb is a small disc, its
   * food shared over its pixels, so every crumb is worth one.
   */
  drop(): boolean {
    const { w, h, label, food } = this;
    const reach = Math.ceil(CRUMB_RADIUS);
    const keep = CRUMB_MARGIN + reach;
    const cx = keep + Math.floor(Math.random() * (w - 2 * keep));
    const cy = keep + Math.floor(Math.random() * (h - 2 * keep));
    const offsets: number[] = [];
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        if (dx * dx + dy * dy > CRUMB_RADIUS ** 2) continue;
        if (label[(cy + dy) * w + cx + dx] !== MEDIUM) return false;
        offsets.push(dx, dy);
      }
    }
    const share = 2 / offsets.length;
    for (let d = 0; d < offsets.length; d += 2) {
      const x = cx + offsets[d];
      const y = cy + offsets[d + 1];
      food[y * w + x] += share;
      this.foodCell[this.cellOf(x, y)] += share;
    }
    this.crumbs++;
    return true;
  }

  step(p: AmoebaParams): void {
    // New crumbs fall at the rate set, a share of one every step.
    this.owed += p.inflow / 1000;
    while (this.owed >= 1) {
      this.owed--;
      for (let tries = 0; tries < 20 && !this.drop(); tries++);
    }
    this.spreadSmell(p.carries);
    this.look();
    const { w, h, label } = this;
    if (this.discRadius !== p.radius) this.buildDisc(p.radius);
    const disc = this.disc;
    const radius = p.radius;
    const half = disc.length / 2;
    const jitter = p.noise * half;
    const weight = this.weights();
    const reach = p.pull * half;
    const blind = p.sense === 'blind';
    const { sum, area, edgeSmell, heading, changed, changedTo } = this;
    const seen = new Uint16Array(10);
    const count = new Float64Array(10);
    let changes = 0;
    const todo = p.banded ? this.bandSize : w * h;
    for (let t = 0; t < todo; t++) {
      const i = p.banded ? this.band[t] : t;
      const x = i % w;
      const y = (i - x) / w;
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
      if (kinds === 1) continue;
      // Near the edge, the water beyond it may have a say too.
      const nearEdge = p.walls > 0 && (x < radius || y < radius || x >= w - radius || y >= h - radius);
      let water = -1;
      if (nearEdge) {
        water = 0;
        while (water < kinds && seen[water] !== MEDIUM) water++;
        if (water === kinds) seen[kinds++] = MEDIUM;
      }
      count.fill(0, 0, kinds);
      for (let d = 0; d < disc.length; d += 2) {
        const nx = x + disc[d];
        const ny = y + disc[d + 1];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
          if (nearEdge) count[water] += p.walls;
          continue;
        }
        const other = label[ny * w + nx];
        for (let k = 0; k < kinds; k++) {
          if (seen[k] === other) {
            count[k]++;
            break;
          }
        }
      }
      const scent = blind || reach === 0 ? 0 : Math.log(this.smellAt(x, y) + SMELL_FLOOR);
      let best = here;
      let bestScore = -Infinity;
      for (let k = 0; k < kinds; k++) {
        const l = seen[k];
        let score = count[k] * weight[l] + jitter * (Math.random() - 0.5);
        if (l !== MEDIUM && reach !== 0 && area[l] > 0) {
          // Out where it smells more than the rest of the edge, or the way it wanders.
          let lean: number;
          if (blind) {
            const dx = x - sum[l * 2] / area[l];
            const dy = y - sum[l * 2 + 1] / area[l];
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
      if (best !== here) {
        changed[changes] = i;
        changedTo[changes++] = best;
      }
    }
    this.apply(changes, p.feeds);
    this.steps++;
    this.live(p.starves);
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
      this.count--;
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
    return [this.sum[l * 2] / this.area[l], this.sum[l * 2 + 1] / this.area[l]];
  }

  get labelCount(): number {
    return this.labels;
  }

  /** Pixels by a membrane. */
  get bandPixels(): number {
    return this.bandSize;
  }

  isAlive(l: number): boolean {
    return this.area[l] > 0 && this.target[l] > 0;
  }

  /** The smell at a pixel, read between the squares of its grid. */
  smellAt(x: number, y: number): number {
    const { sw, sh, smell } = this;
    const gx = Math.max(0, Math.min(sw - 1.001, (x + 0.5) / SMELL_CELL - 0.5));
    const gy = Math.max(0, Math.min(sh - 1.001, (y + 0.5) / SMELL_CELL - 0.5));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const i = y0 * sw + x0;
    const top = smell[i] + (smell[i + 1] - smell[i]) * fx;
    const bottom = smell[i + sw] + (smell[i + sw + 1] - smell[i + sw]) * fx;
    return top + (bottom - top) * fy;
  }

  private cellOf(x: number, y: number): number {
    return Math.floor(y / SMELL_CELL) * this.sw + Math.floor(x / SMELL_CELL);
  }

  /**
   * The changes of a step all at once: areas and centres kept up, food
   * eaten where an amoeba takes a pixel, and the band moved with the
   * membranes, to the pixels by one of those that changed or that were in it.
   */
  private apply(changes: number, feeds: number): void {
    const { w, h, label, food, area, sum, target, born, changed, changedTo, stamp, band, spare } = this;
    let eaten = 0;
    for (let c = 0; c < changes; c++) {
      const i = changed[c];
      const from = label[i];
      const to = changedTo[c];
      const x = i % w;
      const y = (i - x) / w;
      label[i] = to;
      area[from]--;
      area[to]++;
      sum[from * 2] -= x;
      sum[from * 2 + 1] -= y;
      sum[to * 2] += x;
      sum[to * 2 + 1] += y;
      if (to !== MEDIUM && food[i] > 0 && target[to] > 0) {
        // A crumb's worth of food is worth `feeds` of the amoeba's newborn area.
        target[to] += food[i] * feeds * born[to];
        eaten += food[i];
        this.foodCell[this.cellOf(x, y)] -= food[i];
        food[i] = 0;
      }
    }
    this.eaten += eaten;
    if (++this.round === 0xffffffff) {
      stamp.fill(0);
      this.round = 1;
    }
    const round = this.round;
    let size = 0;
    const consider = (i: number) => {
      if (stamp[i] === round) return;
      stamp[i] = round;
      if (this.byMembrane(i)) spare[size++] = i;
    };
    // The new band: what of the old is still by a membrane, and what is round a change.
    for (let t = 0; t < this.bandSize; t++) consider(band[t]);
    for (let c = 0; c < changes; c++) {
      const i = changed[c];
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < w) consider(ny * w + nx);
        }
      }
    }
    this.band = spare;
    this.spare = band;
    this.bandSize = size;
  }

  /** Whether a pixel has another label in the 3×3 round it. */
  private byMembrane(i: number): boolean {
    const { w, h, label } = this;
    const here = label[i];
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < w && label[ny * w + nx] !== here) return true;
      }
    }
    return false;
  }

  /** Every amoeba burns some of what it holds to; one starved dies, one fed to twice its size divides. */
  private live(starves: number): void {
    const { target, born, area } = this;
    const due: number[] = [];
    for (let l = 1; l <= this.labels; l++) {
      if (!(area[l] > 0) || !(target[l] > 0)) continue;
      target[l] -= ((1 - STARVED) * born[l]) / starves;
      if (target[l] <= STARVED * born[l]) {
        target[l] = 0;
        this.deaths++;
        this.count--;
      } else if (target[l] >= 2 * born[l]) due.push(l);
    }
    if (due.length > 0) this.divide(due);
  }

  /** The smell spreads and fades; food gives it off where it lies. */
  private spreadSmell(carries: number): void {
    const { sw, sh, foodCell } = this;
    const cells = carries / SMELL_CELL;
    const fade = SMELL_SPREAD / (cells * cells);
    for (let s = 0; s < SMELL_SUBSTEPS; s++) {
      const a = this.smell;
      const b = this.smellNext;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const i = y * sw + x;
          const c = a[i];
          // Walls give back what reaches them.
          const left = x > 0 ? a[i - 1] : c;
          const right = x + 1 < sw ? a[i + 1] : c;
          const up = y > 0 ? a[i - sw] : c;
          const down = y + 1 < sh ? a[i + sw] : c;
          b[i] = c + SMELL_SPREAD * (left + right + up + down - 4 * c) - fade * c + SMELL_GIVEN * foodCell[i];
        }
      }
      this.smell = b;
      this.smellNext = a;
    }
  }

  /** The mean log smell along every amoeba's edge, from the band. */
  private look(): void {
    const { w, h, label, band } = this;
    const n = this.labels + 1;
    const edge = new Float64Array(n * 2);
    for (let t = 0; t < this.bandSize; t++) {
      const i = band[t];
      const l = label[i];
      if (l === MEDIUM) continue;
      const x = i % w;
      const y = (i - x) / w;
      const rim = (x > 0 && label[i - 1] !== l) || (x + 1 < w && label[i + 1] !== l) || (y > 0 && label[i - w] !== l) || (y + 1 < h && label[i + w] !== l);
      if (rim) {
        edge[l * 2]++;
        edge[l * 2 + 1] += Math.log(this.smellAt(x, y) + SMELL_FLOOR);
      }
    }
    for (let l = 1; l < n; l++) this.edgeSmell[l] = edge[l * 2] > 0 ? edge[l * 2 + 1] / edge[l * 2] : 0;
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
      this.count++;
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
    this.rebuild();
  }

  /** Areas, centres and the band, from the whole field. */
  private rebuild(): void {
    const { w, label, area, sum, band } = this;
    area.fill(0);
    sum.fill(0);
    let size = 0;
    for (let i = 0; i < label.length; i++) {
      const l = label[i];
      const x = i % w;
      area[l]++;
      sum[l * 2] += x;
      sum[l * 2 + 1] += (i - x) / w;
      if (this.byMembrane(i)) band[size++] = i;
    }
    this.bandSize = size;
  }

  private reset(): void {
    this.labels = 0;
    this.steps = 0;
    this.divisions = 0;
    this.deaths = 0;
    this.count = 0;
    this.eaten = 0;
    this.crumbs = 0;
    this.owed = 0;
    this.area = new Float64Array(64);
    this.sum = new Float64Array(128);
    this.target = new Float64Array(64);
    this.born = new Float64Array(64);
    this.tint = new Float32Array(64);
    this.heading = new Float64Array(64);
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
      this.sum = grow(this.sum, (n) => new Float64Array(n));
      this.target = grow(this.target, (n) => new Float64Array(n));
      this.born = grow(this.born, (n) => new Float64Array(n));
      this.tint = grow(this.tint, (n) => new Float32Array(n));
      this.heading = grow(this.heading, (n) => new Float64Array(n));
      this.edgeSmell = grow(this.edgeSmell, (n) => new Float64Array(n));
    }
    this.tint[mine] = tint;
    this.heading[mine] = Math.random() * 2 * Math.PI;
    return mine;
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
