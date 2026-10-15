import { traceShell, svgPath, type Shell } from './shells.ts';

/** Fills for the spline shells made for pictures, the more so in a mirror. */
export type ArtFill = 'glow' | 'neon' | 'rings' | 'glass' | 'hatch' | 'engrave';

export const ART_FILLS: readonly string[] = ['glow', 'neon', 'rings', 'glass', 'hatch', 'engrave'];

/** What a fill needs of a bubble besides its shell. */
export interface ArtBubble {
  shell: Shell;
  /** Its own colour, r, g, b in 0..255. */
  colour: readonly number[];
  /** A number of its own in 0..1, for what a fill turns by it. */
  turn: number;
  /** Bubbles it shares a film with. */
  sides: number;
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
  if (fill === 'hatch' || fill === 'engrave') return { liquid: PAPER, inside: PAPER, outline: INK, width: 1.2 };
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
  ctx.save();
  ctx.clip('evenodd');
  if (fill === 'rings') {
    // The bubble in a dark tone of its colour, and copies of its outline
    // drawn in towards the middle in its colour, a lighter and a darker by turns.
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
    const runs = engraving(x, y, r, bubble.turn, Math.max(4, 2.8 * line));
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';
    runs.forEach((run, k) => {
      ctx.beginPath();
      for (let i = 0; i < run.length; i += 4) {
        ctx.moveTo(run[i], run[i + 1]);
        ctx.lineTo(run[i + 2], run[i + 3]);
      }
      ctx.lineWidth = Math.max(0.5, ENGRAVE_WIDTHS[k] * line);
      ctx.stroke();
    });
    ctx.lineCap = 'butt';
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
  defs.push(`<clipPath id="c${id}"><path clip-rule="evenodd" d="${d}"/></clipPath>`);
  const inside: string[] = [];
  if (fill === 'rings') {
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
    const runs = engraving(c.x, c.y, c.r, bubble.turn, Math.max(1.6, 2.8 * line));
    runs.forEach((run, k) => {
      let path = '';
      for (let i = 0; i < run.length; i += 4) path += `M${f(run[i])} ${f(run[i + 1])}L${f(run[i + 2])} ${f(run[i + 3])}`;
      if (path) inside.push(`<path fill="none" stroke="${INK}" stroke-linecap="round" stroke-width="${f(ENGRAVE_WIDTHS[k] * line)}" d="${path}"/>`);
    });
  }
  body.push(`<g clip-path="url(#c${id})">${inside.join('')}</g>`);
  return { defs, body };
}
