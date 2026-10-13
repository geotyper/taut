import type { Point } from '../hull.ts';
import { Sim, type Params, type PottsParams } from '../sim.ts';
import { Clusters, type FieldParams, type Layout } from './clusters.ts';
import { OneRule, type RuleParams } from './onerule.ts';

const SIZE = 256;
/** Per-frame time limit for stepping the bands, in ms. */
const BUDGET = 12;
/** Steps per frame of the stages before the bands, slow enough to watch. */
const STAGE_STEPS = { spread: 1, label: 6, swell: 1 };
const RULE_SETTLING_STEPS = 3;

const COLOR_OUTSIDE = rgb(11, 13, 17);
const COLOR_INSIDE = rgb(30, 42, 60);
const COLOR_STONE = rgb(132, 138, 150);
const COLOR_FRONT = rgb(255, 209, 102);
const COLOR_HULL = '#4dd0e1';

/** One colour per cluster, picked by its label: the band and its dim inside. */
const HUES = 256;
const BRIGHT = new Uint32Array(HUES);
const DIM = new Uint32Array(HUES);
for (let i = 0; i < HUES; i++) {
  BRIGHT[i] = hsl((i / HUES) * 360, 0.85, 0.66);
  DIM[i] = hsl((i / HUES) * 360, 0.4, 0.17);
}

type Algorithm = 'potts' | 'wide';
/** One rule for everything, or the staged version in one of its layouts. */
type Mode = 'rule' | Layout;

const stones = new Uint8Array(SIZE * SIZE);
/** Only used to draw and scatter stones on the big field. */
const editor = new Sim(SIZE, SIZE, stones);
const clusters = new Clusters(SIZE, SIZE, stones);
const oneRule = new OneRule(SIZE, SIZE, stones);

const canvas = byId<HTMLCanvasElement>('field');
canvas.width = SIZE;
canvas.height = SIZE;
const ctx = canvas.getContext('2d')!;
const image = ctx.createImageData(SIZE, SIZE);
const pixels = new Uint32Array(image.data.buffer);
const stat = byId('stat');

const wideParams: Params = { radius: 2, threshold: 0.5, noise: 0.3 };
const pottsParams: PottsParams = { temperature: 0.5, pressure: 0 };
const fieldParams: FieldParams = { temperature: 0.5, repulsion: 3 };
const ruleParams: RuleParams = { temperature: 0.5 };
let mode: Mode = 'rule';
let algorithm: Algorithm = 'potts';
let reach = 10;
/** One rule only: a bridge thinner than this many cells does not join clusters. */
let bridge = 0;
let pottsSteps = 40;
let wideSteps = 4;
let stoneCount = 40;
let stoneSize = 0.3;
/** How many clumps the stones gather in; 0 scatters them evenly. */
let stoneClumps = 5;
let brush = 3;
let showHull = true;
let paused = false;

bindRange('reach', 0, (v) => {
  reach = v;
  restart();
});
bindRange('bridge', 0, (v) => {
  bridge = v;
  if (mode === 'rule') restart();
});
bindRange('temperature', 2, (v) => {
  pottsParams.temperature = v;
  fieldParams.temperature = v;
  ruleParams.temperature = v;
});
bindRange('repulsion', 1, (v) => (fieldParams.repulsion = v));
bindRange('potts-speed', 0, (v) => (pottsSteps = v));
bindRange('radius', 0, (v) => (wideParams.radius = v));
bindRange('noise', 2, (v) => (wideParams.noise = v));
bindRange('speed', 0, (v) => (wideSteps = v));
bindRange('stone-count', 0, (v) => (stoneCount = v));
bindRange('stone-size', 2, (v) => (stoneSize = v));
bindRange('stone-clumps', 0, (v) => (stoneClumps = v));
bindRange('brush', 0, (v) => (brush = v));

const layoutSelect = byId<HTMLSelectElement>('layout');
layoutSelect.addEventListener('change', () => {
  mode = layoutSelect.value as Mode;
  syncControls();
  restart();
});

const algorithmSelect = byId<HTMLSelectElement>('algorithm');
algorithmSelect.addEventListener('change', () => {
  algorithm = algorithmSelect.value as Algorithm;
  syncControls();
  restart();
});

const hullToggle = byId<HTMLInputElement>('show-hull');
hullToggle.addEventListener('change', () => (showHull = hullToggle.checked));

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', togglePause);
byId('restart').addEventListener('click', restart);
byId('random').addEventListener('click', scatter);
byId('add-stone').addEventListener('click', addStone);
byId('clear').addEventListener('click', () => {
  editor.clearStones();
  restart();
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') togglePause();
  else if (e.key === 'r' || e.key === 'R') restart();
  else if (e.key === 'n' || e.key === 'N') scatter();
  else if (e.key === 'a' || e.key === 'A') addStone();
  else return;
  e.preventDefault();
});

syncControls();
scatter();

function scatter(): void {
  editor.clearStones();
  editor.randomStones(stoneCount, stoneSize, stoneClumps);
  restart();
}

/** One more stone somewhere, taken in without starting over where that works. */
function addStone(): void {
  editor.randomStones(1, stoneSize);
  stonesAdded();
}

/** The one rule takes new stones in as it is; the stages start again. */
function stonesAdded(): void {
  if (mode === 'rule') oneRule.addStones();
  else restart();
}

function restart(): void {
  if (mode === 'rule') oneRule.restart(reach, bridge);
  else clusters.restart(reach, mode);
}

function togglePause(): void {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
}

function syncControls(): void {
  // The single field is one Potts model; only the layers can pick an automaton.
  const layers = mode === 'layers';
  byId('pick-algorithm').hidden = !layers;
  byId('group-potts').hidden = layers && algorithm !== 'potts';
  byId('group-wide').hidden = !layers || algorithm !== 'wide';
  byId('pick-repulsion').hidden = mode !== 'field';
  byId('pick-bridge').hidden = mode !== 'rule';
}

// Painting stones with the pointer.
let last: Point | null = null;
let erasing = false;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  erasing = e.button === 2 || e.shiftKey;
  last = toGrid(e);
  stroke(last, last);
});
canvas.addEventListener('pointermove', (e) => {
  if (!last) return;
  const next = toGrid(e);
  stroke(last, next);
  last = next;
});
canvas.addEventListener('pointerup', () => (last = null));
canvas.addEventListener('pointercancel', () => (last = null));

function toGrid(e: PointerEvent): Point {
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
    editor.paintStone(x, y, brush, erasing ? 0 : 1);
  }
  // A stone taken away can split a cluster, which only a fresh start finds.
  if (erasing) restart();
  else stonesAdded();
}

function frame(): void {
  if (!paused) advance();
  render();
  requestAnimationFrame(frame);
}

function advance(): void {
  if (mode === 'rule') {
    // While the labels settle, a few steps a frame are enough to watch.
    const steps = oneRule.settling ? RULE_SETTLING_STEPS : pottsSteps;
    const begin = performance.now();
    for (let i = 0; i < steps; i++) {
      oneRule.step(ruleParams);
      if (performance.now() - begin > BUDGET) break;
    }
    return;
  }
  const { stage } = clusters;
  if (stage !== 'bands') {
    // A stage may end part-way through the frame; the next one waits its turn.
    for (let i = 0; i < STAGE_STEPS[stage] && clusters.stage === stage; i++) clusters.step();
    return;
  }
  const potts = mode === 'field' || algorithm === 'potts';
  const steps = potts ? pottsSteps : wideSteps;
  const begin = performance.now();
  for (let i = 0; i < steps; i++) {
    if (mode === 'field') {
      clusters.stepField(fieldParams);
    } else {
      for (const { sim } of clusters.bands) {
        if (potts) sim.stepPotts(pottsParams);
        else sim.step(wideParams);
      }
      clusters.steps++;
    }
    if (performance.now() - begin > BUDGET) break;
  }
}

function render(): void {
  pixels.fill(COLOR_OUTSIDE);
  if (mode === 'rule') renderRule();
  else if (clusters.stage === 'spread') renderWave();
  else if (clusters.stage === 'bands' && mode === 'layers') renderLayers();
  else renderLabels();
  ctx.putImageData(image, 0, 0);

  let text = '';
  if (mode === 'rule') {
    const { hullArea } = oneRule;
    text = oneRule.settling ? 'labels settling' : `${oneRule.hulls.length} clusters`;
    text += ` · step ${oneRule.steps}`;
    if (hullArea > 0) text += ` · area ${(oneRule.area() / hullArea).toFixed(3)}`;
    if (showHull) drawHulls(oneRule.hulls);
  } else if (clusters.stage === 'spread') text = `wave from the stones · step ${clusters.steps}`;
  else if (clusters.stage === 'label') text = `agreeing on labels · step ${clusters.steps}`;
  else if (clusters.stage === 'swell') text = `swelling · step ${clusters.steps}`;
  else {
    const { hullArea } = clusters;
    text = `${clusters.hulls.length} clusters · step ${clusters.steps}`;
    if (hullArea > 0) text += ` · area ${(clusters.area() / hullArea).toFixed(3)}`;
    if (showHull) drawHulls(clusters.hulls);
  }
  stat.textContent = text;
}

/**
 * The one-rule automaton: cells inside a band, coloured by their label. The
 * band is the inside cells that touch anything that is not their own inside.
 */
function renderRule(): void {
  const { inside, label } = oneRule;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (!inside[i]) continue;
      const s = label[i];
      const front =
        x === 0 ||
        y === 0 ||
        x === SIZE - 1 ||
        y === SIZE - 1 ||
        !inside[i - 1] ||
        !inside[i + 1] ||
        !inside[i - SIZE] ||
        !inside[i + SIZE] ||
        label[i - 1] !== s ||
        label[i + 1] !== s ||
        label[i - SIZE] !== s ||
        label[i + SIZE] !== s;
      pixels[i] = front ? BRIGHT[hue(s)] : stones[i] ? COLOR_STONE : DIM[hue(s)];
    }
  }
}

/** The wave growing from the stones. */
function renderWave(): void {
  const { spread } = clusters;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      if (!spread.reached(i)) continue;
      const front =
        (x > 0 && !spread.reached(i - 1)) ||
        (x < SIZE - 1 && !spread.reached(i + 1)) ||
        (y > 0 && !spread.reached(i - SIZE)) ||
        (y < SIZE - 1 && !spread.reached(i + SIZE));
      pixels[i] = front ? COLOR_FRONT : stones[i] ? COLOR_STONE : COLOR_INSIDE;
    }
  }
}

/**
 * The single field, coloured by the label each cell holds. Once the labels
 * have settled, the band is the cells of a label that touch anything else.
 */
function renderLabels(): void {
  const { label, stage } = clusters;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const s = label[i];
      if (s === 0) continue;
      const front =
        stage !== 'label' &&
        (x === 0 ||
          y === 0 ||
          x === SIZE - 1 ||
          y === SIZE - 1 ||
          label[i - 1] !== s ||
          label[i + 1] !== s ||
          label[i - SIZE] !== s ||
          label[i + SIZE] !== s);
      pixels[i] = front ? BRIGHT[hue(s)] : stones[i] ? COLOR_STONE : DIM[hue(s)];
    }
  }
}

/** Every band on its own layer: insides first, then stones, then the bands. */
function renderLayers(): void {
  for (const { sim, x0, y0, id } of clusters.bands) {
    const dim = DIM[hue(id)];
    for (let y = 0; y < sim.h; y++) {
      for (let x = 0; x < sim.w; x++) {
        if (sim.phase[y * sim.w + x]) pixels[(y0 + y) * SIZE + x0 + x] = dim;
      }
    }
  }
  for (let i = 0; i < stones.length; i++) {
    if (stones[i]) pixels[i] = COLOR_STONE;
  }
  for (const { sim, x0, y0, id } of clusters.bands) {
    const { w, h, phase } = sim;
    const bright = BRIGHT[hue(id)];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!phase[i]) continue;
        // The band is the inside cells that touch the outside phase.
        const front =
          x === 0 ||
          y === 0 ||
          x === w - 1 ||
          y === h - 1 ||
          !phase[i - 1] ||
          !phase[i + 1] ||
          !phase[i - w] ||
          !phase[i + w];
        if (front) pixels[(y0 + y) * SIZE + x0 + x] = bright;
      }
    }
  }
}

function drawHulls(hulls: Point[][]): void {
  ctx.beginPath();
  for (const hull of hulls) {
    if (hull.length === 0) continue;
    ctx.moveTo(hull[0].x, hull[0].y);
    for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
    ctx.closePath();
  }
  ctx.strokeStyle = COLOR_HULL;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([2, 2]);
  ctx.stroke();
}

/** Spread labels over the colour table so that near labels look unlike. */
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

/** Pack a colour for a little-endian RGBA pixel buffer. */
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
