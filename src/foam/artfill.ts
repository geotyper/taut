import { traceShell, svgPath, type Shell } from './shells.ts';

/** Fills for the spline shells made for pictures, the more so in a mirror. */
export type ArtFill = 'glow' | 'neon' | 'rings' | 'glass' | 'hatch';

export const ART_FILLS: readonly string[] = ['glow', 'neon', 'rings', 'glass', 'hatch'];

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

/** Widths of the bands of the neon rim as shares of the radius, with their opacity: soft to bright. */
const NEON = [1, 0.8, 0.62, 0.48, 0.36, 0.26, 0.18, 0.11, 0.05].map((w, k, all) => [w, k === all.length - 1 ? 0.9 : 0.09]);

/** The leading between the panes of the stained glass. */
export const LEAD = '#17141c';

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
      const i = k === 0 ? 0 : 6 * k;
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
  if (fill === 'neon') {
    // A wide soft band inside the rim and a narrower bright one, cut by the shell.
    for (const [width, alpha] of NEON) {
      ctx.strokeStyle = rgba(mix(colour, 255, alpha > 0.5 ? 0.4 : 0), alpha);
      ctx.lineWidth = 2 * width * r;
      ctx.stroke();
    }
  } else if (fill === 'rings') {
    // Copies of the outline drawn in towards the middle, the colour drifting from one to the next.
    const gap = Math.max(5, 3.5 * line);
    const count = Math.floor(r / gap);
    ctx.lineWidth = Math.max(1, 0.6 * line);
    for (let k = 1; k <= count; k++) {
      const s = 1 - k / (count + 1);
      ctx.beginPath();
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      ctx.translate(-x, -y);
      traceShell(ctx, shell, cell);
      ctx.restore();
      const h = (bubble.turn + k * 0.07) % 1;
      ctx.strokeStyle = `hsla(${h * 360},90%,${62 + 10 * (k % 2)}%,0.9)`;
      ctx.stroke();
    }
    ctx.beginPath();
    traceShell(ctx, shell, cell);
  } else {
    // Parallel strokes, turned to an angle of the bubble's own.
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
    ctx.strokeStyle = rgba(colour, 0.85);
    ctx.lineWidth = Math.max(1, 0.7 * line);
    ctx.stroke();
    ctx.beginPath();
    traceShell(ctx, shell, cell);
  }
  ctx.restore();
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
  if (fill === 'neon') {
    for (const [width, alpha] of NEON) {
      inside.push(`<path fill="none" stroke="${hex(mix(colour, 255, alpha > 0.5 ? 0.4 : 0))}" stroke-opacity="${alpha}" stroke-width="${f(2 * width * c.r)}" d="${d}"/>`);
    }
  } else if (fill === 'rings') {
    const gap = Math.max(2, 3.5 * line);
    const count = Math.floor(c.r / gap);
    for (let k = 1; k <= count; k++) {
      const s = 1 - k / (count + 1);
      const h = (bubble.turn + k * 0.07) % 1;
      inside.push(
        `<path fill="none" stroke="hsl(${(h * 360).toFixed(0)},90%,${62 + 10 * (k % 2)}%)" stroke-width="${f(0.6 * line / s)}" transform="translate(${f(c.x)} ${f(c.y)}) scale(${s.toFixed(3)}) translate(${f(-c.x)} ${f(-c.y)})" d="${d}"/>`,
      );
    }
  } else {
    const gap = Math.max(2, 3.5 * line);
    defs.push(
      `<pattern id="h${id}" patternUnits="userSpaceOnUse" width="${f(gap)}" height="${f(gap)}" patternTransform="rotate(${(bubble.turn * 180).toFixed(1)})"><line x1="0" y1="0" x2="${f(gap)}" y2="0" stroke="${hex(colour)}" stroke-opacity="0.85" stroke-width="${f(0.5 * line)}"/></pattern>`,
    );
    inside.push(`<path fill-rule="evenodd" fill="url(#h${id})" d="${d}"/>`);
  }
  body.push(`<g clip-path="url(#c${id})">${inside.join('')}</g>`);
  return { defs, body };
}
