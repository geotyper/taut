import { MEDIUM, SMELL_CELL, type Amoebae } from './amoebae.ts';

/** The colours the field is drawn in: as before on dark water, as under a phase-contrast microscope, or glowing. */
export type Palette = 'dark' | 'microscope' | 'fluorescence';

export interface Look {
  palette: Palette;
  /** Every amoeba of one body, joined to the others by films, in the body's colour. */
  byBody: boolean;
  /** The amoebae as soft blobs: blurred and cut at a level, so the walls inside are gone. */
  blob: boolean;
  /** How far the blur reaches for a blob, in pixels. */
  blobReach: number;
  /** A fading trail where the amoebae have been. */
  trails: boolean;
  showSmell: boolean;
  showLight: boolean;
  /** Only the water, food, trails and glows: the amoebae are drawn over, as vectors. */
  waterOnly: boolean;
}

export type RGB = [number, number, number];

/** The smell is drawn by its log, over this many factors of e below the strongest. */
const SMELL_SHOWN = 12;
/** How far a membrane's halo or glow reaches, in pixels. */
const HALO = 3;
/** Radius of a nucleus's glow in a blob, in pixels. */
const GLOW = 5;

const FILM: RGB = [226, 232, 244];
const DARK_WATER: RGB = [11, 13, 17];
const SCOPE_WATER: RGB = [196, 200, 188];
const SCOPE_MEMBRANE: RGB = [52, 58, 52];
const SCOPE_FOOD: RGB = [92, 82, 52];
const FLUOR_WATER: RGB = [2, 3, 7];
const FLUOR_MEMBRANE: RGB = [160, 255, 215];
const FLUOR_GLOW: RGB = [30, 220, 150];
const FLUOR_FOOD: RGB = [255, 50, 210];

/** How the vectors of the smooth view are drawn in a palette. */
export interface VectorStyle {
  fillAlpha: number;
  inner: RGB;
  outer: RGB;
  /** The wider rim under the outer membrane, and how much it shows. */
  rim: RGB;
  rimAlpha: number;
  /** A glow round the outer membrane, in pixels; 0 for none. */
  glow: number;
}

export const VECTOR_STYLES: Record<Palette, VectorStyle> = {
  dark: { fillAlpha: 1, inner: FILM, outer: FILM, rim: FILM, rimAlpha: 0.25, glow: 0 },
  microscope: { fillAlpha: 0.6, inner: SCOPE_MEMBRANE, outer: SCOPE_MEMBRANE, rim: [255, 255, 250], rimAlpha: 0.45, glow: 0 },
  fluorescence: { fillAlpha: 1, inner: FLUOR_MEMBRANE, outer: FLUOR_MEMBRANE, rim: FLUOR_GLOW, rimAlpha: 0.3, glow: 6 },
};

/**
 * Paints the field a pixel a pixel, in the look chosen. Each layer is worked
 * out over the whole field: the water with its smell and the trails, the food,
 * the amoebae, hard or blurred into blobs, and their membranes, with the halo
 * or glow round them blurred out from the membranes.
 */
export class Painter {
  readonly trail: Float32Array;
  /** The body every amoeba is in, as the lowest label in it. */
  private body = new Uint16Array(1);
  private readonly mask: Float32Array;
  private readonly red: Float32Array;
  private readonly green: Float32Array;
  private readonly blue: Float32Array;
  private readonly membrane: Float32Array;
  private readonly halo: Float32Array;
  private readonly foodLight: Float32Array;
  private readonly spare: Float32Array;

  readonly size: number;

  constructor(size: number) {
    this.size = size;
    const n = size * size;
    this.trail = new Float32Array(n);
    this.mask = new Float32Array(n);
    this.red = new Float32Array(n);
    this.green = new Float32Array(n);
    this.blue = new Float32Array(n);
    this.membrane = new Float32Array(n);
    this.halo = new Float32Array(n);
    this.foodLight = new Float32Array(n);
    this.spare = new Float32Array(n);
  }

  /** The trails fade, halving over `half` steps, for `steps` steps run, and are full again under every amoeba. */
  fade(world: Amoebae, steps: number, half: number): void {
    const { trail } = this;
    const { label } = world;
    const keep = Math.pow(0.5, steps / Math.max(1, half));
    for (let i = 0; i < trail.length; i++) trail[i] = label[i] !== MEDIUM ? 1 : trail[i] * keep;
  }

  clearTrails(): void {
    this.trail.fill(0);
  }

  /** Which body every amoeba is in, by the films between them: joined where two lie side by side. */
  findBodies(world: Amoebae): void {
    const { label } = world;
    const n = this.size;
    const count = world.labelCount + 1;
    if (this.body.length < count) this.body = new Uint16Array(count * 2);
    const parent = this.body;
    for (let l = 0; l < count; l++) parent[l] = l;
    const root = (l: number): number => {
      while (parent[l] !== l) l = parent[l] = parent[parent[l]];
      return l;
    };
    const join = (a: number, b: number) => {
      const ra = root(a);
      const rb = root(b);
      if (ra < rb) parent[rb] = ra;
      else if (rb < ra) parent[ra] = rb;
    };
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const here = label[i];
        if (here === MEDIUM) continue;
        if (x + 1 < n && label[i + 1] !== here && label[i + 1] !== MEDIUM) join(here, label[i + 1]);
        if (y + 1 < n && label[i + n] !== here && label[i + n] !== MEDIUM) join(here, label[i + n]);
      }
    }
    for (let l = 0; l < count; l++) parent[l] = root(l);
  }

  /** An amoeba's colour: by its line, or its body's, lighter the better fed it is. */
  colourOf(world: Amoebae, l: number, look: Look): RGB {
    const by = look.byBody && l < this.body.length ? this.body[l] : l;
    const t = world.tintOf(by);
    const hue = (((t % 1) + 1) % 1) * 360;
    const fed = Math.max(0, Math.min(2, world.fedOf(l)));
    if (look.palette === 'microscope') return hsl(hue, 0.25, 0.4 + 0.1 * fed);
    if (look.palette === 'fluorescence') return hsl(hue, 0.7, 0.07 + 0.06 * fed);
    return hsl(hue, 0.5, 0.28 + 0.14 * fed);
  }

  paint(world: Amoebae, pixels: Uint32Array, look: Look): void {
    const n = this.size;
    const { label, food } = world;
    const { mask, red, green, blue, membrane, halo, spare, trail } = this;
    const { palette } = look;
    if (look.byBody) this.findBodies(world);
    const colours: RGB[] = [[0, 0, 0]];
    for (let l = 1; l <= world.labelCount; l++) colours.push(this.colourOf(world, l, look));
    const at = (x: number, y: number) => (x < 0 || x >= n || y < 0 || y >= n ? -1 : label[y * n + x]);

    // The amoebae, as how much of each pixel they cover and in what colour.
    const showAmoebae = !look.waterOnly || look.blob;
    for (let i = 0; i < mask.length; i++) {
      const l = label[i];
      const c = colours[l];
      const m = l !== MEDIUM ? 1 : 0;
      mask[i] = m;
      red[i] = c[0] * m;
      green[i] = c[1] * m;
      blue[i] = c[2] * m;
    }
    if (look.blob) {
      const r = Math.max(1, Math.round(look.blobReach));
      for (const channel of [mask, red, green, blue]) blur(channel, spare, n, r);
    }

    // The outer membrane: hard, an amoeba's pixel by the water or the edge; soft, the blob's rim.
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (look.blob) {
          const a = smoothstep(mask[i]);
          membrane[i] = Math.min(1, 4 * a * (1 - a));
        } else {
          const here = label[i];
          membrane[i] =
            here !== MEDIUM &&
            (at(x + 1, y) <= MEDIUM || at(x - 1, y) <= MEDIUM || at(x, y + 1) <= MEDIUM || at(x, y - 1) <= MEDIUM)
              ? 1
              : 0;
        }
      }
    }
    const glows = palette !== 'dark';
    if (glows) {
      halo.set(membrane);
      blur(halo, spare, n, HALO);
    }
    // The food's glow, under fluorescence.
    let foodLight: Float32Array | null = null;
    if (palette === 'fluorescence') {
      foodLight = this.foodLight;
      for (let i = 0; i < foodLight.length; i++) foodLight[i] = Math.min(1, food[i] * 8);
      blur(foodLight, spare, n, HALO);
    }

    // How lit the water is on every square of the smell's grid, by the log of the smell.
    const { smell, sw } = world;
    let strongest = 0;
    if (look.showSmell) for (let i = 0; i < smell.length; i++) strongest = Math.max(strongest, smell[i]);
    const top = Math.log(strongest + 1e-30);
    const lit = look.showSmell && strongest > 0;
    const shines = look.showLight && world.lightX.length > 0;

    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const here = label[i];
        let g = 0;
        if (lit) {
          const s = Math.max(0, 1 + (Math.log(smell[Math.floor(y / SMELL_CELL) * sw + Math.floor(x / SMELL_CELL)] + 1e-30) - top) / SMELL_SHOWN);
          g = s * s;
        }
        // The water, with the smell and the trails.
        let r: number, gr: number, b: number;
        const tr = look.trails ? trail[i] : 0;
        if (palette === 'microscope') {
          r = SCOPE_WATER[0] - 14 * g - 26 * tr;
          gr = SCOPE_WATER[1] - 8 * g - 22 * tr;
          b = SCOPE_WATER[2] - 4 * g - 14 * tr;
        } else if (palette === 'fluorescence') {
          r = FLUOR_WATER[0] + 10 * g + 10 * tr;
          gr = FLUOR_WATER[1] + 4 * g + 40 * tr;
          b = FLUOR_WATER[2] + 26 * g + 90 * tr;
        } else {
          r = DARK_WATER[0] + 34 * tr;
          gr = DARK_WATER[1] + 30 * g + 26 * tr;
          b = DARK_WATER[2] + 22 * g + 60 * tr;
        }
        // The light, warm on the water.
        if (shines) {
          const L = world.lightAt(x + 0.5, y + 0.5);
          if (palette === 'microscope') {
            r += (255 - r) * L * 0.35;
            gr += (250 - gr) * L * 0.3;
            b += (215 - b) * L * 0.2;
          } else {
            const k = palette === 'fluorescence' ? 0.5 : 1;
            r += 70 * L * k;
            gr += 56 * L * k;
            b += 14 * L * k;
          }
        }
        // The food.
        if (food[i] > 0 && here === MEDIUM) {
          const f = Math.min(1, food[i] * 8);
          if (palette === 'microscope') {
            r += (SCOPE_FOOD[0] - r) * f * 0.85;
            gr += (SCOPE_FOOD[1] - gr) * f * 0.85;
            b += (SCOPE_FOOD[2] - b) * f * 0.85;
          } else if (palette === 'fluorescence') {
            r += FLUOR_FOOD[0] * f;
            gr += FLUOR_FOOD[1] * f;
            b += FLUOR_FOOD[2] * f;
          } else {
            r = 60 + 120 * f;
            gr = 90 + 140 * f;
            b = 40 + 40 * f;
          }
        }
        if (foodLight) {
          const f = foodLight[i] * 1.6;
          r += FLUOR_FOOD[0] * f;
          gr += FLUOR_FOOD[1] * f;
          b += FLUOR_FOOD[2] * f;
        }
        // The halo of phase contrast, bright on the water just outside the membrane.
        if (palette === 'microscope') {
          const h = Math.min(1, halo[i] * 1.6) * (1 - (look.blob ? smoothstep(mask[i]) : mask[i]));
          r += (255 - r) * h * 0.7;
          gr += (255 - gr) * h * 0.7;
          b += (250 - b) * h * 0.7;
        }

        // The amoebae over the water.
        if (showAmoebae) {
          const m = mask[i];
          const a = look.blob ? smoothstep(m) : m;
          if (a > 0) {
            let cr = red[i] / m;
            let cg = green[i] / m;
            let cb = blue[i] / m;
            let alpha = a;
            if (palette === 'microscope') {
              // Grainy, and the water seen through.
              const grain = (hash(x, y) - 0.5) * 26;
              cr += grain;
              cg += grain;
              cb += grain;
              alpha *= 0.6;
            }
            r += (cr - r) * alpha;
            gr += (cg - gr) * alpha;
            b += (cb - b) * alpha;
          }
          // The films.
          if (!look.blob) {
            const right = x + 1 < n ? label[i + 1] : here;
            const below = y + 1 < n ? label[i + n] : here;
            const film = right !== here || below !== here;
            if (palette === 'dark') {
              if (film) [r, gr, b] = FILM;
            } else {
              const inside = film && here !== MEDIUM && (right === here || right !== MEDIUM) && (below === here || below !== MEDIUM);
              const colour = palette === 'microscope' ? SCOPE_MEMBRANE : FLUOR_MEMBRANE;
              const k = membrane[i] > 0 ? 0.9 : inside ? 0.3 : 0;
              r += (colour[0] - r) * k;
              gr += (colour[1] - gr) * k;
              b += (colour[2] - b) * k;
            }
          } else if (palette !== 'dark') {
            const colour = palette === 'microscope' ? SCOPE_MEMBRANE : FLUOR_MEMBRANE;
            const k = membrane[i] * 0.8;
            r += (colour[0] - r) * k;
            gr += (colour[1] - gr) * k;
            b += (colour[2] - b) * k;
          } else {
            const k = membrane[i] * 0.85;
            r += (FILM[0] - r) * k;
            gr += (FILM[1] - gr) * k;
            b += (FILM[2] - b) * k;
          }
        }
        // The neon glow round the membranes.
        if (palette === 'fluorescence') {
          const h = Math.min(1, halo[i] * 1.4);
          r += FLUOR_GLOW[0] * h;
          gr += FLUOR_GLOW[1] * h;
          b += FLUOR_GLOW[2] * h;
        }
        pixels[i] = pack(r, gr, b);
      }
    }
    if (look.blob && showAmoebae) this.glowNuclei(world, pixels, palette);
  }

  /** A soft light at every nucleus, inside a blob. */
  private glowNuclei(world: Amoebae, pixels: Uint32Array, palette: Palette): void {
    const n = this.size;
    const light: RGB = palette === 'microscope' ? [40, 44, 40] : palette === 'fluorescence' ? [90, 140, 255] : [255, 236, 190];
    const darkens = palette === 'microscope';
    for (let l = 1; l <= world.labelCount; l++) {
      if (!world.isAlive(l)) continue;
      const [cx, cy] = world.centreOf(l);
      const r = Math.ceil(GLOW * 1.5);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = Math.round(cx) + dx;
          const y = Math.round(cy) + dy;
          if (x < 0 || x >= n || y < 0 || y >= n) continue;
          const k = Math.exp(-(dx * dx + dy * dy) / (GLOW * GLOW)) * (darkens ? 0.5 : 0.6);
          if (k < 0.01) continue;
          const i = y * n + x;
          const p = pixels[i];
          let r0 = p & 255;
          let g0 = (p >>> 8) & 255;
          let b0 = (p >>> 16) & 255;
          if (darkens) {
            r0 += (light[0] - r0) * k;
            g0 += (light[1] - g0) * k;
            b0 += (light[2] - b0) * k;
          } else {
            r0 += light[0] * k;
            g0 += light[1] * k;
            b0 += light[2] * k;
          }
          pixels[i] = pack(r0, g0, b0);
        }
      }
    }
  }
}

/** Blur in place, a box this many pixels each way, twice over, so near a Gaussian. */
function blur(data: Float32Array, spare: Float32Array, n: number, r: number): void {
  for (let round = 0; round < 2; round++) {
    boxPass(data, spare, n, r, 1, n);
    boxPass(spare, data, n, r, n, 1);
  }
}

/** A running box along lines: `along` between pixels of a line, `across` between lines. */
function boxPass(from: Float32Array, to: Float32Array, n: number, r: number, along: number, across: number): void {
  const width = 2 * r + 1;
  for (let line = 0; line < n; line++) {
    const base = line * across;
    let sum = 0;
    // Beyond the field counts as the pixel at its edge.
    for (let k = -r; k <= r; k++) sum += from[base + Math.min(n - 1, Math.max(0, k)) * along];
    for (let k = 0; k < n; k++) {
      to[base + k * along] = sum / width;
      sum += from[base + Math.min(n - 1, k + r + 1) * along] - from[base + Math.max(0, k - r) * along];
    }
  }
}

/** From 0 below a third to 1 above two thirds, smoothly: where a blurred blob is cut. */
function smoothstep(v: number): number {
  const t = Math.max(0, Math.min(1, (v - 0.3) / 0.35));
  return t * t * (3 - 2 * t);
}

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function pack(r: number, g: number, b: number): number {
  const c = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
  return ((255 << 24) | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0;
}

export function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const channel = (k0: number) => {
    const k = (k0 + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [channel(0), channel(8), channel(4)];
}
