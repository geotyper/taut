import { traceFilms, WALL } from '../foam/lines.ts';
import { drawMeasures, measureFilms, Seepage, type Measures } from '../foam/measure.ts';
import { MEDIUM, OUTER, Tissue, type Plane, type TissueParams } from './tissue.ts';

/** The egg's shell, as a share of half the field. */
const SHELL = 0.9;
/** Growth stops when the colony comes this near the field's edge, in pixels. */
const MARGIN = 6;
/** Time a frame may spend on steps, in ms. */
const BUDGET = 30;
const MEASURE_EVERY = 500;

const COLOR_MEDIUM = rgb(11, 13, 17);
const COLOR_WALL = rgb(24, 27, 34);
const COLOR_FILM = rgb(226, 232, 244);
/** Cells by sides, from 3 up: few sides warm, six grey, many cold. */
const SIDE_COLOURS = [
  rgb(220, 70, 60),
  rgb(235, 150, 50),
  rgb(90, 190, 100),
  rgb(150, 155, 165),
  rgb(70, 130, 220),
  rgb(140, 90, 210),
  rgb(200, 90, 190),
];
const OPEN = rgb(60, 64, 74);

const canvas = byId<HTMLCanvasElement>('field');
const ctx = canvas.getContext('2d')!;
const stat = byId('stat');
const plot = byId<HTMLCanvasElement>('measure-plot');
const params: TissueParams = { radius: 4, noise: 0.1, stiffer: 1 };

let size = 384;
let tissue = new Tissue(size, size);
let image = ctx.createImageData(size, size);
let pixels = new Uint32Array(image.data.buffer);
let start: 'egg' | 'colony' = 'egg';
let plane: Plane = 'long';
let every = 300;
let rounds = 5;
let doubling = 600;
let cellSize = 18;
let colours: 'clone' | 'fate' | 'sides' | 'generation' = 'clone';
let stepsPerFrame = 2;
let paused = false;
let measuring = false;
let measures: Measures | null = null;
let measuredAt = 0;
/** Steps since the egg last divided, and rounds of division so far. */
let sinceDivision = 0;
let roundsDone = 0;
let rate = 0;
let rateSteps = 0;
let rateSince = performance.now();
const seepage = new Seepage();

bindRange('radius', 0, (v) => (params.radius = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('stiffer', 1, (v) => (params.stiffer = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('every', 0, (v) => (every = v));
bindRange('rounds', 0, (v) => (rounds = v));
bindRange('doubling', 0, (v) => (doubling = v));
bindRange('cell-size', 0, (v) => (cellSize = v));
onSelect('plane', (v) => (plane = v as Plane));
onSelect('colours', (v) => (colours = v as typeof colours));
onSelect('start', (v) => {
  start = v as typeof start;
  byId('pick-egg').hidden = start !== 'egg';
  byId('pick-colony').hidden = start !== 'colony';
  restart();
});
onSelect('field-size', (v) => {
  size = Number(v);
  tissue = new Tissue(size, size);
  canvas.width = size;
  canvas.height = size;
  image = ctx.createImageData(size, size);
  pixels = new Uint32Array(image.data.buffer);
  restart();
});
const measureToggle = byId<HTMLInputElement>('measure');
measureToggle.addEventListener('change', () => {
  measuring = measureToggle.checked;
  plot.hidden = !measuring;
});

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
});
byId('restart').addEventListener('click', restart);
byId('divide').addEventListener('click', divideAll);
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'SELECT' || (target.tagName === 'BUTTON' && e.key === ' ')) return;
  const key = e.key.toLowerCase();
  if (key === 'n') restart();
  else if (key === 'd') divideAll();
  else if (key === ' ') pauseButton.click();
  else return;
  e.preventDefault();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * size);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * size);
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  if (e.button === 2 || e.shiftKey) tissue.remove(x, y);
  else tissue.divideCell(x, y, plane);
});

// For checks from the console or a test.
Object.assign(window, { cellsPage: { tissue: () => tissue, measures: () => measures } });
requestAnimationFrame(frame);

function restart(): void {
  if (start === 'egg') tissue.egg((SHELL * size) / 2);
  else tissue.seed(cellSize / 2);
  sinceDivision = 0;
  roundsDone = 0;
  measures = null;
}

/** Every cell divides at once; with the egg, as one of its rounds. */
function divideAll(): void {
  tissue.divideAll(plane);
  sinceDivision = 0;
  roundsDone++;
}

function frame(): void {
  if (!paused) {
    const began = performance.now();
    const before = tissue.steps;
    for (let s = 0; s < stepsPerFrame; s++) {
      if (start === 'egg') {
        // The egg divides on its own until the rounds set are done.
        if (++sinceDivision >= every && roundsDone < rounds) divideAll();
      } else {
        // Newborn cells hold to the area of a disc as wide as set, and grow to twice it.
        tissue.grow(doubling, plane, MARGIN);
      }
      tissue.step(params);
      if (performance.now() - began > BUDGET) break;
    }
    rateSteps += tissue.steps - before;
  }
  const now = performance.now();
  if (now - rateSince > 1000) {
    rate = (rateSteps * 1000) / (now - rateSince);
    rateSteps = 0;
    rateSince = now;
  }
  if ((measuring || colours === 'sides') && now - measuredAt > MEASURE_EVERY) {
    measuredAt = now;
    measures = measureFilms(traceFilms(tissue.label, size, size));
    if (measuring) drawMeasures(plot, measures, seepage, false);
  }
  render();
  stat.textContent = status();
  requestAnimationFrame(frame);
}

function render(): void {
  const label = tissue.label;
  const sides = measures?.sides;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const here = label[i];
      const film = (x + 1 < size && label[i + 1] !== here) || (y + 1 < size && label[i + size] !== here);
      if (here === WALL) pixels[i] = film ? COLOR_FILM : COLOR_WALL;
      else if (film) pixels[i] = COLOR_FILM;
      else if (here === MEDIUM) pixels[i] = COLOR_MEDIUM;
      else pixels[i] = colour(here, sides);
    }
  }
  ctx.putImageData(image, 0, 0);
}

function colour(l: number, sides: Map<number, number> | undefined): number {
  if (colours === 'sides') {
    const n = sides?.get(l);
    return n === undefined ? OPEN : SIDE_COLOURS[Math.max(0, Math.min(SIDE_COLOURS.length - 1, n - 3))];
  }
  if (colours === 'fate') {
    // Outer warm, inner cold, each clone a little lighter or darker.
    const shade = 0.38 + 0.2 * ((((tissue.tintOf(l) * 7) % 1) + 1) % 1);
    return tissue.fateOf(l) === OUTER ? hsl(28, 0.75, shade) : hsl(205, 0.6, shade);
  }
  if (colours === 'generation') return hsl((tissue.generationOf(l) * 47) % 360, 0.5, 0.45);
  const t = tissue.tintOf(l);
  return hsl((((t % 1) + 1) % 1) * 360, 0.55, 0.5);
}

function status(): string {
  const { inner, outer } = tissue.fates;
  const parts = [`${tissue.cells} cells, ${outer} outer and ${inner} inner`, `step ${tissue.steps}`, `${tissue.divisions} divisions`, `generation ${tissue.deepest}`];
  if (measures && measures.sides.size > 0) {
    const h = measures.histogram;
    const total = measures.sides.size;
    const share = (n: number) => `${Math.round((100 * h[n]) / total)}%`;
    parts.push(`closed cells: ${share(5)} with 5 sides, ${share(6)} with 6, ${share(7)} with 7, of ${total}`);
    parts.push(`junctions off 120° by ${measures.angleSpread.toFixed(1)}° rms`);
  }
  parts.push(`${Math.round(rate)} steps/s`);
  return parts.join(' · ');
}

function onSelect(id: string, apply: (value: string) => void): void {
  const select = byId<HTMLSelectElement>(id);
  select.addEventListener('change', () => apply(select.value));
  apply(select.value);
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
