import { cameraFrame, FOCAL, Renderer, type Camera, type View } from '../3d/renderer.ts';
import { Foam3, type Enclosure, type Foam3Params } from './foam3.ts';
import {
  extractContours,
  extractSkeleton,
  filmsInFront,
  inSight,
  visibleParts,
  type ContourShape,
  type Contours,
  type Skeleton,
} from './skeleton.ts';
import { tubeField } from './tubes.ts';
import { buildFilms, distanceFromBorders, type Films } from './films.ts';
import { drawPicture, pictureSvg, renderStill, type Picture, type StillOptions } from './still.ts';

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
/** Lines across the films, if any, and the light of each piece as last seen. */
let contourShape: ContourShape | 'off' = 'off';
let contours: Contours | null = null;
let contourLight = new Float32Array(0);
/** Contour lines this many cells apart at 96³, and as far in field sizes at others. */
let contourSpacing = 3;
let partsFor = '';
const stat = byId('stat');
/** The still look: the films meshed from the labels, and the picture last drawn of them. */
let films: Films | null = null;
let filmsDistance: Float64Array | null = null;
let filmsStep = -1;
let filmsAt = 0;
let filmsMs = 0;
let picture: Picture | null = null;
let pictureFor = '';
let pictureMs = 0;
/** The view must hold still this long, in ms, before the picture is drawn again. */
const STILL_AFTER = 150;
let movedAt = 0;
const still: Omit<StillOptions, 'width' | 'height' | 'scale'> = {
  fill: 'colour',
  across: 'none',
  byLight: false,
  spacing: 2.5,
  lineWidth: 1.5,
  xray: false,
  cut: 'none',
  plane: { turn: 30, tilt: 20, offset: 0 },
  slab: 16,
  open: false,
};
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
/** The films' own colours, if not a hue per bubble; see View.film. */
let colours: 'hues' | 'soap' | 'stress' = 'hues';
/** Seconds the films have been draining, and how fast they drain. */
let drained = 0;
let drainage = 0.3;
let lastFrame = performance.now();
/** Mip levels the tubes of the smoothed skeleton are blurred over. */
let tubeBlur = 1;
/** Radius of the tubes round the skeleton's lines, in cells. */
let tubeRadius = 0.8;
/** The black film spreads down no further than this share of the sphere: below, the foam would burst first. */
const LOWEST_FRONT = 0.3;
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
onSelect('contours', (v) => {
  contourShape = v as ContourShape | 'off';
  syncView();
});
bindRange('spacing', 1, (v) => {
  contourSpacing = v;
  skeletonStep = -1;
});
const lookSelect = onSelect('look', (v) => {
  look = v;
  syncView();
});
bindRange('films', 3, (v) => (light.films = v));
const coloursSelect = onSelect('colours', (v) => {
  colours = v as typeof colours;
  syncView();
});
bindRange('drain', 2, (v) => (drainage = v));
bindRange('tubes', 2, (v) => (tubeBlur = v));
bindRange('tube-radius', 2, (v) => {
  tubeRadius = v;
  // The distances are kept only as far as the tubes need.
  skeletonStep = -1;
  skeletonAt = 0;
});
bindRange('lines', 2, (v) => (light.lines = v));
onSelect('still-fill', (v) => (still.fill = v as StillOptions['fill']));
onSelect('still-across', (v) => (still.across = v as StillOptions['across']));
bindRange('still-spacing', 1, (v) => (still.spacing = v));
bindRange('still-width', 2, (v) => (still.lineWidth = v));
onCheck('still-light', (v) => (still.byLight = v));
onCheck('still-xray', (v) => (still.xray = v));
onCheck('still-open', (v) => (still.open = v));
onSelect('still-cut', (v) => {
  still.cut = v as StillOptions['cut'];
  byId('pick-plane').hidden = still.cut !== 'plane' && still.cut !== 'slab';
  byId('pick-slab').hidden = still.cut !== 'slab';
});
bindRange('plane-turn', 0, (v) => (still.plane.turn = v));
bindRange('plane-tilt', 0, (v) => (still.plane.tilt = v));
bindRange('plane-offset', 2, (v) => (still.plane.offset = v));
bindRange('slab', 0, (v) => (still.slab = v));
byId('still-again').addEventListener('click', () => (filmsStep = -1));
byId('still-png').addEventListener('click', () => {
  if (!foam || !films) return;
  const canvas = renderOffscreen(foam.n, 2);
  canvas.toBlob((blob) => blob && download(blob, 'foam3d.png'));
});
byId('still-svg').addEventListener('click', () => {
  if (!foam || !films) return;
  const { picture: big, canvas } = renderPicture(foam.n, 2);
  const url = big.image ? canvas.toDataURL('image/png') : null;
  download(new Blob([pictureSvg(big, url)], { type: 'image/svg+xml' }), 'foam3d.svg');
});

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
  else if (key === 'w') drained = 0;
  else if (key === 'c') {
    coloursSelect.selectedIndex = (coloursSelect.selectedIndex + 1) % coloursSelect.options.length;
    coloursSelect.dispatchEvent(new Event('change'));
  }
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
  movedAt = performance.now();
  camera.yaw -= e.movementX * 0.008;
  camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch + e.movementY * 0.008));
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointercancel', () => (dragging = false));
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    movedAt = performance.now();
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
  drained = 0;
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
    if (!paused) drained += Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (now - rateSince > 1000) {
      rate = (rateSteps * 1000) / (now - rateSince);
      rateSteps = 0;
      rateSince = now;
    }
    if (look === 'still') {
      renderer.clear();
      // Meshing is slow; while the foam moves it is done again only now and then.
      if (foam.steps !== filmsStep && now - filmsAt > Math.max(1000, 6 * filmsMs) && !dragging) {
        filmsStep = foam.steps;
        films = buildFilms(foam.readLabels(), foam.n);
        filmsDistance = null;
        filmsMs = performance.now() - now;
        filmsAt = performance.now();
        pictureFor = '';
      }
      drawStill(foam.n, now);
    } else if (look === 'vector') {
      renderer.clear();
      if (foam.steps !== skeletonStep && now - skeletonAt > SKELETON_EVERY) {
        skeletonStep = foam.steps;
        skeletonAt = now;
        skeletonLabels = foam.readLabels();
        skeleton = extractSkeleton(skeletonLabels, foam.n);
        contours =
          contourShape === 'off'
            ? null
            : extractContours(skeletonLabels, foam.n, contourShape, (contourSpacing * foam.n) / 96);
        skeletonMs = performance.now() - now;
        partsFor = '';
      }
      drawSkeleton(foam.n);
    } else if (look === 'lines-tubes') {
      // The distances take longer than the lines; rebuilt more seldom, so
      // the view does not stall for long.
      if (foam.steps !== skeletonStep && now - skeletonAt > Math.max(SKELETON_EVERY, 8 * skeletonMs)) {
        skeletonStep = foam.steps;
        skeletonAt = now;
        skeleton = extractSkeleton(foam.readLabels(), foam.n);
        // Finer than the field where that is cheap, so thin tubes stay round.
        const scale = foam.n <= 96 ? 2 : 1;
        const field = tubeField(skeleton, foam.n, scale, tubeRadius * 1.5 + 1.5);
        renderer.setLineTubes(field.data, field.size, field.reach);
        skeletonMs = performance.now() - now;
      }
      const view: View = { opacity, oneColor: false, smoothness: 0.6, skeleton: 'lines', tubeRadius };
      renderer.drawVoxels(null, foam.n, camera, view);
    } else {
      // The skeleton is drawn in voxels whatever the surface.
      const skeletonView = look === 'skeleton' || look === 'tubes';
      const smoothView = smooth && !skeletonView;
      foam.show(smoothView);
      const lit = look === 'light' && !smooth;
      const view: View = {
        opacity,
        oneColor: false,
        smoothness: 0.6,
        light: lit ? light : undefined,
        skeleton: look === 'skeleton' ? 'voxels' : look === 'tubes' ? tubeBlur : undefined,
      };
      if (colours !== 'hues') {
        // A draining film thins about as one over the root of the time, and
        // the black film comes down as fast.
        const front = Math.max(LOWEST_FRONT, 1.05 / Math.sqrt(1 + drained * drainage * 0.1));
        view.film = { mode: colours, time: drained, front };
      }
      if (smoothView) renderer.drawSmooth(null, foam.n, camera, view);
      else renderer.drawVoxels(null, foam.n, camera, view);
    }
    const air = foam.growing ? ` · growing, ${Math.round(foam.air)} cells of air left` : '';
    const lines =
      look === 'still' && films
        ? ` · ${films.triangles.length / 3} triangles, ${films.borders.length} borders, meshed in ${Math.round(filmsMs)} ms, drawn in ${Math.round(pictureMs)} ms`
        : (look === 'vector' || look === 'lines-tubes') && skeleton
          ? ` · ${skeleton.lines.length} lines in ${Math.round(skeletonMs)} ms`
          : '';
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
  const skeletonLook = look === 'skeleton' || look === 'tubes' || look === 'lines-tubes';
  byId('pick-tube-radius').hidden = look !== 'lines-tubes';
  byId('pick-look').hidden = smooth && !vector && !skeletonLook;
  byId('pick-colours').hidden = vector || skeletonLook;
  byId('pick-drain').hidden = vector || skeletonLook || colours !== 'soap';
  byId('pick-tubes').hidden = look !== 'tubes';
  byId('pick-films').hidden = !lit;
  byId('pick-lines').hidden = !lit && !vector;
  byId('pick-through').hidden = !vector;
  byId('pick-contours').hidden = !vector;
  byId('pick-spacing').hidden = !vector || contourShape === 'off';
  byId('pick-opacity').hidden = lit || vector || skeletonLook;
  byId('pick-surface').hidden = vector || skeletonLook;
  const stillLook = look === 'still';
  byId('pick-still').hidden = !stillLook;
  if (stillLook) {
    byId('pick-colours').hidden = true;
    byId('pick-drain').hidden = true;
    byId('pick-opacity').hidden = true;
    byId('pick-surface').hidden = true;
    byId('pick-look').hidden = false;
  }
  vectorCanvas.hidden = !vector && !stillLook;
  skeletonStep = -1;
  filmsStep = -1;
}

/** The size of the overlay in device pixels, and the scale to CSS pixels. */
function overlaySize(): { w: number; h: number; scale: number } {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(vectorCanvas.clientWidth * scale));
  const h = Math.max(1, Math.round(vectorCanvas.clientHeight * scale));
  return { w, h, scale };
}

/** The still picture at the overlay's size times this, on a canvas of its own. */
function renderPicture(n: number, times: number): { picture: Picture; canvas: HTMLCanvasElement } {
  const { w, h, scale } = overlaySize();
  if (still.across === 'rings' && !filmsDistance && films) filmsDistance = distanceFromBorders(films);
  const big = renderStill(films!, filmsDistance, cameraFrame(camera, n), n, {
    ...still,
    width: w * times,
    height: h * times,
    scale: scale * times,
  });
  const canvas = document.createElement('canvas');
  canvas.width = big.width;
  canvas.height = big.height;
  if (big.image) canvas.getContext('2d')!.putImageData(big.image, 0, 0);
  return { picture: big, canvas };
}

function renderOffscreen(n: number, times: number): HTMLCanvasElement {
  const { picture: big, canvas } = renderPicture(n, times);
  drawPicture(canvas.getContext('2d')!, big);
  return canvas;
}

/**
 * The still picture on the overlay: drawn again once the view has held
 * still a moment; while it moves, only the borders, unhidden, so the view
 * can be turned at speed.
 */
function drawStill(n: number, now: number): void {
  const { w, h, scale } = overlaySize();
  if (vectorCanvas.width !== w || vectorCanvas.height !== h) {
    vectorCanvas.width = w;
    vectorCanvas.height = h;
    pictureFor = '';
  }
  const ctx = vectorContext;
  if (!films) {
    ctx.clearRect(0, 0, w, h);
    return;
  }
  const view = `${camera.yaw},${camera.pitch},${camera.distance},${w},${h},${JSON.stringify(still)},${filmsStep}`;
  const moving = dragging || now - movedAt < STILL_AFTER;
  if (moving) {
    drawPreview(ctx, n, w, h, scale);
    pictureFor = '';
    return;
  }
  if (view === pictureFor && picture) return;
  pictureFor = view;
  const start = performance.now();
  if (still.across === 'rings' && !filmsDistance) filmsDistance = distanceFromBorders(films);
  picture = renderStill(films, filmsDistance, cameraFrame(camera, n), n, { ...still, width: w, height: h, scale });
  drawPicture(ctx, picture);
  pictureMs = performance.now() - start;
}

/** The borders alone, every one, as thin lines: quick enough to follow the pointer. */
function drawPreview(ctx: CanvasRenderingContext2D, n: number, w: number, h: number, scale: number): void {
  const { eye, right, up, forward } = cameraFrame(camera, n);
  ctx.fillStyle = still.fill === 'paper' ? '#faf8f2' : '#0c0c10';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = still.fill === 'paper' ? 'rgba(20, 20, 20, 0.6)' : 'rgba(230, 230, 255, 0.6)';
  ctx.lineWidth = scale;
  ctx.beginPath();
  for (const border of films!.borders) {
    border.points.forEach((p, k) => {
      const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const depth = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
      const x = (((d[0] * right[0] + d[1] * right[1] + d[2] * right[2]) * FOCAL) / depth * h + w) / 2;
      const y = (h - ((d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) * FOCAL) / depth * h) / 2;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  }
  ctx.stroke();
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
    // The contour pieces are hidden or faded by the same rule, judged at their middles.
    if (contours) {
      const pieces = contours.pieces;
      contourLight = new Float32Array(pieces.length / 6);
      for (let k = 0; k < contourLight.length; k++) {
        const middle = [0, 1, 2].map((a) => (pieces[k * 6 + a] + pieces[k * 6 + 3 + a]) / 2);
        if (through === Infinity || !labels) contourLight[k] = 1;
        else if (hiding === 'fade') contourLight[k] = FADE ** filmsInFront([middle], labels, n, eye, 4)[0];
        else contourLight[k] = inSight(middle, labels, n, eye, through) ? 1 : 0;
      }
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
  if (contours) drawContours(ctx, contours, project, nearness, strength, scale);
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

/** The pieces of the lines across the films: thin, faint and without a glow. */
function drawContours(
  ctx: CanvasRenderingContext2D,
  { pieces, hues }: Contours,
  project: (p: number[]) => number[],
  nearness: (depth: number) => number,
  strength: number,
  scale: number,
): void {
  ctx.lineWidth = 0.8 * scale;
  ctx.lineCap = 'butt';
  for (let k = 0; k < hues.length; k++) {
    const light = contourLight[k] ?? 0;
    if (light < 0.01) continue;
    const a = project([pieces[k * 6], pieces[k * 6 + 1], pieces[k * 6 + 2]]);
    const b = project([pieces[k * 6 + 3], pieces[k * 6 + 4], pieces[k * 6 + 5]]);
    if (a[2] <= 1 || b[2] <= 1) continue;
    const alpha = Math.min(1, 0.45 * strength * light * nearness((a[2] + b[2]) / 2));
    ctx.strokeStyle = `hsla(${Math.round(hues[k] * 360)}, 60%, 75%, ${alpha})`;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  ctx.lineCap = 'round';
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
