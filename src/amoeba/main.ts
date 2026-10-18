import { outlines, traceFilms, WALL, type FilmLine } from '../foam/lines.ts';
import { Amoebae, MEDIUM, type AmoebaParams, type Sense } from './amoebae.ts';
import { Painter, VECTOR_STYLES, type Look, type Palette, type RGB } from './looks.ts';

/** Time a frame may spend on steps, in ms. */
const BUDGET = 30;
/** Radius of an amoeba's nucleus, in pixels. */
const NUCLEUS = 2.5;

const COLOR_NUCLEUS: RGB = [30, 24, 40];
/** The most canvas pixels a field pixel gets when drawn smooth. */
const MOST_SCALE = 4;

const canvas = byId<HTMLCanvasElement>('field');
const ctx = canvas.getContext('2d')!;
const stat = byId('stat');
const params: AmoebaParams = { radius: 4, noise: 0.1, sense: 'smell', pull: 0.35, carries: 40, feeds: 0.1, starves: 6000, walls: 1.5, inflow: 0, banded: true, stick: 0, share: 0, lights: 0, lightRadius: 60, lightFeeds: 0.3, lightPull: 0.3, lightMoves: 0 };

let size = 384;
let world = new Amoebae(size, size);
let image = ctx.createImageData(size, size);
let pixels = new Uint32Array(image.data.buffer);
let crumbs = 200;
let stepsPerFrame = 2;
let painter = new Painter(size);
const look: Look = { palette: 'dark', byBody: false, blob: false, blobReach: 3, trails: false, showSmell: true, showLight: true, waterOnly: false };
/** Steps over which a trail fades to half. */
let trailHalf = 1500;
let showNuclei = false;
let smooth = false;
/** The outer membrane's width and the inner walls' width, in field pixels, and how much the inner walls show. */
let outerWidth = 2.5;
let innerWidth = 0.6;
let innerShows = 0.25;
/** The water, food and smell at a pixel a pixel, laid under the smooth amoebae. */
const under = document.createElement('canvas');
const underCtx = under.getContext('2d')!;
let paused = false;
let rate = 0;
let rateSteps = 0;
let rateSince = performance.now();

bindRange('radius', 0, (v) => (params.radius = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('pull', 2, (v) => (params.pull = v));
bindRange('carries', 0, (v) => (params.carries = v));
bindRange('feeds', 2, (v) => (params.feeds = v));
bindRange('starves', 0, (v) => (params.starves = v));
bindRange('walls', 1, (v) => (params.walls = v));
bindRange('stick', 2, (v) => (params.stick = v));
bindRange('share', 2, (v) => (params.share = v));
bindRange('lights', 0, (v) => (params.lights = v));
bindRange('light-radius', 0, (v) => (params.lightRadius = v));
bindRange('light-feeds', 2, (v) => (params.lightFeeds = v));
bindRange('light-pull', 2, (v) => (params.lightPull = v));
bindRange('light-moves', 0, (v) => (params.lightMoves = v));
bindRange('crumbs', 0, (v) => (crumbs = v));
bindRange('inflow', 0, (v) => (params.inflow = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('outer-width', 1, (v) => (outerWidth = v));
bindRange('inner-width', 1, (v) => (innerWidth = v));
bindRange('inner-shows', 2, (v) => (innerShows = v));
bindRange('blob-reach', 0, (v) => (look.blobReach = v));
bindRange('trail-half', 0, (v) => (trailHalf = v));
onSelect('palette', (v) => (look.palette = v as Palette));
bindCheck('by-body', (v) => (look.byBody = v));
bindCheck('blob', (v) => (look.blob = v));
bindCheck('trails', (v) => (look.trails = v));
onSelect('look', (v) => {
  smooth = v === 'smooth';
  canvas.classList.toggle('smooth', smooth);
  byId('smooth-settings').hidden = !smooth;
});
onSelect('sense', (v) => (params.sense = v as Sense));
onSelect('field-size', (v) => {
  size = Number(v);
  world = new Amoebae(size, size);
  painter = new Painter(size);
  image = ctx.createImageData(size, size);
  pixels = new Uint32Array(image.data.buffer);
  restart();
});
const bandToggle = byId<HTMLInputElement>('banded');
bandToggle.addEventListener('change', () => (params.banded = bandToggle.checked));
params.banded = bandToggle.checked;
bindCheck('show-smell', (v) => (look.showSmell = v));
bindCheck('show-light', (v) => (look.showLight = v));
bindCheck('show-nuclei', (v) => (showNuclei = v));

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
});
byId('restart').addEventListener('click', restart);
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'SELECT' || (target.tagName === 'BUTTON' && e.key === ' ')) return;
  const key = e.key.toLowerCase();
  if (key === 'n') restart();
  else if (key === ' ') pauseButton.click();
  else return;
  e.preventDefault();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * size);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * size);
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  if (e.button === 2 || e.shiftKey) world.remove(x, y);
  else world.divideAt(x, y);
});

// For checks from the console.
Object.assign(window, { amoebaPage: { world: () => world } });
requestAnimationFrame(frame);

function restart(): void {
  world.start(crumbs);
  painter.clearTrails();
}

function frame(): void {
  if (!paused) {
    const began = performance.now();
    const before = world.steps;
    for (let s = 0; s < stepsPerFrame; s++) {
      world.step(params);
      if (performance.now() - began > BUDGET) break;
    }
    rateSteps += world.steps - before;
    if (look.trails) painter.fade(world, world.steps - before, trailHalf);
  }
  const now = performance.now();
  if (now - rateSince > 1000) {
    rate = (rateSteps * 1000) / (now - rateSince);
    rateSteps = 0;
    rateSince = now;
  }
  render();
  stat.textContent = status();
  requestAnimationFrame(frame);
}

function render(): void {
  if (smooth) renderSmooth();
  else renderPixels();
}

/** Every pixel as it is: films light, amoebae by their tint, water and food below. */
function renderPixels(): void {
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  look.waterOnly = false;
  painter.paint(world, pixels, look);
  if (showNuclei) paintNuclei();
  ctx.putImageData(image, 0, 0);
}

/**
 * The amoebae as smooth shapes on the water: the films traced as lines, each
 * amoeba filled within its own, the inner walls between two amoebae drawn
 * thin and faint and the outer membrane, on the water, thick, so a body of
 * many reads as one.
 */
function renderSmooth(): void {
  const scale = Math.max(1, Math.min(MOST_SCALE, Math.round((canvas.clientWidth * devicePixelRatio) / size)));
  if (canvas.width !== size * scale) {
    canvas.width = size * scale;
    canvas.height = size * scale;
  }
  if (under.width !== size) {
    under.width = size;
    under.height = size;
  }
  // A blob is drawn a pixel a pixel already, and only scaled up smooth.
  look.waterOnly = !look.blob;
  painter.paint(world, pixels, look);
  underCtx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(under, 0, 0, canvas.width, canvas.height);
  if (look.blob) {
    if (showNuclei) drawNuclei(scale);
    return;
  }
  const style = VECTOR_STYLES[look.palette];

  const lines = traceFilms(world.label, size, size);
  const inner: FilmLine[] = [];
  const outer: FilmLine[] = [];
  for (const line of lines) {
    const aAmoeba = line.a !== MEDIUM && line.a !== WALL;
    const bAmoeba = line.b !== MEDIUM && line.b !== WALL;
    if (aAmoeba || bAmoeba) (aAmoeba && bAmoeba ? inner : outer).push(line);
  }

  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Each amoeba within the loops its films make, a hole for any amoeba inside it.
  for (const [l, found] of outlines(lines)) {
    if (l === MEDIUM) continue;
    ctx.beginPath();
    for (const loop of found) traceLine(closedLoop(loop));
    ctx.fillStyle = css(painter.colourOf(world, l, look));
    ctx.globalAlpha = style.fillAlpha;
    ctx.fill('evenodd');
    // The fill's own seams, hidden under its colour, where it is opaque.
    if (style.fillAlpha === 1) {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  if (innerShows > 0 && innerWidth > 0) {
    ctx.beginPath();
    for (const line of inner) traceLine(line.points);
    ctx.strokeStyle = css(style.inner, innerShows);
    ctx.lineWidth = innerWidth;
    ctx.stroke();
  }
  if (outerWidth > 0) {
    ctx.beginPath();
    for (const line of outer) traceLine(line.points);
    // A soft rim, as the clear ectoplasm, and the membrane itself over it.
    ctx.strokeStyle = css(style.rim, style.rimAlpha);
    ctx.lineWidth = outerWidth * 2;
    ctx.stroke();
    if (style.glow > 0) {
      ctx.shadowColor = css(style.rim);
      ctx.shadowBlur = style.glow * scale;
    }
    ctx.strokeStyle = css(style.outer);
    ctx.lineWidth = outerWidth;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  if (showNuclei) drawNuclei(1);
  ctx.restore();
}

/** A dark dot at every nucleus, as a vector, the canvas this many pixels a field pixel. */
function drawNuclei(scale: number): void {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.beginPath();
  for (let l = 1; l <= world.labelCount; l++) {
    if (!world.isAlive(l)) continue;
    const [cx, cy] = world.centreOf(l);
    ctx.moveTo(cx + 0.5 + NUCLEUS, cy + 0.5);
    ctx.arc(cx + 0.5, cy + 0.5, NUCLEUS, 0, 2 * Math.PI);
  }
  ctx.fillStyle = css(COLOR_NUCLEUS);
  ctx.fill();
  ctx.restore();
}

/** A loop's lines end to end as one closed line, its first point again at the end. */
function closedLoop(loop: Float32Array[]): Float32Array {
  let length = 2;
  for (const points of loop) length += points.length;
  const out = new Float32Array(length);
  let at = 0;
  for (const points of loop) {
    out.set(points, at);
    at += points.length;
  }
  out[at] = out[0];
  out[at + 1] = out[1];
  return out;
}

/** A line through its points as a quadratic B-spline: through the midpoints, bent towards the points. */
function traceLine(p: Float32Array): void {
  const n = p.length / 2;
  if (n < 2) return;
  const closed = n > 2 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1];
  if (n < 3) {
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    return;
  }
  if (closed) {
    ctx.moveTo((p[0] + p[2]) / 2, (p[1] + p[3]) / 2);
    for (let k = 1; k < n - 1; k++) {
      ctx.quadraticCurveTo(p[k * 2], p[k * 2 + 1], (p[k * 2] + p[k * 2 + 2]) / 2, (p[k * 2 + 1] + p[k * 2 + 3]) / 2);
    }
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + p[2]) / 2, (p[1] + p[3]) / 2);
    ctx.closePath();
    return;
  }
  // An open line keeps its ends, where it meets the others.
  ctx.moveTo(p[0], p[1]);
  for (let k = 1; k < n - 1; k++) {
    ctx.quadraticCurveTo(p[k * 2], p[k * 2 + 1], (p[k * 2] + p[k * 2 + 2]) / 2, (p[k * 2 + 1] + p[k * 2 + 3]) / 2);
  }
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
}

/** A dark nucleus in the middle of every living amoeba. */
function paintNuclei(): void {
  const { label } = world;
  for (let l = 1; l <= world.labelCount; l++) {
    if (!world.isAlive(l)) continue;
    const [cx, cy] = world.centreOf(l);
    const r = Math.ceil(NUCLEUS);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(cx) + dx;
        const y = Math.round(cy) + dy;
        if (dx * dx + dy * dy > NUCLEUS * NUCLEUS || x < 0 || x >= size || y < 0 || y >= size) continue;
        if (label[y * size + x] === l) pixels[y * size + x] = rgb(...COLOR_NUCLEUS);
      }
    }
  }
}

function status(): string {
  const parts = [
    `${world.count} amoebae`,
    `step ${world.steps}`,
    `${world.divisions} divisions, ${world.deaths} deaths`,
    `food left ${world.foodLeft.toFixed(0)} of ${world.crumbs} crumbs laid`,
    `${world.bandPixels} pixels by membranes, ${((100 * world.bandPixels) / (size * size)).toFixed(1)}% of the field`,
    `${Math.round(rate)} steps/s`,
  ];
  return parts.join(' · ');
}

function onSelect(id: string, apply: (value: string) => void): void {
  const select = byId<HTMLSelectElement>(id);
  select.addEventListener('change', () => apply(select.value));
  apply(select.value);
}

function bindRange(id: string, digits: number, apply: (value: number) => void): void {
  const input = byId<HTMLInputElement>(id);
  const out = byId(`${id}-out`);
  const update = () => {
    const value = Number(input.value);
    apply(value);
    out.textContent = value.toFixed(digits);
  };
  input.addEventListener('input', update);
  update();
}

function bindCheck(id: string, apply: (on: boolean) => void): void {
  const input = byId<HTMLInputElement>(id);
  input.addEventListener('change', () => apply(input.checked));
  apply(input.checked);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function css(c: RGB, alpha = 1): string {
  const [r, g, b] = c.map(Math.round);
  return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rgb(r: number, g: number, b: number): number {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}
