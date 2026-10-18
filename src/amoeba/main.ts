import { Amoebae, MEDIUM, type AmoebaParams, type Sense } from './amoebae.ts';

/** Time a frame may spend on steps, in ms. */
const BUDGET = 30;
/** The smell is drawn by its log, over this many factors of e below the strongest. */
const SMELL_SHOWN = 12;
/** Radius of an amoeba's nucleus, in pixels. */
const NUCLEUS = 2.5;

const COLOR_FILM = rgb(226, 232, 244);
const COLOR_NUCLEUS = rgb(30, 24, 40);

const canvas = byId<HTMLCanvasElement>('field');
const ctx = canvas.getContext('2d')!;
const stat = byId('stat');
const params: AmoebaParams = { radius: 4, noise: 0.1, sense: 'smell', pull: 0.35, carries: 40, feeds: 0.1, starves: 6000, walls: 1.5 };

let size = 384;
let world = new Amoebae(size, size);
let image = ctx.createImageData(size, size);
let pixels = new Uint32Array(image.data.buffer);
let crumbs = 200;
let stepsPerFrame = 2;
let showSmell = true;
let paused = false;
let rate = 0;
let rateSteps = 0;
let rateSince = performance.now();

bindRange('radius', 0, (v) => (params.radius = v));
bindRange('noise', 2, (v) => (params.noise = v));
bindRange('pull', 2, (v) => (params.pull = v));
bindRange('carries', 0, (v) => (params.carries = v));
bindRange('feeds', 2, (v) => (params.feeds = v));
bindRange('starves', 0, (v) => (params.starves = v));
bindRange('walls', 1, (v) => (params.walls = v));
bindRange('crumbs', 0, (v) => (crumbs = v));
bindRange('speed', 0, (v) => (stepsPerFrame = v));
onSelect('sense', (v) => (params.sense = v as Sense));
onSelect('field-size', (v) => {
  size = Number(v);
  world = new Amoebae(size, size);
  canvas.width = size;
  canvas.height = size;
  image = ctx.createImageData(size, size);
  pixels = new Uint32Array(image.data.buffer);
  restart();
});
const smellToggle = byId<HTMLInputElement>('show-smell');
smellToggle.addEventListener('change', () => (showSmell = smellToggle.checked));

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
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * size);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * size);
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  if (e.button === 2 || e.shiftKey) world.remove(x, y);
  else world.divideAt(x, y);
});

// For checks from the console.
Object.assign(window, { amoebaPage: { world: () => world } });
requestAnimationFrame(frame);

function restart(): void {
  world.start(crumbs);
}

function frame(): void {
  if (!paused) {
    const began = performance.now();
    const before = world.steps;
    for (let s = 0; s < stepsPerFrame; s++) {
      world.step(params);
      if (performance.now() - began > BUDGET) break;
    }
    rateSteps += world.steps - before;
  }
  const now = performance.now();
  if (now - rateSince > 1000) {
    rate = (rateSteps * 1000) / (now - rateSince);
    rateSteps = 0;
    rateSince = now;
  }
  render();
  stat.textContent = status();
  requestAnimationFrame(frame);
}

function render(): void {
  const { label, food, smell } = world;
  let strongest = 0;
  if (showSmell) for (let i = 0; i < smell.length; i++) strongest = Math.max(strongest, smell[i]);
  const top = Math.log(strongest + 1e-30);
  const tints = new Uint32Array(world.labelCount + 1);
  for (let l = 1; l <= world.labelCount; l++) tints[l] = amoebaColour(l);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const here = label[i];
      const film = (x + 1 < size && label[i + 1] !== here) || (y + 1 < size && label[i + size] !== here);
      if (film) pixels[i] = COLOR_FILM;
      else if (here !== MEDIUM) pixels[i] = tints[here];
      else if (food[i] > 0) {
        const f = Math.min(1, food[i] * 8);
        pixels[i] = rgb(Math.round(60 + 120 * f), Math.round(90 + 140 * f), Math.round(40 + 40 * f));
      } else {
        // The water, lit faintly where the food smells.
        const s = showSmell && strongest > 0 ? Math.max(0, 1 + (Math.log(smell[i] + 1e-30) - top) / SMELL_SHOWN) : 0;
        pixels[i] = rgb(11, Math.round(13 + 30 * s * s), Math.round(17 + 22 * s * s));
      }
    }
  }
  // A dark nucleus in the middle of every living amoeba.
  for (let l = 1; l <= world.labelCount; l++) {
    if (!world.isAlive(l)) continue;
    const [cx, cy] = world.centreOf(l);
    const r = Math.ceil(NUCLEUS);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(cx) + dx;
        const y = Math.round(cy) + dy;
        if (dx * dx + dy * dy > NUCLEUS * NUCLEUS || x < 0 || x >= size || y < 0 || y >= size) continue;
        if (label[y * size + x] === l) pixels[y * size + x] = COLOR_NUCLEUS;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** By its line, a little drift with every division; lighter the better fed. */
function amoebaColour(l: number): number {
  const t = world.tintOf(l);
  const fed = Math.max(0, Math.min(2, world.fedOf(l)));
  return hsl((((t % 1) + 1) % 1) * 360, 0.5, 0.28 + 0.14 * fed);
}

function status(): string {
  const parts = [
    `${world.count} amoebae`,
    `step ${world.steps}`,
    `${world.divisions} divisions, ${world.deaths} deaths`,
    `food left ${world.foodLeft.toFixed(0)} of ${world.crumbs} crumbs`,
    `${Math.round(rate)} steps/s`,
  ];
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
