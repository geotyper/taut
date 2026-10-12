import { convexHull, polygonArea, type Point } from '../hull.ts';

/** Squared distance of a cell that has not heard of any stone yet. */
const FAR = 0x7fffffff;

/** How much further than the cluster radius a young band reaches, in cells. */
const BAND_SLACK = 12;
/** How many steps longer than that reach a cell stays young. */
const YOUTH_MARGIN = 16;

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

export interface RuleParams {
  /** Temperature of the band: how readily a cell makes a move that costs energy. */
  temperature: number;
}

/**
 * A band per group of stones as one cellular automaton: every cell applies
 * the same rule on every step, all at once, reading only its 8 neighbours.
 * There are no stages and no clock; the cell state has four parts that the
 * rule updates together.
 *
 * - **Nearest stone**: the offset to the nearest stone the cell has heard of;
 *   it takes a shorter one from a neighbour. Never stops at a radius, so in
 *   the end every cell knows which stone it belongs to.
 * - **Label**: within the cluster radius of a stone, the smallest label among
 *   such neighbours, so stones closer than two radii agree on one. Further
 *   out, the label of the neighbour towards the nearest stone, which carries
 *   the label of every cluster over its whole territory.
 * - **Age**: steps since the label last changed here or near here, among
 *   cells of the same label. It stops counting at a limit.
 * - **Band**: inside or outside. A young cell close enough to its stone is
 *   inside, which keeps a cluster in one fat piece while its labels are still
 *   settling. An old cell follows tension: it looks at a random neighbour and
 *   copies it by the Metropolis rule. Cells of another label
 *   count as outside, so two bands never merge.
 */
export class OneRule {
  readonly w: number;
  readonly h: number;
  readonly stones: Uint8Array;
  steps = 0;
  /** True while the nearest stones and the labels are still changing. */
  settling = true;
  label: Int32Array;
  inside: Uint8Array;
  /** Exact convex hull of every cluster's stones; known once labels settle. */
  hulls: Point[][] = [];
  hullArea = 0;

  private d2: Int32Array;
  private ox: Int16Array;
  private oy: Int16Array;
  private age: Uint8Array;
  private nd2: Int32Array;
  private nox: Int16Array;
  private noy: Int16Array;
  private nlabel: Int32Array;
  private nage: Uint8Array;
  private ninside: Uint8Array;
  private core2 = 1;
  private fat2 = 1;
  private old = 1;
  /** The band is all that can still change: the rest of the rule is a no-op. */
  private bandOnly = false;

  constructor(w: number, h: number, stones: Uint8Array) {
    const n = w * h;
    this.w = w;
    this.h = h;
    this.stones = stones;
    this.label = new Int32Array(n);
    this.inside = new Uint8Array(n);
    this.d2 = new Int32Array(n);
    this.ox = new Int16Array(n);
    this.oy = new Int16Array(n);
    this.age = new Uint8Array(n);
    this.nd2 = new Int32Array(n);
    this.nox = new Int16Array(n);
    this.noy = new Int16Array(n);
    this.nlabel = new Int32Array(n);
    this.nage = new Uint8Array(n);
    this.ninside = new Uint8Array(n);
    this.restart(1);
  }

  /**
   * The starting state: stones are inside and know they are stones, every
   * cell holds a label of its own, and nothing else is known.
   */
  restart(reach: number): void {
    const r = Math.max(1, Math.round(reach));
    this.core2 = r * r;
    this.fat2 = (r + BAND_SLACK) ** 2;
    this.old = r + BAND_SLACK + YOUTH_MARGIN;
    for (let i = 0; i < this.label.length; i++) {
      this.d2[i] = this.stones[i] ? 0 : FAR;
      this.ox[i] = 0;
      this.oy[i] = 0;
      this.label[i] = i + 1;
      this.age[i] = 0;
      this.inside[i] = this.stones[i];
    }
    this.steps = 0;
    this.settling = true;
    this.bandOnly = false;
    this.hulls = [];
    this.hullArea = 0;
  }

  area(): number {
    let n = 0;
    for (let i = 0; i < this.inside.length; i++) n += this.inside[i];
    return n;
  }

  /** One synchronous step of the rule on every cell. */
  step(p: RuleParams): void {
    if (this.bandOnly) this.stepBand(p);
    else this.stepAll(p);
    this.steps++;
  }

  private stepAll(p: RuleParams): void {
    const { w, h, stones, core2, fat2, old } = this;
    const { d2, ox, oy, label, age, nd2, nox, noy, nlabel, nage, ninside } = this;
    let knowing = false;
    let ageing = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const own = label[i];
        const core = d2[i] <= core2;

        let best = d2[i];
        let bx = ox[i];
        let by = oy[i];
        let low = own;
        let young = age[i] < old ? age[i] + 1 : old;
        for (let k = 0; k < 8; k++) {
          const nx = x + DX[k];
          const ny = y + DY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (d2[j] !== FAR) {
            const cx = ox[j] + DX[k];
            const cy = oy[j] + DY[k];
            const c = cx * cx + cy * cy;
            if (c < best) {
              best = c;
              bx = cx;
              by = cy;
            }
          }
          if (core && d2[j] <= core2 && label[j] < low) low = label[j];
          if (label[j] === own && age[j] + 1 < young) young = age[j] + 1;
        }
        if (!core && d2[i] !== FAR) {
          const tx = x + Math.sign(ox[i]);
          const ty = y + Math.sign(oy[i]);
          if (d2[ty * w + tx] !== FAR) low = label[ty * w + tx];
        }
        if (low !== own) young = 0;

        if (best !== d2[i] || low !== own) knowing = true;
        if (young !== age[i]) ageing = true;
        nd2[i] = best;
        nox[i] = bx;
        noy[i] = by;
        nlabel[i] = low;
        nage[i] = young;
        if (stones[i] || (age[i] < old && d2[i] <= fat2)) ninside[i] = 1;
        else ninside[i] = this.bandRule(x, y, p);
      }
    }
    this.swapBand();
    this.d2 = nd2;
    this.ox = nox;
    this.oy = noy;
    this.label = nlabel;
    this.age = nage;
    this.nd2 = d2;
    this.nox = ox;
    this.noy = oy;
    this.nlabel = label;
    this.nage = age;

    if (this.settling && !knowing) {
      this.settling = false;
      this.measureHulls();
    }
    // Nothing but the band depends on the band, so once the rest has stopped
    // changing it never starts again and need not be computed.
    if (!knowing && !ageing) this.bandOnly = true;
  }

  private stepBand(p: RuleParams): void {
    const { w, h, stones, ninside } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        ninside[i] = stones[i] ? 1 : this.bandRule(x, y, p);
      }
    }
    this.swapBand();
  }

  private swapBand(): void {
    const inside = this.inside;
    this.inside = this.ninside;
    this.ninside = inside;
  }

  /**
   * Tension. A neighbour is inside for this cell when it is inside and holds
   * the same label. The cell looks at one random neighbour and, if that one
   * differs, copies it when that leaves fewer unlike pairs around the cell,
   * or with the Metropolis chance when it leaves more.
   */
  private bandRule(x: number, y: number, p: RuleParams): number {
    const { w, h, inside, label } = this;
    const i = y * w + x;
    const current = inside[i];
    const own = label[i];
    let count = 0;
    let seen = 0;
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
      for (let k = 0; k < 8; k++) {
        const j = i + DY[k] * w + DX[k];
        if (inside[j] && label[j] === own) {
          count++;
          seen |= 1 << k;
        }
      }
    } else {
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (inside[j] && label[j] === own) {
          count++;
          seen |= 1 << k;
        }
      }
    }
    if (count === (current ? 8 : 0)) return current;

    const source = (seen >> ((Math.random() * 8) | 0)) & 1;
    if (source === current) return current;
    const dH = current ? 2 * count - 8 : 8 - 2 * count;
    if (dH > 0 && Math.random() >= Math.exp(-dH / Math.max(p.temperature, 1e-3))) return current;
    return source;
  }

  /** Not part of the rule: the exact hulls the bands are checked against. */
  private measureHulls(): void {
    const { w, h, stones, label } = this;
    const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!stones[i]) continue;
        const box = boxes.get(label[i]);
        if (!box) {
          boxes.set(label[i], { x0: x, y0: y, x1: x, y1: y });
          continue;
        }
        if (x < box.x0) box.x0 = x;
        if (x > box.x1) box.x1 = x;
        if (y > box.y1) box.y1 = y;
      }
    }
    for (const [id, box] of boxes) {
      const cw = box.x1 - box.x0 + 1;
      const ch = box.y1 - box.y0 + 1;
      const own = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const i = (box.y0 + y) * w + box.x0 + x;
          if (stones[i] && label[i] === id) own[y * cw + x] = 1;
        }
      }
      const hull = convexHull(own, cw, ch).map((q) => ({ x: q.x + box.x0, y: q.y + box.y0 }));
      this.hulls.push(hull);
      this.hullArea += polygonArea(hull);
    }
  }
}
