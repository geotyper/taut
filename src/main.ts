import { convexHull, polygonArea, type Point } from './hull.ts';
import {
  RULE_ANNEAL,
  RULE_MAJORITY,
  Sim,
  type ClassicRule,
  type Params,
  type StartShape,
} from './sim.ts';

const SIZE = 256;
/** Per-frame simulation time limits, in ms; stepping stops early past them. */
const CLASSIC_BUDGET = 9;
const WIDE_BUDGET = 5;

const COLOR_OUTSIDE = rgb(11, 13, 17);
const COLOR_INSIDE = rgb(30, 42, 60);
const COLOR_STONE = rgb(132, 138, 150);
const COLOR_FRONT = rgb(255, 209, 102);
const COLOR_HULL = '#4dd0e1';

const RULES: Record<string, ClassicRule> = {
  anneal: RULE_ANNEAL,
  majority: RULE_MAJORITY,
};

interface View {
  sim: Sim;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  pixels: Uint32Array;
  stat: HTMLElement;
}

// Both automata run on the same stones.
const wide = createView('field-wide', 'stat-wide', new Sim(SIZE, SIZE));
const classic = createView(
  'field-classic',
  'stat-classic',
  new Sim(SIZE, SIZE, wide.sim.stones),
);
const views = [classic, wide];

const params: Params = { radius: 5, threshold: 0.5, noise: 0.1 };
let rule = RULE_ANNEAL;
let start: StartShape = 'rough';
let classicSteps = 60;
let wideSteps = 2;
let brush = 7;
let showHull = true;
let paused = false;

let hull: Point[] = [];
let hullArea = 0;
let hullDirty = true;

bindRange('classic-speed', 0, (v) => (classicSteps = v));
bindRange('radius', 0, (v) => (params.radius = v));
bindRange('threshold', 3, (v) => (params.threshold = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('speed', 0, (v) => (wideSteps = v));
bindRange('brush', 0, (v) => (brush = v));

const ruleSelect = byId<HTMLSelectElement>('rule');
ruleSelect.addEventListener('change', () => (rule = RULES[ruleSelect.value]));

const startSelect = byId<HTMLSelectElement>('start');
startSelect.addEventListener('change', () => {
  start = startSelect.value as StartShape;
  restart();
});

const hullToggle = byId<HTMLInputElement>('show-hull');
hullToggle.addEventListener('change', () => (showHull = hullToggle.checked));

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? 'Продолжить' : 'Пауза';
});
byId('restart').addEventListener('click', restart);
byId('random').addEventListener('click', () => {
  wide.sim.clearStones();
  wide.sim.randomStones(6);
  restart();
});
byId('clear').addEventListener('click', () => {
  wide.sim.clearStones();
  restart();
});

wide.sim.randomStones(6);
restart();

function restart(): void {
  for (const view of views) view.sim.restart(start);
  hullDirty = true;
}

// Painting stones with the pointer, on either field.
let last: Point | null = null;
let erasing = false;

for (const { canvas } of views) {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    erasing = e.button === 2 || e.shiftKey;
    last = toGrid(canvas, e);
    stroke(last, last);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const next = toGrid(canvas, e);
    stroke(last, next);
    last = next;
  });
  canvas.addEventListener('pointerup', () => (last = null));
  canvas.addEventListener('pointercancel', () => (last = null));
}

function toGrid(canvas: HTMLCanvasElement, e: PointerEvent): Point {
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
    for (const view of views) view.sim.paintStone(x, y, brush, erasing ? 0 : 1);
  }
  hullDirty = true;
}

function frame(): void {
  if (!paused) {
    run(classicSteps, CLASSIC_BUDGET, () => classic.sim.stepClassic(rule));
    run(wideSteps, WIDE_BUDGET, () => wide.sim.step(params));
  }
  if (hullDirty) {
    hull = convexHull(wide.sim.stones, SIZE, SIZE);
    hullArea = polygonArea(hull);
    hullDirty = false;
  }
  for (const view of views) render(view);
  requestAnimationFrame(frame);
}

function run(steps: number, budget: number, step: () => void): void {
  const begin = performance.now();
  for (let i = 0; i < steps; i++) {
    step();
    if (performance.now() - begin > budget) break;
  }
}

function render(view: View): void {
  const { sim, ctx, image, pixels, stat } = view;
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
    ctx.setLineDash([3, 3]);
    ctx.stroke();
  }

  const ratio = hullArea > 0 ? (sim.area() / hullArea).toFixed(3) : '—';
  stat.textContent = `шаг ${sim.steps} · площадь / оболочка ${ratio}`;
}

function createView(canvasId: string, statId: string, sim: Sim): View {
  const canvas = byId<HTMLCanvasElement>(canvasId);
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const pixels = new Uint32Array(image.data.buffer);
  return { sim, canvas, ctx, image, pixels, stat: byId(statId) };
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
