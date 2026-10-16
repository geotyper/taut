import { FOCAL } from '../3d/renderer.ts';
import { OUTSIDE, type Films } from './films.ts';

/**
 * A still picture of the films, drawn on the CPU from the mesh: a depth
 * buffer of all the films, taken as opaque, hides the lines behind them;
 * the films are filled in it, and the lines are drawn over it as smooth
 * strokes, ready for SVG.
 */

export type StillFill = 'colour' | 'paper' | 'dark';
export type StillAcross = 'none' | 'rings' | 'level';

export interface StillOptions {
  width: number;
  height: number;
  /** Device pixels to a CSS pixel, for line widths. */
  scale: number;
  fill: StillFill;
  /** Lines across the films: none, at equal distances from their borders, or level like heights on a map. */
  across: StillAcross;
  /** The lines across the films thicker where the film is in shade, as in an engraving. */
  byLight: boolean;
  /** Cells between lines across the films. */
  spacing: number;
  /** Width of the borders, in CSS pixels. */
  lineWidth: number;
  /** Draw the lines behind the films too, the films not filled. */
  xray: boolean;
  /**
   * What is cut away: nothing; the near half, at the centre of the field and
   * square to the view; all on one side of a plane; or all but a slab
   * between two planes.
   */
  cut: StillCut;
  /** The plane of a cut: its normal turned round the vertical and tilted up, in degrees, and its offset from the centre in sphere radii. */
  plane: { turn: number; tilt: number; offset: number };
  /** How thick the slab is, in cells. */
  slab: number;
  /** Leave out the films against the outside, so the outer cells are open, like a honeycomb. */
  open: boolean;
}

export type StillCut = 'none' | 'near' | 'plane' | 'slab';

export interface ViewFrame {
  eye: number[];
  right: number[];
  up: number[];
  forward: number[];
}

export interface Stroke {
  /** Screen points, in device pixels. */
  points: number[][];
  /** One width for the whole stroke, or one a point. */
  width: number | number[];
  colour: string;
}

export interface Picture {
  width: number;
  height: number;
  background: string;
  /** The filled films, if any. */
  image: ImageData | null;
  strokes: Stroke[];
  /** Junctions, as dots. */
  dots: { x: number; y: number; r: number; colour: string }[];
}

/** Lines are hidden behind a film nearer than this, in cells: they lie on films. */
const SLACK = 0.9;

export function renderStill(
  films: Films,
  distance: Float64Array | null,
  frame: ViewFrame,
  n: number,
  options: StillOptions,
): Picture {
  const { width: w, height: h } = options;
  const { eye, right, up, forward } = frame;
  // What is kept of a cut: the points whose signed distance from the
  // plane through the centre lies between lo and hi.
  const centre = [n / 2, n / 2, n / 2];
  let normal = forward;
  let lo = -Infinity;
  let hi = Infinity;
  if (options.cut === 'near') lo = 0;
  else if (options.cut === 'plane' || options.cut === 'slab') {
    const turn = (options.plane.turn * Math.PI) / 180;
    const tilt = (options.plane.tilt * Math.PI) / 180;
    normal = [Math.cos(tilt) * Math.sin(turn), Math.sin(tilt), Math.cos(tilt) * Math.cos(turn)];
    // The sphere's radius, as the foam is scattered in.
    const offset = options.plane.offset * 0.45 * n;
    // What lies beyond the plane, the way its normal points, is cut away.
    if (options.cut === 'plane') hi = offset;
    else [lo, hi] = [offset - options.slab / 2, offset + options.slab / 2];
  }
  const sideOf = (p: ArrayLike<number>) =>
    (p[0] - centre[0]) * normal[0] + (p[1] - centre[1]) * normal[1] + (p[2] - centre[2]) * normal[2];
  // A little slack, so the lines of the cut, right on its planes, are kept.
  const kept = (side: number) => side >= lo - 1e-3 && side <= hi + 1e-3;
  const skin = (t: number) => films.patches[films.patchOf[t]].a === OUTSIDE;
  const shown = (t: number) => !(options.open && skin(t));
  const project = (p: ArrayLike<number>): number[] => {
    const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const depth = dot(d, forward);
    const u = (dot(d, right) * FOCAL) / depth;
    const v = (dot(d, up) * FOCAL) / depth;
    return [(u * h + w) / 2, (h - v * h) / 2, depth];
  };

  const pos = films.positions;
  const tris = films.triangles;
  const count = films.kinds.length;
  const screen = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const s = project([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    screen[v * 3] = s[0];
    screen[v * 3 + 1] = s[1];
    screen[v * 3 + 2] = s[2];
  }
  const sides = new Float32Array(count);
  for (let v = 0; v < count; v++) sides[v] = sideOf([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
  const normals = cornerNormals(films);
  // The light comes from above, to the left and a little from the viewer.
  const light = normalize(add(add(scale(up, 0.65), scale(right, -0.45)), scale(forward, -0.6)));

  const depth = new Float32Array(w * h).fill(Infinity);
  const fill = !options.xray && options.fill !== 'paper';
  const image = fill ? new ImageData(w, h) : null;
  const background = options.fill === 'dark' ? [8, 8, 12] : options.fill === 'paper' ? [250, 248, 242] : [24, 24, 30];
  if (image) {
    for (let i = 0; i < w * h; i++) image.data.set([...background, 255], i * 4);
  }

  if (!options.xray) {
    for (let t = 0; t < tris.length / 3; t++) {
      const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
      const za = screen[a * 3 + 2];
      const zb = screen[b * 3 + 2];
      const zc = screen[c * 3 + 2];
      if (za <= 0.5 || zb <= 0.5 || zc <= 0.5) continue;
      if (!shown(t)) continue;
      const [ea, eb, ec] = [sides[a], sides[b], sides[c]];
      if ((ea < lo && eb < lo && ec < lo) || (ea > hi && eb > hi && ec > hi)) continue;
      const patch = films.patches[films.patchOf[t]];
      // The colour of the bubble on the camera's side, or of the other if
      // that side is outside.
      const faceNormal = triangleNormal(pos, a, b, c);
      const toEye = sub(eye, [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]]);
      const facing = dot(faceNormal, toEye) > 0;
      let label = facing ? patch.b : patch.a;
      if (label === OUTSIDE) label = facing ? patch.a : patch.b;
      const base = image ? colourOf(label, options.fill) : [0, 0, 0];
      const flip = facing ? 1 : -1;
      const shadeAt = (k: number): number => {
        const o = (t * 3 + k) * 3;
        const nn = [normals[o] * flip, normals[o + 1] * flip, normals[o + 2] * flip];
        const lambert = Math.max(0, dot(nn, light));
        return 0.28 + 0.72 * lambert;
      };
      const sa = image ? shadeAt(0) : 0;
      const sb = image ? shadeAt(1) : 0;
      const sc = image ? shadeAt(2) : 0;
      raster(
        screen[a * 3], screen[a * 3 + 1], za,
        screen[b * 3], screen[b * 3 + 1], zb,
        screen[c * 3], screen[c * 3 + 1], zc,
        w, h,
        (i, z, la, lb, lc) => {
          if (z >= depth[i] || !kept(la * ea + lb * eb + lc * ec)) return;
          depth[i] = z;
          if (!image) return;
          const shade = la * sa + lb * sb + lc * sc;
          image.data[i * 4] = base[0] * shade;
          image.data[i * 4 + 1] = base[1] * shade;
          image.data[i * 4 + 2] = base[2] * shade;
        },
      );
    }
  }

  // Whether a point at this depth is in sight: in front of the films there,
  // give or take the slack; looked for round the pixel too, so a line on the
  // outline of a film is not cut.
  const seen = (x: number, y: number, z: number, p: number[]): boolean => {
    if (z <= 0.5 || !kept(sideOf(p))) return false;
    if (options.xray) return true;
    const px = Math.floor(x);
    const py = Math.floor(y);
    let far = -Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) return true;
        far = Math.max(far, depth[qy * w + qx]);
      }
    }
    return z <= far + SLACK;
  };

  const ink = options.fill === 'dark' ? 'rgba(235, 235, 255, 0.9)' : options.fill === 'paper' ? '#141414' : 'rgba(10, 10, 14, 0.85)';
  const strokes: Stroke[] = [];

  // Lines across the films first, so the borders lie over them.
  if (options.across !== 'none') {
    const value = options.across === 'rings' && distance ? distance : heights(films);
    const levels = isolines(
      films,
      (t, k) => value[tris[t * 3 + k]],
      { spacing: options.spacing, skipZero: options.across === 'rings' },
      shown,
    );
    for (const line of levels) {
      const shaded = line.points.map((p, k) => {
        const nn = line.normals[k];
        const toEye = sub(eye, p);
        const flip = dot(nn, toEye) >= 0 ? 1 : -1;
        return 0.15 + 0.85 * Math.max(0, flip * dot(nn, light));
      });
      const base = options.lineWidth * 0.5 * options.scale;
      const widths = options.byLight ? shaded.map((s) => base * (0.3 + 2.4 * (1 - s))) : null;
      const colour =
        options.fill === 'colour' ? 'rgba(10, 10, 14, 0.45)' : options.fill === 'dark' ? 'rgba(200, 210, 255, 0.55)' : '#202020';
      for (const run of visibleRuns(line.points, project, seen, widths)) {
        strokes.push({ points: run.points, width: run.widths ?? base, colour });
      }
    }
  }

  for (const border of films.borders) {
    const points = smoothLine(border.points);
    for (const run of visibleRuns(points, project, seen, null)) {
      strokes.push({ points: run.points, width: options.lineWidth * options.scale, colour: ink });
    }
  }

  if (!options.xray) {
    // The outline: where a film turns from facing the eye to facing away,
    // found between the vertices, by the smooth normals, not along the
    // mesh's edges, which would zigzag.
    const facing = (t: number, k: number): number => {
      const v = tris[t * 3 + k];
      const o = (t * 3 + k) * 3;
      const d = [eye[0] - pos[v * 3], eye[1] - pos[v * 3 + 1], eye[2] - pos[v * 3 + 2]];
      return (normals[o] * d[0] + normals[o + 1] * d[1] + normals[o + 2] * d[2]) / Math.hypot(d[0], d[1], d[2]);
    };
    for (const line of isolines(films, facing, { only: 0 }, shown)) {
      for (const run of visibleRuns(smoothLine(line.points), project, seen, null)) {
        strokes.push({ points: run.points, width: options.lineWidth * options.scale, colour: ink });
      }
    }
  }
  if (options.cut !== 'none' && !options.xray) {
    // Where the cut goes through the films, on each of its planes.
    const sideAt = (t: number, k: number): number => sides[tris[t * 3 + k]];
    for (const level of [lo, hi]) {
      if (!Number.isFinite(level)) continue;
      for (const line of isolines(films, sideAt, { only: level }, shown)) {
        for (const run of visibleRuns(line.points, project, seen, null)) {
          strokes.push({ points: run.points, width: options.lineWidth * options.scale, colour: ink });
        }
      }
    }
  }

  const dots: Picture['dots'] = [];
  for (const corner of films.corners) {
    const [x, y, z] = project(corner);
    if (!seen(x, y, z, corner)) continue;
    dots.push({ x, y, r: options.lineWidth * options.scale * 0.9, colour: ink });
  }

  return {
    width: w,
    height: h,
    background: `rgb(${background.join(',')})`,
    image,
    strokes,
    dots,
  };
}

/** Draw a picture on a canvas of its size. */
export function drawPicture(ctx: CanvasRenderingContext2D, picture: Picture): void {
  ctx.save();
  if (picture.image) ctx.putImageData(picture.image, 0, 0);
  else {
    ctx.fillStyle = picture.background;
    ctx.fillRect(0, 0, picture.width, picture.height);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const stroke of picture.strokes) {
    ctx.strokeStyle = stroke.colour;
    const pts = stroke.points;
    if (typeof stroke.width === 'number') {
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      tracePath(ctx, pts);
      ctx.stroke();
    } else {
      // A width a point: a piece round each point, midpoint to midpoint.
      const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const last = pts.length - 1;
      for (let k = 0; k <= last; k++) {
        const from = k === 0 ? pts[0] : mid(pts[k - 1], pts[k]);
        const to = k === last ? pts[last] : mid(pts[k], pts[k + 1]);
        ctx.lineWidth = stroke.width[k];
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.quadraticCurveTo(pts[k][0], pts[k][1], to[0], to[1]);
        ctx.stroke();
      }
    }
  }
  for (const dot of picture.dots) {
    ctx.fillStyle = dot.colour;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}

/** The picture as SVG: the filled films as an embedded image, the lines as paths. */
export function pictureSvg(picture: Picture, imageUrl: string | null): string {
  const { width: w, height: h } = picture;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="${picture.background}"/>`,
  ];
  if (imageUrl) out.push(`<image width="${w}" height="${h}" href="${imageUrl}"/>`);
  out.push('<g fill="none" stroke-linecap="round" stroke-linejoin="round">');
  const f = (v: number) => v.toFixed(1);
  for (const stroke of picture.strokes) {
    const pts = stroke.points;
    if (typeof stroke.width === 'number') {
      out.push(`<path d="${svgPath(pts)}" stroke="${stroke.colour}" stroke-width="${f(stroke.width)}"/>`);
    } else {
      const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const last = pts.length - 1;
      for (let k = 0; k <= last; k++) {
        const from = k === 0 ? pts[0] : mid(pts[k - 1], pts[k]);
        const to = k === last ? pts[last] : mid(pts[k], pts[k + 1]);
        out.push(
          `<path d="M${f(from[0])} ${f(from[1])}Q${f(pts[k][0])} ${f(pts[k][1])} ${f(to[0])} ${f(to[1])}" stroke="${stroke.colour}" stroke-width="${f(stroke.width[k])}"/>`,
        );
      }
    }
  }
  out.push('</g>');
  for (const dot of picture.dots) out.push(`<circle cx="${f(dot.x)}" cy="${f(dot.y)}" r="${f(dot.r)}" fill="${dot.colour}"/>`);
  out.push('</svg>');
  return out.join('\n');
}

/** Through the midpoints, so the line bends smoothly at its points. */
function tracePath(ctx: CanvasRenderingContext2D, pts: number[][]): void {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length - 1; k++) {
    ctx.quadraticCurveTo(pts[k][0], pts[k][1], (pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function svgPath(pts: number[][]): string {
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let k = 1; k < pts.length - 1; k++) {
    d += `Q${f(pts[k][0])} ${f(pts[k][1])} ${f((pts[k][0] + pts[k + 1][0]) / 2)} ${f((pts[k][1] + pts[k + 1][1]) / 2)}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${f(last[0])} ${f(last[1])}`;
}

/**
 * The parts of a line in sight, in screen points. The line is cut finer
 * where its points lie far apart on the screen, so it is hidden to about a
 * pixel.
 */
function visibleRuns(
  points: number[][],
  project: (p: number[]) => number[],
  seen: (x: number, y: number, z: number, p: number[]) => boolean,
  widths: number[] | null,
): { points: number[][]; widths: number[] | null }[] {
  const runs: { points: number[][]; widths: number[] | null }[] = [];
  let run: number[][] = [];
  let runWidths: number[] = [];
  const close = () => {
    if (run.length >= 2) runs.push({ points: run, widths: widths ? runWidths : null });
    run = [];
    runWidths = [];
  };
  let before: number[] | null = null;
  for (let k = 0; k < points.length; k++) {
    const s = project(points[k]);
    if (before && k > 0) {
      // Points between, a couple of pixels apart, checked but not kept.
      const gap = Math.hypot(s[0] - before[0], s[1] - before[1]);
      const steps = Math.min(32, Math.floor(gap / 2));
      for (let j = 1; j <= steps; j++) {
        const t = j / (steps + 1);
        const between = lerp(points[k - 1], points[k], t);
        const q = project(between);
        if (!seen(q[0], q[1], q[2], between)) {
          close();
          break;
        }
      }
    }
    before = s;
    if (s[2] <= 0.5 || !seen(s[0], s[1], s[2], points[k])) {
      close();
      continue;
    }
    run.push([s[0], s[1]]);
    if (widths) runWidths.push(widths[k]);
  }
  close();
  return runs;
}

/** A border's points, cut finer and smoothed, its ends kept: the staircase of the voxels taken out. */
function smoothLine(points: number[][]): number[][] {
  let line = points;
  if (line.length < 3) return line;
  const closed = distance(line[0], line[line.length - 1]) < 1e-6;
  for (let pass = 0; pass < 3; pass++) {
    line = line.map((p, k) => {
      if (k === 0 || k === line.length - 1) return closed ? average3(line[line.length - 2], p, line[1]) : p;
      return average3(line[k - 1], p, line[k + 1]);
    });
  }
  return line;
}

function average3(a: number[], b: number[], c: number[]): number[] {
  return [0, 1, 2].map((i) => (a[i] + 2 * b[i] + c[i]) / 4);
}

/** The height of each vertex, for level lines. */
function heights(films: Films): Float64Array {
  const count = films.kinds.length;
  const value = new Float64Array(count);
  for (let v = 0; v < count; v++) value[v] = films.positions[v * 3 + 1];
  return value;
}

/**
 * The lines where a value on the films crosses each multiple of the
 * spacing (or only the given level), worked out triangle by triangle and
 * joined into polylines where they cross the same edge, with the films'
 * normal at each point. The value is given at each corner of a triangle,
 * so it may differ between films at a border; each patch gets its own
 * lines, so a line ends at a border rather than turning onto the next film.
 */
function isolines(
  films: Films,
  valueAt: (t: number, k: number) => number,
  levels: { spacing: number; skipZero: boolean } | { only: number },
  keep?: (t: number) => boolean,
): { points: number[][]; normals: number[][] }[] {
  const pos = films.positions;
  const tris = films.triangles;
  const normals = cornerNormals(films);
  // Pieces keyed by the edges they cross: patch, edge and level.
  const pieces: { a: string; b: string; pa: number[]; pb: number[]; na: number[]; nb: number[] }[] = [];
  const count = films.kinds.length;
  const vals = [0, 0, 0];
  for (let t = 0; t < tris.length / 3; t++) {
    if (keep && !keep(t)) continue;
    const ids = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    for (let k = 0; k < 3; k++) vals[k] = valueAt(t, k);
    if (!vals.every(Number.isFinite)) continue;
    let lo: number;
    let hi: number;
    let spacing = 1;
    if ('only' in levels) {
      lo = hi = 0;
    } else {
      spacing = levels.spacing;
      lo = Math.ceil(Math.min(vals[0], vals[1], vals[2]) / spacing);
      hi = Math.floor(Math.max(vals[0], vals[1], vals[2]) / spacing);
    }
    const patch = films.patchOf[t];
    for (let level = lo; level <= hi; level++) {
      if ('skipZero' in levels && levels.skipZero && level <= 0) continue;
      const iso = 'only' in levels ? levels.only : level * spacing;
      const cross: { key: string; p: number[]; n: number[] }[] = [];
      for (let e = 0; e < 3; e++) {
        const i = e;
        const j = (e + 1) % 3;
        const vi = vals[i] - iso;
        const vj = vals[j] - iso;
        // Half-open, so a vertex right on the level is crossed once.
        if (vi >= 0 === vj >= 0) continue;
        const s = vi / (vi - vj);
        const a = ids[i];
        const b = ids[j];
        const p = [0, 1, 2].map((x) => pos[a * 3 + x] + s * (pos[b * 3 + x] - pos[a * 3 + x]));
        const nn = [0, 1, 2].map((x) => normals[(t * 3 + i) * 3 + x] * (1 - s) + normals[(t * 3 + j) * 3 + x] * s);
        const lowId = Math.min(a, b);
        const highId = Math.max(a, b);
        cross.push({ key: `${patch}:${lowId * count + highId}:${level}`, p, n: nn });
      }
      if (cross.length === 2) {
        pieces.push({ a: cross[0].key, b: cross[1].key, pa: cross[0].p, pb: cross[1].p, na: cross[0].n, nb: cross[1].n });
      }
    }
  }
  // Join the pieces at shared crossings.
  const at = new Map<string, number[]>();
  pieces.forEach((piece, k) => {
    for (const key of [piece.a, piece.b]) {
      const list = at.get(key);
      if (list) list.push(k);
      else at.set(key, [k]);
    }
  });
  const used = new Uint8Array(pieces.length);
  const lines: { points: number[][]; normals: number[][] }[] = [];
  const extend = (start: number, key: string, points: number[][], norms: number[][]) => {
    let k = start;
    let here = key;
    for (;;) {
      const next = (at.get(here) ?? []).find((j) => j !== k && !used[j]);
      if (next === undefined) return;
      used[next] = 1;
      const piece = pieces[next];
      const forward = piece.a === here;
      points.push(forward ? piece.pb : piece.pa);
      norms.push(forward ? piece.nb : piece.na);
      here = forward ? piece.b : piece.a;
      k = next;
    }
  };
  for (let k = 0; k < pieces.length; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const piece = pieces[k];
    const ahead = [piece.pb];
    const aheadN = [piece.nb];
    extend(k, piece.b, ahead, aheadN);
    const behind = [piece.pa];
    const behindN = [piece.na];
    extend(k, piece.a, behind, behindN);
    lines.push({ points: [...behind.reverse(), ...ahead], normals: [...behindN.reverse(), ...aheadN] });
  }
  return lines;
}

/** Normals at each triangle's corners, smooth over the patch: averaged over the triangles of the same patch round the vertex. */
const normalCache = new WeakMap<Films, Float32Array>();
function cornerNormals(films: Films): Float32Array {
  const cached = normalCache.get(films);
  if (cached) return cached;
  const pos = films.positions;
  const tris = films.triangles;
  const sums = new Map<number, number[]>();
  const keyOf = (v: number, t: number) => v * 65536 + films.patchOf[t];
  const faces: number[][] = [];
  for (let t = 0; t < tris.length / 3; t++) {
    // Not normalised: larger triangles weigh more.
    const nn = triangleNormal(pos, tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2], false);
    faces.push(nn);
    for (let k = 0; k < 3; k++) {
      const key = keyOf(tris[t * 3 + k], t);
      const sum = sums.get(key);
      if (sum) {
        sum[0] += nn[0];
        sum[1] += nn[1];
        sum[2] += nn[2];
      } else sums.set(key, [nn[0], nn[1], nn[2]]);
    }
  }
  const out = new Float32Array(tris.length * 3);
  for (let t = 0; t < tris.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const nn = normalize(sums.get(keyOf(tris[t * 3 + k], t)) ?? faces[t]);
      out.set(nn, (t * 3 + k) * 3);
    }
  }
  normalCache.set(films, out);
  return out;
}

/**
 * Fill a triangle's pixels, depth and barycentric weights correct for the
 * perspective: 1/z is what is linear on the screen.
 */
function raster(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  w: number, h: number,
  plot: (i: number, z: number, la: number, lb: number, lc: number) => void,
): void {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
  const ia = 1 / az;
  const ib = 1 / bz;
  const ic = 1 / cz;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      const wc = 1 - wa - wb;
      if (wa < 0 || wb < 0 || wc < 0) continue;
      const inv = wa * ia + wb * ib + wc * ic;
      const z = 1 / inv;
      plot(y * w + x, z, wa * ia * z, wb * ib * z, wc * ic * z);
    }
  }
}

/** A colour a bubble, as the other foam views give it: a hue from its label. */
function colourOf(label: number, fill: StillFill): number[] {
  const hue = (Math.imul(label, 0x9e3779b1) >>> 24) / 256;
  const rgb = [0, 2 / 3, 1 / 3].map((o) => Math.min(1, Math.max(0, Math.abs(((hue + o) % 1) * 6 - 3) - 1)));
  if (fill === 'dark') return rgb.map((c) => 255 * (0.08 + 0.18 * c));
  return rgb.map((c) => 255 * (0.42 + 0.5 * c));
}

function triangleNormal(pos: Float32Array, a: number, b: number, c: number, unit = true): number[] {
  const ab = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]];
  const ac = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]];
  const nn = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  return unit ? normalize(nn) : nn;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function sub(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: number[], b: number[]): number[] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: number[], s: number): number[] {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function lerp(a: number[], b: number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
