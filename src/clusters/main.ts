import type { Point } from '../hull.ts';
import { Sim, type Params, type PottsParams } from '../sim.ts';
import { Channels } from './channels.ts';
import { Clusters, type FieldParams, type Layout } from './clusters.ts';
import { OneRule, type RuleParams } from './onerule.ts';
import { MergeTree } from './tree.ts';

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
/** Where two bands lie over each other. */
const COLOR_OVERLAP = rgb(62, 66, 84);
const COLOR_HULL = '#4dd0e1';
/** Steps of the merge tree's sweep a frame, a radius each. */
const TREE_STEPS = 1;

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
type Mode = 'rule' | 'channels' | Layout;

const stones = new Uint8Array(SIZE * SIZE);
/** Only used to draw and scatter stones on the big field. */
const editor = new Sim(SIZE, SIZE, stones);
const clusters = new Clusters(SIZE, SIZE, stones);
const oneRule = new OneRule(SIZE, SIZE, stones);
/** Built when its mode is first chosen, and again when the channel count changes. */
let channels: Channels | null = null;

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
/** Overlapping bands: how many bands a cell has room for. */
let channelCount = 4;
let pottsSteps = 40;
let wideSteps = 4;
let stoneCount = 40;
let stoneSize = 0.3;
/** How many clumps the stones gather in; 0 scatters them evenly. */
let stoneClumps = 5;
let brush = 3;
let showHull = true;
let paused = false;
/** The merge tree, while its sweep is shown on the field and after, until the stones change. */
let tree: MergeTree | null = null;
let sweeping = false;
let treeStale = false;
/** The stones the tree was grown on, to tell when they have changed. */
let treeStones = new Uint8Array(0);
const treeCanvas = byId<HTMLCanvasElement>('tree');
const treeCtx = treeCanvas.getContext('2d')!;

const reachInput = byId<HTMLInputElement>('reach');
bindRange('reach', 0, (v) => {
  reach = v;
  if (!sweeping) restart();
});
bindRange('bridge', 0, (v) => {
  bridge = v;
  if (mode === 'rule' || mode === 'channels') restart();
});
bindRange('channels', 0, (v) => {
  channelCount = v;
  channels = null;
  if (mode === 'channels') restart();
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
byId('grow-tree').addEventListener('click', growTree);
treeCanvas.addEventListener('pointerdown', (e) => {
  // A click on the tree cuts it there: the cluster radius is set to that height.
  if (!tree || sweeping) return;
  const rect = treeCanvas.getBoundingClientRect();
  const height = heightAt(((e.clientY - rect.top) / rect.height) * treeCanvas.height);
  setReach(Math.round(height));
});
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
  else if (e.key === 't' || e.key === 'T') growTree();
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
  else if (mode === 'channels' && channels) channels.addStones();
  else restart();
}

function restart(): void {
  sweeping = false;
  if (tree) treeStale = !sameStones();
  if (mode === 'rule') oneRule.restart(reach, bridge);
  else if (mode === 'channels') {
    channels ??= new Channels(SIZE, SIZE, stones, channelCount);
    channels.restart(reach, bridge);
  } else clusters.restart(reach, mode);
}

function sameStones(): boolean {
  if (treeStones.length !== stones.length) return false;
  for (let i = 0; i < stones.length; i++) if (treeStones[i] !== stones[i]) return false;
  return true;
}

/** Sweep the radius up from nothing over the field, building the merge tree as it goes. */
function growTree(): void {
  tree = new MergeTree(SIZE, SIZE, stones, SIZE);
  treeStones = stones.slice();
  treeStale = false;
  sweeping = true;
}

function setReach(value: number): void {
  const v = Math.max(Number(reachInput.min), Math.min(Number(reachInput.max), value));
  reachInput.value = String(v);
  reachInput.dispatchEvent(new Event('input'));
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
  byId('pick-bridge').hidden = mode !== 'rule' && mode !== 'channels';
  byId('pick-channels').hidden = mode !== 'channels';
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
  if (!paused) {
    if (sweeping && tree) {
      for (let i = 0; i < TREE_STEPS; i++) tree.step();
      // Swept to one cluster, the field goes back to the bands at the radius set.
      if (tree.done) restart();
    } else advance();
  }
  if (sweeping && tree) renderSweep(tree);
  else render();
  drawTree();
  requestAnimationFrame(frame);
}

function advance(): void {
  if (mode === 'rule' || mode === 'channels') {
    const rule = mode === 'rule' ? oneRule : channels!;
    // While the labels settle, a few steps a frame are enough to watch.
    const steps = rule.settling ? RULE_SETTLING_STEPS : pottsSteps;
    const begin = performance.now();
    for (let i = 0; i < steps; i++) {
      rule.step(ruleParams);
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
  else if (mode === 'channels') renderChannels();
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
  } else if (mode === 'channels') {
    const rule = channels!;
    text = rule.settling ? 'labels settling' : `${rule.hulls.length} clusters`;
    text += ` · step ${rule.steps} · ${rule.used()} of ${rule.count} channels in use`;
    if (rule.hullArea > 0) text += ` · area ${(rule.area() / rule.hullArea).toFixed(3)}`;
    if (showHull) drawHulls(rule.hulls);
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

/**
 * Bands that may overlap: every channel drawn over the same field. Insides
 * first, greyed where two lie over each other, then stones, then the bands.
 */
function renderChannels(): void {
  const { inside, owner, count } = channels!;
  const n = SIZE * SIZE;
  for (let i = 0; i < n; i++) {
    let seen = 0;
    for (let k = 0; k < count; k++) {
      if (!inside[k * n + i]) continue;
      pixels[i] = seen++ ? COLOR_OVERLAP : DIM[hue(owner[k * n + i])];
    }
    if (stones[i]) pixels[i] = COLOR_STONE;
  }
  for (let k = 0; k < count; k++) {
    const base = k * n;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = base + y * SIZE + x;
        if (!inside[c]) continue;
        const s = owner[c];
        const mine = (j: number) => inside[j] === 1 && owner[j] === s;
        const front =
          x === 0 ||
          y === 0 ||
          x === SIZE - 1 ||
          y === SIZE - 1 ||
          !mine(c - 1) ||
          !mine(c + 1) ||
          !mine(c - SIZE) ||
          !mine(c + SIZE);
        if (front) pixels[c - base] = BRIGHT[hue(s)];
      }
    }
  }
}

/** The sweep: every cell the wave has reached, in the colour of the cluster it is in at this radius. */
function renderSweep(t: MergeTree): void {
  pixels.fill(COLOR_OUTSIDE);
  const at = (i: number) => t.clusterAt(i);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const c = at(i);
      if (c < 0) continue;
      const colour = t.nodes[c].colour;
      const front =
        (x > 0 && at(i - 1) < 0) || (x < SIZE - 1 && at(i + 1) < 0) || (y > 0 && at(i - SIZE) < 0) || (y < SIZE - 1 && at(i + SIZE) < 0);
      pixels[i] = stones[i] ? COLOR_STONE : front ? BRIGHT[hue(colour + 1)] : DIM[hue(colour + 1)];
    }
  }
  ctx.putImageData(image, 0, 0);
  stat.textContent = `merge tree · radius ${t.radius} · ${t.roots} clusters`;
}

/** Room round the tree's plot, in canvas pixels. */
const TREE_PAD = 10;

/** The height of the plot's top, in radii. */
function treeTop(): number {
  if (!tree) return 1;
  let most = tree.radius;
  for (const n of tree.nodes) most = Math.max(most, n.height);
  return Math.max(4, most * 1.08, reach * 1.08);
}

function yOf(height: number): number {
  return treeCanvas.height - TREE_PAD - (height / treeTop()) * (treeCanvas.height - 2 * TREE_PAD);
}

function heightAt(y: number): number {
  return ((treeCanvas.height - TREE_PAD - y) / (treeCanvas.height - 2 * TREE_PAD)) * treeTop();
}

/**
 * The dendrogram: the stones along the bottom in the order of the tree, and
 * every merge a bar at the radius it is made at. Cut at the cluster radius
 * set, every cluster below the cut is drawn in its colour, and the merges
 * above it grey; while the sweep runs, a line marks how far it has got.
 */
function drawTree(): void {
  const dpr = devicePixelRatio || 1;
  const w = Math.round(treeCanvas.clientWidth * dpr);
  const h = Math.round(treeCanvas.clientHeight * dpr);
  if (treeCanvas.width !== w || treeCanvas.height !== h) {
    treeCanvas.width = w;
    treeCanvas.height = h;
  }
  const g = treeCtx;
  g.clearRect(0, 0, w, h);
  if (!tree) {
    g.fillStyle = '#6b7385';
    g.font = `${12 * dpr}px system-ui, sans-serif`;
    g.fillText('Grow the merge tree to see it here.', TREE_PAD, h / 2);
    return;
  }
  const { nodes } = tree;
  // The stones in the order a walk down the tree meets them, so no two bars cross.
  const leaves: number[] = [];
  const walk = (k: number) => {
    const n = nodes[k];
    if (n.left < 0) leaves.push(k);
    else {
      walk(n.left);
      walk(n.right);
    }
  };
  for (const k of tree.tops()) walk(k);
  const xs = new Float64Array(nodes.length);
  const step = (w - 2 * TREE_PAD) / Math.max(1, leaves.length - 1);
  leaves.forEach((k, j) => (xs[k] = leaves.length === 1 ? w / 2 : TREE_PAD + j * step));
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.left >= 0) xs[k] = (xs[n.left] + xs[n.right]) / 2;
  }
  // Which cluster below the cut every node is in, for its colour.
  const under = new Int32Array(nodes.length).fill(-1);
  for (const k of tree.cut(reach)) {
    const mark = (j: number) => {
      under[j] = k;
      if (nodes[j].left >= 0) {
        mark(nodes[j].left);
        mark(nodes[j].right);
      }
    };
    mark(k);
  }
  const colourOf = (k: number) => (under[k] >= 0 ? cssHue(nodes[under[k]].colour) : '#4a5060');
  g.lineWidth = 1.5 * dpr;
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.left < 0) continue;
    const y = yOf(n.height);
    g.strokeStyle = colourOf(k);
    g.beginPath();
    g.moveTo(xs[n.left], yOf(nodes[n.left].height));
    g.lineTo(xs[n.left], y);
    g.lineTo(xs[n.right], y);
    g.lineTo(xs[n.right], yOf(nodes[n.right].height));
    g.stroke();
  }
  // The clusters still apart, up to where the sweep has got.
  for (const k of tree.tops()) {
    g.strokeStyle = colourOf(k);
    g.beginPath();
    g.moveTo(xs[k], yOf(nodes[k].height));
    g.lineTo(xs[k], yOf(tree.done ? treeTop() : tree.radius));
    g.stroke();
  }
  for (const k of leaves) {
    g.fillStyle = colourOf(k);
    g.fillRect(xs[k] - 1.5 * dpr, yOf(0) - 1.5 * dpr, 3 * dpr, 3 * dpr);
  }
  // The cut at the cluster radius set, and the sweep's front.
  g.setLineDash([4 * dpr, 3 * dpr]);
  g.strokeStyle = COLOR_HULL;
  g.lineWidth = dpr;
  g.beginPath();
  g.moveTo(0, yOf(reach));
  g.lineTo(w, yOf(reach));
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = COLOR_HULL;
  g.font = `${11 * dpr}px system-ui, sans-serif`;
  const count = tree.cut(reach).length;
  g.fillText(`radius ${reach}: ${count} cluster${count === 1 ? '' : 's'}${treeStale ? ' (stones changed since)' : ''}`, TREE_PAD, yOf(reach) - 4 * dpr);
  if (sweeping) {
    g.strokeStyle = 'rgba(255, 209, 102, 0.7)';
    g.beginPath();
    g.moveTo(0, yOf(tree.radius));
    g.lineTo(w, yOf(tree.radius));
    g.stroke();
  }
}

function cssHue(colour: number): string {
  const c = BRIGHT[hue(colour + 1)];
  return `rgb(${c & 255}, ${(c >>> 8) & 255}, ${(c >>> 16) & 255})`;
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
