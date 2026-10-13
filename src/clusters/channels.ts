import type { Point } from '../hull.ts';
import { OneRule, type RuleParams } from './onerule.ts';

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * Distances inside a channel are counted in thirds of a cell: a step to a
 * side neighbour costs 3 and a diagonal one 4.
 */
const UNIT = 3;
const COST = [3, 4, 3, 4, 3, 4, 3, 4];
/** The distance of a cell that knows of no stone in its channel. */
const NOWHERE = 60000;

/** Same reach of a young band as in the one rule, in cells. */
const BAND_SLACK = 12;

/**
 * Bands that may overlap, still as one rule applied by every cell at once.
 *
 * In the one rule a cell holds one label, so it belongs to one cluster, and a
 * band stops at the border of its cluster's territory. Here a cell has room
 * for several bands: the state has `count` channels, each with a band of its
 * own, and every cluster keeps its band in one of them. In its channel a band
 * meets only the clusters that share the channel, so it can run over a
 * neighbour that lives in another one.
 *
 * The clusters themselves are found as in the one rule (`base`): nearest
 * stone, depth, label, age. On top of that a cell holds:
 *
 * - **Turn**: how many times its cluster has moved on to the next channel.
 *   The channel of a cluster follows from its label and its turn. A cell
 *   takes the largest turn among the neighbours of its label. Where it meets
 *   a settled neighbour of a smaller label and the same channel, it adds one:
 *   the cluster with the larger label gives way.
 * - Per channel, **distance** to the nearest stone whose cluster is in this
 *   channel: 0 on such a stone, elsewhere the smallest among the neighbours
 *   plus the step. Nothing is kept from the step before, so when a cluster
 *   leaves the channel the distances around it grow until they fit again.
 * - Per channel, **owner**: the label of that stone, taken from the same
 *   neighbour as the distance.
 * - Per channel, **age**: steps since the owner last changed here or nearby.
 * - Per channel, **band**: inside or outside. A cell on a stone of the
 *   channel is inside. A cell whose owner has just changed is inside if it is
 *   close to that stone and outside if not. A young cell close to its stone
 *   is inside. Any other follows tension, as in the one rule, counting cells
 *   of another owner as outside.
 */
export class Channels {
  readonly w: number;
  readonly h: number;
  readonly count: number;
  readonly stones: Uint8Array;
  /** Finds the clusters; its own single band is not used. */
  readonly base: OneRule;
  /** `count` fields one after another: the band and its owner in each channel. */
  inside: Uint8Array;
  owner: Int32Array;

  private turn: Uint8Array;
  private nturn: Uint8Array;
  /** The label a cell's turn was counted for; another label starts from 0. */
  private turnOf: Int32Array;
  private nturnOf: Int32Array;
  private dist: Uint16Array;
  private ndist: Uint16Array;
  private nowner: Int32Array;
  private age: Uint8Array;
  private nage: Uint8Array;
  private ninside: Uint8Array;
  /**
   * While only the bands change: the cells that could change on this step,
   * those with unlike neighbours or next to a cell that has just changed.
   */
  private watch: Uint8Array;
  private nwatch: Uint8Array;
  /** No stone is further than this, so a larger distance leads to none. */
  private readonly horizon: number;
  private fat = 1;
  /** Only the bands can still change: the rest of the rule is a no-op. */
  private bandsOnly = false;

  constructor(w: number, h: number, stones: Uint8Array, count: number) {
    const n = w * h;
    this.w = w;
    this.h = h;
    this.stones = stones;
    this.count = Math.max(1, Math.round(count));
    this.base = new OneRule(w, h, stones);
    this.base.bandUnused = true;
    this.horizon = (w + h) * UNIT;
    const all = n * this.count;
    this.inside = new Uint8Array(all);
    this.ninside = new Uint8Array(all);
    this.owner = new Int32Array(all);
    this.nowner = new Int32Array(all);
    this.dist = new Uint16Array(all);
    this.ndist = new Uint16Array(all);
    this.age = new Uint8Array(all);
    this.nage = new Uint8Array(all);
    this.watch = new Uint8Array(all);
    this.nwatch = new Uint8Array(all);
    this.turn = new Uint8Array(n);
    this.nturn = new Uint8Array(n);
    this.turnOf = new Int32Array(n);
    this.nturnOf = new Int32Array(n);
    this.restart(1);
  }

  get steps(): number {
    return this.base.steps;
  }

  get settling(): boolean {
    return this.base.settling;
  }

  get hulls(): Point[][] {
    return this.base.hulls;
  }

  get hullArea(): number {
    return this.base.hullArea;
  }

  /** The starting state: no cell knows of any stone in any channel. */
  restart(reach: number, bridge = 0): void {
    this.base.restart(reach, bridge);
    this.fat = (Math.max(1, Math.round(reach)) + BAND_SLACK) * UNIT;
    this.inside.fill(0);
    this.owner.fill(0);
    this.dist.fill(NOWHERE);
    this.age.fill(0);
    this.turn.fill(0);
    this.turnOf.fill(0);
    this.bandsOnly = false;
  }

  /** Take in stones added since the last step, without starting over. */
  addStones(): void {
    this.base.addStones();
    this.bandsOnly = false;
  }

  /** Cells inside a band, counted once per band they are inside of. */
  area(): number {
    let n = 0;
    for (let i = 0; i < this.inside.length; i++) n += this.inside[i];
    return n;
  }

  /** How many channels hold at least one cluster. */
  used(): number {
    const { stones, count, dist } = this;
    const n = stones.length;
    let used = 0;
    for (let k = 0; k < count; k++) {
      for (let i = 0; i < n; i++) {
        if (stones[i] && dist[k * n + i] === 0) {
          used++;
          break;
        }
      }
    }
    return used;
  }

  /** One synchronous step of the rule on every cell. */
  step(p: RuleParams): void {
    if (this.bandsOnly) this.stepBands(p);
    else this.stepAll(p);
    // The clusters read nothing of the channels, so their part of the rule
    // can run after it: both have read the same state.
    this.base.step(p);
  }

  private stepAll(p: RuleParams): void {
    const { w, h, count, stones, fat } = this;
    const { turn, nturn, turnOf, nturnOf, dist, ndist, owner, nowner, age, nage, ninside } = this;
    const { label, ages, oldAge: old } = this.base;
    const n = w * h;
    const near = new Int32Array(8);
    const step = new Int32Array(8);
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let m = 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + DX[k];
          const ny = y + DY[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          near[m] = ny * w + nx;
          step[m++] = COST[k];
        }
        const own = label[i];
        const mine = turnOf[i] === own ? turn[i] : 0;

        // The turn: the largest around, and one more to give way.
        let turns = mine;
        for (let q = 0; q < m; q++) {
          const j = near[q];
          if (label[j] === own && turnOf[j] === own && turn[j] > turns) turns = turn[j];
        }
        if (ages[i] >= old && turns < 3 * count) {
          const channel = channelOf(own, turns, count);
          for (let q = 0; q < m; q++) {
            const j = near[q];
            const other = label[j];
            if (other >= own || ages[j] < old) continue;
            if (channelOf(other, turnOf[j] === other ? turn[j] : 0, count) !== channel) continue;
            turns++;
            break;
          }
        }
        if (turns !== turn[i] || own !== turnOf[i]) changed = true;
        nturn[i] = turns;
        nturnOf[i] = own;

        const home = stones[i] ? channelOf(own, mine, count) : -1;
        for (let k = 0; k < count; k++) {
          const c = k * n + i;
          const base = k * n;
          const was = owner[c];
          let d = NOWHERE;
          let holder = 0;
          if (k === home) {
            d = 0;
            holder = own;
          } else {
            for (let q = 0; q < m; q++) {
              const through = dist[base + near[q]] + step[q];
              if (through < d) {
                d = through;
                holder = owner[base + near[q]];
              }
            }
            // A distance that only grows belongs to a stone that has left.
            if (d > this.horizon) {
              d = NOWHERE;
              holder = 0;
            }
          }
          let young = age[c] < old ? age[c] + 1 : old;
          if (holder !== was) young = 0;
          else {
            for (let q = 0; q < m; q++) {
              const j = base + near[q];
              if (owner[j] === was && age[j] + 1 < young) young = age[j] + 1;
            }
          }
          if (d !== dist[c] || holder !== was || young !== age[c]) changed = true;
          ndist[c] = d;
          nowner[c] = holder;
          nage[c] = young;

          if (k === home) ninside[c] = 1;
          else if (was === 0) ninside[c] = 0;
          else if (holder !== was) ninside[c] = d <= fat ? 1 : 0;
          else if (age[c] < old && dist[c] <= fat) ninside[c] = 1;
          else ninside[c] = this.bandRule(base, x, y, p);
        }
      }
    }
    this.swapBands();
    this.watch.fill(1);
    this.turn = nturn;
    this.nturn = turn;
    this.turnOf = nturnOf;
    this.nturnOf = turnOf;
    this.dist = ndist;
    this.ndist = dist;
    this.owner = nowner;
    this.nowner = owner;
    this.age = nage;
    this.nage = age;
    // The bands decide nothing but themselves, so once the rest has stopped
    // it never starts again and need not be computed.
    if (!changed && this.base.still) this.bandsOnly = true;
  }

  /**
   * The rule once only the bands change. A cell whose neighbours all look
   * like it stays as it is, so only the watched cells are worked out.
   */
  private stepBands(p: RuleParams): void {
    const { w, h, count, dist, owner, inside, ninside, watch, nwatch } = this;
    const n = w * h;
    ninside.set(inside);
    nwatch.fill(0);
    for (let k = 0; k < count; k++) {
      const base = k * n;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = base + y * w + x;
          if (!watch[c] || dist[c] === 0 || owner[c] === 0) continue;
          const next = this.bandRule(base, x, y, p);
          if (next === inside[c]) continue;
          ninside[c] = next;
          for (let q = 0; q < 8; q++) {
            const nx = x + DX[q];
            const ny = y + DY[q];
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) nwatch[base + ny * w + nx] = 1;
          }
        }
      }
    }
    this.swapBands();
    this.watch = nwatch;
    this.nwatch = watch;
  }

  private swapBands(): void {
    const inside = this.inside;
    this.inside = this.ninside;
    this.ninside = inside;
  }

  /**
   * Tension within one channel, as in the one rule: a neighbour is inside for
   * this cell when it is inside and has the same owner.
   */
  private bandRule(base: number, x: number, y: number, p: RuleParams): number {
    const { w, h, inside, owner } = this;
    const c = base + y * w + x;
    const current = inside[c];
    const own = owner[c];
    let total = 0;
    let seen = 0;
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
      for (let k = 0; k < 8; k++) {
        const j = c + DY[k] * w + DX[k];
        if (inside[j] && owner[j] === own) {
          total++;
          seen |= 1 << k;
        }
      }
    } else {
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = base + ny * w + nx;
        if (inside[j] && owner[j] === own) {
          total++;
          seen |= 1 << k;
        }
      }
    }
    if (total === (current ? 8 : 0)) return current;
    this.nwatch[c] = 1;

    const source = (seen >> ((Math.random() * 8) | 0)) & 1;
    if (source === current) return current;
    const dH = current ? 2 * total - 8 : 8 - 2 * total;
    if (dH > 0 && Math.random() >= Math.exp(-dH / Math.max(p.temperature, 1e-3))) return current;
    return source;
  }
}

/** The channel a cluster keeps its band in: set by its label, moved on by its turn. */
function channelOf(label: number, turn: number, count: number): number {
  return ((Math.imul(label, 0x9e3779b1) >>> 16) + turn) % count;
}
