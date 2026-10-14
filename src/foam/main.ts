import { AIR, Foam, type FoamParams } from './foam.ts';
import { FoamGpu } from './foamgpu.ts';
import { Sheen } from './sheen.ts';

/** Per-frame time limit for stepping, in ms. */
const BUDGET = 12;
/** A scattered centre starts as a disc this many kernel radii across. */
const SEED_SIZE = 1.5;

const COLOR_AIR = rgb(11, 13, 17);
const COLOR_FILM = rgb(226, 232, 244);
const COLOR_FILM_DARK = rgb(52, 58, 82);

/** One colour per bubble, picked by its label. */
const HUES = 256;
const DIM = new Uint32Array(HUES);
const PASTEL = new Uint32Array(HUES);
/** The colours of a thin film, which change with its thickness. */
const SHEEN = new Uint32Array(HUES);
const SHEEN_BRIGHT = new Uint32Array(HUES);
for (let i = 0; i < HUES; i++) {
  const angle = (i / HUES) * 360;
  DIM[i] = hsl(angle, 0.45, 0.2);
  PASTEL[i] = hsl(angle, 0.5, 0.8);
  // Lighter and paler twice around the circle, as the bands of a real film are.
  const wave = Math.cos((i / HUES) * 4 * Math.PI);
  SHEEN[i] = hsl(angle, 0.42 + 0.14 * wave, 0.72 - 0.06 * wave);
  SHEEN_BRIGHT[i] = hsl(angle, 0.9, 0.7);
}
/**
 * How fast the colour of a film runs down the field, in hues per cell: a
 * film drains downwards, so its thickness and its colour change with height.
 */
const SHEEN_DRIFT = 0.6;

type Palette = 'soap' | 'pastel' | 'films' | 'dark';

/** "?cpu" keeps the rule off the GPU. */
const onGpu = !new URLSearchParams(location.search).has('cpu');

const canvas = byId<HTMLCanvasElement>('field');
const ctx = canvas.getContext('2d')!;
const stat = byId('stat');
/** The shader picture, drawn on a canvas of its own. */
const sheenCanvas = byId<HTMLCanvasElement>('field-sheen');

let size = 0;
let foam!: Foam;
/** Null when the rule runs on the CPU. */
let gpu: FoamGpu | null = null;
let image!: ImageData;
let pixels!: Uint32Array;
/** Null where the shader cannot run. */
let sheen: Sheen | null = null;
/** Steps a second, measured over the last second or so. */
let rate = 0;
let rateSteps = 0;
let rateSince = performance.now();

const params: FoamParams = { radius: 6, noise: 0.1, keepArea: true };
let stepsPerFrame = 1;
let centreCount = 40;
let brush = 10;
let palette: Palette = 'soap';
let paused = false;
build(Number(byId<HTMLSelectElement>('field-size').value));
let shimmer = sheen !== null;

const paletteSelect = byId<HTMLSelectElement>('palette');
paletteSelect.addEventListener('change', () => {
  palette = paletteSelect.value as Palette;
  syncControls();
});

const sheenToggle = byId<HTMLInputElement>('sheen');
sheenToggle.checked = shimmer;
sheenToggle.disabled = sheen === null;
sheenToggle.addEventListener('change', () => {
  shimmer = sheenToggle.checked;
  syncControls();
});

bindRange('radius', 0, (v) => (params.radius = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('count', 0, (v) => (centreCount = v));
bindRange('brush', 0, (v) => (brush = v));
// Scatter a new set once the slider is released, not on every tick of a drag.
byId('count').addEventListener('change', scatter);

const sizeSelect = byId<HTMLSelectElement>('field-size');
sizeSelect.addEventListener('change', () => {
  build(Number(sizeSelect.value));
  scatter();
});

const keepToggle = byId<HTMLInputElement>('keep-area');
keepToggle.addEventListener('change', () => (params.keepArea = keepToggle.checked));

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', togglePause);
byId('random').addEventListener('click', scatter);
byId('add').addEventListener('click', addCentre);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') togglePause();
  else if (e.key === 'n' || e.key === 'N') scatter();
  else if (e.key === 'a' || e.key === 'A') addCentre();
  else return;
  e.preventDefault();
});

for (const target of [canvas, sheenCanvas]) {
  target.addEventListener('contextmenu', (e) => e.preventDefault());
  target.addEventListener('pointerdown', (e) => {
    const rect = target.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * size);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * size);
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    if (e.button === 2 || e.shiftKey) foam.pop(x, y);
    else foam.seed(x, y, brush);
  });
}

syncControls();
scatter();

/** The shimmer belongs to the two light palettes. */
function shimmering(): boolean {
  return shimmer && sheen !== null && (palette === 'soap' || palette === 'pastel');
}

function syncControls(): void {
  byId('pick-sheen').hidden = palette !== 'soap' && palette !== 'pastel';
  canvas.hidden = shimmering();
  sheenCanvas.hidden = !shimmering();
}

/** A new field of this many cells a side, on the GPU where it can run. */
function build(n: number): void {
  gpu?.dispose();
  size = n;
  foam = new Foam(n, n);
  gpu = onGpu ? FoamGpu.create(foam) : null;
  canvas.width = n;
  canvas.height = n;
  image = ctx.createImageData(n, n);
  pixels = new Uint32Array(image.data.buffer);
  sheen = Sheen.create(sheenCanvas, n, n);
}

function scatter(): void {
  foam.clear();
  foam.scatter(centreCount, params.radius * SEED_SIZE);
}

function addCentre(): void {
  foam.seed(Math.floor(Math.random() * size), Math.floor(Math.random() * size), brush);
}

function togglePause(): void {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
}

function frame(): void {
  if (!paused) {
    const before = foam.steps;
    if (gpu) gpu.step(params, stepsPerFrame);
    else {
      const started = performance.now();
      for (let s = 0; s < stepsPerFrame; s++) {
        foam.step(params);
        if (performance.now() - started > BUDGET) break;
      }
    }
    rateSteps += foam.steps - before;
  }
  const now = performance.now();
  if (now - rateSince > 1000) {
    rate = (rateSteps * 1000) / (now - rateSince);
    rateSteps = 0;
    rateSince = now;
  }
  render();
  requestAnimationFrame(frame);
}

function render(): void {
  const label = foam.label;
  stat.textContent = status();
  if (shimmering()) {
    sheen!.draw(label, hue, palette === 'pastel', performance.now() / 1000);
    return;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const here = label[i];
      // A film is drawn on the cell to the left of or above a border.
      const film =
        (x + 1 < size && label[i + 1] !== here) || (y + 1 < size && label[i + size] !== here);
      pixels[i] = here === AIR && !film ? COLOR_AIR : colour(here, y, film);
    }
  }
  ctx.putImageData(image, 0, 0);
}

function status(): string {
  const air = foam.air > 0 ? ` · ${Math.round((foam.air / (size * size)) * 100)}% air` : '';
  const where = gpu ? 'on the GPU' : 'on the CPU';
  return `${foam.bubbles} bubbles · step ${foam.steps}${air} · ${Math.round(rate)} steps/s ${where} · film length ${foam.filmLength()}`;
}

function colour(label: number, y: number, film: boolean): number {
  if (palette === 'dark') return film ? COLOR_FILM : DIM[hue(label)];
  if (palette === 'pastel') return film ? COLOR_FILM_DARK : PASTEL[hue(label)];
  // Every bubble starts the run of colours at a place of its own.
  const sheen = (hue(label) + y * SHEEN_DRIFT) & (HUES - 1);
  if (palette === 'films') return film ? SHEEN_BRIGHT[sheen] : COLOR_AIR;
  return film ? COLOR_FILM : SHEEN[sheen];
}

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
