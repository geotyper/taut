/** Parameters of the wide-kernel threshold dynamics. */
export interface Params {
  /** Box kernel radius in cells; three box passes approximate a Gaussian. */
  radius: number;
  /** Phase threshold. 0.5 is pure tension; above 0.5 adds inward pressure. */
  threshold: number;
  /** Width of the uniform noise added near the front. Unpins the lattice. */
  noise: number;
}

/** Parameters of the Potts model; energies are in units of one unlike pair. */
export interface PottsParams {
  /** Metropolis temperature. Zero freezes the front on the lattice. */
  temperature: number;
  /** Energy per inside cell: positive squeezes the band, negative inflates it. */
  pressure: number;
}

/** Optional physics that can be switched on for any automaton supporting it. */
export interface Extras {
  /** 0..1: how hard the band sticks to the stones it rests on. 0 is off. */
  friction: number;
  /** Length the band tries to keep, in cells. 0 means "as short as possible". */
  targetLength: number;
}

export const NO_EXTRAS: Extras = { friction: 0, targetLength: 0 };

/**
 * A classic outer-totalistic rule on the Moore neighbourhood: the next state
 * indexed by how many of the 9 cells (the cell itself included) are inside.
 */
export type ClassicRule = readonly number[];

/** Vichniac majority vote, B5678/S45678: inside when 5 or more of 9 are. */
export const RULE_MAJORITY: ClassicRule = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1];
/** Vichniac anneal ("twisted majority"), B4678/S35678: 4 and 5 swapped. */
export const RULE_ANNEAL: ClassicRule = [0, 0, 0, 0, 1, 0, 1, 1, 1, 1];

/**
 * Where the band starts: along the field border, as an inscribed circle,
 * along the border with a randomly pitted edge, or collapsed onto the stones
 * (for the automaton that grows outwards).
 */
export type StartShape = 'square' | 'circle' | 'rough' | 'stones';

/** Depth of the randomly pitted strip of the 'rough' start, in cells. */
const ROUGH_WIDTH = 4;

/** Cells this close to the field border can never hold a stone. */
export const STONE_MARGIN = 4;

/** Free cells within this Chebyshev distance of a stone are sticky. */
const STICKY_REACH = 2;
/** Box radius used to smooth lattice roughness away before measuring length. */
const LENGTH_SMOOTHING = 2;

/** At full friction: the blurred-phase deficit a stuck wide-kernel cell resists. */
const FRICTION_WIDE = 0.2;
/** At full friction: the energy needed to peel a Potts cell off a stone. */
const FRICTION_POTTS = 8;

/**
 * Fixed length: outward push per unit of relative length shortfall, the rate
 * of its integral, and the cap. In threshold units for the wide kernel and in
 * pressure units for Potts. A band that is too long is left to plain tension.
 */
const LENGTH_WIDE = { gain: 1, integral: 0.02, max: 0.06 };
const LENGTH_POTTS = { gain: 5, integral: 0.05, max: 0.6 };

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * A binary field with frozen stones and several automata that can step it.
 * phase = 1 is "inside the band", 0 is "outside". Everything beyond the field
 * counts as outside, so the outside phase floods in from the borders.
 */
export class Sim {
  readonly w: number;
  readonly h: number;
  readonly phase: Uint8Array;
  readonly stones: Uint8Array;
  steps = 0;
  /** Set once the growing automaton has nothing left to add. */
  settled = false;

  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly counts: Uint8Array;
  private readonly sticky: Uint8Array;
  private readonly front: Int32Array;
  private stickyStale = true;
  private lengthShift = 0;
  private seed = 0x9e3779b9;
  private growthRadius = 0;
  private growthOffsets: number[] = [];

  /** Pass another sim's `stones` to run two automata on the same stones. */
  constructor(w: number, h: number, stones?: Uint8Array) {
    this.w = w;
    this.h = h;
    this.phase = new Uint8Array(w * h);
    this.stones = stones ?? new Uint8Array(w * h);
    this.a = new Float32Array(w * h);
    this.b = new Float32Array(w * h);
    this.counts = new Uint8Array(w * h);
    this.sticky = new Uint8Array(w * h);
    this.front = new Int32Array(w * h);
    this.restart();
  }

  /** Relaunch the wave from the given starting shape of the band. */
  restart(start: StartShape = 'square'): void {
    const { w, h, phase } = this;
    this.steps = 0;
    this.settled = false;
    this.lengthShift = 0;
    if (start === 'stones') {
      phase.set(this.stones);
      return;
    }
    phase.fill(1);
    if (start === 'circle') {
      const cx = (w - 1) / 2;
      const cy = (h - 1) / 2;
      const r = Math.min(w, h) / 2 - 2;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) phase[y * w + x] = 0;
        }
      }
    } else if (start === 'rough') {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
          if (edge < ROUGH_WIDTH && Math.random() < 0.5) phase[y * w + x] = 0;
        }
      }
    }
  }

  clearStones(): void {
    this.stones.fill(0);
    this.stonesChanged();
  }

  /** Call on every sim sharing the stones after they were edited. */
  stonesChanged(): void {
    this.stickyStale = true;
    this.settled = false;
  }

  /**
   * Wide kernel: threshold dynamics (Merriman-Bence-Osher). Three box blurs
   * and a threshold move the front by curvature until it rests on the stones.
   */
  step(p: Params, extras: Extras = NO_EXTRAS): void {
    const { w, h, phase, stones, a, b } = this;
    const r = Math.max(1, Math.round(p.radius));

    // Lowering the threshold pushes the front outwards. Measured before the
    // blur below, because measuring the length reuses the same buffers.
    const threshold = p.threshold + this.lengthPush(extras, LENGTH_WIDE);

    boxPass(phase, a, h, w, w, 1, r);
    boxPass(a, b, w, h, 1, w, r);
    for (let k = 0; k < 2; k++) {
      boxPass(b, a, h, w, w, 1, r);
      boxPass(a, b, w, h, 1, w, r);
    }

    const sticky = extras.friction > 0 ? this.stickyMask() : null;
    const grip = extras.friction * FRICTION_WIDE;
    const half = p.noise / 2;
    for (let i = 0; i < phase.length; i++) {
      if (stones[i]) {
        phase[i] = 1;
        continue;
      }
      let v = b[i] - threshold;
      if (v > -half && v < half) v += (Math.random() - 0.5) * p.noise;
      if (sticky && sticky[i] && phase[i]) v += grip;
      phase[i] = v > 0 ? 1 : 0;
    }
    this.steps++;
  }

  /**
   * One synchronous step of a classic two-state automaton: 8 neighbours plus
   * the cell itself, no weights, no randomness. Stones stay frozen inside.
   */
  stepClassic(rule: ClassicRule, extras: Extras = NO_EXTRAS): void {
    const { w, h, phase, stones, counts } = this;
    const sticky = extras.friction > 0 ? this.stickyMask() : null;
    // A stuck cell lets go only when this few of its 9 cells are still inside.
    const letGo = 5 - Math.round(5 * extras.friction);

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        let n = phase[i];
        if (x > 0) n += phase[i - 1];
        if (x < w - 1) n += phase[i + 1];
        counts[i] = n;
      }
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (stones[i]) {
          phase[i] = 1;
          continue;
        }
        let n = counts[i];
        if (y > 0) n += counts[i - w];
        if (y < h - 1) n += counts[i + w];
        let next = rule[n];
        if (!next && sticky && sticky[i] && phase[i] && n > letGo) next = 1;
        phase[i] = next;
      }
    }
    this.steps++;
  }

  /**
   * Cellular Potts model: one Monte Carlo sweep of Metropolis copy attempts.
   * Energy = unlike Moore pairs (tension) + pressure * area, plus optional
   * length and adhesion terms. Cells change one at a time, each seeing the last.
   * Only cells on the front can change, so a sweep draws from those alone.
   */
  stepPotts(p: PottsParams, extras: Extras = NO_EXTRAS): void {
    const { w, h, phase, stones, front } = this;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (stones[i]) continue;
        const inside = this.insideNeighbours(x, y);
        if (phase[i] ? inside < 8 : inside > 0) front[n++] = i;
      }
    }
    if (n === 0) return;

    const sticky = extras.friction > 0 ? this.stickyMask() : null;
    const adhesion = extras.friction * FRICTION_POTTS;
    const pressure = p.pressure + this.lengthPush(extras, LENGTH_POTTS);
    const beta = 1 / Math.max(p.temperature, 1e-3);

    let s = this.seed;
    for (let k = 0; k < n; k++) {
      // xorshift32: one draw picks both the cell and the neighbour to copy.
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const i = front[(s >>> 0) % n];
      const dir = (s >>> 28) & 7;
      const x = i % w;
      const y = (i / w) | 0;
      const nx = x + DX[dir];
      const ny = y + DY[dir];
      const source = nx < 0 || ny < 0 || nx >= w || ny >= h ? 0 : phase[ny * w + nx];
      const current = phase[i];
      if (source === current) continue;

      const inside = this.insideNeighbours(x, y);
      const dPairs = current ? 2 * inside - 8 : 8 - 2 * inside;
      let dH = dPairs + (current ? -pressure : pressure);
      if (sticky && current && sticky[i]) dH += adhesion;
      if (dH > 0 && Math.random() >= Math.exp(-dH * beta)) continue;
      phase[i] = source;
    }
    this.seed = s;
    this.steps++;
  }

  /**
   * Growing automaton: a cell joins the inside when some pair of cells at
   * opposite offsets within `radius` is already inside. Starts from the stones
   * and only ever grows; stops by itself.
   */
  stepGrowth(radius: number): void {
    if (this.settled) return;
    const { w, h, phase, counts } = this;
    const offsets = this.offsetsWithin(Math.max(1, Math.round(radius)));

    // Betweenness never leaves the bounding box of what is already inside.
    let x0 = w;
    let x1 = -1;
    let y0 = h;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!phase[y * w + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }

    counts.set(phase);
    let grown = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (counts[i]) continue;
        for (let k = 0; k < offsets.length; k += 2) {
          const dx = offsets[k];
          const dy = offsets[k + 1];
          const ax = x + dx;
          const ay = y + dy;
          const bx = x - dx;
          const by = y - dy;
          if (ax < x0 || ax > x1 || bx < x0 || bx > x1) continue;
          if (ay > y1 || by < y0) continue;
          if (counts[ay * w + ax] && counts[by * w + bx]) {
            phase[i] = 1;
            grown++;
            break;
          }
        }
      }
    }
    if (grown === 0) this.settled = true;
    else this.steps++;
  }

  /** Paint (value = 1) or erase (value = 0) a disc of stone. */
  paintStone(cx: number, cy: number, r: number, value: 0 | 1): void {
    const { w, h, stones, phase } = this;
    const x0 = Math.max(STONE_MARGIN, Math.floor(cx - r));
    const x1 = Math.min(w - 1 - STONE_MARGIN, Math.ceil(cx + r));
    const y0 = Math.max(STONE_MARGIN, Math.floor(cy - r));
    const y1 = Math.min(h - 1 - STONE_MARGIN, Math.ceil(cy + r));
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r2) continue;
        const i = y * w + x;
        stones[i] = value;
        if (value) phase[i] = 1;
      }
    }
    this.stonesChanged();
  }

  /**
   * Scatter stones shaped between a circle and a rounded square.
   * `scale` shrinks or enlarges them relative to the default size.
   */
  randomStones(count: number, scale = 1): void {
    const { w, h, stones } = this;
    const size = Math.min(w, h);
    for (let n = 0; n < count; n++) {
      const ra = size * scale * (0.03 + Math.random() * 0.05);
      const rb = ra * (0.7 + Math.random() * 0.6);
      const reach = Math.max(ra, rb) * 1.2 + STONE_MARGIN + size * 0.08;
      const cx = reach + Math.random() * (w - 2 * reach);
      const cy = reach + Math.random() * (h - 2 * reach);
      const power = 2 + Math.random() * 4;
      const angle = Math.random() * Math.PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const ext = Math.ceil(Math.max(ra, rb) * 1.2);
      for (let dy = -ext; dy <= ext; dy++) {
        for (let dx = -ext; dx <= ext; dx++) {
          const u = Math.abs(dx * cos + dy * sin) / ra;
          const v = Math.abs(dy * cos - dx * sin) / rb;
          if (u ** power + v ** power > 1) continue;
          const x = Math.round(cx + dx);
          const y = Math.round(cy + dy);
          if (x < STONE_MARGIN || y < STONE_MARGIN) continue;
          if (x >= w - STONE_MARGIN || y >= h - STONE_MARGIN) continue;
          stones[y * w + x] = 1;
        }
      }
    }
    this.stonesChanged();
  }

  area(): number {
    let n = 0;
    for (let i = 0; i < this.phase.length; i++) n += this.phase[i];
    return n;
  }

  /**
   * Length of the front in cells: total variation of the lightly blurred
   * phase, which ignores cell-scale roughness of the front.
   */
  perimeter(): number {
    const { w, h, phase, a, b } = this;
    boxPass(phase, a, h, w, w, 1, LENGTH_SMOOTHING);
    boxPass(a, b, w, h, 1, w, LENGTH_SMOOTHING);
    let sum = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const v = b[i];
        const gx = (x < w - 1 ? b[i + 1] : 0) - (x > 0 ? b[i - 1] : 0);
        const gy = (y < h - 1 ? b[i + w] : 0) - (y > 0 ? b[i - w] : 0);
        sum += Math.sqrt(gx * gx + gy * gy);
        // The row of cells just past the field border sees this one too.
        if (x === 0 || x === w - 1) sum += v;
        if (y === 0 || y === h - 1) sum += v;
      }
    }
    return sum / 2;
  }

  /**
   * Fixed length: when the band is shorter than its target, returns a negative
   * (outward) push that grows until the measured length settles on the target.
   */
  private lengthPush(
    extras: Extras,
    k: { gain: number; integral: number; max: number },
  ): number {
    if (extras.targetLength <= 0) return 0;
    const error = this.perimeter() / extras.targetLength - 1;
    this.lengthShift = Math.max(-k.max, Math.min(0, this.lengthShift + k.integral * error));
    return Math.max(-k.max, Math.min(0, k.gain * error + this.lengthShift));
  }

  /** How many of the 8 Moore neighbours are inside; off-field is outside. */
  private insideNeighbours(x: number, y: number): number {
    const { w, h, phase } = this;
    const i = y * w + x;
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
      return (
        phase[i - w - 1] + phase[i - w] + phase[i - w + 1] +
        phase[i - 1] + phase[i + 1] +
        phase[i + w - 1] + phase[i + w] + phase[i + w + 1]
      );
    }
    let n = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) n += phase[ny * w + nx];
    }
    return n;
  }

  /** Free cells next to a stone, where friction holds the band. */
  private stickyMask(): Uint8Array {
    const { w, h, stones, sticky } = this;
    if (!this.stickyStale) return sticky;
    sticky.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!stones[y * w + x]) continue;
        for (let dy = -STICKY_REACH; dy <= STICKY_REACH; dy++) {
          for (let dx = -STICKY_REACH; dx <= STICKY_REACH; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (!stones[ny * w + nx]) sticky[ny * w + nx] = 1;
          }
        }
      }
    }
    this.stickyStale = false;
    return sticky;
  }

  /** Flat (dx, dy) list of one offset from each opposite pair within r. */
  private offsetsWithin(r: number): number[] {
    if (r === this.growthRadius) return this.growthOffsets;
    const offsets: number[] = [];
    for (let dy = 0; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dy === 0 && dx <= 0) continue;
        if (dx * dx + dy * dy <= r * r) offsets.push(dx, dy);
      }
    }
    this.growthRadius = r;
    this.growthOffsets = offsets;
    return offsets;
  }
}

/**
 * One 1D box blur over every line of the grid, zero-padded at the ends.
 * A running sum makes the cost independent of the radius.
 */
function boxPass(
  src: ArrayLike<number>,
  dst: Float32Array,
  lines: number,
  len: number,
  lineStride: number,
  cellStride: number,
  r: number,
): void {
  const norm = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    let sum = 0;
    for (let i = 0; i < r && i < len; i++) sum += src[base + i * cellStride];
    for (let i = 0; i < len; i++) {
      const add = i + r;
      const sub = i - r - 1;
      if (add < len) sum += src[base + add * cellStride];
      if (sub >= 0) sum -= src[base + sub * cellStride];
      dst[base + i * cellStride] = sum * norm;
    }
  }
}
