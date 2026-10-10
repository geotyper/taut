/** Parameters shared by both 3D automata. */
export interface Params3 {
  /**
   * Film: box kernel radius in cells. Lines: half-length of the line segments
   * a cell looks along.
   */
  radius: number;
  /** Fraction of inside cells needed to be inside. 0.5 is neutral. */
  threshold: number;
  /** Width of the uniform noise on the threshold. Unpins the lattice. */
  noise: number;
}

/** Start as a ball inscribed in the field, or as the whole field. */
export type StartShape3 = 'ball' | 'cube';

/** Voxel classes handed to the renderer. */
export const VOXEL_EMPTY = 0;
export const VOXEL_MEMBRANE = 1;
export const VOXEL_STONE = 2;

/**
 * Line directions: every lattice vector with components in -2..2, one from
 * each opposite pair, with no common factor. 49 lines through each cell.
 */
const LINES: { dx: number; dy: number; dz: number; length: number }[] = [];
for (let dz = -2; dz <= 2; dz++) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const first = dz !== 0 ? dz : dy !== 0 ? dy : dx;
      if (first <= 0) continue;
      if (dx % 2 === 0 && dy % 2 === 0 && dz % 2 === 0) continue;
      LINES.push({ dx, dy, dz, length: Math.hypot(dx, dy, dz) });
    }
  }
}

/**
 * A binary n*n*n field with frozen stones and two automata that can step it.
 * phase = 1 is "inside the membrane", 0 is "outside". Everything beyond the
 * field counts as outside.
 */
export class Sim3 {
  readonly n: number;
  readonly phase: Uint8Array;
  readonly stones: Uint8Array;
  steps = 0;

  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly flips: Int32Array;

  constructor(n: number) {
    this.n = n;
    const cells = n * n * n;
    this.phase = new Uint8Array(cells);
    this.stones = new Uint8Array(cells);
    this.a = new Float32Array(cells);
    this.b = new Float32Array(cells);
    this.flips = new Int32Array(cells);
    this.restart();
  }

  /** Relaunch the wave from the given starting shape of the membrane. */
  restart(start: StartShape3 = 'ball'): void {
    const { n, phase, stones } = this;
    this.steps = 0;
    phase.fill(1);
    if (start === 'cube') return;
    const c = (n - 1) / 2;
    const r2 = (n / 2 - 1) ** 2;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = (z * n + y) * n + x;
          if (!stones[i] && (x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2 > r2) phase[i] = 0;
        }
      }
    }
  }

  /**
   * Line majority: a cell is inside when, along at least one line through it,
   * most cells within `radius` are inside. A cell on a convex bump sees short
   * chords in every direction and is shed; a cell in a dent or a neck sees a
   * long chord and is filled. The front moves by its smallest principal
   * curvature and comes to rest stretched flat between the stones.
   */
  stepLines(p: Params3): void {
    const { n, phase, stones, flips } = this;
    const n2 = n * n;
    const last = n - 1;
    let flipCount = 0;

    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = z * n2 + y * n + x;
          if (stones[i]) continue;
          const self = phase[i];
          // Only cells on the front can change: skip those whose six
          // neighbours all agree with them.
          const other = 1 - self;
          const onFront =
            (x > 0 ? phase[i - 1] : 0) === other ||
            (x < last ? phase[i + 1] : 0) === other ||
            (y > 0 ? phase[i - n] : 0) === other ||
            (y < last ? phase[i + n] : 0) === other ||
            (z > 0 ? phase[i - n2] : 0) === other ||
            (z < last ? phase[i + n2] : 0) === other;
          if (!onFront) continue;

          const threshold = p.threshold + (Math.random() - 0.5) * p.noise;
          let inside = 0;
          for (let l = 0; l < LINES.length && !inside; l++) {
            const { dx, dy, dz, length } = LINES[l];
            const reach = Math.max(1, Math.round(p.radius / length));
            const need = (2 * reach + 1) * threshold;
            const stride = dz * n2 + dy * n + dx;
            let count = self;
            // Forward along the line, as far as the field goes.
            let k = Math.min(reach, room(x, dx, last), room(y, dy, last), room(z, dz, last));
            for (let j = i + stride; k > 0; k--, j += stride) count += phase[j];
            k = Math.min(reach, room(x, -dx, last), room(y, -dy, last), room(z, -dz, last));
            for (let j = i - stride; k > 0; k--, j -= stride) count += phase[j];
            if (count > need) inside = 1;
          }
          if (inside !== self) flips[flipCount++] = i;
        }
      }
    }
    for (let f = 0; f < flipCount; f++) phase[flips[f]] ^= 1;
    this.steps++;
  }

  /**
   * Film: threshold dynamics (Merriman-Bence-Osher), the direct 3D port of
   * the 2D wide kernel. The front moves by mean curvature, so in 3D necks
   * pinch off and the membrane ends up shrunk onto each stone separately.
   */
  stepFilm(p: Params3): void {
    const { n, phase, stones, a, b } = this;
    const r = Math.max(1, Math.round(p.radius));

    // Three box blurs along each of the three axes; the result lands in `a`.
    let src: ArrayLike<number> = phase;
    for (let k = 0; k < 9; k++) {
      const dst = k % 2 === 0 ? a : b;
      boxPass(src, dst, n, k % 3, r);
      src = dst;
    }

    const half = p.noise / 2;
    for (let i = 0; i < phase.length; i++) {
      if (stones[i]) {
        phase[i] = 1;
        continue;
      }
      let v = a[i] - p.threshold;
      if (v > -half && v < half) v += (Math.random() - 0.5) * p.noise;
      phase[i] = v > 0 ? 1 : 0;
    }
    this.steps++;
  }

  /**
   * Fill `out` with what the renderer draws: stones, and the membrane - the
   * free inside cells that touch the outside phase. Returns the membrane size.
   */
  classify(out: Uint8Array): number {
    const { n, phase, stones } = this;
    const n2 = n * n;
    let membrane = 0;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = z * n2 + y * n + x;
          if (stones[i]) {
            out[i] = VOXEL_STONE;
            continue;
          }
          const exposed =
            phase[i] === 1 &&
            (x === 0 || y === 0 || z === 0 ||
              x === n - 1 || y === n - 1 || z === n - 1 ||
              !phase[i - 1] || !phase[i + 1] ||
              !phase[i - n] || !phase[i + n] ||
              !phase[i - n2] || !phase[i + n2]);
          out[i] = exposed ? VOXEL_MEMBRANE : VOXEL_EMPTY;
          if (exposed) membrane++;
        }
      }
    }
    return membrane;
  }

  volume(): number {
    let v = 0;
    for (let i = 0; i < this.phase.length; i++) v += this.phase[i];
    return v;
  }
}

/** How many steps of size |d| fit between coordinate c and the field edge. */
function room(c: number, d: number, last: number): number {
  if (d === 0) return Infinity;
  return Math.floor((d > 0 ? last - c : c) / Math.abs(d));
}

/**
 * One 1D box blur along the given axis (0 = x, 1 = y, 2 = z) of an n*n*n
 * grid, zero-padded at the ends. A running sum makes the cost independent of
 * the radius.
 */
function boxPass(
  src: ArrayLike<number>,
  dst: Float32Array,
  n: number,
  axis: number,
  r: number,
): void {
  const n2 = n * n;
  const stride = axis === 0 ? 1 : axis === 1 ? n : n2;
  const norm = 1 / (2 * r + 1);
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      const base = axis === 0 ? u * n2 + v * n : axis === 1 ? u * n2 + v : u * n + v;
      let sum = 0;
      for (let i = 0; i < r && i < n; i++) sum += src[base + i * stride];
      for (let i = 0; i < n; i++) {
        const add = i + r;
        const sub = i - r - 1;
        if (add < n) sum += src[base + add * stride];
        if (sub >= 0) sum -= src[base + sub * stride];
        dst[base + i * stride] = sum * norm;
      }
    }
  }
}
