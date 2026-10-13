import { AIR, Foam, type FoamParams } from './foam.ts';

const SIZE = 320;
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

const foam = new Foam(SIZE, SIZE);

const canvas = byId<HTMLCanvasElement>('field');
canvas.width = SIZE;
canvas.height = SIZE;
const ctx = canvas.getContext('2d')!;
const image = ctx.createImageData(SIZE, SIZE);
const pixels = new Uint32Array(image.data.buffer);
const stat = byId('stat');

const params: FoamParams = { radius: 6, noise: 0.1, keepArea: true };
let stepsPerFrame = 1;
let centreCount = 40;
let brush = 10;
let palette: Palette = 'soap';
let paused = false;

const paletteSelect = byId<HTMLSelectElement>('palette');
paletteSelect.addEventListener('change', () => (palette = paletteSelect.value as Palette));

bindRange('radius', 0, (v) => (params.radius = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('count', 0, (v) => (centreCount = v));
bindRange('brush', 0, (v) => (brush = v));
// Scatter a new set once the slider is released, not on every tick of a drag.
byId('count').addEventListener('change', scatter);

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

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * SIZE);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * SIZE);
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
  if (e.button === 2 || e.shiftKey) foam.pop(x, y);
  else foam.seed(x, y, brush);
});

scatter();

function scatter(): void {
  foam.clear();
  foam.scatter(centreCount, params.radius * SEED_SIZE);
}

function addCentre(): void {
  foam.seed(Math.floor(Math.random() * SIZE), Math.floor(Math.random() * SIZE), brush);
}

function togglePause(): void {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
}

function frame(): void {
  if (!paused) {
    const started = performance.now();
    for (let s = 0; s < stepsPerFrame; s++) {
      foam.step(params);
      if (performance.now() - started > BUDGET) break;
    }
  }
  render();
  requestAnimationFrame(frame);
}

function render(): void {
  const label = foam.label;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const here = label[i];
      // A film is drawn on the cell to the left of or above a border.
      const film =
        (x + 1 < SIZE && label[i + 1] !== here) || (y + 1 < SIZE && label[i + SIZE] !== here);
      pixels[i] = here === AIR && !film ? COLOR_AIR : colour(here, y, film);
    }
  }
  ctx.putImageData(image, 0, 0);

  const air = foam.air > 0 ? ` · ${Math.round((foam.air / (SIZE * SIZE)) * 100)}% air` : '';
  stat.textContent = `${foam.bubbles} bubbles · step ${foam.steps}${air} · film length ${foam.filmLength()}`;
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
