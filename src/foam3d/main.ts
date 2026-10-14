import { cameraFrame, FOCAL, Renderer, type Camera, type View } from '../3d/renderer.ts';
import { Foam3, type Enclosure, type Foam3Params } from './foam3.ts';
import { extractSkeleton, filmsInFront, inSight, visibleParts, type Skeleton } from './skeleton.ts';

/** A scattered centre starts as a ball this many kernel radii across. */
const SEED_SIZE = 1.5;

/** The skeleton is read back and rebuilt at most this often, in ms: it is slow. */
const SKELETON_EVERY = 400;

/** See the 2D foam: how a fine foam gets coarser. */
type Coarsening = 'none' | 'seep' | 'burst' | 'pop';

const canvas = byId<HTMLCanvasElement>('field-3d');
const vectorCanvas = byId<HTMLCanvasElement>('vector');
const vectorContext = vectorCanvas.getContext('2d')!;
let skeleton: Skeleton | null = null;
let skeletonStep = -1;
let skeletonAt = 0;
let skeletonMs = 0;
/** The labels the skeleton was built from, for the rays that hide lines. */
let skeletonLabels: Uint32Array | null = null;
/** How many films a line may be seen through; Infinity shows all. */
let through = Infinity;
/**
 * Two ways to spare the cut ends of lines half in sight: 'whole' keeps or
 * hides a line as a whole, 'fade' dims every point by the films in front of
 * it, smoothly along the line. 'cut' cuts lines where they go out of sight.
 */
let hiding: 'cut' | 'whole' | 'fade' = 'cut';
/** A line in 'whole' is shown when at least this share of its points is in sight. */
const MOSTLY = 0.6;
/** In 'fade', each film in front of a point lets this much of its light through. */
const FADE = 0.3;
/** The visible parts of the lines, with a brightness per point in 'fade', and the view they were worked out for. */
let parts: { points: number[][]; hue: number; light?: number[] }[] = [];
let corners: number[][] = [];
let partsFor = '';
const stat = byId('stat');
const camera: Camera = { yaw: 0.7, pitch: 0.4, distance: 1.45 };
const params: Foam3Params = { radius: 3, noise: 0.1, keepVolume: true };

let renderer: Renderer | null = null;
let foam: Foam3 | null = null;
let failure = '';
try {
  renderer = new Renderer(canvas);
} catch (error) {
  failure = String(error);
}

let size = Number(byId<HTMLSelectElement>('size').value);
let enclosure = byId<HTMLSelectElement>('enclosure').value as Enclosure;
let coarsening: Coarsening = 'none';
let bubbleCount = 60;
let stepsPerFrame = 2;
let opacity = 0.2;
let smooth = byId<HTMLSelectElement>('surface').value === 'smooth';
let paused = false;
let look = 'glass';
const light = { films: 0.05, lines: 0.25 };
/** Bursts or pops a step, on average, and those owed but not yet made. */
let burstRate = 0.01;
let burstsOwed = 0;
let rate = 0;
let rateSteps = 0;
let rateSince = performance.now();

bindRange('radius', 0, (v) => (params.radius = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
bindRange('count', 0, (v) => (bubbleCount = v));
bindRange('opacity', 2, (v) => (opacity = v));
bindRange('rate', 0, (v) => (burstRate = v / 1000));
byId('count').addEventListener('change', scatter);

onSelect('size', (v) => {
  size = Number(v);
  build();
});
onSelect('enclosure', (v) => {
  enclosure = v as Enclosure;
  scatter();
});
onSelect('coarsening', (v) => {
  coarsening = v as Coarsening;
  params.keepVolume = coarsening !== 'seep';
  byId('pick-rate').hidden = coarsening !== 'burst' && coarsening !== 'pop';
});
const surfaceSelect = onSelect('surface', (v) => {
  smooth = v === 'smooth';
  syncView();
});
onSelect('through', (v) => {
  hiding = v === 'whole' || v === 'fade' ? v : 'cut';
  through = v === 'all' ? Infinity : hiding === 'cut' ? Number(v) : 0;
  partsFor = '';
});
const lookSelect = onSelect('look', (v) => {
  look = v;
  syncView();
});
bindRange('films', 3, (v) => (light.films = v));
bindRange('lines', 2, (v) => (light.lines = v));

const pauseButton = byId<HTMLButtonElement>('pause');
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
});
byId('random').addEventListener('click', scatter);

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target as HTMLElement;
  if (target.tagName === 'SELECT' || (target.tagName === 'BUTTON' && e.key === ' ')) return;
  const key = e.key.toLowerCase();
  if (key === 'n') scatter();
  else if (key === ' ') pauseButton.click();
  else if (key === 'g') {
    lookSelect.value = look === 'light' ? 'glass' : 'light';
    lookSelect.dispatchEvent(new Event('change'));
  }
  else if (key === 's') {
    surfaceSelect.value = smooth ? 'voxels' : 'smooth';
    surfaceSelect.dispatchEvent(new Event('change'));
  } else return;
  e.preventDefault();
});

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

// The resolution list above has already built the first field.
requestAnimationFrame(frame);

/** A new field at the chosen resolution. */
function build(): void {
  if (!renderer) return;
  foam?.dispose();
  foam = null;
  try {
    foam = new Foam3(renderer, size);
  } catch (error) {
    failure = String(error);
    return;
  }
  scatter();
}

function scatter(): void {
  foam?.scatter(bubbleCount, params.radius * SEED_SIZE, enclosure);
}

function frame(): void {
  if (foam && renderer) {
    if (!paused) {
      const before = foam.steps;
      foam.step(params, stepsPerFrame);
      rateSteps += foam.steps - before;
      coarsen(foam.steps - before);
    }
    const now = performance.now();
    if (now - rateSince > 1000) {
      rate = (rateSteps * 1000) / (now - rateSince);
      rateSteps = 0;
      rateSince = now;
    }
    if (look === 'vector') {
      renderer.clear();
      if (foam.steps !== skeletonStep && now - skeletonAt > SKELETON_EVERY) {
        skeletonStep = foam.steps;
        skeletonAt = now;
        skeletonLabels = foam.readLabels();
        skeleton = extractSkeleton(skeletonLabels, foam.n);
        skeletonMs = performance.now() - now;
        partsFor = '';
      }
      drawSkeleton(foam.n);
    } else {
      foam.show(smooth);
      const lit = look === 'light' && !smooth;
      const view: View = { opacity, oneColor: false, smoothness: 0.6, light: lit ? light : undefined };
      if (smooth) renderer.drawSmooth(null, foam.n, camera, view);
      else renderer.drawVoxels(null, foam.n, camera, view);
    }
    const air = foam.growing ? ` · growing, ${Math.round(foam.air)} cells of air left` : '';
    const lines = look === 'vector' && skeleton ? ` · ${skeleton.lines.length} lines in ${Math.round(skeletonMs)} ms` : '';
    stat.textContent = `${foam.bubbles} bubbles · step ${foam.steps}${air} · ${Math.round(rate)} steps/s on the GPU${lines}`;
  } else {
    stat.textContent = `The 3D foam needs WebGL2 with float blending: ${failure}`;
  }
  requestAnimationFrame(frame);
}

/** The light is drawn on the voxels only, and opacity is for the glass. */
function syncView(): void {
  const lit = look === 'light' && !smooth;
  const vector = look === 'vector';
  byId('pick-look').hidden = smooth && !vector;
  byId('pick-films').hidden = !lit;
  byId('pick-lines').hidden = !lit && !vector;
  byId('pick-through').hidden = !vector;
  byId('pick-opacity').hidden = lit || vector;
  byId('pick-surface').hidden = vector;
  vectorCanvas.hidden = !vector;
  skeletonStep = -1;
}

/**
 * Draw the skeleton over the cleared 3D view, seen by the same camera: each
 * line twice, wide and faint for a glow and thin and bright for its core,
 * the light adding up where lines cross; nearer lines brighter.
 */
function drawSkeleton(n: number): void {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(vectorCanvas.clientWidth * scale));
  const h = Math.max(1, Math.round(vectorCanvas.clientHeight * scale));
  if (vectorCanvas.width !== w || vectorCanvas.height !== h) {
    vectorCanvas.width = w;
    vectorCanvas.height = h;
  }
  const ctx = vectorContext;
  ctx.clearRect(0, 0, w, h);
  if (!skeleton) return;
  const { eye, right, up, forward } = cameraFrame(camera, n);
  const middle = camera.distance * n;
  // Which parts of the lines are in sight, worked out again only when the
  // view or the lines change.
  const view = `${camera.yaw},${camera.pitch},${camera.distance},${through},${hiding}`;
  if (view !== partsFor) {
    partsFor = view;
    parts = [];
    const labels = skeletonLabels;
    corners = through === Infinity || !labels ? skeleton.points : skeleton.points.filter((p) => inSight(p, labels, n, eye, through));
    for (const line of skeleton.lines) {
      if (through === Infinity || !labels) parts.push(line);
      else if (hiding === 'whole') {
        const front = filmsInFront(line.points, labels, n, eye, 1);
        if (front.filter((f) => f === 0).length >= MOSTLY * front.length) parts.push(line);
      } else if (hiding === 'fade') {
        const front = filmsInFront(line.points, labels, n, eye, 4);
        // Averaged with the neighbours, so the light fades out along the line.
        const raw = front.map((f) => FADE ** f);
        const light = raw.map((_, k) => {
          const near = raw.slice(Math.max(0, k - 1), k + 2);
          return near.reduce((a, b) => a + b, 0) / near.length;
        });
        parts.push({ points: line.points, hue: line.hue, light });
      } else for (const points of visibleParts(line.points, labels, n, eye, through)) parts.push({ points, hue: line.hue });
    }
  }
  // Screen position and depth of a point, as the ray caster would show it.
  const project = (p: number[]): number[] => {
    const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const depth = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
    const u = ((d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) * FOCAL) / depth;
    const v = ((d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) * FOCAL) / depth;
    return [(u * h + w) / 2, (h - v * h) / 2, depth];
  };
  const nearness = (depth: number) => Math.max(0.25, Math.min(1, 1.1 - (depth - middle) / n));
  const strength = light.lines * 3;

  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of [
    { width: 5 * scale, alpha: 0.1 },
    { width: 1.3 * scale, alpha: 0.75 },
  ]) {
    ctx.lineWidth = pass.width;
    for (const line of parts) {
      const screen = line.points.map(project);
      if (screen.some((s) => s[2] <= 1)) continue;
      const depth = screen.reduce((sum, s) => sum + s[2], 0) / screen.length;
      const alpha = Math.min(1, pass.alpha * strength * nearness(depth));
      const hue = Math.round(line.hue * 360);
      if (line.light) {
        strokeFading(ctx, screen, line.light, hue, alpha);
        continue;
      }
      ctx.strokeStyle = `hsla(${hue}, 70%, 78%, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(screen[0][0], screen[0][1]);
      // Through the midpoints, so the line bends smoothly at its points.
      for (let k = 1; k < screen.length - 1; k++) {
        const mx = (screen[k][0] + screen[k + 1][0]) / 2;
        const my = (screen[k][1] + screen[k + 1][1]) / 2;
        ctx.quadraticCurveTo(screen[k][0], screen[k][1], mx, my);
      }
      const last = screen[screen.length - 1];
      ctx.lineTo(last[0], last[1]);
      ctx.stroke();
    }
  }
  for (const p of corners) {
    const [x, y, depth] = project(p);
    if (depth <= 1) continue;
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, 0.6 * strength * nearness(depth))})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.8 * scale, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * A line whose light changes along it: a piece around each point, from the
 * midpoint before it to the midpoint after, bent through the point, in that
 * point's light.
 */
function strokeFading(
  ctx: CanvasRenderingContext2D,
  screen: number[][],
  light: number[],
  hue: number,
  alpha: number,
): void {
  const last = screen.length - 1;
  const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // Round caps would overlap where two pieces meet and, the light adding up,
  // string the line with beads.
  ctx.lineCap = 'butt';
  for (let k = 0; k <= last; k++) {
    if (light[k] < 0.01) continue;
    const from = k === 0 ? screen[0] : mid(screen[k - 1], screen[k]);
    const to = k === last ? screen[last] : mid(screen[k], screen[k + 1]);
    ctx.strokeStyle = `hsla(${hue}, 70%, 78%, ${alpha * light[k]})`;
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.quadraticCurveTo(screen[k][0], screen[k][1], to[0], to[1]);
    ctx.stroke();
  }
  ctx.lineCap = 'round';
}

/** The bursts or pops due over this many steps; none while the bubbles grow. */
function coarsen(steps: number): void {
  if (!foam || (coarsening !== 'burst' && coarsening !== 'pop') || foam.growing) return;
  burstsOwed += steps * burstRate;
  while (burstsOwed >= 1) {
    burstsOwed--;
    const done = coarsening === 'burst' ? foam.burstFilm() : foam.popAny();
    if (!done) break;
  }
}

/** Listen to a select, and take up its value at the start too: a reload may keep it. */
function onSelect(id: string, apply: (value: string) => void): HTMLSelectElement {
  const select = byId<HTMLSelectElement>(id);
  select.addEventListener('change', () => apply(select.value));
  apply(select.value);
  return select;
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
