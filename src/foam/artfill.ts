import { traceShell, svgPath, type Shell } from './shells.ts';

/** Fills for the spline shells made for pictures, the more so in a mirror. */
export type ArtFill = 'glow' | 'neon' | 'rings' | 'glass' | 'hatch' | 'engrave' | 'shaped';

export const ART_FILLS: readonly string[] = ['glow', 'neon', 'rings', 'glass', 'hatch', 'engrave', 'shaped'];

/** The fills drawn in ink on paper, which may leave large bubbles out or draw them otherwise. */
export const INK_FILLS: readonly string[] = ['hatch', 'engrave', 'shaped'];

/** What becomes of a large bubble in an ink fill: drawn as the others, left blank, or in contour lines. */
export type Large = 'same' | 'blank' | 'contours';

/**
 * How far every cell of the field is from the edge of its bubble, in cells,
 * and the farthest any cell of each bubble is: its half width, the height
 * its dome is given.
 */
export interface Relief {
  w: number;
  h: number;
  label: Uint16Array;
  depth: Float32Array;
  top: Float32Array;
}

/** What a fill needs of a bubble besides its shell. */
export interface ArtBubble {
  shell: Shell;
  /** Its own colour, r, g, b in 0..255. */
  colour: readonly number[];
  /** A number of its own in 0..1, for what a fill turns by it. */
  turn: number;
  /** Bubbles it shares a film with. */
  sides: number;
  /** The field's relief, for the fills that follow a bubble's shape. */
  relief?: Relief;
  /** Drawn otherwise for being large, in the ink fills. */
  large?: Large;
}

/** The leading between the panes of the stained glass. */
export const LEAD = '#17141c';
const PAPER = '#f3efe6';
const INK = '#16130f';
const NIGHT = '#040406';

/**
 * The colours a fill is drawn in besides its own: the liquid between the
 * shells, the inside of a shell under the fill, and the outline drawn over
 * it ('own' in the bubble's colour, or none, the neon drawing its own).
 */
export function lookOf(fill: ArtFill, liquid: string, inside: string): { liquid: string; inside: string; outline: string | null; width: number } {
  if (fill === 'glass') return { liquid: LEAD, inside, outline: LEAD, width: 1.5 };
  if (INK_FILLS.includes(fill)) return { liquid: PAPER, inside: PAPER, outline: INK, width: 1.2 };
  if (fill === 'neon') return { liquid: NIGHT, inside: NIGHT, outline: null, width: 1 };
  return { liquid, inside, outline: 'own', width: 1 };
}

/** Colours of the stained glass by sides, from three up to nine and more. */
const BY_SIDES = [
  [214, 52, 58],
  [236, 120, 40],
  [242, 190, 54],
  [48, 170, 120],
  [52, 120, 214],
  [130, 74, 206],
  [204, 64, 168],
];

/** Middle of a bubble's outline and the radius of a disc of its area, in cells. */
export function centreOf(shell: Shell): { x: number; y: number; r: number } {
  let best = { x: 0, y: 0, area: 0 };
  for (const b of shell.loops) {
    let area = 0;
    let x = 0;
    let y = 0;
    // The ends of the Béziers are on the curve, close enough to stand for it.
    const n = (b.length - 2) / 6;
    for (let k = 0; k < n; k++) {
      const i = 6 * k;
      const j = 6 * (k + 1);
      const cross = b[i] * b[j + 1] - b[j] * b[i + 1];
      area += cross;
      x += (b[i] + b[j]) * cross;
      y += (b[i + 1] + b[j + 1]) * cross;
    }
    if (Math.abs(area) > Math.abs(best.area)) best = { x: x / (3 * area), y: y / (3 * area), area };
  }
  return { x: best.x, y: best.y, r: Math.sqrt(Math.abs(best.area) / 2 / Math.PI) };
}

export function sidesColour(sides: number): readonly number[] {
  return BY_SIDES[Math.max(0, Math.min(BY_SIDES.length - 1, sides - 3))];
}

const rgba = (c: readonly number[], a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (c: readonly number[], to: number, t: number) => c.map((v) => v + (to - v) * t);

/** The neon tube: soft halos widening out, the coloured glass, and a core near white. */
const NEON: [width: number, alpha: number, white: number][] = [
  [16, 0.07, 0],
  [10, 0.12, 0],
  [6, 0.2, 0.05],
  [3.2, 0.4, 0.15],
  [1.8, 0.85, 0.35],
  [0.8, 1, 0.75],
];

/** Widths of the engraved strokes, thin in the light to thick in the shade, as shares of a line. */
const ENGRAVE_WIDTHS = [0.3, 0.6, 0.95, 1.35, 1.8];

/**
 * The strokes of an engraving of a bubble as if it were a dome lit from the
 * upper left: parallel lines at an angle of its own that bow over the dome,
 * as lines drawn across a round thing do, each piece as thick as the shade
 * there. In whatever unit the centre and radius come in; by width, as x1,
 * y1, x2, y2 runs.
 */
function engraving(x: number, y: number, r: number, turn: number, gap: number): number[][] {
  const out = ENGRAVE_WIDTHS.map(() => [] as number[]);
  const angle = turn * Math.PI;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  // The light, from the upper left and in front.
  const lx = -0.5;
  const ly = -0.65;
  const lz = 0.57;
  const reach = 1.5 * r;
  const step = Math.max(gap / 2, reach / 24);
  const point = (s: number, t: number) => {
    const px = ux * s - uy * t;
    const py = uy * s + ux * t;
    const rho = (px * px + py * py) / (r * r);
    const h = rho < 1 ? Math.sqrt(1 - rho) : 0;
    // The line is lifted over the dome and seen from a little below, so it bows.
    const lift = 0.45 * r * h;
    const nx = rho < 1 ? px / r : 0;
    const ny = rho < 1 ? py / r : 0;
    const nz = rho < 1 ? h : 1;
    const shade = 1 - Math.max(0, nx * lx + ny * ly + nz * lz);
    return [x + px - uy * lift, y + py + ux * lift, shade];
  };
  for (let t = -reach; t <= reach; t += gap) {
    let last = point(-reach, t);
    for (let s = -reach + step; s <= reach + 1e-9; s += step) {
      const next = point(s, t);
      const shade = (last[2] + next[2]) / 2;
      const k = Math.min(ENGRAVE_WIDTHS.length - 1, Math.floor(shade * ENGRAVE_WIDTHS.length));
      out[k].push(last[0], last[1], next[0], next[1]);
      last = next;
    }
  }
  return out;
}

/**
 * The relief of a field of labels: the distance from every cell to the
 * nearest cell of another bubble or the wall, by the exact transform of
 * Felzenszwalb and Huttenlocher, a column and then a row pass.
 */
export function reliefOf(label: Uint16Array, w: number, h: number, labels: number): Relief {
  const INF = 1e20;
  const sq = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = label[i];
      const edge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        label[i - 1] !== l || label[i + 1] !== l || label[i - w] !== l || label[i + w] !== l;
      sq[i] = edge ? 0 : INF;
    }
  }
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass = (count: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < count; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < count; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = sq[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) sq[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = sq[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) sq[y * w + x] = d[x];
  }
  const depth = new Float32Array(w * h);
  const top = new Float32Array(labels + 1);
  for (let i = 0; i < depth.length; i++) {
    // An edge cell is half a cell from the edge itself.
    depth[i] = Math.sqrt(sq[i]) + 0.5;
    if (depth[i] > top[label[i]]) top[label[i]] = depth[i];
  }
  return { w, h, label, depth, top };
}

/** The height of a bubble's dome at a point, in cells: a quarter circle up from its edge to its half width. */
function heightAt(relief: Relief, own: number, x: number, y: number): number {
  const { w, h, label, depth, top } = relief;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= w || cy >= h || label[cy * w + cx] !== own) return 0;
  // Between the centres of the cells, of those that are the bubble's own.
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.max(0, Math.min(w - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  let sum = 0;
  let weight = 0;
  for (const [dx, dy, k] of [
    [0, 0, (1 - tx) * (1 - ty)],
    [1, 0, tx * (1 - ty)],
    [0, 1, (1 - tx) * ty],
    [1, 1, tx * ty],
  ]) {
    const i = (y0 + dy) * w + x0 + dx;
    if (label[i] !== own) continue;
    sum += depth[i] * k;
    weight += k;
  }
  const dist = weight > 0 ? sum / weight : 0.5;
  const peak = top[own] || 1;
  const t = Math.min(1, dist / peak);
  return peak * Math.sqrt(1 - (1 - t) * (1 - t));
}

/** The box round a shell's outline, in cells. */
function boxOf(shell: Shell): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of shell.loops) {
    for (let i = 0; i < b.length; i += 2) {
      x0 = Math.min(x0, b[i]);
      x1 = Math.max(x1, b[i]);
      y0 = Math.min(y0, b[i + 1]);
      y1 = Math.max(y1, b[i + 1]);
    }
  }
  return [x0, y0, x1, y1];
}

/**
 * The engraving again, but over a dome of the bubble's own shape: its height
 * at a point goes by how far the point is from the bubble's edge, so a long
 * bubble is a cylinder and a crooked one a cushion, and the strokes run
 * over all of it. In cells.
 */
function shapedEngraving(bubble: ArtBubble, gap: number): number[][] {
  const relief = bubble.relief!;
  const own = bubble.shell.label;
  const out = ENGRAVE_WIDTHS.map(() => [] as number[]);
  const [x0, y0, x1, y1] = boxOf(bubble.shell);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const reach = Math.hypot(x1 - x0, y1 - y0) / 2 + gap;
  const angle = bubble.turn * Math.PI;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const lx = -0.5;
  const ly = -0.65;
  const lz = 0.57;
  const step = Math.max(gap / 2, (2 * reach) / 96);
  const e = 0.75;
  const point = (s: number, t: number): number[] | null => {
    const px = cx + ux * s - uy * t;
    const py = cy + uy * s + ux * t;
    const height = heightAt(relief, own, px, py);
    if (height <= 0) return null;
    const gx = (heightAt(relief, own, px + e, py) - heightAt(relief, own, px - e, py)) / (2 * e);
    const gy = (heightAt(relief, own, px, py + e) - heightAt(relief, own, px, py - e)) / (2 * e);
    const norm = Math.hypot(gx, gy, 1);
    const shade = 1 - Math.max(0, (-gx * lx - gy * ly + lz) / norm);
    const lift = 0.45 * height;
    return [px - uy * lift, py + ux * lift, shade];
  };
  for (let t = -reach; t <= reach; t += gap) {
    let last: number[] | null = null;
    for (let s = -reach; s <= reach + 1e-9; s += step) {
      const next = point(s, t);
      if (last && next) {
        const shade = (last[2] + next[2]) / 2;
        const k = Math.min(ENGRAVE_WIDTHS.length - 1, Math.floor(shade * ENGRAVE_WIDTHS.length));
        out[k].push(last[0], last[1], next[0], next[1]);
      }
      last = next;
    }
  }
  return out;
}

/**
 * Lines of equal distance from the edge of a bubble, `gap` apart, as x1, y1,
 * x2, y2 runs in cells, a list for every distance from the edge inwards:
 * the bubble drawn in its own contours, by marching squares over the
 * centres of its cells.
 */
function contourLines(bubble: ArtBubble, gap: number): number[][] {
  const { w, h, label, depth, top } = bubble.relief!;
  const own = bubble.shell.label;
  const [bx0, by0, bx1, by1] = boxOf(bubble.shell);
  const x0 = Math.max(0, Math.floor(bx0) - 1);
  const y0 = Math.max(0, Math.floor(by0) - 1);
  const x1 = Math.min(w - 2, Math.ceil(bx1) + 1);
  const y1 = Math.min(h - 2, Math.ceil(by1) + 1);
  const value = (x: number, y: number) => {
    const i = y * w + x;
    return label[i] === own ? depth[i] : -depth[i];
  };
  const levels: number[][] = [];
  for (let level = gap; level < top[own]; level += gap) {
    const out: number[] = [];
    levels.push(out);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const corners = [value(x, y), value(x + 1, y), value(x + 1, y + 1), value(x, y + 1)];
        const at = [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
        ];
        const cuts: number[] = [];
        for (let k = 0; k < 4; k++) {
          const a = corners[k] - level;
          const b = corners[(k + 1) % 4] - level;
          if (a < 0 === b < 0) continue;
          const t = a / (a - b);
          const [ax, ay] = at[k];
          const [bx, by] = at[(k + 1) % 4];
          cuts.push(ax + (bx - ax) * t + 0.5, ay + (by - ay) * t + 0.5);
        }
        for (let k = 0; k + 3 < cuts.length; k += 4) out.push(cuts[k], cuts[k + 1], cuts[k + 2], cuts[k + 3]);
      }
    }
  }
  return levels;
}

/** Draw runs of strokes in ink, the k-th list `widths[k]` lines wide, scaled by `scale`. */
function strokeRuns(ctx: CanvasRenderingContext2D, runs: number[][], widths: readonly number[], line: number, scale: number, colours?: string[]): void {
  ctx.strokeStyle = INK;
  ctx.lineCap = 'round';
  runs.forEach((run, k) => {
    if (!run.length) return;
    if (colours) ctx.strokeStyle = colours[k];
    ctx.beginPath();
    for (let i = 0; i < run.length; i += 4) {
      ctx.moveTo(run[i] * scale, run[i + 1] * scale);
      ctx.lineTo(run[i + 2] * scale, run[i + 3] * scale);
    }
    ctx.lineWidth = Math.max(0.5, widths[k] * line);
    ctx.stroke();
  });
  ctx.lineCap = 'butt';
}

/** The same runs as SVG paths, in cells. */
function svgRuns(runs: number[][], widths: readonly number[], line: number, colours?: string[]): string[] {
  const f = (v: number) => v.toFixed(2);
  const out: string[] = [];
  runs.forEach((run, k) => {
    let path = '';
    for (let i = 0; i < run.length; i += 4) path += `M${f(run[i])} ${f(run[i + 1])}L${f(run[i + 2])} ${f(run[i + 3])}`;
    if (path) out.push(`<path fill="none" stroke="${colours ? colours[k] : INK}" stroke-linecap="round" stroke-width="${f(widths[k] * line)}" d="${path}"/>`);
  });
  return out;
}

/**
 * Fill a shell on a canvas, `cell` pixels a cell, `line` the width of a
 * line in pixels. The path of the shell is the current one when it is
 * called, and is the current one after.
 */
export function drawArt(ctx: CanvasRenderingContext2D, fill: ArtFill, bubble: ArtBubble, cell: number, line: number): void {
  const { shell, colour } = bubble;
  const c = centreOf(shell);
  const x = c.x * cell;
  const y = c.y * cell;
  const r = Math.max(1, c.r * cell);
  if (fill === 'neon') {
    // A faint breath of the tube's light inside it; the tube is drawn after all the fills.
    ctx.fillStyle = rgba(colour, 0.06);
    ctx.fill('evenodd');
    return;
  }
  if (fill === 'glow' || fill === 'glass') {
    const tint = fill === 'glass' ? sidesColour(bubble.sides) : colour;
    const g = ctx.createRadialGradient(x - 0.25 * r, y - 0.3 * r, 0, x, y, 1.25 * r);
    if (fill === 'glow') {
      g.addColorStop(0, rgba(mix(tint, 255, 0.6), 0.95));
      g.addColorStop(0.45, rgba(tint, 0.6));
      g.addColorStop(1, rgba(tint, 0));
    } else {
      g.addColorStop(0, rgba(mix(tint, 255, 0.35), 1));
      g.addColorStop(0.7, rgba(tint, 1));
      g.addColorStop(1, rgba(mix(tint, 0, 0.35), 1));
    }
    ctx.fillStyle = g;
    ctx.fill('evenodd');
    return;
  }
  // A large bubble in an ink fill may be left blank.
  if (bubble.large === 'blank') return;
  ctx.save();
  ctx.clip('evenodd');
  if (bubble.large === 'contours' && bubble.relief) {
    strokeRuns(ctx, [contourLines(bubble, Math.max(4, 3 * line) / cell).flat()], [0.6], line, cell);
  } else if (fill === 'shaped' && bubble.relief) {
    strokeRuns(ctx, shapedEngraving(bubble, Math.max(4, 2.8 * line) / cell), ENGRAVE_WIDTHS, line, cell);
  } else if (fill === 'rings' && bubble.relief) {
    // The bubble in a dark tone of its colour, and its contours, lines of
    // equal distance from its edge, in its colour, a lighter and a darker by turns.
    ctx.fillStyle = rgba(mix(colour, 0, 0.72), 1);
    ctx.fill('evenodd');
    const levels = contourLines(bubble, Math.max(5, 3.5 * line) / cell);
    strokeRuns(ctx, levels, levels.map(() => 0.7), line, cell, levels.map((_, k) => rgba(k % 2 ? mix(colour, 0, 0.35) : colour, 0.95)));
  } else if (fill === 'rings') {
    ctx.fillStyle = rgba(mix(colour, 0, 0.72), 1);
    ctx.fill('evenodd');
    const gap = Math.max(5, 3.5 * line);
    const count = Math.floor(r / gap);
    ctx.lineWidth = Math.max(1, 0.7 * line);
    for (let k = 1; k <= count; k++) {
      const s = 1 - k / (count + 1);
      ctx.beginPath();
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      ctx.translate(-x, -y);
      traceShell(ctx, shell, cell);
      ctx.restore();
      ctx.strokeStyle = rgba(k % 2 ? colour : mix(colour, 0, 0.35), 0.95);
      ctx.stroke();
    }
  } else if (fill === 'hatch') {
    // Parallel strokes of ink, turned to an angle of the bubble's own.
    const angle = bubble.turn * Math.PI;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const gap = Math.max(5, 3.5 * line);
    const reach = 1.6 * r;
    ctx.beginPath();
    for (let t = -reach; t <= reach; t += gap) {
      ctx.moveTo(x - dy * t - dx * reach, y + dx * t - dy * reach);
      ctx.lineTo(x - dy * t + dx * reach, y + dx * t + dy * reach);
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, 0.7 * line);
    ctx.stroke();
  } else {
    strokeRuns(ctx, engraving(x, y, r, bubble.turn, Math.max(4, 2.8 * line)), ENGRAVE_WIDTHS, line, 1);
  }
  ctx.beginPath();
  traceShell(ctx, shell, cell);
  ctx.restore();
}

/** The neon tube along a shell, its light adding to what is there. */
export function drawNeon(ctx: CanvasRenderingContext2D, bubble: ArtBubble, cell: number, line: number): void {
  ctx.beginPath();
  traceShell(ctx, bubble.shell, cell);
  ctx.globalCompositeOperation = 'lighter';
  for (const [width, alpha, white] of NEON) {
    ctx.strokeStyle = rgba(mix(bubble.colour, 255, white), alpha);
    ctx.lineWidth = width * line;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** What the SVG of a fill needs once, before any bubble. */
export function svgArtDefs(fill: ArtFill, line: number): string {
  if (fill !== 'neon') return '';
  return `<filter id="neon" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(1.5 * line).toFixed(2)}"/></filter>`;
}

/** The same fill as SVG, in cells: a list of defs and of elements for the bubble. */
export function svgArt(fill: ArtFill, bubble: ArtBubble, id: number, line: number): { defs: string[]; body: string[] } {
  const { shell, colour } = bubble;
  const d = svgPath(shell);
  const c = centreOf(shell);
  const f = (v: number) => v.toFixed(2);
  const hex = (v: readonly number[]) => `rgb(${v.map((n) => n | 0).join(',')})`;
  const defs: string[] = [];
  const body: string[] = [];
  if (fill === 'neon') {
    body.push(`<path fill="${hex(colour)}" fill-opacity="0.06" fill-rule="evenodd" d="${d}"/>`);
    body.push(`<g fill="none" style="mix-blend-mode:screen">`);
    body.push(`<path stroke="${hex(colour)}" stroke-opacity="0.8" stroke-width="${f(6 * line)}" filter="url(#neon)" d="${d}"/>`);
    for (const [width, alpha, white] of NEON.slice(3)) {
      body.push(`<path stroke="${hex(mix(colour, 255, white))}" stroke-opacity="${alpha}" stroke-width="${f(width * line)}" d="${d}"/>`);
    }
    body.push('</g>');
    return { defs, body };
  }
  if (fill === 'glow' || fill === 'glass') {
    const tint = fill === 'glass' ? sidesColour(bubble.sides) : colour;
    const stops =
      fill === 'glow'
        ? [`<stop offset="0" stop-color="${hex(mix(tint, 255, 0.6))}" stop-opacity="0.95"/>`, `<stop offset="0.45" stop-color="${hex(tint)}" stop-opacity="0.6"/>`, `<stop offset="1" stop-color="${hex(tint)}" stop-opacity="0"/>`]
        : [`<stop offset="0" stop-color="${hex(mix(tint, 255, 0.35))}"/>`, `<stop offset="0.7" stop-color="${hex(tint)}"/>`, `<stop offset="1" stop-color="${hex(mix(tint, 0, 0.35))}"/>`];
    defs.push(`<radialGradient id="g${id}" gradientUnits="userSpaceOnUse" cx="${f(c.x)}" cy="${f(c.y)}" r="${f(1.25 * c.r)}" fx="${f(c.x - 0.25 * c.r)}" fy="${f(c.y - 0.3 * c.r)}">${stops.join('')}</radialGradient>`);
    body.push(`<path fill-rule="evenodd" fill="url(#g${id})" d="${d}"/>`);
    return { defs, body };
  }
  if (bubble.large === 'blank') return { defs, body };
  defs.push(`<clipPath id="c${id}"><path clip-rule="evenodd" d="${d}"/></clipPath>`);
  const inside: string[] = [];
  if (bubble.large === 'contours' && bubble.relief) {
    inside.push(...svgRuns([contourLines(bubble, Math.max(1.6, 3 * line)).flat()], [0.6], line));
  } else if (fill === 'shaped' && bubble.relief) {
    inside.push(...svgRuns(shapedEngraving(bubble, Math.max(1.6, 2.8 * line)), ENGRAVE_WIDTHS, line));
  } else if (fill === 'rings' && bubble.relief) {
    inside.push(`<path fill-rule="evenodd" fill="${hex(mix(colour, 0, 0.72))}" d="${d}"/>`);
    const levels = contourLines(bubble, Math.max(2, 3.5 * line));
    inside.push(...svgRuns(levels, levels.map(() => 0.7), line, levels.map((_, k) => hex(k % 2 ? mix(colour, 0, 0.35) : colour))));
  } else if (fill === 'rings') {
    inside.push(`<path fill-rule="evenodd" fill="${hex(mix(colour, 0, 0.72))}" d="${d}"/>`);
    const gap = Math.max(2, 3.5 * line);
    const count = Math.floor(c.r / gap);
    for (let k = 1; k <= count; k++) {
      const s = 1 - k / (count + 1);
      inside.push(
        `<path fill="none" stroke="${hex(k % 2 ? colour : mix(colour, 0, 0.35))}" stroke-width="${f((0.7 * line) / s)}" transform="translate(${f(c.x)} ${f(c.y)}) scale(${s.toFixed(3)}) translate(${f(-c.x)} ${f(-c.y)})" d="${d}"/>`,
      );
    }
  } else if (fill === 'hatch') {
    const gap = Math.max(2, 3.5 * line);
    defs.push(
      `<pattern id="h${id}" patternUnits="userSpaceOnUse" width="${f(gap)}" height="${f(gap)}" patternTransform="rotate(${(bubble.turn * 180).toFixed(1)})"><line x1="0" y1="0" x2="${f(gap)}" y2="0" stroke="${INK}" stroke-width="${f(0.7 * line)}"/></pattern>`,
    );
    inside.push(`<path fill-rule="evenodd" fill="url(#h${id})" d="${d}"/>`);
  } else {
    inside.push(...svgRuns(engraving(c.x, c.y, c.r, bubble.turn, Math.max(1.6, 2.8 * line)), ENGRAVE_WIDTHS, line));
  }
  body.push(`<g clip-path="url(#c${id})">${inside.join('')}</g>`);
  return { defs, body };
}
