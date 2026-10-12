import type { Point } from '../hull.ts';
import { Sim, type Params, type PottsParams } from '../sim.ts';
import { Clusters } from './clusters.ts';

const SIZE = 256;
/** Per-frame time limit for stepping the bands, in ms. */
const BUDGET = 12;
/** Steps per frame of the wave and of the labelling, slow enough to watch. */
const SPREAD_STEPS = 1;
const LABEL_STEPS = 6;

const COLOR_OUTSIDE = rgb(11, 13, 17);
const COLOR_INSIDE = rgb(30, 42, 60);
const COLOR_STONE = rgb(132, 138, 150);
const COLOR_FRONT = rgb(255, 209, 102);
const COLOR_HULL = '#4dd0e1';

/** One colour per cluster, picked by its label: the band and its dim inside. */
const HUES = 256;
const BRIGHT = new Uint32Array(HUES);
const DIM = new Uint32Array(HUES);
for (let i = 0; i < HUES; i++) {
  BRIGHT[i] = hsl((i / HUES) * 360, 0.85, 0.66);
  DIM[i] = hsl((i / HUES) * 360, 0.4, 0.17);
}

type Algorithm = 'potts' | 'wide';

const stones = new Uint8Array(SIZE * SIZE);
/** Only used to draw and scatter stones on the big field. */
const editor = new Sim(SIZE, SIZE, stones);
const clusters = new Clusters(SIZE, SIZE, stones);

const canvas = byId<HTMLCanvasElement>('field');
canvas.width = SIZE;
canvas.height = SIZE;
const ctx = canvas.getContext('2d')!;
const image = ctx.createImageData(SIZE, SIZE);
const pixels = new Uint32Array(image.data.buffer);
const stat = byId('stat');

const wideParams: Params = { radius: 2, threshold: 0.5, noise: 0.3 };
const pottsParams: PottsParams = { temperature: 0.5, pressure: 0 };
let algorithm: Algorithm = 'potts';
let reach = 10;
let pottsSteps = 40;
let wideSteps = 4;
let stoneCount = 40;
let stoneSize = 0.3;
let brush = 3;
let showHull = true;
let paused = false;

bindRange('reach', 0, (v) => {
  reach = v;
  clusters.restart(reach);
});
bindRange('temperature', 2, (v) => (pottsParams.temperature = v));
bindRange('potts-speed', 0, (v) => (pottsSteps = v));
bindRange('radius', 0, (v) => (wideParams.radius = v));
bindRange('noise', 2, (v) => (wideParams.noise = v));
bindRange('speed', 0, (v) => (wideSteps = v));
bindRange('stone-count', 0, (v) => (stoneCount = v));
bindRange('stone-size', 2, (v) => (stoneSize = v));
bindRange('brush', 0, (v) => (brush = v));

const algorithmSelect = byId<HTMLSelectElement>('algorithm');
algorithmSelect.addEventListener('change', () => {
  algorithm = algorithmSelect.value as Algorithm;
  syncControls();
  clusters.restart(reach);
});

const hullToggle = byId<HTMLInputElement>('show-hull');
hullToggle.addEventListener('change', () => (showHull = hullToggle.checked));

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', togglePause);
byId('restart').addEventListener('click', () => clusters.restart(reach));
byId('random').addEventListener('click', scatter);
byId('clear').addEventListener('click', () => {
  editor.clearStones();
  clusters.restart(reach);
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') togglePause();
  else if (e.key === 'r' || e.key === 'R') clusters.restart(reach);
  else if (e.key === 'n' || e.key === 'N') scatter();
  else return;
  e.preventDefault();
});

syncControls();
scatter();

function scatter(): void {
  editor.clearStones();
  editor.randomStones(stoneCount, stoneSize);
  clusters.restart(reach);
}

function togglePause(): void {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
}

function syncControls(): void {
  byId('group-potts').hidden = algorithm !== 'potts';
  byId('group-wide').hidden = algorithm !== 'wide';
}

// Painting stones with the pointer.
let last: Point | null = null;
let erasing = false;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  erasing = e.button === 2 || e.shiftKey;
  last = toGrid(e);
  stroke(last, last);
});
canvas.addEventListener('pointermove', (e) => {
  if (!last) return;
  const next = toGrid(e);
  stroke(last, next);
  last = next;
});
canvas.addEventListener('pointerup', () => (last = null));
canvas.addEventListener('pointercancel', () => (last = null));

function toGrid(e: PointerEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * SIZE,
    y: ((e.clientY - rect.top) / rect.height) * SIZE,
  };
}

function stroke(from: Point, to: Point): void {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.ceil(dist / (brush / 2)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    editor.paintStone(x, y, brush, erasing ? 0 : 1);
  }
  clusters.restart(reach);
}

function frame(): void {
  if (!paused) advance();
  render();
  requestAnimationFrame(frame);
}

function advance(): void {
  if (clusters.stage === 'spread') {
    for (let i = 0; i < SPREAD_STEPS; i++) clusters.step();
    return;
  }
  if (clusters.stage === 'label') {
    for (let i = 0; i < LABEL_STEPS; i++) clusters.step();
    return;
  }
  const steps = algorithm === 'potts' ? pottsSteps : wideSteps;
  const begin = performance.now();
  for (let i = 0; i < steps; i++) {
    for (const { sim } of clusters.bands) {
      if (algorithm === 'potts') sim.stepPotts(pottsParams);
      else sim.step(wideParams);
    }
    clusters.steps++;
    if (performance.now() - begin > BUDGET) break;
  }
}

function render(): void {
  pixels.fill(COLOR_OUTSIDE);
  if (clusters.stage === 'bands') renderBands();
  else renderGrowth();
  ctx.putImageData(image, 0, 0);

  let text = '';
  if (clusters.stage === 'spread') text = `wave from the stones · step ${clusters.steps}`;
  else if (clusters.stage === 'label') text = `agreeing on labels · step ${clusters.steps}`;
  else {
    let area = 0;
    let hullArea = 0;
    for (const band of clusters.bands) {
      area += band.sim.area();
      hullArea += band.hullArea;
    }
    text = `${clusters.bands.length} clusters · step ${clusters.steps}`;
    if (hullArea > 0) text += ` · area ${(area / hullArea).toFixed(3)}`;
    if (showHull) drawHulls();
  }
  stat.textContent = text;
}

/** The wave, then the grown blobs coloured by the label each cell holds. */
function renderGrowth(): void {
  const { spread, label, stage } = clusters;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (!spread.reached(i)) continue;
      if (stones[i]) {
        pixels[i] = COLOR_STONE;
      } else if (stage === 'label') {
        pixels[i] = DIM[hue(label[i])];
      } else {
        const front =
          (x > 0 && !spread.reached(i - 1)) ||
          (x < SIZE - 1 && !spread.reached(i + 1)) ||
          (y > 0 && !spread.reached(i - SIZE)) ||
          (y < SIZE - 1 && !spread.reached(i + SIZE));
        pixels[i] = front ? COLOR_FRONT : COLOR_INSIDE;
      }
    }
  }
}

/** Every band on its own layer: insides first, then stones, then the bands. */
function renderBands(): void {
  for (const { sim, x0, y0, id } of clusters.bands) {
    const dim = DIM[hue(id)];
    for (let y = 0; y < sim.h; y++) {
      for (let x = 0; x < sim.w; x++) {
        if (sim.phase[y * sim.w + x]) pixels[(y0 + y) * SIZE + x0 + x] = dim;
      }
    }
  }
  for (let i = 0; i < stones.length; i++) {
    if (stones[i]) pixels[i] = COLOR_STONE;
  }
  for (const { sim, x0, y0, id } of clusters.bands) {
    const { w, h, phase } = sim;
    const bright = BRIGHT[hue(id)];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!phase[i]) continue;
        // The band is the inside cells that touch the outside phase.
        const front =
          x === 0 ||
          y === 0 ||
          x === w - 1 ||
          y === h - 1 ||
          !phase[i - 1] ||
          !phase[i + 1] ||
          !phase[i - w] ||
          !phase[i + w];
        if (front) pixels[(y0 + y) * SIZE + x0 + x] = bright;
      }
    }
  }
}

function drawHulls(): void {
  ctx.beginPath();
  for (const { hull } of clusters.bands) {
    if (hull.length === 0) continue;
    ctx.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
    ctx.closePath();
  }
  ctx.strokeStyle = COLOR_HULL;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([2, 2]);
  ctx.stroke();
}

/** Spread labels over the colour table so that near labels look unlike. */
function hue(label: number): number {
  return Math.imul(label, 0x9e3779b1) >>> 24;
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

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

/** Pack a colour for a little-endian RGBA pixel buffer. */
function rgb(r: number, g: number, b: number): number {
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function hsl(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return rgb(channel(0), channel(8), channel(4));
}

requestAnimationFrame(frame);
