/** A film as a line: its points, flat as x, y, x, y, ..., in cells, and the two labels on its sides. */
export interface FilmLine {
  points: Float32Array;
  a: number;
  b: number;
  /** The corners it starts and ends at, as numbered by the tracing; the same one for a closed line. */
  start: number;
  end: number;
}

/** The label of what lies beyond the edge of the field. */
export const WALL = 0xffff;

/** Rounds of smoothing a traced line gets; each pulls a point halfway to the middle of its neighbours. */
const SMOOTHING = 6;

/**
 * The films of a field as lines. A film runs along the cell edges between
 * unlike cells, so the edges are walked from corner to corner of the cells
 * and joined into lines that end where three films meet or at the wall, or
 * close on themselves. The staircase of the cells is then smoothed away,
 * with the ends held where they are.
 */
export function traceFilms(label: Uint16Array, w: number, h: number): FilmLine[] {
  const cw = w + 1;
  // An edge from the corner (x, y) to (x + 1, y), between the cells above and below it...
  const across = new Uint8Array(cw * (h + 1));
  // ...and from (x, y) to (x, y + 1), between the cells left and right of it.
  const down = new Uint8Array(cw * (h + 1));
  const degree = new Uint8Array(cw * (h + 1));
  // The edge of the field is traced too, so that every bubble is closed round;
  // those lines are not films, and have WALL on one side.
  const at = (x: number, y: number) => (x < 0 || x >= w || y < 0 || y >= h ? WALL : label[y * w + x]);
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y - 1) !== at(x, y)) {
        across[y * cw + x] = 1;
        degree[y * cw + x]++;
        degree[y * cw + x + 1]++;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x <= w; x++) {
      if (at(x - 1, y) !== at(x, y)) {
        down[y * cw + x] = 1;
        degree[y * cw + x]++;
        degree[(y + 1) * cw + x]++;
      }
    }
  }

  const lines: FilmLine[] = [];
  /** The next corner along an unwalked edge from this one, marking the edge walked; -1 if none. */
  const step = (c: number): number => {
    if (across[c] === 1) {
      across[c] = 2;
      return c + 1;
    }
    if (c % cw > 0 && across[c - 1] === 1) {
      across[c - 1] = 2;
      return c - 1;
    }
    if (down[c] === 1) {
      down[c] = 2;
      return c + cw;
    }
    if (c >= cw && down[c - cw] === 1) {
      down[c - cw] = 2;
      return c - cw;
    }
    return -1;
  };
  /** The two labels beside the edge from corner c to corner d. */
  const sides = (c: number, d: number): [number, number] => {
    const x = Math.min(c, d) % cw;
    const y = Math.floor(Math.min(c, d) / cw);
    return Math.abs(d - c) === 1 ? [at(x, y - 1), at(x, y)] : [at(x - 1, y), at(x, y)];
  };
  // The corners of the field end lines too, so that the edge is not rounded off.
  const fieldCorner = (c: number) => (c % cw === 0 || c % cw === w) && (c < cw || c >= h * cw);
  const end = (c: number) => degree[c] !== 2 || fieldCorner(c);
  const walk = (start: number, closed: boolean): void => {
    const corners = [start];
    let c = start;
    for (;;) {
      const next = step(c);
      if (next < 0) break;
      corners.push(next);
      c = next;
      if (end(c)) break;
    }
    if (corners.length < 2) return;
    const [a, b] = sides(corners[0], corners[1]);
    const points = new Float32Array(corners.length * 2);
    for (let k = 0; k < corners.length; k++) {
      points[k * 2] = corners[k] % cw;
      points[k * 2 + 1] = Math.floor(corners[k] / cw);
    }
    smooth(points, closed);
    lines.push({ points, a, b, start: corners[0], end: corners[corners.length - 1] });
  };

  // Lines from the ends: corners where three films meet, or one runs into the wall.
  for (let c = 0; c < degree.length; c++) {
    if (degree[c] === 0 || !end(c)) continue;
    for (let k = 0; k < degree[c]; k++) walk(c, false);
  }
  // What is left are films closed on themselves: a bubble inside another.
  for (let c = 0; c < degree.length; c++) {
    if (degree[c] === 2) walk(c, true);
  }
  return lines;
}

/** Pull every point towards the middle of its neighbours; the ends of an open line stay. */
function smooth(points: Float32Array, closed: boolean): void {
  const n = points.length / 2;
  if (n < 3) return;
  const copy = new Float32Array(points.length);
  for (let round = 0; round < SMOOTHING; round++) {
    copy.set(points);
    for (let k = 0; k < n; k++) {
      let before = k - 1;
      let after = k + 1;
      if (closed) {
        // The first and last corners of a closed line are the same one.
        if (k === 0 || k === n - 1) {
          before = n - 2;
          after = 1;
        }
      } else if (k === 0 || k === n - 1) continue;
      for (let axis = 0; axis < 2; axis++) {
        const middle = (copy[before * 2 + axis] + copy[after * 2 + axis]) / 2;
        points[k * 2 + axis] = (copy[k * 2 + axis] + middle) / 2;
      }
    }
  }
}

/**
 * The outline of every bubble, made of the lines round it: for a label, its
 * lines joined end to end into closed loops. A bubble with another inside it
 * gets two loops, to be filled with the even-odd rule.
 */
export function outlines(lines: FilmLine[]): Map<number, Float32Array[][]> {
  const byLabel = new Map<number, FilmLine[]>();
  for (const line of lines) {
    for (const side of [line.a, line.b]) {
      if (side === WALL) continue;
      let own = byLabel.get(side);
      if (!own) byLabel.set(side, (own = []));
      own.push(line);
    }
  }
  const result = new Map<number, Float32Array[][]>();
  for (const [label, own] of byLabel) {
    // Which of its lines meet at each corner.
    const meeting = new Map<number, number[]>();
    own.forEach((line, k) => {
      for (const corner of [line.start, line.end]) {
        const list = meeting.get(corner);
        if (list) list.push(k);
        else meeting.set(corner, [k]);
      }
    });
    const used = new Uint8Array(own.length);
    const loops: Float32Array[][] = [];
    for (let first = 0; first < own.length; first++) {
      if (used[first]) continue;
      // Round the loop from the start of its first line until it is back there.
      const loop: Float32Array[] = [];
      const home = own[first].start;
      let k = first;
      let from = home;
      for (;;) {
        used[k] = 1;
        const line = own[k];
        const forward = line.start === from;
        loop.push(forward ? line.points : reversed(line.points));
        const to = forward ? line.end : line.start;
        if (to === home) break;
        const next = (meeting.get(to) ?? []).find((j) => !used[j]);
        if (next === undefined) break;
        k = next;
        from = to;
      }
      loops.push(loop);
    }
    result.set(label, loops);
  }
  return result;
}

function reversed(points: Float32Array): Float32Array {
  const out = new Float32Array(points.length);
  for (let k = 0; k < points.length; k += 2) {
    out[k] = points[points.length - 2 - k];
    out[k + 1] = points[points.length - 1 - k];
  }
  return out;
}
