import { LINES, room, VOXEL_EMPTY, VOXEL_STONE, type Params3 } from './sim3.ts';

/** Squared distance of a cell that has not heard of any stone yet. */
const FAR = 0x7fffffff;

/** First voxel class of a coloured membrane; the classes above it are hues. */
export const VOXEL_HUE = 3;
const HUES = 256 - VOXEL_HUE;

/**
 * How much further than the cluster radius a young membrane reaches, and how
 * many steps longer than that reach a cell stays young, as fractions of the
 * field size.
 */
const SLACK = 1 / 16;
const YOUTH_MARGIN = 1 / 8;

/** The 26 neighbours of a cell, as flat (dx, dy, dz) triples. */
const NEIGHBOURS: number[] = [];
for (let dz = -1; dz <= 1; dz++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx !== 0 || dy !== 0 || dz !== 0) NEIGHBOURS.push(dx, dy, dz);
    }
  }
}
const NDX = Int8Array.from({ length: 26 }, (_, k) => NEIGHBOURS[3 * k]);
const NDY = Int8Array.from({ length: 26 }, (_, k) => NEIGHBOURS[3 * k + 1]);
const NDZ = Int8Array.from({ length: 26 }, (_, k) => NEIGHBOURS[3 * k + 2]);

/**
 * Depth is counted in thirds of a cell: a step to a neighbour costs 3, 4 or 5
 * as it changes one, two or three coordinates, which keeps it close to the
 * straight distance.
 */
const DEPTH_UNIT = 3;
const DEPTH_COST = Uint8Array.from(NDX, (dx, k) => 2 + Math.abs(dx) + Math.abs(NDY[k]) + Math.abs(NDZ[k]));
const DEPTH_CAP = 255;

/**
 * A membrane per group of stones in 3D, as one rule applied by every cell on
 * every step, all at once. The 2D one-rule automaton carried over: the cell
 * state has the same five parts, and only the tension differs.
 *
 * - **Nearest stone**: the offset to the nearest stone the cell has heard of;
 *   it takes a shorter one from any of its 26 neighbours.
 * - **Depth**: for a cell within the cluster radius of a stone, how far it is
 *   from the nearest cell that is not: one more than the smallest depth among
 *   its neighbours.
 * - **Label**: on a stone, or within the cluster radius of one and deep
 *   enough, the smallest label among such neighbours, so stones closer than
 *   two radii agree on one unless the bridge between them is too thin.
 *   Elsewhere, the label of the neighbour towards the nearest stone. A cell
 *   that hears of a nearer stone takes the label of the neighbour it heard
 *   it from.
 * - **Age**: steps since the label last changed here or near here.
 * - **Membrane**: inside or outside. A cell within the padding of its stone
 *   is always inside, so the membrane is pulled taut around the stones grown
 *   by that much rather than around the bare stones, and keeps some body
 *   where a cluster is thin. A young cell close enough to its stone is inside
 *   too, so a cluster stays in one piece while its labels settle. Any other
 *   cell follows the line majority rule, with cells of another label counted
 *   as outside, so two membranes never merge.
 */
export class Clusters3 {
  readonly n: number;
  readonly stones: Uint8Array;
  steps = 0;
  /** True while the nearest stones and the labels are still changing. */
  settling = true;
  /** Number of clusters; known once the labels have settled. */
  clusters = 0;
  phase: Uint8Array;
  label: Int32Array;

  private d2: Int32Array;
  private ox: Int16Array;
  private oy: Int16Array;
  private oz: Int16Array;
  private age: Uint8Array;
  private depth: Uint8Array;
  private ndepth: Uint8Array;
  private nd2: Int32Array;
  private nox: Int16Array;
  private noy: Int16Array;
  private noz: Int16Array;
  private nlabel: Int32Array;
  private nage: Uint8Array;
  private nphase: Uint8Array;
  /**
   * Cells whose neighbourhood changed on the last step. The rest would only
   * repeat themselves, so everything but their membrane is carried over.
   */
  private wake: Uint8Array;
  private nwake: Uint8Array;
  /** The label of every inside cell and 0 for the rest; rebuilt each step. */
  private readonly own: Int32Array;
  private core2 = 1;
  /** Labels spread only through cells at least this deep; 0 for all of them. */
  private deep = 0;
  private pad2 = 0;
  private fat2 = 1;
  private old = 1;
  /** The membrane is all that can still change: the rest of the rule is a no-op. */
  private membraneOnly = false;
  private readonly strides: Int32Array;
  private readonly reaches = new Int32Array(LINES.length);
  private readonly lineStrides = new Int32Array(LINES.length);

  /** `stones` is shared with whoever scatters them. */
  constructor(n: number, stones: Uint8Array) {
    const cells = n * n * n;
    this.n = n;
    this.stones = stones;
    this.phase = new Uint8Array(cells);
    this.label = new Int32Array(cells);
    this.d2 = new Int32Array(cells);
    this.ox = new Int16Array(cells);
    this.oy = new Int16Array(cells);
    this.oz = new Int16Array(cells);
    this.age = new Uint8Array(cells);
    this.depth = new Uint8Array(cells);
    this.ndepth = new Uint8Array(cells);
    this.nd2 = new Int32Array(cells);
    this.nox = new Int16Array(cells);
    this.noy = new Int16Array(cells);
    this.noz = new Int16Array(cells);
    this.nlabel = new Int32Array(cells);
    this.nage = new Uint8Array(cells);
    this.nphase = new Uint8Array(cells);
    this.wake = new Uint8Array(cells);
    this.nwake = new Uint8Array(cells);
    this.own = new Int32Array(cells);
    this.strides = Int32Array.from(NDX, (dx, k) => (NDZ[k] * n + NDY[k]) * n + dx);
    for (let l = 0; l < LINES.length; l++) {
      const { dx, dy, dz } = LINES[l];
      this.lineStrides[l] = (dz * n + dy) * n + dx;
    }
    this.restart(1, 0, 0);
  }

  /**
   * The starting state: stones are inside and know they are stones, every
   * cell holds a label of its own, and nothing else is known. Where the
   * grown stones join by a bridge thinner than `bridge` cells, the clusters
   * stay apart; 0 joins everything that touches.
   */
  restart(reach: number, padding: number, bridge: number): void {
    const { n, stones } = this;
    const r = Math.max(1, Math.round(reach));
    this.padding = padding;
    const fat = r + Math.round(n * SLACK);
    this.core2 = r * r;
    this.deep = bridge > 0 ? Math.min(DEPTH_CAP, Math.round((DEPTH_UNIT * (bridge + 1)) / 2)) : 0;
    this.depth.fill(0);
    this.ndepth.fill(0);
    this.fat2 = fat * fat;
    this.old = Math.min(255, fat + Math.round(n * YOUTH_MARGIN));
    for (let i = 0; i < stones.length; i++) {
      this.d2[i] = stones[i] ? 0 : FAR;
      this.ox[i] = 0;
      this.oy[i] = 0;
      this.oz[i] = 0;
      this.label[i] = i + 1;
      this.age[i] = 0;
      this.phase[i] = stones[i];
    }
    this.wake.fill(1);
    this.steps = 0;
    this.settling = true;
    this.clusters = 0;
    this.membraneOnly = false;
  }

  /**
   * Take in stones added since the last step, without starting over. A new
   * stone cell knows it is a stone and gets a label of its own; the rule does
   * the rest, since a new stone can only join clusters and never splits one.
   */
  addStones(): void {
    const { stones, d2 } = this;
    for (let i = 0; i < stones.length; i++) {
      if (!stones[i] || d2[i] === 0) continue;
      d2[i] = 0;
      this.ox[i] = 0;
      this.oy[i] = 0;
      this.oz[i] = 0;
      this.label[i] = i + 1;
      this.age[i] = 0;
      this.phase[i] = 1;
    }
    this.wake.fill(1);
    this.settling = true;
    this.membraneOnly = false;
  }

  /**
   * How far around a stone its cells are always inside, in cells. Can be
   * changed while running: the membrane follows.
   */
  set padding(cells: number) {
    this.pad2 = Math.max(0, cells) ** 2;
  }

  /** One synchronous step of the rule on every cell. */
  step(p: Params3): void {
    for (let l = 0; l < LINES.length; l++) {
      this.reaches[l] = Math.max(1, Math.round(p.radius / LINES[l].length));
    }
    this.tagCells();
    if (this.membraneOnly) this.stepMembrane(p);
    else this.stepAll(p);
    this.steps++;
  }

  private stepAll(p: Params3): void {
    const { n, stones, strides, core2, deep, pad2, fat2, old } = this;
    const { d2, ox, oy, oz, label, age, nd2, nox, noy, noz, nlabel, nage, nphase } = this;
    const { depth, ndepth } = this;
    const { wake, nwake } = this;
    const n2 = n * n;
    const last = n - 1;
    let knowing = false;
    let ageing = false;
    nwake.fill(0);
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = z * n2 + y * n + x;
          const own = label[i];
          const here = d2[i];
          if (!wake[i]) {
            nd2[i] = here;
            nox[i] = ox[i];
            noy[i] = oy[i];
            noz[i] = oz[i];
            nlabel[i] = own;
            nage[i] = age[i];
            ndepth[i] = depth[i];
            if (here <= pad2 || (age[i] < old && here <= fat2)) nphase[i] = 1;
            else nphase[i] = this.lineRule(i, x, y, z, p);
            continue;
          }
          // With no bridge to break the depth decides nothing and is left at 0.
          const grown = deep > 0 && here <= core2;
          const core = stones[i] === 1 || (here <= core2 && depth[i] >= deep);

          let shallow = grown ? DEPTH_CAP : 0;
          let best = here;
          let bx = ox[i];
          let by = oy[i];
          let bz = oz[i];
          let low = own;
          let heard = own;
          let young = age[i] < old ? age[i] + 1 : old;
          const edge = x === 0 || y === 0 || z === 0 || x === last || y === last || z === last;
          for (let k = 0; k < 26; k++) {
            const dx = NDX[k];
            const dy = NDY[k];
            const dz = NDZ[k];
            if (edge) {
              const nx = x + dx;
              const ny = y + dy;
              const nz = z + dz;
              if (nx < 0 || ny < 0 || nz < 0 || nx > last || ny > last || nz > last) continue;
            }
            const j = i + strides[k];
            const there = d2[j];
            if (there !== FAR) {
              const cx = ox[j] + dx;
              const cy = oy[j] + dy;
              const cz = oz[j] + dz;
              const c = cx * cx + cy * cy + cz * cz;
              if (c < best) {
                best = c;
                bx = cx;
                by = cy;
                bz = cz;
                heard = label[j];
              }
            }
            if (grown && depth[j] + DEPTH_COST[k] < shallow) shallow = depth[j] + DEPTH_COST[k];
            if (core && label[j] < low && (stones[j] || (there <= core2 && depth[j] >= deep))) {
              low = label[j];
            }
            if (label[j] === own && age[j] + 1 < young) young = age[j] + 1;
          }
          // The label comes with the stone: whoever tells of a nearer one is
          // believed about its label too, and the old label is dropped.
          if (best !== here) low = heard;
          else if (!core && here !== FAR) {
            const j = i + Math.sign(oz[i]) * n2 + Math.sign(oy[i]) * n + Math.sign(ox[i]);
            if (d2[j] !== FAR) low = label[j];
          }
          if (low !== own) young = 0;

          const deeper = shallow !== depth[i];
          if (best !== here || low !== own || deeper) knowing = true;
          if (young !== age[i]) ageing = true;
          ndepth[i] = shallow;
          if (best !== here || low !== own || deeper || young !== age[i]) {
            nwake[i] = 1;
            if (edge) {
              for (let k = 0; k < 26; k++) {
                const nx = x + NDX[k];
                const ny = y + NDY[k];
                const nz = z + NDZ[k];
                if (nx < 0 || ny < 0 || nz < 0 || nx > last || ny > last || nz > last) continue;
                nwake[i + strides[k]] = 1;
              }
            } else {
              for (let k = 0; k < 26; k++) nwake[i + strides[k]] = 1;
            }
          }
          nd2[i] = best;
          nox[i] = bx;
          noy[i] = by;
          noz[i] = bz;
          nlabel[i] = low;
          nage[i] = young;
          if (here <= pad2 || (age[i] < old && here <= fat2)) nphase[i] = 1;
          else nphase[i] = this.lineRule(i, x, y, z, p);
        }
      }
    }
    this.swapPhase();
    this.d2 = nd2;
    this.ox = nox;
    this.oy = noy;
    this.oz = noz;
    this.label = nlabel;
    this.age = nage;
    this.nd2 = d2;
    this.nox = ox;
    this.noy = oy;
    this.noz = oz;
    this.nlabel = label;
    this.nage = age;
    this.depth = ndepth;
    this.ndepth = depth;
    this.wake = nwake;
    this.nwake = wake;

    if (this.settling && !knowing) {
      this.settling = false;
      this.clusters = this.countClusters();
    }
    // Nothing but the membrane depends on the membrane, so once the rest has
    // stopped changing it never starts again and need not be computed.
    if (!knowing && !ageing) this.membraneOnly = true;
  }

  private stepMembrane(p: Params3): void {
    const { n, d2, pad2, nphase } = this;
    const n2 = n * n;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = z * n2 + y * n + x;
          nphase[i] = d2[i] <= pad2 ? 1 : this.lineRule(i, x, y, z, p);
        }
      }
    }
    this.swapPhase();
  }

  private swapPhase(): void {
    const phase = this.phase;
    this.phase = this.nphase;
    this.nphase = phase;
  }

  /**
   * Line majority among the cells of the same label: the cell is inside when,
   * along at least one of the 49 lines through it, most cells within reach
   * are inside and hold its label.
   */
  private lineRule(i: number, x: number, y: number, z: number, p: Params3): number {
    const { n, own: tag, reaches, lineStrides } = this;
    const n2 = n * n;
    const last = n - 1;
    const mine = this.label[i];
    const self = tag[i] === mine ? 1 : 0;
    // Only cells on the front can change: skip those whose six neighbours all
    // look the same to them as they are themselves. Beyond the field is outside.
    const sides =
      (x > 0 && tag[i - 1] === mine ? 1 : 0) + (x < last && tag[i + 1] === mine ? 1 : 0) +
      (y > 0 && tag[i - n] === mine ? 1 : 0) + (y < last && tag[i + n] === mine ? 1 : 0) +
      (z > 0 && tag[i - n2] === mine ? 1 : 0) + (z < last && tag[i + n2] === mine ? 1 : 0);
    if (sides === (self ? 6 : 0)) return self;

    const threshold = p.threshold + (Math.random() - 0.5) * p.noise;
    for (let l = 0; l < LINES.length; l++) {
      const { dx, dy, dz } = LINES[l];
      const reach = reaches[l];
      const need = (2 * reach + 1) * threshold;
      const stride = lineStrides[l];
      let total = self;
      let k = Math.min(reach, room(x, dx, last), room(y, dy, last), room(z, dz, last));
      for (let j = i + stride; k > 0; k--, j += stride) {
        if (tag[j] === mine) total++;
      }
      k = Math.min(reach, room(x, -dx, last), room(y, -dy, last), room(z, -dz, last));
      for (let j = i - stride; k > 0; k--, j -= stride) {
        if (tag[j] === mine) total++;
      }
      if (total > need) return 1;
    }
    return 0;
  }

  /** Fill `own`: what every cell shows of itself to the line rule this step. */
  private tagCells(): void {
    const { phase, label, own } = this;
    for (let i = 0; i < own.length; i++) own[i] = phase[i] ? label[i] : 0;
  }

  /**
   * Fill `out` with what the renderer draws: stones, and the membranes - the
   * free inside cells that touch anything that is not their own inside -
   * each in the hue of its label. Returns the membrane size.
   */
  classify(out: Uint8Array): number {
    const { n, stones, phase, label } = this;
    const n2 = n * n;
    const last = n - 1;
    let membrane = 0;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const i = z * n2 + y * n + x;
          if (stones[i]) {
            out[i] = VOXEL_STONE;
            continue;
          }
          const own = label[i];
          const exposed =
            phase[i] === 1 &&
            (x === 0 || y === 0 || z === 0 || x === last || y === last || z === last ||
              !phase[i - 1] || label[i - 1] !== own || !phase[i + 1] || label[i + 1] !== own ||
              !phase[i - n] || label[i - n] !== own || !phase[i + n] || label[i + n] !== own ||
              !phase[i - n2] || label[i - n2] !== own || !phase[i + n2] || label[i + n2] !== own);
          out[i] = exposed ? VOXEL_HUE + hue(own) : VOXEL_EMPTY;
          if (exposed) membrane++;
        }
      }
    }
    return membrane;
  }

  /**
   * Fill `out` with the hue class of every inside cell and 0 for the rest:
   * what the smooth view colours the membranes by.
   */
  tint(out: Uint8Array): void {
    const { phase, label } = this;
    for (let i = 0; i < out.length; i++) out[i] = phase[i] ? VOXEL_HUE + hue(label[i]) : 0;
  }

  volume(): number {
    let v = 0;
    for (let i = 0; i < this.phase.length; i++) v += this.phase[i];
    return v;
  }

  /** Not part of the rule: how many labels the stones ended up with. */
  private countClusters(): number {
    const seen = new Set<number>();
    for (let i = 0; i < this.stones.length; i++) {
      if (this.stones[i]) seen.add(this.label[i]);
    }
    return seen.size;
  }
}

/** Spread labels over the hues so that near labels look unlike. */
function hue(label: number): number {
  return (Math.imul(label, 0x9e3779b1) >>> 8) % HUES;
}
