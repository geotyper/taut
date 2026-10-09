export interface Params {
  /** Box kernel radius in cells; three box passes approximate a Gaussian. */
  radius: number;
  /** Phase threshold. 0.5 is pure tension; above 0.5 adds inward pressure. */
  threshold: number;
  /** Width of the uniform noise added near the front. Unpins the lattice. */
  noise: number;
}

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
 * Where the band starts: along the field border, as an inscribed circle, or
 * along the border with a randomly pitted edge.
 */
export type StartShape = 'square' | 'circle' | 'rough';

/** Depth of the randomly pitted strip of the 'rough' start, in cells. */
const ROUGH_WIDTH = 4;

/** Cells this close to the field border can never hold a stone. */
export const STONE_MARGIN = 4;

/**
 * Threshold dynamics (Merriman-Bence-Osher) on a binary field.
 * phase = 1 is "inside the band", 0 is "outside". Everything beyond the field
 * counts as outside, so the outside phase floods in from the borders and the
 * front moves by curvature until it rests on the stones.
 */
export class Sim {
  readonly w: number;
  readonly h: number;
  readonly phase: Uint8Array;
  readonly stones: Uint8Array;
  steps = 0;

  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly counts: Uint8Array;

  /** Pass another sim's `stones` to run two automata on the same stones. */
  constructor(w: number, h: number, stones?: Uint8Array) {
    this.w = w;
    this.h = h;
    this.phase = new Uint8Array(w * h);
    this.stones = stones ?? new Uint8Array(w * h);
    this.counts = new Uint8Array(w * h);
    this.a = new Float32Array(w * h);
    this.b = new Float32Array(w * h);
    this.restart();
  }

  /** Relaunch the wave from the given starting shape of the band. */
  restart(start: StartShape = 'square'): void {
    const { w, h, phase } = this;
    phase.fill(1);
    this.steps = 0;
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
  }

  step(p: Params): void {
    const { w, h, phase, stones, a, b } = this;
    const r = Math.max(1, Math.round(p.radius));

    boxPass(phase, a, h, w, w, 1, r);
    boxPass(a, b, w, h, 1, w, r);
    for (let k = 0; k < 2; k++) {
      boxPass(b, a, h, w, w, 1, r);
      boxPass(a, b, w, h, 1, w, r);
    }

    const half = p.noise / 2;
    for (let i = 0; i < phase.length; i++) {
      if (stones[i]) {
        phase[i] = 1;
        continue;
      }
      let v = b[i] - p.threshold;
      if (v > -half && v < half) v += (Math.random() - 0.5) * p.noise;
      phase[i] = v > 0 ? 1 : 0;
    }
    this.steps++;
  }

  /**
   * One synchronous step of a classic two-state automaton: 8 neighbours plus
   * the cell itself, no weights, no randomness. Stones stay frozen inside.
   */
  stepClassic(rule: ClassicRule): void {
    const { w, h, phase, stones, counts } = this;
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
        phase[i] = rule[n];
      }
    }
    this.steps++;
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
  }

  /** Scatter stones shaped between a circle and a rounded square. */
  randomStones(count: number): void {
    const { w, h, stones } = this;
    const size = Math.min(w, h);
    for (let n = 0; n < count; n++) {
      const ra = size * (0.03 + Math.random() * 0.05);
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
  }

  area(): number {
    let n = 0;
    for (let i = 0; i < this.phase.length; i++) n += this.phase[i];
    return n;
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
