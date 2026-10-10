import { Renderer, type Camera, type View } from './renderer.ts';
import { Sim3, type LineKernel, type Params3, type StartShape3 } from './sim3.ts';
import { scatterStones, type StoneOptions } from './stones.ts';

/** Per-frame simulation time limit, in ms; stepping stops early past it. */
const FRAME_BUDGET = 14;

type Automaton = 'lines' | 'film';

/**
 * Line threshold at zero and at full inward pressure, per kernel. Below the
 * first value the membrane stays pinned where it started; towards the second
 * it sags ever deeper between the stones.
 */
const SAG_RANGE: Record<LineKernel, [number, number]> = {
  thin: [0.6, 0.95],
  soft: [0.52, 0.9],
};
/** Full outward pressure inflates the membrane by this fraction of the field. */
const INFLATE_REACH = 1 / 8;

const canvas = byId<HTMLCanvasElement>('field-3d');
const stat = byId('stat-3d');
const renderer = createRenderer();

const linesParams: Params3 = { radius: 10, threshold: SAG_RANGE.thin[0], noise: 0 };
const filmParams: Params3 = { radius: 3, threshold: 0.5, noise: 0.1 };
const camera: Camera = { yaw: 0.7, pitch: 0.45, distance: 1.5 };
let automaton: Automaton = 'lines';
let kernel: LineKernel = 'thin';
/** -1..1: negative inflates the membrane, positive makes it sag inwards. */
let pressure = 0;
let start: StartShape3 = 'ball';
const stoneOptions: StoneOptions = { count: 5, spread: 0.88, placement: 'box', shape: 'mixed' };
let stepsPerFrame = 1;
let opacity = 0.3;
let opaque = false;
let oneColor = false;
let smooth = false;
let smoothness = 1.2;
let paused = false;

let sim = new Sim3(64);
let voxels = new Uint8Array(sim.phase.length);
let stoneVolume = 0;
let stepMs = 0;

bindRange('lines-radius', 0, (v) => (linesParams.radius = v));
bindRange('pressure', 2, (v) => {
  pressure = v;
  syncPressure();
});
bindRange('lines-noise', 2, (v) => (linesParams.noise = v));
bindRange('film-radius', 0, (v) => (filmParams.radius = v));
bindRange('film-threshold', 3, (v) => (filmParams.threshold = v));
bindRange('film-noise', 2, (v) => (filmParams.noise = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('opacity', 2, (v) => (opacity = v));
bindRange('smoothness', 1, (v) => (smoothness = v));
bindRange('stone-count', 0, (v) => (stoneOptions.count = v));
bindRange('stone-spread', 2, (v) => (stoneOptions.spread = v));
// Scatter a new set once the slider is released, not on every tick of a drag.
for (const id of ['stone-count', 'stone-spread']) {
  byId(id).addEventListener('change', () => rebuild(sim.n));
}

const placementSelect = byId<HTMLSelectElement>('stone-placement');
placementSelect.addEventListener('change', () => {
  stoneOptions.placement = placementSelect.value as StoneOptions['placement'];
  rebuild(sim.n);
});

const shapeSelect = byId<HTMLSelectElement>('stone-shape');
shapeSelect.addEventListener('change', () => {
  stoneOptions.shape = shapeSelect.value as StoneOptions['shape'];
  rebuild(sim.n);
});

const automatonSelect = byId<HTMLSelectElement>('automaton');
automatonSelect.addEventListener('change', () => {
  automaton = automatonSelect.value as Automaton;
  syncControls();
  sim.restart(start);
});

const kernelSelect = byId<HTMLSelectElement>('kernel');
kernelSelect.addEventListener('change', () => {
  kernel = kernelSelect.value as LineKernel;
  syncPressure();
  sim.restart(start);
});

const sizeSelect = byId<HTMLSelectElement>('size');
sizeSelect.addEventListener('change', () => {
  const n = Number(sizeSelect.value);
  // Radii are in cells: scale them so the membrane behaves the same at any
  // resolution.
  for (const id of ['lines-radius', 'film-radius']) {
    const input = byId<HTMLInputElement>(id);
    input.value = String(Math.round((Number(input.value) * n) / sim.n));
    input.dispatchEvent(new Event('input'));
  }
  rebuild(n);
});

const surfaceSelect = byId<HTMLSelectElement>('surface');
surfaceSelect.addEventListener('change', () => {
  smooth = surfaceSelect.value === 'smooth';
  syncControls();
});

const opaqueToggle = byId<HTMLInputElement>('opaque');
opaqueToggle.addEventListener('change', () => {
  opaque = opaqueToggle.checked;
  byId<HTMLInputElement>('opacity').disabled = opaque;
});

const startSelect = byId<HTMLSelectElement>('start');
startSelect.addEventListener('change', () => {
  start = startSelect.value as StartShape3;
  sim.restart(start);
});

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
});
byId('restart').addEventListener('click', () => sim.restart(start));
byId('random').addEventListener('click', () => rebuild(sim.n));

// Keyboard shortcuts, so the view can be switched without reaching for the
// menu - while recording, scrolling to a control would shift the picture.
const SHORTCUTS: Record<string, () => void> = {
  o: () => opaqueToggle.click(),
  c: () => oneColorToggle.click(),
  s: () => {
    surfaceSelect.value = smooth ? 'voxels' : 'smooth';
    surfaceSelect.dispatchEvent(new Event('change'));
  },
  n: () => rebuild(sim.n),
  r: () => sim.restart(start),
  ' ': () => pauseButton.click(),
};
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // A focused list uses letters to jump between its options, and a focused
  // button already answers to the space bar.
  const target = e.target as HTMLElement;
  if (target.tagName === 'SELECT' || (target.tagName === 'BUTTON' && e.key === ' ')) return;
  const action = SHORTCUTS[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();
  action();
});

// Orbit with the pointer, zoom with the wheel.
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  dragging = true;
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  camera.yaw -= e.movementX * 0.008;
  camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch + e.movementY * 0.008));
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointercancel', () => (dragging = false));
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camera.distance = Math.max(0.6, Math.min(4, camera.distance * Math.exp(e.deltaY * 0.001)));
  },
  { passive: false },
);

syncControls();
rebuild(sim.n);
// "?steps=200" runs that many steps before the first frame, to open the page
// on an already settled membrane.
const oneColorToggle = byId<HTMLInputElement>('one-color');
oneColorToggle.addEventListener('change', () => (oneColor = oneColorToggle.checked));

// "?opaque", "?onecolor" and "?smooth" start with those view options chosen.
const query = new URLSearchParams(location.search);
if (query.has('opaque')) opaqueToggle.click();
if (query.has('onecolor')) oneColorToggle.click();
if (query.has('smooth')) {
  surfaceSelect.value = 'smooth';
  surfaceSelect.dispatchEvent(new Event('change'));
}
for (const select of [placementSelect, shapeSelect]) {
  const value = query.get(select.id);
  if (value === null) continue;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}
if (query.has('kernel')) {
  kernelSelect.value = query.get('kernel')!;
  kernelSelect.dispatchEvent(new Event('change'));
}
if (query.has('pressure')) {
  const input = byId<HTMLInputElement>('pressure');
  input.value = query.get('pressure')!;
  input.dispatchEvent(new Event('input'));
}
if (query.has('size')) {
  sizeSelect.value = query.get('size')!;
  sizeSelect.dispatchEvent(new Event('change'));
}
for (let i = Number(query.get('steps')); i > 0; i--) step();
requestAnimationFrame(frame);

/** New field of the given size with a fresh set of stones. */
function rebuild(n: number): void {
  sim = new Sim3(n);
  voxels = new Uint8Array(sim.phase.length);
  scatterStones(sim.stones, n, stoneOptions);
  stoneVolume = 0;
  for (let i = 0; i < sim.stones.length; i++) stoneVolume += sim.stones[i];
  renderer?.setStones(sim.stones, n);
  sim.restart(start);
}

/** Inward pressure is the line threshold; outward pressure is handled in `shown`. */
function syncPressure(): void {
  const [taut, slack] = SAG_RANGE[kernel];
  linesParams.threshold = taut + Math.max(0, pressure) * (slack - taut);
}

/** The field to draw: the membrane itself, or inflated under outward pressure. */
function shown(): Uint8Array {
  if (automaton !== 'lines' || pressure >= 0) return sim.phase;
  return sim.inflated(-pressure * INFLATE_REACH * sim.n);
}

function syncControls(): void {
  byId('group-lines').hidden = automaton !== 'lines';
  byId('group-film').hidden = automaton !== 'film';
  byId('group-smoothness').hidden = !smooth;
}

function step(): void {
  if (automaton === 'lines') sim.stepLines(linesParams, kernel);
  else sim.stepFilm(filmParams);
}

function frame(): void {
  if (!paused) {
    const begin = performance.now();
    let done = 0;
    while (done < stepsPerFrame) {
      step();
      done++;
      if (performance.now() - begin > FRAME_BUDGET) break;
    }
    stepMs = (performance.now() - begin) / done;
  }
  const view: View = { opacity: opaque ? 1 : opacity, oneColor, smoothness };
  const field = shown();
  if (smooth) {
    renderer?.drawSmooth(field, sim.n, camera, view);
  } else {
    sim.classify(voxels, field);
    renderer?.drawVoxels(voxels, sim.n, camera, view);
  }

  const volume = stoneVolume > 0 ? (sim.volume(field) / stoneVolume).toFixed(2) : '—';
  stat.textContent =
    `step ${sim.steps} · ${stepMs.toFixed(1)} ms/step · ` +
    `volume ${volume}× stones`;
  requestAnimationFrame(frame);
}

function createRenderer(): Renderer | null {
  try {
    return new Renderer(canvas);
  } catch (error) {
    stat.textContent = String(error);
    return null;
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
