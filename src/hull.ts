export interface Point {
  x: number;
  y: number;
}

/**
 * Exact convex hull of the stone cells, in grid coordinates (cell corners).
 * This is the closed-form answer the band should converge to.
 */
export function convexHull(stones: Uint8Array, w: number, h: number): Point[] {
  const pts: Point[] = [];
  for (let y = 0; y < h; y++) {
    let min = -1;
    let max = -1;
    for (let x = 0; x < w; x++) {
      if (!stones[y * w + x]) continue;
      if (min < 0) min = x;
      max = x;
    }
    if (min < 0) continue;
    pts.push({ x: min, y }, { x: min, y: y + 1 });
    pts.push({ x: max + 1, y }, { x: max + 1, y: y + 1 });
  }
  if (pts.length < 3) return [];

  // Andrew's monotone chain.
  pts.sort((p, q) => p.x - q.x || p.y - q.y);
  const hull: Point[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const start = hull.length;
    for (const p of pass === 0 ? pts : pts.slice().reverse()) {
      while (
        hull.length >= start + 2 &&
        cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0
      ) {
        hull.pop();
      }
      hull.push(p);
    }
    hull.pop();
  }
  return hull;
}

export function polygonArea(poly: Point[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) / 2;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
