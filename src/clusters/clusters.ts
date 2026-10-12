import { convexHull, polygonArea, type Point } from '../hull.ts';
import { Sim } from '../sim.ts';

/** Squared distance of a cell the wave has not reached. */
const FAR = 0x7fffffff;

/**
 * How much further than the cluster radius a band starts from its stones, in
 * cells. Keeps the starting blob fat where two stones are only just linked.
 */
const BAND_SLACK = 12;

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * Wave from the seeds: every cell keeps the offset to the nearest seed it has
 * heard of and each step takes a shorter one from its 8 neighbours, as long as
 * it stays within `reach`. The front may move one cell of distance per step,
 * so it stays round. Settles on the seeds grown by a disc of that radius.
 */
export class Spread {
  readonly w: number;
  readonly h: number;
  private readonly reach: number;
  private time = 0;
  private d2: Int32Array;
  private ox: Int16Array;
  private oy: Int16Array;
  private nd2: Int32Array;
  private nox: Int16Array;
  private noy: Int16Array;

  constructor(w: number, h: number, seeds: Uint8Array, reach: number) {
    this.w = w;
    this.h = h;
    this.reach = reach;
    this.d2 = new Int32Array(w * h);
    this.ox = new Int16Array(w * h);
    this.oy = new Int16Array(w * h);
    this.nd2 = new Int32Array(w * h);
    this.nox = new Int16Array(w * h);
    this.noy = new Int16Array(w * h);
    for (let i = 0; i < seeds.length; i++) this.d2[i] = seeds[i] ? 0 : FAR;
  }

  reached(i: number): boolean {
    return this.d2[i] !== FAR;
  }

  /** One synchronous step. Returns false once nothing changes any more. */
  step(): boolean {
    const { w, h, d2, ox, oy, nd2, nox, noy } = this;
    const limit = Math.min(++this.time, this.reach) ** 2;
    let changed = this.time < this.reach;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let best = d2[i];
        let bx = ox[i];
        let by = oy[i];
        if (best !== 0) {
          for (let k = 0; k < 8; k++) {
            const nx = x + DX[k];
            const ny = y + DY[k];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (d2[j] === FAR) continue;
            const cx = ox[j] + DX[k];
            const cy = oy[j] + DY[k];
            const c = cx * cx + cy * cy;
            if (c < best && c <= limit) {
              best = c;
              bx = cx;
              by = cy;
            }
          }
          if (best !== d2[i]) changed = true;
        }
        nd2[i] = best;
        nox[i] = bx;
        noy[i] = by;
      }
    }
    this.d2 = nd2;
    this.ox = nox;
    this.oy = noy;
    this.nd2 = d2;
    this.nox = ox;
    this.noy = oy;
    return changed;
  }
}

export type Stage = 'spread' | 'label' | 'bands';

/** One cluster: its own small field, cut out of the big one at (x0, y0). */
export interface Band {
  /** The settled label of the cluster; stable while its stones are. */
  id: number;
  sim: Sim;
  x0: number;
  y0: number;
  /** Exact convex hull of the cluster's stones, in big-field coordinates. */
  hull: Point[];
  hullArea: number;
}

/**
 * A rubber band per group of stones, in three stages of local rules:
 * a wave grows every stone by the cluster radius, the grown blobs agree on a
 * label each (every cell takes the smallest label around it), and each label
 * then gets a band of its own that is pulled taut around its stones only.
 * Stones closer than two radii end up under a common band.
 */
export class Clusters {
  readonly w: number;
  readonly h: number;
  readonly stones: Uint8Array;
  stage: Stage = 'spread';
  steps = 0;
  spread: Spread;
  /** 0 outside the grown stones, otherwise the label the cell holds now. */
  label: Int32Array;
  bands: Band[] = [];

  private next: Int32Array;
  private reach = 1;

  constructor(w: number, h: number, stones: Uint8Array) {
    this.w = w;
    this.h = h;
    this.stones = stones;
    this.label = new Int32Array(w * h);
    this.next = new Int32Array(w * h);
    this.spread = new Spread(w, h, stones, 1);
  }

  /** Start over from the stones with the given cluster radius, in cells. */
  restart(reach: number): void {
    this.reach = Math.max(1, Math.round(reach));
    this.spread = new Spread(this.w, this.h, this.stones, this.reach);
    this.stage = 'spread';
    this.steps = 0;
    this.bands = [];
  }

  /** One step of the wave or of the labelling; the bands are stepped by the caller. */
  step(): void {
    if (this.stage === 'spread') {
      if (this.spread.step()) this.steps++;
      else this.startLabels();
    } else if (this.stage === 'label') {
      if (this.stepLabels()) this.steps++;
      else this.startBands();
    }
  }

  private startLabels(): void {
    const { label, spread } = this;
    for (let i = 0; i < label.length; i++) label[i] = spread.reached(i) ? i + 1 : 0;
    this.stage = 'label';
    this.steps = 0;
  }

  private stepLabels(): boolean {
    const { w, h, label, next } = this;
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let best = label[i];
        if (best !== 0) {
          for (let k = 0; k < 8; k++) {
            const nx = x + DX[k];
            const ny = y + DY[k];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const other = label[ny * w + nx];
            if (other !== 0 && other < best) best = other;
          }
          if (best !== label[i]) changed = true;
        }
        next[i] = best;
      }
    }
    this.label = next;
    this.next = label;
    return changed;
  }

  private startBands(): void {
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

    const pad = this.reach + BAND_SLACK;
    this.bands = [];
    for (const [id, box] of boxes) {
      const x0 = Math.max(0, box.x0 - pad);
      const y0 = Math.max(0, box.y0 - pad);
      const cw = Math.min(w - 1, box.x1 + pad) - x0 + 1;
      const ch = Math.min(h - 1, box.y1 + pad) - y0 + 1;
      const own = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const i = (y0 + y) * w + x0 + x;
          if (stones[i] && label[i] === id) own[y * cw + x] = 1;
        }
      }

      // The band starts as the cluster's stones grown into one fat blob.
      const blob = new Spread(cw, ch, own, pad);
      while (blob.step());
      const sim = new Sim(cw, ch, own);
      for (let i = 0; i < own.length; i++) sim.phase[i] = blob.reached(i) ? 1 : 0;

      const hull = convexHull(own, cw, ch).map((p) => ({ x: p.x + x0, y: p.y + y0 }));
      this.bands.push({ id, sim, x0, y0, hull, hullArea: polygonArea(hull) });
    }
    this.stage = 'bands';
    this.steps = 0;
  }
}
