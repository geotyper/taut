import { convexHull, polygonArea, polygonPerimeter, type Point } from './hull.ts';
import {
  RULE_ANNEAL,
  RULE_MAJORITY,
  Sim,
  type ClassicRule,
  type Extras,
  type Params,
  type PottsParams,
  type StartShape,
} from './sim.ts';

const SIZE = 256;
/**
 * Per-frame simulation time limits, in ms; stepping stops early past them.
 * A field shown alone gets the whole frame.
 */
const COMPARE_BUDGET = 7;
const SINGLE_BUDGET = 14;

const COLOR_OUTSIDE = rgb(11, 13, 17);
const COLOR_INSIDE = rgb(30, 42, 60);
const COLOR_STONE = rgb(132, 138, 150);
const COLOR_FRONT = rgb(255, 209, 102);
const COLOR_HULL = '#4dd0e1';

const RULES: Record<string, ClassicRule> = {
  anneal: RULE_ANNEAL,
  majority: RULE_MAJORITY,
};

type Algorithm = 'wide' | 'classic' | 'potts' | 'growth';

/** Which optional physics each automaton can take on. */
const SUPPORTS: Record<Algorithm, { friction: boolean; length: boolean }> = {
  wide: { friction: true, length: true },
  classic: { friction: true, length: false },
  potts: { friction: true, length: true },
  growth: { friction: false, length: false },
};

/** One field: its own automaton and options, on the shared stones. */
interface Panel {
  sim: Sim;
  algorithm: Algorithm;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  pixels: Uint32Array;
  stat: HTMLElement;
  figure: HTMLElement;
  algorithmSelect: HTMLSelectElement;
  frictionToggle: HTMLInputElement;
  lengthToggle: HTMLInputElement;
}

const stones = new Uint8Array(SIZE * SIZE);
const panelA = createPanel('a', 'wide');
const panelB = createPanel('b', 'classic');
const panels = [panelA, panelB];

const wideParams: Params = { radius: 5, threshold: 0.5, noise: 0.1 };
const pottsParams: PottsParams = { temperature: 0.5, pressure: 0 };
let rule = RULE_ANNEAL;
let growthRadius = 40;
let frictionStrength = 1;
let lengthFactor = 1.3;
let start: StartShape = 'rough';
let single = false;
let classicSteps = 60;
let wideSteps = 2;
let pottsSteps = 40;
let brush = 7;
let showHull = true;
let paused = false;

let hull: Point[] = [];
let hullArea = 0;
let hullLength = 0;
let hullDirty = true;

bindRange('radius', 0, (v) => (wideParams.radius = v));
bindRange('threshold', 3, (v) => (wideParams.threshold = v));
bindRange('noise', 2, (v) => (wideParams.noise = v));
bindRange('speed', 0, (v) => (wideSteps = v));
bindRange('classic-speed', 0, (v) => (classicSteps = v));
bindRange('temperature', 2, (v) => (pottsParams.temperature = v));
bindRange('potts-pressure', 2, (v) => (pottsParams.pressure = v));
bindRange('potts-speed', 0, (v) => (pottsSteps = v));
bindRange('growth-radius', 0, (v) => {
  growthRadius = v;
  for (const panel of panels) panel.sim.settled = false;
});
bindRange('friction', 2, (v) => (frictionStrength = v));
bindRange('length', 2, (v) => (lengthFactor = v));
bindRange('brush', 0, (v) => (brush = v));

const modeSelect = byId<HTMLSelectElement>('mode');
modeSelect.addEventListener('change', () => {
  single = modeSelect.value === 'single';
  syncControls();
});

const ruleSelect = byId<HTMLSelectElement>('rule');
ruleSelect.addEventListener('change', () => (rule = RULES[ruleSelect.value]));

const startSelect = byId<HTMLSelectElement>('start');
startSelect.addEventListener('change', () => {
  start = startSelect.value as StartShape;
  restartAll();
});

const hullToggle = byId<HTMLInputElement>('show-hull');
hullToggle.addEventListener('change', () => (showHull = hullToggle.checked));

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
});
byId('restart').addEventListener('click', restartAll);
byId('random').addEventListener('click', () => {
  panelA.sim.clearStones();
  panelA.sim.randomStones(6);
  stonesEdited();
  restartAll();
});
byId('clear').addEventListener('click', () => {
  panelA.sim.clearStones();
  stonesEdited();
  restartAll();
});

for (const panel of panels) {
  panel.algorithmSelect.addEventListener('change', () => {
    panel.algorithm = panel.algorithmSelect.value as Algorithm;
    restart(panel);
    syncControls();
  });
  panel.frictionToggle.addEventListener('change', syncControls);
  panel.lengthToggle.addEventListener('change', syncControls);
}

panelA.sim.randomStones(6);
stonesEdited();
restartAll();
syncControls();

function restart(panel: Panel): void {
  panel.sim.restart(panel.algorithm === 'growth' ? 'stones' : start);
}

function restartAll(): void {
  for (const panel of panels) restart(panel);
}

function stonesEdited(): void {
  hullDirty = true;
  for (const panel of panels) {
    panel.sim.stonesChanged();
    // Growth only ever adds cells, so it has to start over from the new stones.
    if (panel.algorithm === 'growth') restart(panel);
  }
}

function frictionOn(panel: Panel): boolean {
  return panel.frictionToggle.checked && SUPPORTS[panel.algorithm].friction;
}

function lengthOn(panel: Panel): boolean {
  return panel.lengthToggle.checked && SUPPORTS[panel.algorithm].length;
}

/** Show only the controls that affect a visible field. */
function syncControls(): void {
  panelB.figure.hidden = single;
  byId('fields').classList.toggle('single', single);
  const visible = single ? [panelA] : panels;
  for (const panel of panels) {
    panel.frictionToggle.disabled = !SUPPORTS[panel.algorithm].friction;
    panel.lengthToggle.disabled = !SUPPORTS[panel.algorithm].length;
  }
  for (const algorithm of Object.keys(SUPPORTS)) {
    byId(`group-${algorithm}`).hidden = !visible.some((p) => p.algorithm === algorithm);
  }
  byId('group-friction').hidden = !visible.some(frictionOn);
  byId('group-length').hidden = !visible.some(lengthOn);
}

// Painting stones with the pointer, on either field.
let last: Point | null = null;
let erasing = false;

for (const { canvas } of panels) {
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
    for (const panel of panels) panel.sim.paintStone(x, y, brush, erasing ? 0 : 1);
  }
  stonesEdited();
}

function frame(): void {
  if (hullDirty) {
    hull = convexHull(stones, SIZE, SIZE);
    hullArea = polygonArea(hull);
    hullLength = polygonPerimeter(hull);
    hullDirty = false;
  }
  for (const panel of panels) {
    // A hidden field is frozen until it is shown again.
    if (panel.figure.hidden) continue;
    if (!paused) advance(panel, single ? SINGLE_BUDGET : COMPARE_BUDGET);
    render(panel);
  }
  requestAnimationFrame(frame);
}

function advance(panel: Panel, budget: number): void {
  const { sim } = panel;
  const extras: Extras = {
    friction: frictionOn(panel) ? frictionStrength : 0,
    targetLength: lengthOn(panel) ? lengthFactor * hullLength : 0,
  };
  let steps: number;
  let step: () => void;
  switch (panel.algorithm) {
    case 'wide':
      steps = wideSteps;
      step = () => sim.step(wideParams, extras);
      break;
    case 'classic':
      steps = classicSteps;
      step = () => sim.stepClassic(rule, extras);
      break;
    case 'potts':
      steps = pottsSteps;
      step = () => sim.stepPotts(pottsParams, extras);
      break;
    case 'growth':
      steps = 1;
      step = () => sim.stepGrowth(growthRadius);
      break;
  }
  const begin = performance.now();
  for (let i = 0; i < steps; i++) {
    step();
    if (performance.now() - begin > budget) break;
  }
}

function render(panel: Panel): void {
  const { sim, ctx, image, pixels, stat } = panel;
  const { phase } = sim;
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

  let text = `step ${sim.steps}`;
  if (hullArea > 0) {
    const area = (sim.area() / hullArea).toFixed(3);
    const length = (sim.perimeter() / hullLength).toFixed(3);
    text += ` · area ${area} · length ${length}`;
  }
  if (panel.algorithm === 'growth' && sim.settled) text += ' · settled';
  stat.textContent = text;
}

function createPanel(name: string, algorithm: Algorithm): Panel {
  const canvas = byId<HTMLCanvasElement>(`field-${name}`);
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(SIZE, SIZE);
  const algorithmSelect = byId<HTMLSelectElement>(`algorithm-${name}`);
  algorithmSelect.value = algorithm;
  return {
    sim: new Sim(SIZE, SIZE, stones),
    algorithm,
    canvas,
    ctx,
    image,
    pixels: new Uint32Array(image.data.buffer),
    stat: byId(`stat-${name}`),
    figure: byId(`figure-${name}`),
    algorithmSelect,
    frictionToggle: byId<HTMLInputElement>(`friction-${name}`),
    lengthToggle: byId<HTMLInputElement>(`length-${name}`),
  };
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
