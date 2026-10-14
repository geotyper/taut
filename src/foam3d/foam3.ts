import { createProgram, createTexture, type Renderer } from '../3d/renderer.ts';

/** A cell that belongs to no bubble. */
const AIR = 0;
const FIRST_BUBBLE = 1;
/** Outside a glass sphere: never changes and is never counted. */
const WALL = 0xffffffff;

/**
 * Air against a bubble while the sphere fills up; see AIR_WEIGHT of the 2D
 * foam. Much lower than its 0.6: in 3D a cell just outside a flat front sees
 * only about 0.3 of its ball inside, and next to a small bubble 0.2, so with
 * 0.6 bubbles in the open did not grow at all; in a glass sphere they only
 * crept along its wall, where the ball is cut short.
 */
const GROWING_AIR_WEIGHT = 0.2;
const PRESSURE_GAIN = 4;
/**
 * How far a bubble short of its volume may push, and one over it give way.
 * Pushing reaches further than in 2D: on a small ball the curvature takes a
 * larger share of the count, and with the 2D limit of a half, bubbles of a
 * few cells across were pulled in right after the sphere filled.
 */
const PUSH_LIMIT = 2;
const YIELD_LIMIT = 0.5;
/** Bubble weights and volumes live in square textures, one texel a label. */
const SIDE = 256;
const MAX_LABEL = SIDE * SIDE - 1;
/**
 * Steps between two counts of the volumes. Every step: with four, as in the
 * 2D foam, small bubbles still collapsed between two counts.
 */
const COUNT_EVERY = 1;
/**
 * The growth counts as over when the bubbles have not gained a cell in this
 * many steps. In the open the outer bubbles round off before they reach the
 * sphere, so a little air stays in it for good.
 */
const STALL_STEPS = 12;
/** How much of the edges drawn last frame stays in the next. */
const EDGE_KEEP = 0.6;
/** The sphere's radius, in field sizes. */
const SPHERE = 0.44;

export interface Foam3Params {
  /** Radius of the ball a cell counts labels in, in cells. */
  radius: number;
  /** Random part of every count, as a share of the ball. */
  noise: number;
  /** Bubbles hold on to the volume they had when the sphere filled up. */
  keepVolume: boolean;
}

/**
 * 'glass': the sphere is a wall and the foam fills it. 'free': the foam is a
 * cluster in the open, grown to fill the sphere and then let go, so the
 * outer bubbles bulge into the air.
 */
export type Enclosure = 'glass' | 'free';

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;
uniform usampler3D uLabel;
uniform int uSize;
uniform float uSphere2;

const uint AIR = ${AIR}u;
const uint WALL = ${WALL}u;

bool inSphere(ivec3 c) {
  vec3 d = vec3(c) + 0.5 - float(uSize) * 0.5;
  return dot(d, d) <= uSphere2;
}

bool inField(ivec3 c) {
  return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, ivec3(uSize)));
}
`;

// The rule of the 2D foam (src/foam/foam.ts) with a ball in place of the disc.
const STEP = `${COMMON}
uniform sampler2D uWeight;
uniform int uLayer;
uniform int uRadius;
uniform float uJitter;
uniform float uAirWeight;
uniform bool uFree;
uniform bool uFilled;
uniform uint uSeed;
out uint outLabel;

const int KINDS = 8;

float random(uvec3 cell, uint k) {
  uint h = cell.x * 1597334677u ^ cell.y * 3812015801u ^ cell.z * 2246822519u ^ (uSeed * 9u + k) * 2654435761u;
  h ^= h >> 16;
  h *= 0x7feb352du;
  h ^= h >> 15;
  h *= 0x846ca68bu;
  h ^= h >> 16;
  return float(h >> 8) / 16777216.0;
}

void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint here = texelFetch(uLabel, cell, 0).r;
  // A free cluster may leave the sphere only once it has filled it.
  if (here == WALL || (uFree && !uFilled && !inSphere(cell))) {
    outLabel = here;
    return;
  }

  // The labels a cell may take are those in its 3x3x3 block, eight at most.
  uint seen[KINDS];
  float count[KINDS];
  int kinds = 1;
  seen[0] = here;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 at = cell + ivec3(dx, dy, dz);
        if (!inField(at)) continue;
        uint other = texelFetch(uLabel, at, 0).r;
        if (other == WALL) continue;
        bool known = false;
        for (int k = 0; k < kinds; k++) known = known || seen[k] == other;
        if (!known && kinds < KINDS) seen[kinds++] = other;
      }
    }
  }
  if (kinds == 1) {
    outLabel = here;
    return;
  }

  for (int k = 0; k < KINDS; k++) count[k] = 0.0;
  int reach = uRadius * uRadius + uRadius;
  for (int dz = -uRadius; dz <= uRadius; dz++) {
    for (int dy = -uRadius; dy <= uRadius; dy++) {
      for (int dx = -uRadius; dx <= uRadius; dx++) {
        if (dx * dx + dy * dy + dz * dz > reach) continue;
        ivec3 at = cell + ivec3(dx, dy, dz);
        // Neither the faces of the field nor a glass wall are counted.
        if (!inField(at)) continue;
        uint other = texelFetch(uLabel, at, 0).r;
        for (int k = 0; k < kinds; k++) {
          if (seen[k] == other) {
            count[k] += 1.0;
            break;
          }
        }
      }
    }
  }

  uint best = here;
  float bestScore = -1e30;
  for (int k = 0; k < kinds; k++) {
    uint kind = seen[k];
    float weight = kind == AIR
      ? uAirWeight
      : texelFetch(uWeight, ivec2(int(kind % ${SIDE}u), int(kind / ${SIDE}u)), 0).r;
    float score = count[k] * weight + uJitter * (random(uvec3(cell), uint(k)) - 0.5);
    if (score > bestScore) {
      bestScore = score;
      best = kind;
    }
  }
  outLabel = best;
}`;

// One label becomes another everywhere: a film bursts, or a bubble pops.
const RELABEL = `${COMMON}
uniform int uLayer;
uniform uint uFrom;
uniform uint uTo;
out uint outLabel;

void main() {
  uint here = texelFetch(uLabel, ivec3(ivec2(gl_FragCoord.xy), uLayer), 0).r;
  outLabel = here == uFrom ? uTo : here;
}`;

// A point per cell, landing on the texel of its label: added up, the volumes.
const COUNT_VERTEX = `${COMMON}
void main() {
  int n = uSize;
  ivec3 c = ivec3(gl_VertexID % n, (gl_VertexID / n) % n, gl_VertexID / (n * n));
  uint label = texelFetch(uLabel, c, 0).r;
  gl_PointSize = 1.0;
  // Only the air in the sphere is wanted, and the air outside would pile
  // hundreds of thousands of points onto one texel.
  if (label == WALL || (label == AIR && !inSphere(c))) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  vec2 texel = (vec2(float(label % ${SIDE}u), float(label / ${SIDE}u)) + 0.5) / ${SIDE}.0;
  gl_Position = vec4(texel * 2.0 - 1.0, 0.0, 1.0);
}`;

const COUNT_FRAGMENT = `#version 300 es
precision highp float;
out vec4 outCount;
void main() {
  outCount = vec4(1.0);
}`;

// The films for the renderer: a cell next to a cell of another label.
const SHOW = `${COMMON}
precision highp sampler3D;
uniform int uLayer;
uniform sampler3D uPrevEdges;
uniform float uKeep;
layout(location = 0) out uint outVoxel;
layout(location = 1) out float outPhase;
layout(location = 2) out uint outTint;
layout(location = 3) out float outEdge;

void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint here = texelFetch(uLabel, cell, 0).r;
  // Films are drawn on the bubble side only, so the outer ones take the
  // colour of their bubble rather than one colour for the air.
  bool film = false;
  if (here != WALL && here != AIR) {
    for (int a = 0; a < 3; a++) {
      for (int s = -1; s <= 1; s += 2) {
        ivec3 at = cell;
        at[a] += s;
        if (!inField(at)) continue;
        uint other = texelFetch(uLabel, at, 0).r;
        film = film || (other != WALL && other != here);
      }
    }
  }
  // Classes from 3 up are coloured by hue; the films of a bubble share one.
  uint hue = 3u + (here * 2654435761u >> 24) % 253u;
  outVoxel = film ? hue : 0u;
  outPhase = film ? 1.0 : 0.0;
  outTint = film ? hue : 0u;

  // The skeleton of the foam: where three labels meet in the 2x2x2 block
  // from this cell a line runs (a Plateau border), where four meet a point.
  // A larger block would draw them as thick tubes. The glass and the air
  // count as labels too, so the lines also trace where films touch them,
  // and any cell may hold a line, not only one on a film of a bubble.
  uint kinds[4];
  int found = 0;
  {
    for (int dz = 0; dz <= 1; dz++) {
      for (int dy = 0; dy <= 1; dy++) {
        for (int dx = 0; dx <= 1; dx++) {
          ivec3 at = cell + ivec3(dx, dy, dz);
          if (!inField(at)) continue;
          uint other = texelFetch(uLabel, at, 0).r;
          bool known = false;
          for (int k = 0; k < found; k++) known = known || kinds[k] == other;
          if (!known && found < 4) kinds[found++] = other;
        }
      }
    }
  }
  float edge = found >= 4 ? 1.0 : found == 3 ? 0.5 : 0.0;
  // The films tremble by a voxel with the noise of the rule, and the lines
  // with them; kept from frame to frame, they hold still.
  outEdge = mix(edge, texelFetch(uPrevEdges, cell, 0).r, uKeep);
}`;

/**
 * Soap films in a sphere, on the GPU. The labels sit in a pair of 3D integer
 * textures and the rule of the 2D foam runs on every cell at once, a layer at
 * a time. The volumes of the bubbles are added up on the GPU too, a point per
 * cell blended into a small texture, so only that texture comes back.
 */
export class Foam3 {
  readonly n: number;
  steps = 0;
  bubbles = 0;
  /** Cells of air left inside the sphere. */
  air = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly renderer: Renderer;
  private readonly stepProgram: WebGLProgram;
  private readonly relabelProgram: WebGLProgram;
  private readonly countProgram: WebGLProgram;
  private readonly showProgram: WebGLProgram;
  private readonly target: WebGLFramebuffer;
  private readonly countTarget: WebGLFramebuffer;
  private readonly weightTexture: WebGLTexture;
  private readonly countTexture: WebGLTexture;
  private current: WebGLTexture;
  private next: WebGLTexture;
  /** The edges as last drawn, and the pair they are drawn into in turn. */
  private readonly edges: WebGLTexture[];
  private edgeTurn = 0;
  private readonly sphere2: number;

  private enclosure: Enclosure = 'glass';
  /** Labels handed out so far, plus the two that are not bubbles. */
  private labels = FIRST_BUBBLE;
  /** The sphere has filled up since the last edit; sticks until the next. */
  private filled = false;
  private volume = new Float64Array(SIDE * SIDE);
  private targetVolume = new Float64Array(SIDE * SIDE);
  private least = new Float64Array(SIDE * SIDE);
  private readonly weights = new Float32Array(SIDE * SIDE);
  private readonly counted = new Float32Array(SIDE * SIDE * 4);
  private seed = 1;
  private shown = -1;
  /** The most cells the bubbles have held since the last edit, and the steps since that grew. */
  private grown = 0;
  private stalled = 0;
  /** Cells the bubbles hold in all, and what they held when the growth ended. */
  private held = 0;
  private heldTarget = 0;
  private sinceCount = 0;

  constructor(renderer: Renderer, n: number) {
    const gl = renderer.gl;
    if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('EXT_float_blend')) {
      throw new Error('This browser cannot add up floats on the GPU');
    }
    this.gl = gl;
    this.renderer = renderer;
    this.n = n;
    this.sphere2 = (n * SPHERE) ** 2;
    this.stepProgram = createProgram(gl, STEP);
    this.relabelProgram = createProgram(gl, RELABEL);
    this.showProgram = createProgram(gl, SHOW);
    this.countProgram = link(gl, COUNT_VERTEX, COUNT_FRAGMENT);

    this.current = createTexture(gl, gl.NEAREST, gl.NEAREST);
    this.next = createTexture(gl, gl.NEAREST, gl.NEAREST);
    for (const texture of [this.current, this.next]) {
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R32UI, n, n, n);
    }
    this.edges = [0, 1].map(() => {
      const texture = createTexture(gl, gl.LINEAR, gl.LINEAR);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8, n, n, n);
      return texture;
    });
    this.weightTexture = flat(gl, gl.R32F);
    this.countTexture = flat(gl, gl.R32F);
    this.target = gl.createFramebuffer()!;
    this.countTarget = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.countTarget);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.countTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Cannot render into a float texture');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** A new foam: `count` centres scattered in the sphere, each a small ball. */
  scatter(count: number, size: number, enclosure: Enclosure): void {
    const { gl, n } = this;
    this.enclosure = enclosure;
    const labels = new Uint32Array(n * n * n);
    const half = n / 2;
    const r = n * SPHERE;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const d = (x + 0.5 - half) ** 2 + (y + 0.5 - half) ** 2 + (z + 0.5 - half) ** 2;
          labels[(z * n + y) * n + x] = d <= r * r || enclosure === 'free' ? AIR : WALL;
        }
      }
    }
    this.least.fill(0);
    this.targetVolume.fill(0);
    this.labels = FIRST_BUBBLE;
    const apart = (2 * r) / Math.cbrt(Math.max(1, count)) * 0.6;
    const placed: number[][] = [];
    for (let c = 0; c < count && this.labels <= MAX_LABEL; c++) {
      let p = [half, half, half];
      for (let attempt = 0; attempt < 30; attempt++) {
        // A point in the sphere, clear of its wall.
        const room = Math.max(0, r - size);
        do p = [0, 0, 0].map(() => (Math.random() * 2 - 1) * room);
        while (p[0] ** 2 + p[1] ** 2 + p[2] ** 2 > room * room);
        p = p.map((v) => v + half);
        if (placed.every((o) => Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) >= apart)) break;
      }
      placed.push(p);
      const mine = this.labels++;
      const s = Math.ceil(size);
      let cells = 0;
      for (let z = Math.floor(p[2]) - s; z <= Math.floor(p[2]) + s; z++) {
        for (let y = Math.floor(p[1]) - s; y <= Math.floor(p[1]) + s; y++) {
          for (let x = Math.floor(p[0]) - s; x <= Math.floor(p[0]) + s; x++) {
            if (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n) continue;
            const i = (z * n + y) * n + x;
            if (labels[i] === WALL) continue;
            if ((x + 0.5 - p[0]) ** 2 + (y + 0.5 - p[1]) ** 2 + (z + 0.5 - p[2]) ** 2 > size * size) continue;
            labels[i] = mine;
            cells++;
          }
        }
      }
      this.least[mine] = cells;
    }
    gl.bindTexture(gl.TEXTURE_3D, this.current);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED_INTEGER, gl.UNSIGNED_INT, labels);
    this.steps = 0;
    this.restartGrowth();
    this.shown = -1;
    this.count();
  }

  /** Bubbles are still growing into the sphere, so no burst is due and volumes are not yet their own. */
  get growing(): boolean {
    return !this.filled;
  }

  /** Make `steps` steps, counting the volumes every few. */
  step(p: Foam3Params, steps: number): void {
    const { gl } = this;
    const program = this.stepProgram;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uRadius'), p.radius);
    gl.uniform1f(gl.getUniformLocation(program, 'uJitter'), p.noise * (ballCells(p.radius) / 2));
    gl.uniform1i(gl.getUniformLocation(program, 'uFree'), this.enclosure === 'free' ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uWeight'), 1);
    for (let s = 0; s < steps; s++) {
      if (this.sinceCount === 0) this.uploadWeights(p);
      gl.useProgram(program);
      const airWeight = this.airWeight(p);
      gl.uniform1f(gl.getUniformLocation(program, 'uAirWeight'), airWeight);
      gl.uniform1i(gl.getUniformLocation(program, 'uFilled'), this.filled ? 1 : 0);
      gl.uniform1ui(gl.getUniformLocation(program, 'uSeed'), this.seed++);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.weightTexture);
      this.pass(program);
      this.steps++;
      if (++this.sinceCount >= COUNT_EVERY) this.count();
    }
  }

  /**
   * A film bursts and its two bubbles become one. The film is looked for in
   * a few layers read back at random; the larger bubble takes in the other.
   */
  burstFilm(): boolean {
    const { gl, n } = this;
    const layer = new Uint32Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    for (let attempt = 0; attempt < 6; attempt++) {
      const z = Math.floor(n * (0.25 + Math.random() * 0.5));
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.current, 0, z);
      gl.readPixels(0, 0, n, n, gl.RGBA_INTEGER, gl.UNSIGNED_INT, layer);
      const pairs: number[] = [];
      for (let i = 0; i + 1 < n * n; i++) {
        const a = layer[i * 4];
        const b = layer[(i + 1) * 4];
        if (a !== b && a >= FIRST_BUBBLE && b >= FIRST_BUBBLE && a !== WALL && b !== WALL) pairs.push(a, b);
      }
      if (pairs.length === 0) continue;
      const k = Math.floor(Math.random() * (pairs.length / 2)) * 2;
      const [keep, gone] =
        this.volume[pairs[k]] >= this.volume[pairs[k + 1]] ? [pairs[k], pairs[k + 1]] : [pairs[k + 1], pairs[k]];
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.relabel(gone, keep);
      this.targetVolume[keep] += this.targetVolume[gone];
      this.least[keep] += this.least[gone];
      this.targetVolume[gone] = 0;
      this.count();
      return true;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return false;
  }

  /** A bubble chosen at random bursts: its cells turn to air, and the sphere fills again. */
  popAny(): boolean {
    const alive: number[] = [];
    for (let l = FIRST_BUBBLE; l < this.labels; l++) if (this.volume[l] > 0) alive.push(l);
    if (alive.length === 0) return false;
    this.relabel(alive[Math.floor(Math.random() * alive.length)], AIR);
    this.restartGrowth();
    this.targetVolume.fill(0);
    this.count();
    return true;
  }

  /** All the labels, read back from the GPU (n*n*n, x fastest). Slow; not for every frame. */
  readLabels(): Uint32Array {
    const { gl, n } = this;
    const labels = new Uint32Array(n * n * n);
    const layer = new Uint32Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.current, 0, z);
      gl.readPixels(0, 0, n, n, gl.RGBA_INTEGER, gl.UNSIGNED_INT, layer);
      const base = z * n * n;
      for (let i = 0; i < n * n; i++) labels[base + i] = layer[i * 4];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return labels;
  }

  /** Fill the renderer's textures with the films. */
  show(smooth: boolean): void {
    const { gl, n } = this;
    const targets = this.renderer.targets(n);
    if (this.shown !== this.steps) {
      this.shown = this.steps;
      const program = this.showProgram;
      gl.useProgram(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
      gl.viewport(0, 0, n, n);
      this.bindLabels(program);
      const [previous, edges] = [this.edges[this.edgeTurn], this.edges[1 - this.edgeTurn]];
      this.edgeTurn = 1 - this.edgeTurn;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, previous);
      gl.uniform1i(gl.getUniformLocation(program, 'uPrevEdges'), 1);
      gl.uniform1f(gl.getUniformLocation(program, 'uKeep'), EDGE_KEEP);
      this.renderer.setEdges(edges);
      const layer = gl.getUniformLocation(program, 'uLayer');
      for (let z = 0; z < n; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, targets.voxels, 0, z);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, targets.phase, 0, z);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, targets.tint, 0, z);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, edges, 0, z);
        gl.uniform1i(layer, z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, null, 0, 0);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, null, 0, 0);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, null, 0, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    if (smooth) {
      gl.bindTexture(gl.TEXTURE_3D, targets.phase);
      gl.generateMipmap(gl.TEXTURE_3D);
    }
  }

  dispose(): void {
    const { gl } = this;
    this.renderer.setEdges(null);
    for (const texture of [this.current, this.next, this.weightTexture, this.countTexture, ...this.edges]) {
      gl.deleteTexture(texture);
    }
    gl.deleteFramebuffer(this.target);
    gl.deleteFramebuffer(this.countTarget);
    for (const program of [this.stepProgram, this.relabelProgram, this.countProgram, this.showProgram]) {
      gl.deleteProgram(program);
    }
  }

  /**
   * How much a cell of air counts for. While the bubbles grow, little. In the
   * open, once they have grown, air is a phase like any other; but when the
   * bubbles do not keep their own volumes, the gas seeps from bubble to
   * bubble and not out of the cluster, so the air gives way or pushes as the
   * whole cluster is short of its volume or over it.
   */
  private airWeight(p: Foam3Params): number {
    if (this.enclosure !== 'free' || !this.filled) return GROWING_AIR_WEIGHT;
    if (p.keepVolume || this.heldTarget === 0) return 1;
    const lack = (PRESSURE_GAIN * (this.heldTarget - this.held)) / this.heldTarget;
    return 1 - Math.max(-YIELD_LIMIT, Math.min(YIELD_LIMIT, lack));
  }

  /** How much a cell of a bubble counts for; see Foam.weightOf. */
  private weightOf(label: number, keepVolume: boolean): number {
    const hold = this.filled ? this.targetVolume[label] : this.least[label];
    if (!keepVolume || !(hold > 0)) return 1;
    let lack = (PRESSURE_GAIN * (hold - this.volume[label])) / hold;
    if (!this.filled) lack = Math.max(0, lack);
    return 1 + Math.max(-YIELD_LIMIT, Math.min(PUSH_LIMIT, lack));
  }

  private uploadWeights(p: Foam3Params): void {
    const { gl } = this;
    for (let l = 0; l < this.labels; l++) this.weights[l] = this.weightOf(l, p.keepVolume);
    gl.bindTexture(gl.TEXTURE_2D, this.weightTexture);
    const rows = Math.ceil(this.labels / SIDE);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIDE, rows, gl.RED, gl.FLOAT, this.weights);
  }

  /** Add up the volumes on the GPU and read them back. */
  private count(): void {
    const { gl, n } = this;
    this.sinceCount = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.countTarget);
    gl.viewport(0, 0, SIDE, SIDE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.countProgram);
    this.bindLabels(this.countProgram);
    gl.drawArrays(gl.POINTS, 0, n * n * n);
    gl.disable(gl.BLEND);
    const rows = Math.ceil(this.labels / SIDE);
    gl.readPixels(0, 0, SIDE, rows, gl.RGBA, gl.FLOAT, this.counted);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.bubbles = 0;
    let held = 0;
    for (let l = 0; l < this.labels; l++) {
      this.volume[l] = this.counted[l * 4];
      if (l >= FIRST_BUBBLE && this.volume[l] > 0) this.bubbles++;
      if (l >= FIRST_BUBBLE) held += this.volume[l];
    }
    this.air = this.volume[AIR];
    this.held = held;
    if (held > this.grown) {
      this.grown = held;
      this.stalled = 0;
    } else this.stalled++;
    // The moment the sphere fills up, or the growth stops short of that,
    // every bubble takes its volume as its own.
    if (!this.filled && (this.air === 0 || this.stalled >= STALL_STEPS)) {
      this.filled = true;
      this.heldTarget = held;
      for (let l = 0; l < this.labels; l++) this.targetVolume[l] = Math.max(this.volume[l], this.least[l]);
    }
  }

  private restartGrowth(): void {
    this.filled = false;
    this.grown = 0;
    this.stalled = 0;
  }

  private relabel(from: number, to: number): void {
    const { gl } = this;
    const program = this.relabelProgram;
    gl.useProgram(program);
    gl.uniform1ui(gl.getUniformLocation(program, 'uFrom'), from);
    gl.uniform1ui(gl.getUniformLocation(program, 'uTo'), to);
    this.pass(program);
    this.shown = -1;
  }

  /** Run `program`, already in use, on every layer into the spare texture, and swap. */
  private pass(program: WebGLProgram): void {
    const { gl, n } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, n, n);
    this.bindLabels(program);
    const layer = gl.getUniformLocation(program, 'uLayer');
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.next, 0, z);
      gl.uniform1i(layer, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    [this.current, this.next] = [this.next, this.current];
  }

  private bindLabels(program: WebGLProgram): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.current);
    gl.uniform1i(gl.getUniformLocation(program, 'uLabel'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uSize'), this.n);
    gl.uniform1f(gl.getUniformLocation(program, 'uSphere2'), this.sphere2);
  }
}

/** Cells in the ball of the rule. */
function ballCells(radius: number): number {
  let cells = 0;
  const reach = radius * radius + radius;
  for (let z = -radius; z <= radius; z++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) if (x * x + y * y + z * z <= reach) cells++;
    }
  }
  return cells;
}

/** A SIDE x SIDE 2D texture of one channel, read texel by texel. */
function flat(gl: WebGL2RenderingContext, format: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, SIDE, SIDE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return texture;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}
