import type { Skeleton } from './skeleton.ts';

/** A field of distances to the skeleton, for the renderer to draw tubes round. */
export interface TubeField {
  /** Two bytes a texel, x fastest: distance to the nearest line, then to the nearest point where four meet. */
  data: Uint8Array;
  /** Texels a side. */
  size: number;
  /** A byte of 255 stands for this distance, in field cells, or more. */
  reach: number;
}

/** A curve between two points of a line is cut into this many straight pieces. */
const PIECES = 3;

/**
 * Distances to the lines of a skeleton and to its points, out to `reach`
 * cells, on a grid `scale` times finer than the field. The lines are bent
 * through the midpoints between their points, as the lines view draws them,
 * so the tubes come out as smooth as the lines.
 */
export function tubeField(skeleton: Skeleton, n: number, scale: number, reach: number): TubeField {
  const size = n * scale;
  const data = new Uint8Array(size * size * size * 2).fill(255);
  const toByte = 255 / reach;

  /** Mark the distance from every texel within reach to the segment a-b in one channel. */
  const splat = (a: number[], b: number[], channel: number) => {
    const lo = [0, 1, 2].map((k) => Math.max(0, Math.floor((Math.min(a[k], b[k]) - reach) * scale)));
    const hi = [0, 1, 2].map((k) => Math.min(size - 1, Math.ceil((Math.max(a[k], b[k]) + reach) * scale)));
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
    for (let z = lo[2]; z <= hi[2]; z++) {
      const pz = (z + 0.5) / scale - a[2];
      for (let y = lo[1]; y <= hi[1]; y++) {
        const py = (y + 0.5) / scale - a[1];
        let at = ((z * size + y) * size + lo[0]) * 2 + channel;
        for (let x = lo[0]; x <= hi[0]; x++, at += 2) {
          const px = (x + 0.5) / scale - a[0];
          const s = Math.max(0, Math.min(1, (px * d[0] + py * d[1] + pz * d[2]) / dd));
          const ex = px - s * d[0];
          const ey = py - s * d[1];
          const ez = pz - s * d[2];
          const byte = Math.sqrt(ex * ex + ey * ey + ez * ez) * toByte;
          if (byte < data[at]) data[at] = byte;
        }
      }
    }
  };

  for (const { points } of skeleton.lines) {
    for (const piece of curve(points)) splat(piece[0], piece[1], 0);
  }
  for (const p of skeleton.points) splat(p, p, 1);
  return { data, size, reach };
}

/** The line bent through the midpoints between its points, as short straight pieces. */
function curve(points: number[][]): number[][][] {
  if (points.length < 3) return points.length === 2 ? [[points[0], points[1]]] : [];
  const mid = (a: number[], b: number[]) => [0, 1, 2].map((k) => (a[k] + b[k]) / 2);
  const pieces: number[][][] = [];
  let from = points[0];
  const last = points.length - 1;
  for (let k = 1; k < last; k++) {
    const to = k === last - 1 ? points[last] : mid(points[k], points[k + 1]);
    const control = points[k];
    let previous = from;
    for (let i = 1; i <= PIECES; i++) {
      const t = i / PIECES;
      const u = 1 - t;
      const next = [0, 1, 2].map((a) => u * u * from[a] + 2 * u * t * control[a] + t * t * to[a]);
      pieces.push([previous, next]);
      previous = next;
    }
    from = to;
  }
  return pieces;
}
