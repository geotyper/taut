import { AIR, Foam, type FoamParams } from './foam.ts';
import { FoamGpu } from './foamgpu.ts';
import { outlines, traceFilms, WALL, type FilmLine } from './lines.ts';
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
 * Without the shader the stress palette gives every bubble one colour from the
 * run a stressed sheet shows between crossed polarisers, past a tint plate.
 */
const STRESS = new Uint32Array(HUES);
for (let i = 0; i < HUES; i++) STRESS[i] = interference(1010 + 900 * (i / HUES));
const STRESS_AIR = rgb(222, 108, 160);
const STRESS_FILM = rgb(20, 12, 26);
const STRESS_EDGE = rgb(250, 240, 244);
/**
 * How fast the colour of a film runs down the field, in hues per cell: a
 * film drains downwards, so its thickness and its colour change with height.
 */
const SHEEN_DRIFT = 0.6;

type Palette = 'soap' | 'pastel' | 'stress' | 'stress-light' | 'stress-smooth' | 'films' | 'dark';
/**
 * How the foam gets coarser. 'seep': bubbles do not keep their area, so the
 * films pull small bubbles in, as gas seeping through the films from a small
 * bubble into its neighbours would. 'burst' and 'pop': areas are kept, and
 * now and then a film ruptures and joins two bubbles, or a bubble bursts and
 * its neighbours grow into the hole.
 */
type Coarsening = 'none' | 'seep' | 'burst' | 'pop';

/** "?cpu" keeps the rule off the GPU. */
const onGpu = !new URLSearchParams(location.search).has('cpu');

const canvas = byId<HTMLCanvasElement>('field');
const ctx = canvas.getContext('2d')!;
const stat = byId('stat');
/** The shader picture, drawn on a canvas of its own. */
const sheenCanvas = byId<HTMLCanvasElement>('field-sheen');
/** The films drawn as lines, in 'films' with `asLines`. */
const linesCanvas = byId<HTMLCanvasElement>('field-lines');
const linesCtx = linesCanvas.getContext('2d')!;
let asLines = false;
/** Width of a line on the screen, in CSS pixels. */
let lineWidth = 2;
let filmLines: FilmLine[] = [];
/**
 * What fills the bubbles under their lines: nothing, a flat colour each, as
 * opaque as `fillOpacity`, or the smoothed stress picture of the shader.
 */
type Fill = 'none' | 'flat' | 'stress';
let fill: Fill = 'none';
let fillOpacity = 0.35;
let bubbleOutlines = new Map<number, Float32Array[][]>();
/** The step and edit the lines were traced at. */
let tracedAt = '';

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
let coarsening: Coarsening = 'none';
/** Bursts or pops a step, on average. */
let burstRate = 0.01;
/** Bursts owed but not yet made, so that a fraction is carried over. */
let burstsOwed = 0;
build(Number(byId<HTMLSelectElement>('field-size').value));
let shimmer = sheen !== null;

const paletteSelect = byId<HTMLSelectElement>('palette');
paletteSelect.addEventListener('change', () => {
  palette = paletteSelect.value as Palette;
  syncControls();
});
palette = paletteSelect.value as Palette;

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

// The selects are read once at the start too: a reload may keep their choice.
const coarseningSelect = byId<HTMLSelectElement>('coarsening');
const chooseCoarsening = () => {
  coarsening = coarseningSelect.value as Coarsening;
  params.keepArea = coarsening !== 'seep';
  syncControls();
};
coarseningSelect.addEventListener('change', chooseCoarsening);
chooseCoarsening();
bindRange('rate', 0, (v) => (burstRate = v / 1000));

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

const linesToggle = byId<HTMLInputElement>('as-lines');
linesToggle.addEventListener('change', () => {
  asLines = linesToggle.checked;
  syncControls();
});
asLines = linesToggle.checked;
bindRange('line-width', 1, (v) => (lineWidth = v));
const fillSelect = byId<HTMLSelectElement>('fill');
fillSelect.addEventListener('change', () => {
  fill = fillSelect.value as Fill;
  syncControls();
});
fill = fillSelect.value as Fill;
bindRange('fill-opacity', 2, (v) => (fillOpacity = v));

for (const target of [canvas, sheenCanvas, linesCanvas]) {
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

/** The shimmer belongs to the palettes drawn by the shader. */
function shimmering(): boolean {
  return shimmer && sheen !== null && shaded(palette);
}

/** The shader's mode for each palette it draws. */
const MODES: Record<Palette, number> = { soap: 0, pastel: 1, stress: 2, 'stress-light': 3, 'stress-smooth': 4, films: 0, dark: 0 };

function shaded(p: Palette): boolean {
  return p === 'soap' || p === 'pastel' || p === 'stress' || p === 'stress-light' || p === 'stress-smooth';
}

function syncControls(): void {
  byId('pick-rate').hidden = coarsening !== 'burst' && coarsening !== 'pop';
  byId('pick-sheen').hidden = !shaded(palette);
  byId('pick-lines').hidden = palette !== 'films';
  byId('pick-line-width').hidden = !drawingLines();
  byId('pick-fill').hidden = !drawingLines();
  byId('pick-fill-opacity').hidden = !drawingLines() || fill !== 'flat';
  // The lines lie over the stress picture, or over the plain field, which they cover.
  canvas.hidden = shimmering() || stressUnder();
  sheenCanvas.hidden = !shimmering() && !stressUnder();
  linesCanvas.hidden = !drawingLines();
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
    coarsen(foam.steps - before);
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

/** The bursts or pops due over this many steps; none while there is air. */
function coarsen(steps: number): void {
  if ((coarsening !== 'burst' && coarsening !== 'pop') || foam.air > 0) return;
  burstsOwed += steps * burstRate;
  while (burstsOwed >= 1) {
    burstsOwed--;
    const done = coarsening === 'burst' ? foam.burstFilm() : foam.popAny();
    if (!done) break;
  }
}

function drawingLines(): boolean {
  return palette === 'films' && asLines;
}

function stressUnder(): boolean {
  return drawingLines() && fill === 'stress' && sheen !== null;
}

/**
 * The films as smooth lines, each in a colour of its pair of bubbles, drawn
 * twice as the skeleton of the 3D foam is: wide and faint for a glow, then
 * thin and bright, the light adding up where they meet.
 */
function renderLines(): void {
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(linesCanvas.clientWidth * scale));
  if (linesCanvas.width !== width || linesCanvas.height !== width) {
    linesCanvas.width = width;
    linesCanvas.height = width;
  }
  const at = `${foam.steps}:${foam.edits}`;
  if (at !== tracedAt) {
    filmLines = traceFilms(foam.label, size, size);
    bubbleOutlines = outlines(filmLines);
    tracedAt = at;
  }
  const ctx = linesCtx;
  const cell = width / size;
  ctx.globalCompositeOperation = 'source-over';
  const stress = stressUnder();
  if (stress) {
    sheen!.draw(foam.label, hue, 5, performance.now() / 1000);
    ctx.clearRect(0, 0, width, width);
  } else {
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(0, 0, width, width);
  }
  if (fill === 'flat') {
    // Inside the same lines as are drawn over it, so the two meet exactly.
    ctx.globalAlpha = fillOpacity;
    for (const [label, loops] of bubbleOutlines) {
      if (label === AIR) continue;
      ctx.fillStyle = css(SHEEN_BRIGHT[hue(label)]);
      ctx.beginPath();
      for (const loop of loops) {
        let first = true;
        for (const points of loop) {
          for (let k = 0; k < points.length; k += 2) {
            const x = points[k] * cell;
            const y = points[k + 1] * cell;
            if (first) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
            first = false;
          }
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
    }
    ctx.globalAlpha = 1;
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [wide, alpha] of [
    [3, 0.22],
    [1, 1],
  ]) {
    ctx.lineWidth = lineWidth * scale * wide;
    ctx.globalAlpha = alpha;
    for (const line of filmLines) {
      // The edge of the field closes the bubbles but is no film.
      if (line.a === WALL || line.b === WALL) continue;
      const { points } = line;
      // Over the stress colours a line is the light rim of a clear edge.
      ctx.strokeStyle = stress ? '#fff8fa' : css(SHEEN_BRIGHT[pairHue(line.a, line.b)]);
      ctx.beginPath();
      ctx.moveTo(points[0] * cell, points[1] * cell);
      for (let k = 2; k < points.length; k += 2) ctx.lineTo(points[k] * cell, points[k + 1] * cell);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** One hue for a film, the same whichever side it is seen from. */
function pairHue(a: number, b: number): number {
  return hue(Math.min(a, b) * 65599 + Math.max(a, b));
}

function css(colour: number): string {
  return `rgb(${colour & 255},${(colour >> 8) & 255},${(colour >> 16) & 255})`;
}

function render(): void {
  const label = foam.label;
  stat.textContent = status();
  if (drawingLines()) {
    stat.textContent = `${status()} · ${filmLines.length} lines`;
    renderLines();
    return;
  }
  if (shimmering()) {
    sheen!.draw(label, hue, MODES[palette], performance.now() / 1000);
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
  if (palette === 'stress-light' || palette === 'stress-smooth') return film ? STRESS_EDGE : label === AIR ? STRESS_AIR : STRESS[hue(label)];
  if (palette === 'stress') return film ? STRESS_FILM : label === AIR ? STRESS_AIR : STRESS[hue(label)];
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

/** The colour of this retardation in nm between crossed polarisers; as in the shader of sheen.ts. */
function interference(retardation: number): number {
  const lobe = (l: number, mu: number, below: number, above: number) =>
    Math.exp(-0.5 * ((l - mu) / (l < mu ? below : above)) ** 2);
  const sum = [0, 0, 0];
  const white = [0, 0, 0];
  for (let l = 400; l < 712; l += 13) {
    const x = 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
    const y = 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
    const z = 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);
    const c = [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z];
    const s = Math.sin((Math.PI * retardation) / l) ** 2;
    for (let k = 0; k < 3; k++) {
      sum[k] += c[k] * s;
      white[k] += c[k];
    }
  }
  const channel = (k: number) => Math.round(255 * Math.min(1, Math.max(0, sum[k] / white[k])) ** (1 / 2.2));
  return rgb(channel(0), channel(1), channel(2));
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
