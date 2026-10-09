import { convexHull, polygonArea, type Point } from './hull.ts';
import { Sim, type Params } from './sim.ts';

const SIZE = 512;
/** Stop stepping early if a frame's simulation work exceeds this, in ms. */
const FRAME_BUDGET = 14;

const COLOR_OUTSIDE = rgb(11, 13, 17);
const COLOR_INSIDE = rgb(30, 42, 60);
const COLOR_STONE = rgb(132, 138, 150);
const COLOR_FRONT = rgb(255, 209, 102);
const COLOR_HULL = '#4dd0e1';

const canvas = byId<HTMLCanvasElement>('field');
canvas.width = SIZE;
canvas.height = SIZE;
const ctx = canvas.getContext('2d')!;
const image = ctx.createImageData(SIZE, SIZE);
const pixels = new Uint32Array(image.data.buffer);

const sim = new Sim(SIZE, SIZE);
sim.randomStones(6);

const params: Params = { radius: 8, threshold: 0.5, noise: 0.1 };
let stepsPerFrame = 3;
let brush = 14;
let showHull = true;
let paused = false;

let hull: Point[] = [];
let hullArea = 0;
let hullDirty = true;

bindRange('radius', 0, (v) => (params.radius = v));
bindRange('threshold', 3, (v) => (params.threshold = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('brush', 0, (v) => (brush = v));

const hullToggle = byId<HTMLInputElement>('show-hull');
hullToggle.addEventListener('change', () => (showHull = hullToggle.checked));

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? 'Продолжить' : 'Пауза';
});
byId('restart').addEventListener('click', () => sim.restart());
byId('random').addEventListener('click', () => {
  sim.clearStones();
  sim.randomStones(6);
  sim.restart();
  hullDirty = true;
});
byId('clear').addEventListener('click', () => {
  sim.clearStones();
  sim.restart();
  hullDirty = true;
});

const statSteps = byId('stat-steps');
const statRatio = byId('stat-ratio');

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
    sim.paintStone(
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
      brush,
      erasing ? 0 : 1,
    );
  }
  hullDirty = true;
}

function frame(): void {
  if (!paused) {
    const start = performance.now();
    for (let i = 0; i < stepsPerFrame; i++) {
      sim.step(params);
      if (performance.now() - start > FRAME_BUDGET) break;
    }
  }
  if (hullDirty) {
    hull = convexHull(sim.stones, SIZE, SIZE);
    hullArea = polygonArea(hull);
    hullDirty = false;
  }
  render();
  statSteps.textContent = String(sim.steps);
  statRatio.textContent = hullArea > 0 ? (sim.area() / hullArea).toFixed(3) : '—';
  requestAnimationFrame(frame);
}

function render(): void {
  const { phase, stones } = sim;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (!phase[i]) {
        pixels[i] = COLOR_OUTSIDE;
        continue;
      }
      // The band is the inside cells that touch the outside phase.
      const front =
        x === 0 ||
        y === 0 ||
        x === SIZE - 1 ||
        y === SIZE - 1 ||
        !phase[i - 1] ||
        !phase[i + 1] ||
        !phase[i - SIZE] ||
        !phase[i + SIZE];
      pixels[i] = front ? COLOR_FRONT : stones[i] ? COLOR_STONE : COLOR_INSIDE;
    }
  }
  ctx.putImageData(image, 0, 0);

  if (showHull && hull.length > 0) {
    ctx.beginPath();
    ctx.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
    ctx.closePath();
    ctx.strokeStyle = COLOR_HULL;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
  }
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

requestAnimationFrame(frame);
