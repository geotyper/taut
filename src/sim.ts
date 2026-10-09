export interface Params {
  /** Box kernel radius in cells; three box passes approximate a Gaussian. */
  radius: number;
  /** Phase threshold. 0.5 is pure tension; above 0.5 adds inward pressure. */
  threshold: number;
  /** Width of the uniform noise added near the front. Unpins the lattice. */
  noise: number;
}

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

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.phase = new Uint8Array(w * h);
    this.stones = new Uint8Array(w * h);
    this.a = new Float32Array(w * h);
    this.b = new Float32Array(w * h);
    this.restart();
  }

  /** Relaunch the wave: the band starts stretched along the field border. */
  restart(): void {
    this.phase.fill(1);
    this.steps = 0;
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
