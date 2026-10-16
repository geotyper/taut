import { Renderer, type Camera, type View } from '../3d/renderer.ts';
import { Drainage } from './drain.ts';
import { filmFaces, frameField, gyroid, heldBubbles, makeFrame, startLabels, type Frame, type FrameKind, type FrameStart } from './frames.ts';
import { Wire3, type Wire3Params } from './wire3.ts';

/** The cuts are looked for this far round a cell: the widest kernel, and one more. */
const REACH = 6;
/** Pulling the rings apart: this much gap, in radii, every so many steps. */
const PULL_STEP = 0.02;
const PULL_EVERY = 40;

const canvas = byId<HTMLCanvasElement>('field-3d');
const stat = byId('stat');
const camera: Camera = { yaw: 0.6, pitch: 0.35, distance: 1.3 };
const params: Wire3Params = { radius: 3, noise: 0.15, breeze: 0 };

let renderer: Renderer | null = null;
let wire: Wire3 | null = null;
let drainage: Drainage | null = null;
let failure = '';
try {
  renderer = new Renderer(canvas);
} catch (error) {
  failure = String(error);
}

let size = Number(byId<HTMLSelectElement>('size').value);
let choice = byId<HTMLSelectElement>('frame').value;
let gap = 0.8;
let pull = false;
let bubbleShare = 0.5;
let bubbleStart = 0;
/** Periods of the gyroid across the field, and the faces of its nodal approximation there. */
let across = 1;
let gyroidFaces = 0;
let stepsPerFrame = 2;
let opacity = 0.35;
let smooth = false;
let paused = false;
let frame: Frame | null = null;
let fieldMs = 0;
let pulledAt = 0;
/** The gap at which the tube between two rings last broke into two discs. */
let brokeAt: number | null = null;
/** Films burst on their own, this many a step on average, and those owed. */
let bursting = false;
let burstRate = 0.003;
let burstsOwed = 0;
let burstCount = 0;
let colours: 'hues' | 'soap' | 'drained' = 'hues';
/**
 * Draining by gravity: seconds drained for a second on the screen, how
 * thick a fresh film is, in µm, and how fast the films evaporate, in nm a
 * minute.
 */
let drainSpeed = 1000;
let fresh = 0.8;
let evaporation = 0.3;
let measuredAt = 0;
/** Seconds the films have drained, as on the foam page. */
let drained = 0;
let lastFrame = performance.now();
/** The black film comes down no further than this share of the field. */
const LOWEST_FRONT = 0.3;
/** How much the swirl thickens and thins the soap films; see View.film. */
const SWIRL = 0.6;
let rate = 0;
let rateSteps = 0;
let rateSince = performance.now();

bindRange('radius', 0, (v) => (params.radius = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('opacity', 2, (v) => (opacity = v));
bindRange('gap', 2, (v) => (gap = v));
byId('gap').addEventListener('change', () => moveWire());
bindRange('bubble', 2, (v) => {
  bubbleShare = v;
  wire?.holdBubble(bubbleShare, bubbleStart);
});
onCheck('pull', (v) => (pull = v));
bindRange('across', 0, (v) => (across = v));
// The speed on a slider of its logarithm, the stat showing the factor.
bindRange('drain-speed', 1, (v) => (drainSpeed = 10 ** v));
byId('drain-speed').addEventListener('input', () => (byId('drain-speed-out').textContent = `×${Math.round(drainSpeed)}`));
byId('drain-speed-out').textContent = `×${Math.round(drainSpeed)}`;
bindRange('evaporation', 1, (v) => (evaporation = v));
bindRange('fresh', 1, (v) => (fresh = v));
byId('across').addEventListener('change', () => restart());
bindRange('breeze', 3, (v) => (params.breeze = v));
onCheck('bursting', (v) => {
  bursting = v;
  byId('pick-rate').hidden = !v;
});
bindRange('rate', 0, (v) => (burstRate = v / 1000));
byId('burst').addEventListener('click', burstOne);
onSelect('colours', (v) => {
  // The draining starts from fresh films, as it has not followed them while it was off.
  if (v === 'drained' && colours !== 'drained') drainage?.wet(fresh);
  colours = v as typeof colours;
  syncControls();
});
onSelect('surface', (v) => (smooth = v === 'smooth'));
onSelect('frame', (v) => {
  choice = v;
  syncControls();
  restart();
});
// Last, as it builds the field and the frame with it.
onSelect('size', (v) => {
  size = Number(v);
  build();
});

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
  else if (key === 'b') burstOne();
  else if (key === 'w') wet();
  else return;
  e.preventDefault();
});

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
requestAnimationFrame(tick);
// For checks from the console or a test: the rule and the draining as they are.
Object.assign(window, { wirePage: { wire: () => wire, drainage: () => drainage } });

function build(): void {
  if (!renderer) return;
  drainage?.dispose();
  drainage = null;
  wire?.dispose();
  wire = null;
  try {
    wire = new Wire3(renderer, size);
  } catch (error) {
    failure = String(error);
    return;
  }
  // Without the draining the rest still runs; the stat says why it is missing.
  try {
    drainage = new Drainage(renderer.gl, wire);
  } catch (error) {
    failure = String(error);
  }
  restart();
}

function kindOf(value: string): FrameKind {
  if (value === 'gyroid-random') return 'gyroid';
  if (value === 'one' || value === 'two' || value === 'unequal') return 'free';
  return value === 'cube-bubble' ? 'cube' : (value as FrameKind);
}

function startOf(value: string): FrameStart {
  if (value === 'rings') return 'catenoid';
  if (value === 'tetra' || value === 'cube') return 'chambers';
  if (value === 'cube-bubble') return 'bubble';
  if (value === 'gyroid') return 'gyroid';
  if (value === 'gyroid-random') return 'random';
  if (value === 'one' || value === 'two' || value === 'unequal') return value;
  return 'cut';
}

/** The frame and its films from the start. */
function restart(): void {
  if (!wire) return;
  const n = wire.n;
  const begun = performance.now();
  frame = makeFrame(kindOf(choice), n, gap);
  const field = frameField(frame, n, REACH, false);
  const start = startOf(choice);
  const labels = startLabels(frame, field, n, start, gap, across);
  if (frame.periodic) {
    // One labyrinth is held to exactly half the field, so the other is too,
    // and the film between them can only pull taut.
    wire.setFrame(frame, field, REACH, labels, [1]);
    bubbleStart = (n * n * n) / 2;
    wire.holdBubble(1, bubbleStart);
    const g = gyroid(n, across);
    const nodal = new Uint32Array(n * n * n);
    for (let i = 0; i < nodal.length; i++) nodal[i] = g((i % n) + 0.5, (Math.floor(i / n) % n) + 0.5, Math.floor(i / (n * n)) + 0.5) > 0 ? 1 : 0;
    gyroidFaces = filmFaces(nodal, n);
  } else {
    wire.setFrame(frame, field, REACH, labels, heldBubbles(start, frame));
    bubbleStart = wire.bubble?.target ?? 0;
    // Only the bubble in a cube has a slider; free bubbles keep the volume they start with.
    if (start === 'bubble') wire.holdBubble(bubbleShare, bubbleStart);
  }
  fieldMs = performance.now() - begun;
  pulledAt = 0;
  brokeAt = null;
  burstCount = 0;
  wet();
}

/** The films fresh again, in both soap looks. */
function wet(): void {
  drained = 0;
  drainage?.wet(fresh);
}

/** The rings moved to the gap set, the films kept as they are. */
function moveWire(): void {
  if (!wire || choice !== 'rings') return;
  const begun = performance.now();
  frame = makeFrame('rings', wire.n, gap);
  wire.setFrame(frame, frameField(frame, wire.n, REACH, false), REACH, null, []);
  fieldMs = performance.now() - begun;
}

function tick(): void {
  if (wire && renderer) {
    if (!paused) {
      wire.step(params, stepsPerFrame);
      rateSteps += stepsPerFrame;
      if (bursting) {
        burstsOwed += stepsPerFrame * burstRate;
        while (burstsOwed >= 1) {
          burstsOwed--;
          burstOne();
        }
      }
      if (pull && choice === 'rings' && wire.steps - pulledAt >= PULL_EVERY) {
        pulledAt = wire.steps;
        const input = byId<HTMLInputElement>('gap');
        gap = Math.min(Number(input.max), gap + PULL_STEP);
        input.value = String(gap);
        byId('gap-out').textContent = gap.toFixed(2);
        moveWire();
      }
    }
    // The inside of the tube is the only label 1: when it is gone, the film has broken.
    if (choice === 'rings' && brokeAt === null && burstCount === 0 && wire.steps > 8 && wire.volumes[1] === 0) brokeAt = gap;
    const now = performance.now();
    const seconds = Math.min(0.1, (now - lastFrame) / 1000);
    if (!paused) drained += seconds;
    if (drainage && colours === 'drained') {
      if (!paused) drainage.drain(seconds * drainSpeed, fresh, evaporation / 60000);
      if (now - measuredAt > 500) {
        measuredAt = now;
        drainage.measure();
      }
    }
    lastFrame = now;
    if (now - rateSince > 1000) {
      rate = (rateSteps * 1000) / (now - rateSince);
      rateSteps = 0;
      rateSince = now;
    }
    wire.show(smooth);
    const view: View = { opacity, oneColor: false, smoothness: 0.6 };
    if (colours === 'soap') {
      // As on the foam page: the film thins as one over the root of the time.
      // A film on a frame swirls more than in a foam, so one lying flat,
      // all at one height, still shows its colours.
      view.film = { mode: 'soap', time: drained, front: Math.max(LOWEST_FRONT, 1.05 / Math.sqrt(1 + drained * 0.03)), swirl: SWIRL };
    } else if (colours === 'drained' && drainage) {
      view.film = { mode: 'drained', time: drained, front: 1 };
    }
    renderer.setThickness(colours === 'drained' && drainage ? drainage.thickness : null);
    if (smooth) renderer.drawSmooth(null, wire.n, camera, view);
    else renderer.drawVoxels(null, wire.n, camera, view);
    const periodic = frame?.periodic === true;
    const bubble = periodic
      ? ` · film ${((100 * wire.filmFaces) / gyroidFaces).toFixed(1)}% of the nodal gyroid's · one labyrinth ${((100 * wire.volumes[1]) / wire.n ** 3).toFixed(1)}% of the field`
      : [...wire.holds].map(([label, target]) => ` · bubble ${Math.round(wire!.volumes[label])} of ${Math.round(target)} cells`).join('');
    const broke = choice === 'rings' ? (brokeAt === null ? ' · a tube' : ` · broke into two discs at a gap of ${brokeAt.toFixed(2)} radii`) : '';
    const burst = burstCount > 0 ? ` · ${burstCount} films burst` : '';
    const thin =
      colours === 'drained' && drainage && drainage.filmCells > 0
        ? ` · drained ${formatTime(drainage.time)}, films ${(drainage.liquid / drainage.filmCells).toFixed(2)} µm on average`
        : '';
    stat.textContent = `step ${wire.steps}${bubble}${broke}${burst}${thin} · ${Math.round(rate)} steps/s · frame worked out in ${Math.round(fieldMs)} ms${failure ? ` · ${failure}` : ''}`;
  } else {
    stat.textContent = `The wire frames need WebGL2 with float blending: ${failure}`;
  }
  requestAnimationFrame(tick);
}

/** A film at random bursts, and the rest pull taut into a new shape. */
function burstOne(): void {
  const film = wire?.findFilm();
  if (!wire || !film) return;
  wire.burst(film[0], film[1]);
  burstCount++;
}

function syncControls(): void {
  byId('pick-gap').hidden = choice !== 'rings';
  byId('pick-pull').hidden = choice !== 'rings';
  byId('pick-bubble').hidden = choice !== 'cube-bubble';
  byId('pick-across').hidden = !choice.startsWith('gyroid');
  byId('pick-drain').hidden = colours !== 'drained';
}

function formatTime(seconds: number): string {
  if (seconds < 120) return `${seconds.toFixed(0)} s`;
  if (seconds < 7200) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function onSelect(id: string, apply: (value: string) => void): HTMLSelectElement {
  const select = byId<HTMLSelectElement>(id);
  select.addEventListener('change', () => apply(select.value));
  apply(select.value);
  return select;
}

function onCheck(id: string, apply: (value: boolean) => void): void {
  const input = byId<HTMLInputElement>(id);
  input.addEventListener('change', () => apply(input.checked));
  apply(input.checked);
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
