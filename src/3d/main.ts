import { Renderer, type Camera } from './renderer.ts';
import { Sim3, type Params3, type StartShape3 } from './sim3.ts';
import { scatterStones } from './stones.ts';

/** Per-frame simulation time limit, in ms; stepping stops early past it. */
const FRAME_BUDGET = 14;

type Automaton = 'lines' | 'film';

const canvas = byId<HTMLCanvasElement>('field-3d');
const stat = byId('stat-3d');
const renderer = createRenderer();

const linesParams: Params3 = { radius: 10, threshold: 0.65, noise: 0 };
const filmParams: Params3 = { radius: 3, threshold: 0.5, noise: 0.1 };
const camera: Camera = { yaw: 0.7, pitch: 0.45, distance: 1.5 };
let automaton: Automaton = 'lines';
let start: StartShape3 = 'ball';
let stoneCount = 5;
let stoneSpread = 0.88;
let stepsPerFrame = 1;
let opacity = 0.3;
let opaque = false;
let oneColor = false;
let paused = false;

let sim = new Sim3(64);
let voxels = new Uint8Array(sim.phase.length);
let stoneVolume = 0;
let stepMs = 0;

bindRange('lines-radius', 0, (v) => (linesParams.radius = v));
bindRange('lines-threshold', 2, (v) => (linesParams.threshold = v));
bindRange('lines-noise', 2, (v) => (linesParams.noise = v));
bindRange('film-radius', 0, (v) => (filmParams.radius = v));
bindRange('film-threshold', 3, (v) => (filmParams.threshold = v));
bindRange('film-noise', 2, (v) => (filmParams.noise = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('opacity', 2, (v) => (opacity = v));
bindRange('stone-count', 0, (v) => (stoneCount = v));
bindRange('stone-spread', 2, (v) => (stoneSpread = v));
// Scatter a new set once the slider is released, not on every tick of a drag.
for (const id of ['stone-count', 'stone-spread']) {
  byId(id).addEventListener('change', () => rebuild(sim.n));
}

const automatonSelect = byId<HTMLSelectElement>('automaton');
automatonSelect.addEventListener('change', () => {
  automaton = automatonSelect.value as Automaton;
  syncControls();
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

// "?opaque" and "?onecolor" start with those view options switched on.
const query = new URLSearchParams(location.search);
if (query.has('opaque')) opaqueToggle.click();
if (query.has('onecolor')) oneColorToggle.click();
for (let i = Number(query.get('steps')); i > 0; i--) step();
requestAnimationFrame(frame);

/** New field of the given size with a fresh set of stones. */
function rebuild(n: number): void {
  sim = new Sim3(n);
  voxels = new Uint8Array(sim.phase.length);
  scatterStones(sim.stones, n, stoneCount, stoneSpread);
  stoneVolume = 0;
  for (let i = 0; i < sim.stones.length; i++) stoneVolume += sim.stones[i];
  sim.restart(start);
}

function syncControls(): void {
  byId('group-lines').hidden = automaton !== 'lines';
  byId('group-film').hidden = automaton !== 'film';
}

function step(): void {
  if (automaton === 'lines') sim.stepLines(linesParams);
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
  const membrane = sim.classify(voxels);
  renderer?.draw(voxels, sim.n, camera, opaque ? 1 : opacity, oneColor);

  const volume = stoneVolume > 0 ? (sim.volume() / stoneVolume).toFixed(2) : '—';
  stat.textContent =
    `step ${sim.steps} · ${stepMs.toFixed(1)} ms/step · ` +
    `volume ${volume}× stones · membrane ${membrane} voxels`;
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
