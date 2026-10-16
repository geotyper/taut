import { Renderer, type Camera, type View } from '../3d/renderer.ts';
import { bubbleLabel, frameField, makeFrame, startLabels, type Frame, type FrameKind, type FrameStart } from './frames.ts';
import { Wire3, type Wire3Params } from './wire3.ts';

/** The cuts are looked for this far round a cell: the widest kernel, and one more. */
const REACH = 6;
/** Pulling the rings apart: this much gap, in radii, every so many steps. */
const PULL_STEP = 0.02;
const PULL_EVERY = 40;

const canvas = byId<HTMLCanvasElement>('field-3d');
const stat = byId('stat');
const camera: Camera = { yaw: 0.6, pitch: 0.35, distance: 1.3 };
const params: Wire3Params = { radius: 3, noise: 0.15 };

let renderer: Renderer | null = null;
let wire: Wire3 | null = null;
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
let stepsPerFrame = 2;
let opacity = 0.35;
let smooth = false;
let paused = false;
let frame: Frame | null = null;
let fieldMs = 0;
let pulledAt = 0;
/** The gap at which the tube between two rings last broke into two discs. */
let brokeAt: number | null = null;
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

function build(): void {
  if (!renderer) return;
  wire?.dispose();
  wire = null;
  try {
    wire = new Wire3(renderer, size);
  } catch (error) {
    failure = String(error);
    return;
  }
  restart();
}

function kindOf(value: string): FrameKind {
  return value === 'cube-bubble' ? 'cube' : (value as FrameKind);
}

function startOf(value: string): FrameStart {
  if (value === 'rings') return 'catenoid';
  if (value === 'tetra' || value === 'cube') return 'chambers';
  if (value === 'cube-bubble') return 'bubble';
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
  const labels = startLabels(frame, field, n, start, gap);
  wire.setFrame(frame, field, REACH, labels, start === 'bubble' ? bubbleLabel(frame) : -1);
  bubbleStart = wire.bubbleTarget;
  wire.holdBubble(bubbleShare, bubbleStart);
  fieldMs = performance.now() - begun;
  pulledAt = 0;
  brokeAt = null;
}

/** The rings moved to the gap set, the films kept as they are. */
function moveWire(): void {
  if (!wire || choice !== 'rings') return;
  const begun = performance.now();
  frame = makeFrame('rings', wire.n, gap);
  wire.setFrame(frame, frameField(frame, wire.n, REACH, false), REACH, null, -1);
  fieldMs = performance.now() - begun;
}

function tick(): void {
  if (wire && renderer) {
    if (!paused) {
      wire.step(params, stepsPerFrame);
      rateSteps += stepsPerFrame;
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
    if (choice === 'rings' && brokeAt === null && wire.steps > 8 && wire.volumes[1] === 0) brokeAt = gap;
    const now = performance.now();
    if (now - rateSince > 1000) {
      rate = (rateSteps * 1000) / (now - rateSince);
      rateSteps = 0;
      rateSince = now;
    }
    wire.show(smooth);
    const view: View = { opacity, oneColor: false, smoothness: 0.6 };
    if (smooth) renderer.drawSmooth(null, wire.n, camera, view);
    else renderer.drawVoxels(null, wire.n, camera, view);
    const bubble = wire.bubbleTarget > 0 ? ` · bubble ${Math.round(wire.bubbleVolume)} of ${Math.round(wire.bubbleTarget)} cells` : '';
    const broke = choice === 'rings' ? (brokeAt === null ? ' · a tube' : ` · broke into two discs at a gap of ${brokeAt.toFixed(2)} radii`) : '';
    stat.textContent = `step ${wire.steps}${bubble}${broke} · ${Math.round(rate)} steps/s · frame worked out in ${Math.round(fieldMs)} ms`;
  } else {
    stat.textContent = `The wire frames need WebGL2 with float blending: ${failure}`;
  }
  requestAnimationFrame(tick);
}

function syncControls(): void {
  byId('pick-gap').hidden = choice !== 'rings';
  byId('pick-pull').hidden = choice !== 'rings';
  byId('pick-bubble').hidden = choice !== 'cube-bubble';
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
