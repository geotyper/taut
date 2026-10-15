import { along, lengthOf, type Piece } from './lines.ts';

/**
 * A bubble as a smooth closed shell: each of its loops as cubic Béziers, the
 * start point first and then three points a segment, x, y, ..., in cells.
 */
export interface Shell {
  label: number;
  loops: Float32Array[];
}

/**
 * Every bubble as a closed cubic B-spline inside its outline. The control
 * points are the points where its films meet and points spaced about
 * `spacing` apart along each film, moved `inset` cells into the bubble. A
 * B-spline cuts the corners of its control polygon, by more the farther apart
 * its points are, so the shells round off at the junctions as the bubbles of
 * a wet foam do, and the space left between two shells is a film `2·inset`
 * thick that widens into a Plateau border at every junction. The B-spline is
 * written out as the Béziers it is made of, so it can be drawn and saved as
 * vectors as it is.
 */
export function shells(loops: Map<number, Piece[][]>, spacing: number, inset: number): Shell[] {
  const result: Shell[] = [];
  for (const [label, found] of loops) {
    const polygons = found.map((loop) => controlPolygon(loop, spacing));
    const areas = polygons.map(signedArea);
    // The outline is the largest loop; any others are holes, bubbles inside.
    let outer = 0;
    areas.forEach((a, k) => {
      if (Math.abs(a) > Math.abs(areas[outer])) outer = k;
    });
    const out: Float32Array[] = [];
    polygons.forEach((polygon, k) => {
      if (polygon.length < 6) return;
      // Inwards is to the left of the way round where the area is positive.
      const into = Math.sign(areas[k]) * (k === outer ? 1 : -1);
      // A small bubble is not inset by more than a part of its size.
      const depth = k === outer ? Math.min(inset, 0.35 * Math.sqrt(Math.abs(areas[k]) / Math.PI)) : inset;
      out.push(beziers(offset(polygon, into * depth)));
    });
    if (out.length) result.push({ label, loops: out });
  }
  return result;
}

/** The control points round a loop: its corners, and points spaced evenly along each line between. */
function controlPolygon(loop: Piece[], spacing: number): number[] {
  const polygon: number[] = [];
  for (const { line, forward } of loop) {
    const length = lengthOf(line.points);
    const steps = Math.max(1, Math.round(length / spacing));
    // The last point is where the next line starts, so it is left to that one.
    for (let s = 0; s < steps; s++) polygon.push(...along(line.points, forward, (length * s) / steps));
  }
  return polygon;
}

function signedArea(polygon: number[]): number {
  const n = polygon.length / 2;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    sum += polygon[k * 2] * polygon[j * 2 + 1] - polygon[j * 2] * polygon[k * 2 + 1];
  }
  return sum / 2;
}

/** Every point moved this far to the left of the way round, square to the line through its neighbours. */
function offset(polygon: number[], distance: number): number[] {
  const n = polygon.length / 2;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const p = ((k + n - 1) % n) * 2;
    const q = ((k + 1) % n) * 2;
    const tx = polygon[q] - polygon[p];
    const ty = polygon[q + 1] - polygon[p + 1];
    const length = Math.hypot(tx, ty) || 1;
    out.push(polygon[k * 2] - (ty / length) * distance, polygon[k * 2 + 1] + (tx / length) * distance);
  }
  return out;
}

/** A closed uniform cubic B-spline on these control points, as the Béziers it is made of. */
function beziers(q: number[]): Float32Array {
  const n = q.length / 2;
  const at = (k: number, axis: number) => q[((k + n) % n) * 2 + axis];
  const out = new Float32Array(2 + n * 6);
  for (let axis = 0; axis < 2; axis++) out[axis] = (at(-1, axis) + 4 * at(0, axis) + at(1, axis)) / 6;
  for (let k = 0; k < n; k++) {
    for (let axis = 0; axis < 2; axis++) {
      out[2 + k * 6 + axis] = (2 * at(k, axis) + at(k + 1, axis)) / 3;
      out[4 + k * 6 + axis] = (at(k, axis) + 2 * at(k + 1, axis)) / 3;
      out[6 + k * 6 + axis] = (at(k, axis) + 4 * at(k + 1, axis) + at(k + 2, axis)) / 6;
    }
  }
  return out;
}

/** Add a shell's loops to the current path of a canvas, `cell` pixels a cell. */
export function traceShell(ctx: CanvasRenderingContext2D, shell: Shell, cell: number): void {
  for (const b of shell.loops) {
    ctx.moveTo(b[0] * cell, b[1] * cell);
    for (let k = 2; k < b.length; k += 6) {
      ctx.bezierCurveTo(b[k] * cell, b[k + 1] * cell, b[k + 2] * cell, b[k + 3] * cell, b[k + 4] * cell, b[k + 5] * cell);
    }
    ctx.closePath();
  }
}

/** A shell's loops as the d of an SVG path, in cells. */
export function svgPath(shell: Shell): string {
  const f = (v: number) => v.toFixed(2);
  return shell.loops
    .map((b) => {
      let d = `M${f(b[0])} ${f(b[1])}`;
      for (let k = 2; k < b.length; k += 6) {
        d += `C${f(b[k])} ${f(b[k + 1])} ${f(b[k + 2])} ${f(b[k + 3])} ${f(b[k + 4])} ${f(b[k + 5])}`;
      }
      return d + 'Z';
    })
    .join('');
}
