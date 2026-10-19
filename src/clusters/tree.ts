import { Spread } from './clusters.ts';

/** A cluster in the tree: a stone, or two clusters merged at a radius. */
export interface TreeNode {
  /** The cluster radius it is made at: 0 for a stone. */
  height: number;
  /** The two it is merged from, or -1 for a stone. */
  left: number;
  right: number;
  /** The node it merges into, or -1 while it has not. */
  parent: number;
  /** Stone cells in it. */
  size: number;
  /** Its colour, a stone's own or the larger half's, so a cluster keeps its colour as it grows. */
  colour: number;
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * The merge tree of the clusters, from a sweep of the radius. The same wave
 * as the clusters' first stage, let run on: after t steps it has grown every
 * stone by a disc of radius t, and two clusters at radius t are two grown
 * blobs that touch. Every cell the wave reaches joins the blobs round it,
 * and where it joins two that were apart, they merge at that radius: the
 * whole single-linkage dendrogram, one level a step.
 */
export class MergeTree {
  readonly w: number;
  readonly h: number;
  readonly nodes: TreeNode[] = [];
  /** The radius the wave has reached. */
  radius = 0;
  /** Clusters still apart. */
  roots = 0;
  done = false;

  private readonly spread: Spread;
  /** A union-find over the cells reached: each cell's parent, or -1 not yet reached. */
  private readonly up: Int32Array;
  /** The node of the blob a root cell stands for, or -1 for none yet. */
  private readonly nodeOf: Int32Array;
  private readonly fresh: Int32Array;

  constructor(w: number, h: number, stones: Uint8Array, most: number) {
    this.w = w;
    this.h = h;
    this.spread = new Spread(w, h, stones, most);
    this.up = new Int32Array(w * h).fill(-1);
    this.nodeOf = new Int32Array(w * h).fill(-1);
    this.fresh = new Int32Array(w * h);
    // The stones, each joined piece of them a leaf.
    for (let i = 0; i < stones.length; i++) if (stones[i]) this.up[i] = i;
    for (let i = 0; i < stones.length; i++) if (stones[i]) this.joinRound(i);
    for (let i = 0; i < stones.length; i++) {
      if (!stones[i]) continue;
      const r = this.root(i);
      if (this.nodeOf[r] < 0) {
        this.nodeOf[r] = this.nodes.length;
        this.nodes.push({ height: 0, left: -1, right: -1, parent: -1, size: 0, colour: this.nodes.length });
      }
      this.nodes[this.nodeOf[r]].size++;
    }
    this.roots = this.nodes.length;
    this.done = this.roots <= 1;
  }

  /** The wave one cell further, and the blobs it joins merged. */
  step(): void {
    if (this.done) return;
    const { up, spread, fresh } = this;
    spread.step();
    this.radius++;
    let count = 0;
    for (let i = 0; i < up.length; i++) {
      if (up[i] < 0 && spread.reached(i)) {
        up[i] = i;
        fresh[count++] = i;
      }
    }
    for (let k = 0; k < count; k++) this.joinRound(fresh[k]);
    if (this.roots <= 1 || this.radius >= Math.max(this.w, this.h)) this.done = true;
  }

  /** The node of the cluster a cell is in now, or -1 if the wave has not reached it. */
  clusterAt(i: number): number {
    return this.up[i] < 0 ? -1 : this.nodeOf[this.root(i)];
  }

  /** The clusters at a radius: the nodes made at or below it whose merge is above it. */
  cut(radius: number): number[] {
    const { nodes } = this;
    const out: number[] = [];
    nodes.forEach((n, k) => {
      if (n.height <= radius && (n.parent < 0 || nodes[n.parent].height > radius)) out.push(k);
    });
    return out;
  }

  /** The nodes not yet merged into another, by the order of their stones in the field. */
  tops(): number[] {
    const out: number[] = [];
    this.nodes.forEach((n, k) => {
      if (n.parent < 0) out.push(k);
    });
    return out;
  }

  private joinRound(i: number): void {
    const { w, h, up } = this;
    const x = i % w;
    const y = (i - x) / w;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (up[j] >= 0) this.join(i, j);
    }
  }

  private join(a: number, b: number): void {
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra === rb) return;
    const { nodeOf, nodes, up } = this;
    const na = nodeOf[ra];
    const nb = nodeOf[rb];
    up[rb] = ra;
    if (na < 0) nodeOf[ra] = nb;
    else if (nb >= 0) {
      // Two clusters apart until now: they merge at this radius.
      const k = nodes.length;
      const big = nodes[na].size >= nodes[nb].size ? na : nb;
      nodes.push({
        height: this.radius,
        left: na,
        right: nb,
        parent: -1,
        size: nodes[na].size + nodes[nb].size,
        colour: nodes[big].colour,
      });
      nodes[na].parent = k;
      nodes[nb].parent = k;
      nodeOf[ra] = k;
      this.roots--;
    }
  }

  private root(i: number): number {
    const { up } = this;
    while (up[i] !== i) i = up[i] = up[up[i]];
    return i;
  }
}
