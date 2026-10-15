import { AIR, Foam, type FoamParams } from './foam.ts';
import { FoamGpu } from './foamgpu.ts';
import { between, lengthOf, loops, outlines, traceFilms, WALL, type FilmLine, type Piece } from './lines.ts';
import { drawMeasures, measureFilms, Seepage } from './measure.ts';
import { shells, svgPath, traceShell, type Shell } from './shells.ts';
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
let bubbleLoops = new Map<number, Piece[][]>();
/** The bubbles drawn as smooth shells with liquid between, instead of lines. */
let asShells = false;
let bubbleShells: Shell[] = [];
/** The tracing and settings the shells were built for. */
let shellsAt = '';
/** The colour of the liquid between the shells. */
const LIQUID = '#d6e2f6';
/** The step and edit the lines were traced at. */
let tracedAt = '';
/** How far the Plateau borders reach along the films, from 0 for a dry foam, in sizes of a bubble. */
let wetness = 0;
/**
 * What sets the width of a line: nothing, its bend, which is the difference in
 * pressure of the bubbles on its two sides, or how short it is.
 */
type WidthBy = 'even' | 'bend' | 'short';
let widthBy: WidthBy = 'even';
/** Measuring the films, every MEASURE_EVERY ms. */
let measuring = false;
const MEASURE_EVERY = 500;
let measuredAt = 0;
const seepage = new Seepage();
const measurePlot = byId<HTMLCanvasElement>('measure-plot');

/**
 * The picture mirrored, only as a picture. 'crop': a half or a quarter of the
 * field at its own scale, mirrored into the rest. 'whole': the whole field
 * shrunk, and mirrored copies of it beside it.
 */
type Mirror = 'none' | 'two-crop' | 'four-crop' | 'two-whole' | 'four-whole' | 'kaleido-3' | 'kaleido-4' | 'kaleido-6';
const MIRRORS: Mirror[] = ['none', 'two-crop', 'four-crop', 'two-whole', 'four-whole', 'kaleido-3', 'kaleido-4', 'kaleido-6'];
/**
 * A kaleidoscope's wedge has its tip near the top left corner of the field,
 * this many cells in from both walls, so that the walls themselves stay out
 * of the picture: films meet a wall square, so mirrored there they run on
 * without a seam.
 */
const KALEIDO_MARGIN = 4;

/**
 * Where the tip of a kaleidoscope's wedge is, as a fraction of the field, and
 * how much smaller the wedge is shown: its reach, to the far walls, comes to
 * the corners of the screen from its middle.
 */
function kaleidoFrame(): { tip: number; zoom: number } {
  const tip = Math.min(0.25, KALEIDO_MARGIN / size);
  return { tip, zoom: Math.SQRT1_2 / (1 - tip) };
}
let mirror: Mirror = 'none';
const mirrorCanvas = byId<HTMLCanvasElement>('field-mirror');
const mirrorCtx = mirrorCanvas.getContext('2d')!;
/**
 * The kaleidoscope with the whole field bent into its wedge: the field's
 * angles from the tip, 0 to 90°, are squeezed into the wedge's, and its reach
 * at each angle, out to the far wall, into a radius of `wedgeSize` halves of
 * the screen; past that the picture is cut off.
 */
let kaleidoBent = false;
let wedgeSize = 1.2;
/** The layers put together at the field's scale, for the bent kaleidoscope to read from. */
const bentSource = document.createElement('canvas');
const bentSourceCtx = bentSource.getContext('2d', { willReadFrequently: true })!;
/** Samples a side of every pixel of the bent picture, which are averaged so thin lines do not break up. */
const BENT_SAMPLES = 2;
/** For every sample of the bent picture, the pixel of `bentSource` it shows, or -1; and what it was made for. */
let bentLookup = new Int32Array(0);
let bentLookupFor = '';

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
/** Radius of the round wall, as a share of half the field. */
let fenceSize = 0.7;
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
  applyFence();
  scatter();
});

// The selects are read once at the start too: a reload may keep their choice.
const coarseningSelect = byId<HTMLSelectElement>('coarsening');
const chooseCoarsening = () => {
  coarsening = coarseningSelect.value as Coarsening;
  params.keepArea = coarsening !== 'seep';
  seepage.reset();
  syncControls();
};
coarseningSelect.addEventListener('change', chooseCoarsening);
chooseCoarsening();
bindRange('rate', 0, (v) => (burstRate = v / 1000));

// A round wall the foam grows inside, until it is taken away.
const fenceToggle = byId<HTMLInputElement>('fence');
const applyFence = () => {
  foam.setFence(fenceToggle.checked ? (fenceSize * size) / 2 : 0);
  byId('pick-fence-size').hidden = !fenceToggle.checked;
  byId('lift-fence').hidden = !fenceToggle.checked;
};
fenceToggle.addEventListener('change', applyFence);
bindRange('fence-size', 2, (v) => {
  fenceSize = v;
  if (fenceToggle.checked) applyFence();
});
byId('lift-fence').addEventListener('click', () => {
  fenceToggle.checked = false;
  applyFence();
});
applyFence();

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', togglePause);
byId('random').addEventListener('click', scatter);
byId('add').addEventListener('click', addCentre);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') togglePause();
  else if (e.key === 'n' || e.key === 'N') scatter();
  else if (e.key === 'a' || e.key === 'A') addCentre();
  else if (e.key === 'm' || e.key === 'M') {
    mirrorSelect.value = MIRRORS[(MIRRORS.indexOf(mirror) + 1) % MIRRORS.length];
    mirrorSelect.dispatchEvent(new Event('change'));
  }
  else return;
  e.preventDefault();
});

const mirrorSelect = byId<HTMLSelectElement>('mirror');
mirrorSelect.addEventListener('change', () => {
  mirror = mirrorSelect.value as Mirror;
  mirrorCanvas.hidden = mirror === 'none';
});
mirror = mirrorSelect.value as Mirror;
mirrorCanvas.hidden = mirror === 'none';
const bakeButton = byId<HTMLButtonElement>('bake-mirror');
bakeButton.addEventListener('click', () => bakeMirror(false));
const bakeJoinedButton = byId<HTMLButtonElement>('bake-mirror-joined');
bakeJoinedButton.addEventListener('click', () => bakeMirror(true));
const syncMirror = () => {
  mirrorCanvas.hidden = mirror === 'none';
  bakeButton.hidden = mirror === 'none';
  bakeJoinedButton.hidden = mirror === 'none';
  byId('pick-bent').hidden = !kaleidoMirrors();
  byId('pick-wedge-size').hidden = !kaleidoMirrors() || !kaleidoBent;
};
mirrorSelect.addEventListener('change', syncMirror);
const bentToggle = byId<HTMLInputElement>('kaleido-bent');
bentToggle.addEventListener('change', () => {
  kaleidoBent = bentToggle.checked;
  syncMirror();
});
kaleidoBent = bentToggle.checked;
bindRange('wedge-size', 2, (v) => (wedgeSize = v));
syncMirror();

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
bindRange('wetness', 2, (v) => (wetness = v));
const shellsToggle = byId<HTMLInputElement>('as-shells');
shellsToggle.addEventListener('change', () => {
  asShells = shellsToggle.checked;
  syncControls();
});
asShells = shellsToggle.checked;
byId('save-svg').addEventListener('click', saveSvg);
const widthSelect = byId<HTMLSelectElement>('width-by');
widthSelect.addEventListener('change', () => (widthBy = widthSelect.value as WidthBy));
widthBy = widthSelect.value as WidthBy;
const measureToggle = byId<HTMLInputElement>('measure');
measureToggle.addEventListener('change', () => {
  measuring = measureToggle.checked;
  seepage.reset();
  measurePlot.hidden = !measuring;
});
measuring = measureToggle.checked;
measurePlot.hidden = !measuring;

for (const target of [canvas, sheenCanvas, linesCanvas]) {
  target.addEventListener('contextmenu', (e) => e.preventDefault());
  target.addEventListener('pointerdown', (e) => {
    const rect = target.getBoundingClientRect();
    const at = unmirror((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    // A kaleidoscope's corners reach past the field.
    if (at && (at[0] < 0 || at[0] >= 1 || at[1] < 0 || at[1] >= 1)) return;
    if (!at) return;
    const x = Math.floor(at[0] * size);
    const y = Math.floor(at[1] * size);
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
  byId('pick-wetness').hidden = !drawingLines();
  byId('pick-width-by').hidden = !drawingLines() || asShells;
  byId('pick-shells').hidden = !drawingLines();
  byId('save-svg').hidden = !drawingLines() || !asShells;
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
  seepage.reset();
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
  if (mirror !== 'none') renderMirror();
  if (measuring && now - measuredAt > MEASURE_EVERY) {
    measuredAt = now;
    measure();
  }
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

/** Trace the films again if the field has changed since. */
function traceLines(): void {
  const at = `${foam.steps}:${foam.edits}`;
  if (at === tracedAt) return;
  filmLines = traceFilms(foam.label, size, size);
  bubbleOutlines = outlines(filmLines);
  bubbleLoops = loops(filmLines);
  tracedAt = at;
}

/** Count the sides and angles of the films, and how the areas change, and chart them. */
function measure(): void {
  traceLines();
  const measures = measureFilms(filmLines);
  if (foam.air > 0) seepage.forget();
  else if (!paused) seepage.update(foam.steps, foam.label, measures.sides);
  drawMeasures(measurePlot, measures, seepage, coarsening === 'seep');
}

/** The radius of a bubble of the mean size, in cells. */
function bubbleRadius(): number {
  return Math.sqrt((size * size) / Math.max(1, foam.bubbles) / Math.PI);
}

/** How much wider than the slider says a whole line is drawn, for `widthBy`; the bend goes point by point. */
function widthFactor(line: FilmLine, meanLength: number): number {
  if (widthBy === 'short') return Math.min(4, 0.35 + (0.65 * meanLength) / Math.max(0.5, lengthOf(line.points)));
  return 1;
}

/** The bend at a point is taken over this share of the line to either side, and no fewer than BEND_REACH points. */
const BEND_SHARE = 0.25;
const BEND_REACH = 4;
/** The most a line is as wide as the radius it bends round. */
const BEND_CAP = 1 / 3;
/** Rounds of smoothing of the widths along a line, so that the wobble of the cells does not show. */
const BEND_SMOOTHING = 10;

/**
 * The width in pixels of a line at each of its points, from `base`, the
 * slider's, by the bend there: the curvature of the circle through the point and two
 * others a quarter of the line to either side, against the radius of a mean
 * bubble. A film is then wide where it curves and thin where it runs
 * straight, and wider still towards its ends, where it runs into the liquid
 * of the junction, as a meniscus.
 */
function bendWidths(points: Float32Array, radius: number, base: number, cellPx: number): Float32Array {
  const n = points.length / 2;
  const widths = new Float32Array(n);
  // Near the ends the window would shrink to a few points, which see only the
  // steps of the cells; there the bend is taken where the window is whole.
  const window = Math.min(Math.max(BEND_REACH, Math.round(n * BEND_SHARE)), Math.floor((n - 1) / 2));
  for (let k = 0; k < n; k++) {
    const middle = Math.min(Math.max(k, window), n - 1 - window);
    const reach = window;
    let bend = 0;
    if (reach > 0) {
      const k = middle;
      const a = (k - reach) * 2;
      const b = k * 2;
      const c = (k + reach) * 2;
      const ab = Math.hypot(points[b] - points[a], points[b + 1] - points[a + 1]);
      const bc = Math.hypot(points[c] - points[b], points[c + 1] - points[b + 1]);
      const ca = Math.hypot(points[c] - points[a], points[c + 1] - points[a + 1]);
      const twice = Math.abs((points[b] - points[a]) * (points[c + 1] - points[a + 1]) - (points[b + 1] - points[a + 1]) * (points[c] - points[a]));
      bend = ab * bc * ca > 0 ? (2 * twice) / (ab * bc * ca) : 0;
    }
    widths[k] = bend;
  }
  const copy = new Float32Array(n);
  for (let round = 0; round < BEND_SMOOTHING; round++) {
    copy.set(widths);
    for (let k = 1; k < n - 1; k++) widths[k] = (copy[k - 1] + 2 * copy[k] + copy[k + 1]) / 4;
  }
  for (let k = 0; k < n; k++) {
    const t = n > 1 ? (2 * k) / (n - 1) - 1 : 0;
    const bend = widths[k];
    widths[k] = base * (0.3 + 1.7 * Math.min(1, bend * radius)) * (0.7 + 0.6 * t * t * t * t);
    // Never wider than a third of the radius it bends round, nor twice the slider:
    // round a small bubble a wide line would fill it.
    if (bend > 0) widths[k] = Math.min(widths[k], (BEND_CAP * cellPx) / bend);
  }
  return widths;
}

/** A line as a filled ribbon whose width changes along it, `widths` in pixels at each point. */
function drawRibbon(ctx: CanvasRenderingContext2D, points: Float32Array, cell: number, widths: Float32Array): void {
  const n = points.length / 2;
  if (n < 2) return;
  const left: number[] = [];
  const right: number[] = [];
  for (let k = 0; k < n; k++) {
    // The direction over a few points, which the wobble of the cells turns less.
    const p = Math.max(0, k - 2) * 2;
    const q = Math.min(n - 1, k + 2) * 2;
    let tx = points[q] - points[p];
    let ty = points[q + 1] - points[p + 1];
    const length = Math.hypot(tx, ty) || 1;
    tx /= length;
    ty /= length;
    const half = widths[k] / 2;
    const x = points[k * 2] * cell;
    const y = points[k * 2 + 1] * cell;
    left.push(x - ty * half, y + tx * half);
    right.push(x + ty * half, y - tx * half);
  }
  ctx.beginPath();
  ctx.moveTo(left[0], left[1]);
  for (let k = 2; k < left.length; k += 2) ctx.lineTo(left[k], left[k + 1]);
  for (let k = right.length - 2; k >= 0; k -= 2) ctx.lineTo(right[k], right[k + 1]);
  ctx.closePath();
  ctx.fill();
}

/**
 * Plateau borders: the liquid of a wet foam, which is all of the field but the
 * bubbles with their corners rounded off. At every junction each bubble cuts
 * its corner back along its two films, as far as `wetness` of a bubble's size
 * but never past most of a film, with a curve that leaves the films smoothly.
 * Bubbles that share a film cut it back at the same place, so the cut corners
 * make the wedge of a border with three concave sides; and as every cut lies
 * inside its own bubble, a border never reaches out past the films. A bubble
 * smaller than the reach is rounded all over. Corners on the wall and air are
 * left sharp.
 */
function drawBorders(ctx: CanvasRenderingContext2D, cell: number, radius: number, colour: string): void {
  const reach = wetness * 0.8 * radius;
  const walled = new Set<number>();
  for (const line of filmLines) {
    if (line.a !== WALL && line.b !== WALL) continue;
    walled.add(line.start);
    walled.add(line.end);
  }
  const lengths = new Map<FilmLine, number>();
  const lengthOfLine = (line: FilmLine) => {
    let length = lengths.get(line);
    if (length === undefined) lengths.set(line, (length = lengthOf(line.points)));
    return length;
  };
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.rect(0, 0, size * cell, size * cell);
  for (const [label, found] of bubbleLoops) {
    for (const loop of found) {
      const sharp = label === AIR || (loop.length === 1 && loop[0].line.start === loop[0].line.end);
      /** How far a piece is cut back at its first or last corner, as the loop runs. */
      const cut = ({ line, forward }: Piece, first: boolean) => {
        const corner = forward === first ? line.start : line.end;
        if (sharp || walled.has(corner)) return 0;
        return Math.min(reach, 0.45 * lengthOfLine(line));
      };
      // Each piece cut back at both ends, in the order the loop runs.
      const cutPieces = loop.map((piece) => {
        const length = lengthOfLine(piece.line);
        const head = cut(piece, true);
        const tail = cut(piece, false);
        const { points } = piece.line;
        if (piece.forward) return between(points, head, length - tail);
        const part = between(points, tail, length - head);
        const turned: number[] = [];
        for (let k = part.length - 2; k >= 0; k -= 2) turned.push(part[k], part[k + 1]);
        return turned;
      });
      const corner = ({ line, forward }: Piece) => {
        const k = forward ? line.points.length - 2 : 0;
        return [line.points[k] * cell, line.points[k + 1] * cell];
      };
      ctx.moveTo(cutPieces[0][0] * cell, cutPieces[0][1] * cell);
      for (let i = 0; i < cutPieces.length; i++) {
        const part = cutPieces[i];
        for (let k = 2; k < part.length; k += 2) ctx.lineTo(part[k] * cell, part[k + 1] * cell);
        // Round the corner to where the next piece starts, the corner itself the control point.
        const next = cutPieces[(i + 1) % cutPieces.length];
        const [cx, cy] = corner(loop[i]);
        ctx.quadraticCurveTo(cx, cy, next[0] * cell, next[1] * cell);
      }
      ctx.closePath();
    }
  }
  ctx.fill('evenodd');
}

/**
 * The shells for the present tracing. The Plateau borders slider sets how far
 * apart their control points are, and so how much they round off at the
 * junctions; the line width sets the films, the gap between two shells.
 */
function currentShells(): Shell[] {
  const spacing = 2 + wetness * 1.2 * bubbleRadius();
  const cssCell = Math.max(1e-6, linesCanvas.clientWidth / size);
  const inset = lineWidth / 2 / cssCell;
  const at = `${tracedAt}:${spacing}:${inset}`;
  if (at !== shellsAt) {
    bubbleShells = shells(bubbleLoops, spacing, inset);
    shellsAt = at;
  }
  return bubbleShells;
}

/** The liquid over the whole field, and the shells over it, each with a thin rim in its colour. */
function renderShells(width: number): void {
  const ctx = linesCtx;
  const cell = width / size;
  const scale = window.devicePixelRatio || 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = LIQUID;
  ctx.fillRect(0, 0, width, width);
  for (const shell of currentShells()) {
    ctx.beginPath();
    traceShell(ctx, shell, cell);
    ctx.fillStyle = '#0b0d11';
    ctx.fill('evenodd');
    if (shell.label === AIR) continue;
    const colour = css(SHEEN_BRIGHT[hue(shell.label)]);
    if (fill === 'flat') {
      ctx.globalAlpha = fillOpacity;
      ctx.fillStyle = colour;
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1, 0.6 * scale * Math.min(2, lineWidth));
    ctx.stroke();
  }
}

/** The shells and the liquid as an SVG file, in cells. */
function saveSvg(): void {
  traceLines();
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 2}" height="${size * 2}">`,
    `<rect width="${size}" height="${size}" fill="${LIQUID}"/>`,
  ];
  for (const shell of currentShells()) {
    const d = svgPath(shell);
    parts.push(`<path fill-rule="evenodd" fill="#0b0d11" d="${d}"/>`);
    if (shell.label === AIR) continue;
    const colour = css(SHEEN_BRIGHT[hue(shell.label)]);
    const inner = fill === 'flat' ? `fill="${colour}" fill-opacity="${fillOpacity}"` : 'fill="none"';
    parts.push(`<path fill-rule="evenodd" ${inner} stroke="${colour}" stroke-width="0.4" d="${d}"/>`);
  }
  parts.push('</svg>');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([parts.join('\n')], { type: 'image/svg+xml' }));
  link.download = `foam-${size}-step${foam.steps}.svg`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/** The tiles of the mirrored picture: where each goes, as fractions of the screen, and which way it is turned. */
function mirrorTiles(): { x: number; y: number; w: number; h: number; flipX: boolean; flipY: boolean }[] {
  const four = mirror === 'four-crop' || mirror === 'four-whole';
  // A cropped half fills the height; two whole fields side by side fill the middle half of it.
  const h = four ? 0.5 : mirror === 'two-crop' ? 1 : 0.5;
  const top = mirror === 'two-whole' ? 0.25 : 0;
  const tiles = [];
  for (let j = 0; j < (four ? 2 : 1); j++) {
    for (let i = 0; i < 2; i++) tiles.push({ x: i * 0.5, y: top + j * 0.5, w: 0.5, h, flipX: i === 1, flipY: j === 1 });
  }
  return tiles;
}

/** What part of the field is mirrored, as fractions of it. */
function mirrorSource(): { w: number; h: number } {
  if (mirror === 'two-crop') return { w: 0.5, h: 1 };
  if (mirror === 'four-crop') return { w: 0.5, h: 0.5 };
  return { w: 1, h: 1 };
}

/** The visible layers of the picture, put together in the tiles of the mirror. */
function renderMirror(): void {
  if (kaleidoMirrors() && kaleidoBent) {
    renderBent();
    return;
  }
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(mirrorCanvas.clientWidth * scale));
  if (mirrorCanvas.width !== width || mirrorCanvas.height !== width) {
    mirrorCanvas.width = width;
    mirrorCanvas.height = width;
  }
  const ctx = mirrorCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, width, width);
  const source = mirrorSource();
  for (const layer of [canvas, sheenCanvas, linesCanvas]) {
    if (layer.hidden || !layer.width) continue;
    // The cells of the plain field stay sharp, as on the page.
    ctx.imageSmoothingEnabled = layer !== canvas;
    const mirrors = kaleidoMirrors();
    if (mirrors) {
      drawKaleidoscope(ctx, layer, width, mirrors);
      continue;
    }
    for (const tile of mirrorTiles()) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate((tile.x + (tile.flipX ? tile.w : 0)) * width, (tile.y + (tile.flipY ? tile.h : 0)) * width);
      ctx.scale(tile.flipX ? -1 : 1, tile.flipY ? -1 : 1);
      ctx.drawImage(layer, 0, 0, source.w * layer.width, source.h * layer.height, 0, 0, tile.w * width, tile.h * width);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * The bent kaleidoscope, pixel by pixel through a lookup table: the layers are
 * put together at the field's scale, read back, and every pixel of the
 * picture takes the one it shows. It is drawn at CSS pixels, not device ones,
 * to keep the work per frame down.
 */
function renderBent(): void {
  const width = Math.max(1, Math.round(mirrorCanvas.clientWidth));
  if (mirrorCanvas.width !== width || mirrorCanvas.height !== width) {
    mirrorCanvas.width = width;
    mirrorCanvas.height = width;
  }
  const n = 1024;
  if (bentSource.width !== n) {
    bentSource.width = n;
    bentSource.height = n;
  }
  const src = bentSourceCtx;
  src.fillStyle = '#0b0d11';
  src.fillRect(0, 0, n, n);
  for (const layer of [canvas, sheenCanvas, linesCanvas]) {
    if (layer.hidden || !layer.width) continue;
    src.imageSmoothingEnabled = layer !== canvas;
    src.drawImage(layer, 0, 0, n, n);
  }
  const key = `${width}:${n}:${mirror}:${wedgeSize}:${size}`;
  const s = BENT_SAMPLES;
  if (key !== bentLookupFor) {
    bentLookup = new Int32Array(width * width * s * s);
    let k = 0;
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        for (let sy = 0; sy < s; sy++) {
          for (let sx = 0; sx < s; sx++) {
            const at = unmirror((x + (sx + 0.5) / s) / width, (y + (sy + 0.5) / s) / width);
            bentLookup[k++] = at ? Math.min(n - 1, Math.floor(at[1] * n)) * n + Math.min(n - 1, Math.floor(at[0] * n)) : -1;
          }
        }
      }
    }
    bentLookupFor = key;
  }
  const from = src.getImageData(0, 0, n, n).data;
  const image = mirrorCtx.createImageData(width, width);
  const to = image.data;
  const samples = s * s;
  for (let i = 0, k = 0; i < width * width; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let q = 0; q < samples; q++, k++) {
      const at = bentLookup[k] * 4;
      if (at < 0) {
        r += 11;
        g += 13;
        b += 17;
      } else {
        r += from[at];
        g += from[at + 1];
        b += from[at + 2];
      }
    }
    to[i * 4] = r / samples;
    to[i * 4 + 1] = g / samples;
    to[i * 4 + 2] = b / samples;
    to[i * 4 + 3] = 255;
  }
  mirrorCtx.putImageData(image, 0, 0);
}

/** A point of the unit disc to the point of the square [-1, 1]² that Fong's elliptical grid mapping takes there. */
function discToSquare(u: number, v: number): [number, number] {
  const r = 2 * Math.SQRT2;
  const a = 2 + u * u - v * v;
  const b = 2 - u * u + v * v;
  const x = 0.5 * Math.sqrt(Math.max(0, a + r * u)) - 0.5 * Math.sqrt(Math.max(0, a - r * u));
  const y = 0.5 * Math.sqrt(Math.max(0, b + r * v)) - 0.5 * Math.sqrt(Math.max(0, b - r * v));
  return [Math.min(1, Math.max(-1, x)), Math.min(1, Math.max(-1, y))];
}

/** The number of mirrors of a kaleidoscope, which makes twice as many wedges; 0 for the others. */
function kaleidoMirrors(): number {
  return mirror.startsWith('kaleido-') ? Number(mirror.slice(8)) : 0;
}

/**
 * The wedge of the layer from near its top left corner at angles 0 to π/mirrors,
 * turned round into every other wedge, and turned over in every second one.
 */
function drawKaleidoscope(ctx: CanvasRenderingContext2D, layer: HTMLCanvasElement, width: number, mirrors: number): void {
  const wedge = Math.PI / mirrors;
  const centre = width / 2;
  const { tip, zoom } = kaleidoFrame();
  for (let j = 0; j < 2 * mirrors; j++) {
    ctx.save();
    // A hair wider than the wedge, so that no seam shows between them.
    ctx.beginPath();
    ctx.moveTo(centre, centre);
    ctx.arc(centre, centre, width, j * wedge - 0.003, (j + 1) * wedge + 0.003);
    ctx.closePath();
    ctx.clip();
    ctx.translate(centre, centre);
    if (j % 2 === 0) ctx.rotate(j * wedge);
    else {
      ctx.rotate((j + 1) * wedge);
      ctx.scale(1, -1);
    }
    ctx.scale((width * zoom) / layer.width, (width * zoom) / layer.height);
    ctx.drawImage(layer, -tip * layer.width, -tip * layer.height);
    ctx.restore();
  }
}

/**
 * Where on the field a point of the screen is, as fractions, through the
 * mirror, and which copy it lies in; null off the picture.
 */
function unmirror(u: number, v: number): [number, number, number] | null {
  if (mirror === 'none') return [u, v, 0];
  const mirrors = kaleidoMirrors();
  if (mirrors) {
    const wedge = Math.PI / mirrors;
    const dx = u - 0.5;
    const dy = v - 0.5;
    const { tip, zoom } = kaleidoFrame();
    const r = Math.hypot(dx, dy) / zoom;
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += 2 * Math.PI;
    const j = Math.min(2 * mirrors - 1, Math.floor(angle / wedge));
    let turned = angle - j * wedge;
    if (j % 2 === 1) turned = wedge - turned;
    if (kaleidoBent) {
      // The wedge opened out into a quarter of a disc, which is the field's
      // square mapped smoothly onto it (Fong's elliptical grid mapping).
      const out = Math.hypot(dx, dy) / (0.5 * wedgeSize);
      if (out > 1) return null;
      const bent = (turned / wedge) * (Math.PI / 2);
      const [sx, sy] = discToSquare(out * Math.cos(bent), out * Math.sin(bent));
      return [tip + (1 - tip) * sx, tip + (1 - tip) * sy, j];
    }
    return [tip + r * Math.cos(turned), tip + r * Math.sin(turned), j];
  }
  const source = mirrorSource();
  const tiles = mirrorTiles();
  for (let k = 0; k < tiles.length; k++) {
    const tile = tiles[k];
    if (u < tile.x || u >= tile.x + tile.w || v < tile.y || v >= tile.y + tile.h) continue;
    let s = (u - tile.x) / tile.w;
    let t = (v - tile.y) / tile.h;
    if (tile.flipX) s = 1 - s;
    if (tile.flipY) t = 1 - t;
    return [s * source.w, t * source.h, k];
  }
  return null;
}

/**
 * The mirrored picture made into the field: every cell takes the label it
 * shows, each copy of a bubble a label of its own, so that where copies meet
 * there is a film along the mirror. With `joined`, copies of a bubble that
 * touch across a mirror are one bubble instead, with no film between, as the
 * picture shows them. The rule then goes on from there and smooths the seams.
 */
function bakeMirror(joined: boolean): void {
  const label = new Uint16Array(size * size);
  // What each cell shows: the bubble it was, and the copy it is in.
  const was = new Uint16Array(size * size);
  const copy = new Uint8Array(size * size);
  const fresh = new Map<number, number>();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = unmirror((x + 0.5) / size, (y + 0.5) / size);
      if (!at) continue;
      const sx = Math.min(size - 1, Math.max(0, Math.floor(at[0] * size)));
      const sy = Math.min(size - 1, Math.max(0, Math.floor(at[1] * size)));
      const old = foam.label[sy * size + sx];
      if (old === AIR) continue;
      const key = old * 64 + at[2];
      let mine = fresh.get(key);
      if (mine === undefined) {
        mine = Math.min(65534, fresh.size + 1);
        fresh.set(key, mine);
      }
      const i = y * size + x;
      label[i] = mine;
      was[i] = old;
      copy[i] = at[2];
    }
  }
  let count = fresh.size;
  if (joined) {
    // Join the copies of a bubble that are next to each other across a mirror.
    const parent = new Uint16Array(count + 1).map((_, k) => k);
    const root = (k: number): number => {
      while (parent[k] !== k) k = parent[k] = parent[parent[k]];
      return k;
    };
    for (let i = 0; i < label.length; i++) {
      if (!label[i]) continue;
      for (const j of [i % size < size - 1 ? i + 1 : -1, i + size < label.length ? i + size : -1]) {
        if (j < 0 || copy[j] === copy[i] || was[j] !== was[i]) continue;
        const a = root(label[i]);
        const b = root(label[j]);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
    // Number the joined bubbles from 1 again.
    const renumber = new Uint16Array(count + 1);
    count = 0;
    for (let k = 1; k < parent.length; k++) if (root(k) === k) renumber[k] = ++count;
    for (let i = 0; i < label.length; i++) if (label[i]) label[i] = renumber[root(label[i])];
  }
  foam.replace(label, count);
  seepage.reset();
  mirrorSelect.value = 'none';
  mirrorSelect.dispatchEvent(new Event('change'));
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
  traceLines();
  if (asShells) {
    renderShells(width);
    return;
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
  const radius = bubbleRadius();
  let meanLength = 0;
  if (widthBy === 'short') {
    let count = 0;
    for (const line of filmLines) {
      if (line.a === WALL || line.b === WALL) continue;
      meanLength += lengthOf(line.points);
      count++;
    }
    meanLength /= Math.max(1, count);
  }
  // The widths by bend, worked out once for both passes.
  const bends = widthBy === 'bend' ? new Map<FilmLine, Float32Array>() : null;
  if (bends) for (const line of filmLines) if (line.a !== WALL && line.b !== WALL) bends.set(line, bendWidths(line.points, radius, lineWidth * scale, cell));
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [wide, alpha] of [
    [3, 0.22],
    [1, 1],
  ]) {
    ctx.globalAlpha = alpha;
    for (const line of filmLines) {
      // The edge of the field closes the bubbles but is no film.
      if (line.a === WALL || line.b === WALL) continue;
      const { points } = line;
      // Over the stress colours a line is the light rim of a clear edge.
      const colour = stress ? '#fff8fa' : css(SHEEN_BRIGHT[pairHue(line.a, line.b)]);
      if (bends) {
        const widths = bends.get(line)!;
        const px = new Float32Array(widths.length);
        for (let k = 0; k < widths.length; k++) px[k] = widths[k] * wide;
        ctx.fillStyle = colour;
        drawRibbon(ctx, points, cell, px);
        continue;
      }
      ctx.lineWidth = lineWidth * scale * wide * widthFactor(line, meanLength);
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(points[0] * cell, points[1] * cell);
      for (let k = 2; k < points.length; k += 2) ctx.lineTo(points[k] * cell, points[k + 1] * cell);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  if (wetness > 0) drawBorders(ctx, cell, radius, stress ? '#fff8fa' : 'rgba(214, 228, 250, 0.92)');
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
