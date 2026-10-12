import { convexHull, polygonArea, type Point } from '../hull.ts';
import { Sim } from '../sim.ts';

/** Squared distance of a cell the wave has not reached. */
const FAR = 0x7fffffff;

/**
 * How much further than the cluster radius a band starts from its stones, in
 * cells. Keeps the starting blob fat where two stones are only just linked.
 */
const BAND_SLACK = 12;

/** Steps the labelled blobs swell by before a single field is pulled taut. */
const SWELL_STEPS = 6;

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

export type Stage = 'spread' | 'label' | 'swell' | 'bands';

/** How the bands are kept apart once the clusters are known. */
export type Layout = 'layers' | 'field';

/** One cluster on a layer of its own: a small field cut out at (x0, y0). */
export interface Band {
  /** The settled label of the cluster; stable while its stones are. */
  id: number;
  sim: Sim;
  x0: number;
  y0: number;
}

/** Parameters of the many-label Potts model run on the single field. */
export interface FieldParams {
  /** Metropolis temperature. */
  temperature: number;
  /**
   * Energy of a pair of cells with two different labels, in units of a
   * label-outside pair. Above 2 the outside phase seeps in between two bands
   * and they stay apart; below 2 they stick like soap bubbles.
   */
  repulsion: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A rubber band per group of stones, in stages of local rules: a wave grows
 * every stone by the cluster radius, the grown blobs agree on a label each
 * (every cell takes the smallest label around it), and each label is then
 * pulled taut around its stones only. Stones closer than two radii end up
 * under a common band.
 *
 * The last stage comes in two layouts. In 'layers' every label gets a field of
 * its own, so the bands are independent and may cross. In 'field' everything
 * stays on the one field: the label is the cell state, and one Potts model
 * with as many states as there are labels tightens all the bands at once.
 */
export class Clusters {
  readonly w: number;
  readonly h: number;
  readonly stones: Uint8Array;
  stage: Stage = 'spread';
  layout: Layout = 'layers';
  steps = 0;
  spread: Spread;
  /**
   * 0 outside, otherwise the label the cell holds now. In the 'field' layout
   * this is the whole state of the bands.
   */
  label: Int32Array;
  /** The layers of the 'layers' layout; empty in the 'field' layout. */
  bands: Band[] = [];
  /** Exact convex hull of every cluster's stones, to check against. */
  hulls: Point[][] = [];
  hullArea = 0;

  private next: Int32Array;
  private readonly front: Int32Array;
  private reach = 1;
  private seed = 0x9e3779b9;

  constructor(w: number, h: number, stones: Uint8Array) {
    this.w = w;
    this.h = h;
    this.stones = stones;
    this.label = new Int32Array(w * h);
    this.next = new Int32Array(w * h);
    this.front = new Int32Array(w * h);
    this.spread = new Spread(w, h, stones, 1);
  }

  /** Start over from the stones with the given cluster radius, in cells. */
  restart(reach: number, layout: Layout = this.layout): void {
    this.reach = Math.max(1, Math.round(reach));
    this.layout = layout;
    this.spread = new Spread(this.w, this.h, this.stones, this.reach);
    this.stage = 'spread';
    this.steps = 0;
    this.bands = [];
    this.hulls = [];
    this.hullArea = 0;
  }

  /** One step of the stages before the bands; those are stepped by the caller. */
  step(): void {
    if (this.stage === 'spread') {
      if (this.spread.step()) this.steps++;
      else this.startLabels();
    } else if (this.stage === 'label') {
      if (this.stepLabels()) this.steps++;
      else if (this.layout === 'layers') this.startLayers();
      else this.startSwell();
    } else if (this.stage === 'swell') {
      this.stepSwell();
      if (++this.steps >= SWELL_STEPS) this.startBands();
    }
  }

  /** Cells inside any band. */
  area(): number {
    let n = 0;
    if (this.layout === 'layers') {
      for (const band of this.bands) n += band.sim.area();
    } else {
      for (let i = 0; i < this.label.length; i++) if (this.label[i]) n++;
    }
    return n;
  }

  /**
   * 'field' layout: one Monte Carlo sweep of a Potts model whose states are
   * the outside and the labels. A front cell copies the state of a random
   * neighbour by the Metropolis rule; energy = unlike Moore pairs, a pair of
   * two different labels costing `repulsion`. Stones keep their label.
   */
  stepField(p: FieldParams): void {
    const { w, h, label, stones, front } = this;
    let n = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (stones[i]) continue;
        const s = label[i];
        if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
          if (
            label[i - w - 1] !== s || label[i - w] !== s || label[i - w + 1] !== s ||
            label[i - 1] !== s || label[i + 1] !== s ||
            label[i + w - 1] !== s || label[i + w] !== s || label[i + w + 1] !== s
          ) {
            front[n++] = i;
          }
        } else {
          for (let d = 0; d < 8; d++) {
            if (this.at(x + DX[d], y + DY[d]) === s) continue;
            front[n++] = i;
            break;
          }
        }
      }
    }
    if (n === 0) return;

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
      const source = this.at(x + DX[dir], y + DY[dir]);
      const current = label[i];
      if (source === current) continue;

      let dH = 0;
      for (let d = 0; d < 8; d++) {
        const other = this.at(x + DX[d], y + DY[d]);
        if (other !== source) dH += other === 0 || source === 0 ? 1 : p.repulsion;
        if (other !== current) dH -= other === 0 || current === 0 ? 1 : p.repulsion;
      }
      if (dH > 0 && Math.random() >= Math.exp(-dH * beta)) continue;
      label[i] = source;
    }
    this.seed = s;
    this.steps++;
  }

  /** The label at a cell; everything beyond the field is outside. */
  private at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.label[y * this.w + x];
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

  private startSwell(): void {
    this.stage = 'swell';
    this.steps = 0;
  }

  /**
   * An outside cell joins a label next to it, unless it sees two different
   * labels: that keeps a gap between clusters while each blob gets fatter
   * where two of its stones are only just linked. Odd steps join across
   * edges only, so the blobs grow as octagons rather than squares.
   */
  private stepSwell(): void {
    const { w, h, label, next } = this;
    const edgesOnly = this.steps % 2 === 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let found = label[i];
        if (found === 0) {
          let seen = 0;
          for (let k = 0; k < 8; k++) {
            const other = this.at(x + DX[k], y + DY[k]);
            if (other === 0) continue;
            if (seen !== 0 && other !== seen) {
              seen = -1;
              break;
            }
            seen = other;
            if (!edgesOnly || k % 2 === 0) found = other;
          }
          if (seen === -1) found = 0;
        }
        next[i] = found;
      }
    }
    this.label = next;
    this.next = label;
  }

  /** 'field' layout: the swollen labels are the bands; only the hulls are left. */
  private startBands(): void {
    for (const [id, box] of this.boxes()) {
      this.addHull(this.ownStones(id, box), box);
    }
    this.stage = 'bands';
    this.steps = 0;
  }

  /** 'layers' layout: cut every cluster out into a field of its own. */
  private startLayers(): void {
    const { w, h } = this;
    const pad = this.reach + BAND_SLACK;
    for (const [id, tight] of this.boxes()) {
      const box = {
        x0: Math.max(0, tight.x0 - pad),
        y0: Math.max(0, tight.y0 - pad),
        x1: Math.min(w - 1, tight.x1 + pad),
        y1: Math.min(h - 1, tight.y1 + pad),
      };
      const cw = box.x1 - box.x0 + 1;
      const ch = box.y1 - box.y0 + 1;
      const own = this.ownStones(id, box);

      // The band starts as the cluster's stones grown into one fat blob.
      const blob = new Spread(cw, ch, own, pad);
      while (blob.step());
      const sim = new Sim(cw, ch, own);
      for (let i = 0; i < own.length; i++) sim.phase[i] = blob.reached(i) ? 1 : 0;

      this.bands.push({ id, sim, x0: box.x0, y0: box.y0 });
      this.addHull(own, box);
    }
    this.stage = 'bands';
    this.steps = 0;
  }

  /** Bounding box of the stones of every label. */
  private boxes(): Map<number, Box> {
    const { w, h, stones, label } = this;
    const boxes = new Map<number, Box>();
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
    return boxes;
  }

  /** The stones of one label, cut out to the given box. */
  private ownStones(id: number, box: Box): Uint8Array {
    const { w, stones, label } = this;
    const cw = box.x1 - box.x0 + 1;
    const ch = box.y1 - box.y0 + 1;
    const own = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (box.y0 + y) * w + box.x0 + x;
        if (stones[i] && label[i] === id) own[y * cw + x] = 1;
      }
    }
    return own;
  }

  private addHull(own: Uint8Array, box: Box): void {
    const cw = box.x1 - box.x0 + 1;
    const ch = box.y1 - box.y0 + 1;
    const hull = convexHull(own, cw, ch).map((p) => ({ x: p.x + box.x0, y: p.y + box.y0 }));
    this.hulls.push(hull);
    this.hullArea += polygonArea(hull);
  }
}
