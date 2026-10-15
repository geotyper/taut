import { AIR } from './foam.ts';
import { along, junctions, lengthOf, WALL, type FilmLine } from './lines.ts';

/** Bubbles with this many sides or more share the last bar. */
const MOST_SIDES = 12;
/** Junction angles are counted in bins this many degrees wide. */
const ANGLE_BIN = 5;
/** How far along a film its direction at a junction is taken, in cells. */
const ARM = 3;
/** Steps between two looks at the areas, for the rate they change at. */
const SEEP_STEPS = 100;

/** What the films of a foam say about Plateau's and Euler's rules. */
export interface Measures {
  /** The number of sides of every bubble closed round by films, not by the wall or air. */
  sides: Map<number, number>;
  /** How many bubbles have n sides, at index n. */
  histogram: number[];
  meanSides: number;
  /** The variance of the number of sides. */
  mu2: number;
  /** The mean number of sides of the neighbours of a bubble with n sides, at index n. */
  neighbours: number[];
  /** Aboav–Weaire's a, from n·m(n) = (6 − a)·n + 6a + μ₂ fitted over the bubbles. */
  aboav: number;
  /** How many angles at three-film junctions fall in each bin. */
  angles: number[];
  /** The share of the angles within 10° of 120°; their mean is 120° whatever they are. */
  angleNear: number;
  /** The root mean square of the angles' distance from 120°. */
  angleSpread: number;
  junctions: number;
}

/** Count sides and neighbours, and the angles where three films meet. */
export function measureFilms(lines: FilmLine[]): Measures {
  const sides = new Map<number, number>();
  const open = new Set<number>();
  const next = new Map<number, number[]>();
  for (const { a, b } of lines) {
    // A bubble on the wall or on air is not closed round by films.
    if (a === WALL || a === AIR) open.add(b);
    if (b === WALL || b === AIR) open.add(a);
    if (a === WALL || b === WALL || a === AIR || b === AIR) continue;
    for (const [mine, other] of [
      [a, b],
      [b, a],
    ]) {
      sides.set(mine, (sides.get(mine) ?? 0) + 1);
      const list = next.get(mine);
      if (list) list.push(other);
      else next.set(mine, [other]);
    }
  }
  for (const label of open) sides.delete(label);

  const histogram = new Array<number>(MOST_SIDES + 1).fill(0);
  let sum = 0;
  let squares = 0;
  for (const n of sides.values()) {
    histogram[Math.min(n, MOST_SIDES)]++;
    sum += n;
    squares += n * n;
  }
  const count = sides.size;
  const meanSides = count ? sum / count : NaN;
  const mu2 = count ? squares / count - meanSides * meanSides : NaN;

  // Neighbours counted only where they are closed round too.
  const neighbourSum = new Array<number>(MOST_SIDES + 1).fill(0);
  const neighbourCount = new Array<number>(MOST_SIDES + 1).fill(0);
  const fit = new Fit();
  for (const [label, n] of sides) {
    let total = 0;
    let known = 0;
    for (const other of next.get(label) ?? []) {
      const m = sides.get(other);
      if (m === undefined) continue;
      total += m;
      known++;
    }
    if (!known) continue;
    const m = total / known;
    neighbourSum[Math.min(n, MOST_SIDES)] += m;
    neighbourCount[Math.min(n, MOST_SIDES)]++;
    fit.add(n, n * m);
  }
  const neighbours = neighbourSum.map((s, n) => (neighbourCount[n] ? s / neighbourCount[n] : NaN));
  const aboav = 6 - fit.slope();

  const angles = new Array<number>(180 / ANGLE_BIN).fill(0);
  let angleNear = 0;
  let angleSquares = 0;
  let angleCount = 0;
  let junctionCount = 0;
  for (const junction of junctions(lines)) {
    if (junction.arms.length !== 3) continue;
    if (junction.arms.some(({ line }) => line.a === WALL || line.b === WALL)) continue;
    const directions = junction.arms
      .map(({ line, fromStart }) => {
        const reach = Math.min(ARM, lengthOf(line.points) / 2);
        const [x, y] = along(line.points, fromStart, reach);
        return Math.atan2(y - junction.y, x - junction.x);
      })
      .sort((p, q) => p - q);
    junctionCount++;
    for (let k = 0; k < 3; k++) {
      const turn = k < 2 ? directions[k + 1] - directions[k] : directions[0] + 2 * Math.PI - directions[2];
      const degrees = (turn * 180) / Math.PI;
      angles[Math.min(angles.length - 1, Math.floor(degrees / ANGLE_BIN))]++;
      if (Math.abs(degrees - 120) <= 10) angleNear++;
      angleSquares += (degrees - 120) ** 2;
      angleCount++;
    }
  }
  return {
    sides,
    histogram,
    meanSides,
    mu2,
    neighbours,
    aboav,
    angles,
    angleNear: angleCount ? angleNear / angleCount : NaN,
    angleSpread: angleCount ? Math.sqrt(angleSquares / angleCount) : NaN,
    junctions: junctionCount,
  };
}

/**
 * Von Neumann's law: in a dry 2D foam whose gas seeps through the films, a
 * bubble with n sides changes its area at a rate k·(n − 6), whatever its
 * size. The areas are looked at every SEEP_STEPS steps, and the rate of every
 * closed bubble is put down against the sides it had at the start.
 */
export class Seepage {
  private before: { step: number; area: Uint32Array; sides: Map<number, number> } | null = null;
  /** Summed rates and counts by number of sides, in cells per 100 steps. */
  readonly rate = new Array<number>(MOST_SIDES + 1).fill(0);
  readonly count = new Array<number>(MOST_SIDES + 1).fill(0);
  private fit = new Fit();

  reset(): void {
    this.before = null;
    this.rate.fill(0);
    this.count.fill(0);
    this.fit = new Fit();
  }

  /** Start again from the next look, keeping what was put down: while there is air, bubbles grow into it. */
  forget(): void {
    this.before = null;
  }

  /** Look at the areas now, if enough steps have gone by since the last look. */
  update(step: number, label: Uint16Array, sides: Map<number, number>): void {
    if (this.before && step < this.before.step) this.reset();
    if (this.before && step - this.before.step < SEEP_STEPS) return;
    const area = new Uint32Array(65536);
    for (let i = 0; i < label.length; i++) area[label[i]]++;
    if (this.before) {
      const steps = step - this.before.step;
      for (const [bubble, n] of this.before.sides) {
        // One that is gone shrank for only part of the time.
        if (!area[bubble]) continue;
        const rate = ((area[bubble] - this.before.area[bubble]) / steps) * 100;
        this.rate[Math.min(n, MOST_SIDES)] += rate;
        this.count[Math.min(n, MOST_SIDES)]++;
        this.fit.add(n - 6, rate);
      }
    }
    this.before = { step, area, sides };
  }

  /** k and c of rate = k·(n − 6) + c, fitted over every bubble looked at. */
  law(): { k: number; c: number; samples: number } {
    return { k: this.fit.slope(), c: this.fit.intercept(), samples: this.fit.n };
  }
}

/** A straight line fitted by least squares. */
class Fit {
  n = 0;
  private x = 0;
  private y = 0;
  private xx = 0;
  private xy = 0;

  add(x: number, y: number): void {
    this.n++;
    this.x += x;
    this.y += y;
    this.xx += x * x;
    this.xy += x * y;
  }

  slope(): number {
    const d = this.n * this.xx - this.x * this.x;
    return d > 0 ? (this.n * this.xy - this.x * this.y) / d : NaN;
  }

  intercept(): number {
    return this.n ? (this.y - this.slope() * this.x) / this.n : NaN;
  }
}

const INK = '#8a91a0';
const BAR = '#4dd0e1';
const IDEAL = '#e0c068';

/** Three small charts: the sides of the bubbles, the angles at junctions, and von Neumann's law. */
export function drawMeasures(canvas: HTMLCanvasElement, m: Measures, seepage: Seepage, seeping: boolean): void {
  const scale = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * scale)) canvas.width = Math.round(width * scale);
  if (canvas.height !== Math.round(height * scale)) canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const panel = height / 3;
  const plot = { left: 4, right: width - 4, top: 30, bottom: panel - 14 };

  const fmt = (v: number, digits: number) => (Number.isFinite(v) ? v.toFixed(digits) : '–');
  const text = (s: string, x: number, y: number, colour = INK, align: CanvasTextAlign = 'left') => {
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.fillText(s, x, y);
  };

  // Sides: the bars, and over them the mean sides of the neighbours.
  {
    const y0 = 0;
    const count = m.sides.size;
    text(`Sides: ${count} closed bubbles, ⟨n⟩ = ${fmt(m.meanSides, 2)}, μ₂ = ${fmt(m.mu2, 2)}`, 0, y0);
    text(`neighbours m(n) in gold; Aboav–Weaire a = ${fmt(m.aboav, 2)}`, 0, y0 + 13);
    const from = 2;
    const bars = MOST_SIDES - from + 1;
    const w = (plot.right - plot.left) / bars;
    const most = Math.max(1, ...m.histogram);
    for (let n = from; n <= MOST_SIDES; n++) {
      const x = plot.left + (n - from) * w;
      const h = (m.histogram[n] / most) * (plot.bottom - plot.top);
      ctx.fillStyle = n === 6 ? '#7fe3ef' : BAR;
      ctx.fillRect(x + 2, y0 + plot.bottom - h, w - 4, h);
      text(n === MOST_SIDES ? `${n}+` : `${n}`, x + w / 2, y0 + plot.bottom + 2, INK, 'center');
      const mn = m.neighbours[n];
      if (Number.isFinite(mn)) {
        // m(n) on a scale from 4 to 9 sides.
        const y = y0 + plot.bottom - ((mn - 4) / 5) * (plot.bottom - plot.top);
        ctx.fillStyle = IDEAL;
        ctx.fillRect(x + w / 2 - 2.5, y - 2.5, 5, 5);
      }
    }
  }

  // Angles at junctions of three films, with 120° marked.
  {
    const y0 = panel;
    text(`Angles at ${m.junctions} junctions, taken ${ARM} cells out:`, 0, y0);
    text(`off 120° by ${fmt(m.angleSpread, 1)}° rms, ${fmt(m.angleNear * 100, 0)}% within 10°`, 0, y0 + 13);
    const first = 60 / ANGLE_BIN;
    const last = 180 / ANGLE_BIN - 1;
    const w = (plot.right - plot.left) / (last - first + 1);
    const most = Math.max(1, ...m.angles);
    for (let b = first; b <= last; b++) {
      const x = plot.left + (b - first) * w;
      const h = (m.angles[b] / most) * (plot.bottom - plot.top);
      ctx.fillStyle = BAR;
      ctx.fillRect(x + 0.5, y0 + plot.bottom - h, w - 1, h);
    }
    for (const degrees of [60, 90, 120, 150, 180]) {
      const x = plot.left + ((degrees / ANGLE_BIN - first) / (last - first + 1)) * (plot.right - plot.left);
      if (degrees === 120) {
        ctx.fillStyle = IDEAL;
        ctx.fillRect(x - 0.5, y0 + plot.top, 1, plot.bottom - plot.top);
      }
      text(`${degrees}°`, Math.min(plot.right - 10, Math.max(plot.left + 8, x)), y0 + plot.bottom + 2, INK, 'center');
    }
  }

  // Von Neumann: the mean rate by sides, with the fitted line.
  {
    const y0 = 2 * panel;
    const { k, c, samples } = seepage.law();
    text(`Von Neumann dA/dt = k(n − 6) + c, per 100 steps:`, 0, y0);
    text(
      seeping ? `k = ${fmt(k, 2)}, c = ${fmt(c, 2)} cells, ${samples} looks` : 'needs gas seeping through the films',
      0,
      y0 + 13,
      seeping ? INK : IDEAL,
    );
    const from = 2;
    const columns = MOST_SIDES - from + 1;
    const w = (plot.right - plot.left) / columns;
    const means = seepage.rate.map((r, n) => (seepage.count[n] ? r / seepage.count[n] : NaN));
    const reach = Math.max(1, ...means.filter(Number.isFinite).map(Math.abs));
    const mid = y0 + (plot.top + plot.bottom) / 2;
    const half = (plot.bottom - plot.top) / 2;
    const yOf = (rate: number) => mid - (rate / reach) * half;
    ctx.fillStyle = '#2a2f3a';
    ctx.fillRect(plot.left, mid - 0.5, plot.right - plot.left, 1);
    if (seepage.law().samples) text(`±${Math.round(reach)}`, plot.right, y0 + plot.top, INK, 'right');
    if (seeping && Number.isFinite(k)) {
      ctx.strokeStyle = IDEAL;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const n of [from, MOST_SIDES]) {
        const x = plot.left + (n - from + 0.5) * w;
        const y = Math.max(y0 + plot.top - 6, Math.min(y0 + plot.bottom + 6, yOf(k * (n - 6) + c)));
        if (n === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let n = from; n <= MOST_SIDES; n++) {
      const x = plot.left + (n - from + 0.5) * w;
      if (Number.isFinite(means[n])) {
        ctx.fillStyle = BAR;
        ctx.beginPath();
        ctx.arc(x, yOf(means[n]), 3, 0, 2 * Math.PI);
        ctx.fill();
      }
      text(n === MOST_SIDES ? `${n}+` : `${n}`, x, y0 + plot.bottom + 2, INK, 'center');
    }
  }
}
