import { VOXEL_HUE } from './clusters3.ts';
import { createProgram, createTexture, type Renderer } from './renderer.ts';
import { LINES, type Params3 } from './sim3.ts';

/** Same fractions of the field size as in the version on the CPU. */
const SLACK = 1 / 16;
const YOUTH_MARGIN = 1 / 8;
/** The age has 7 bits in the state. */
const AGE_CAP = 127;
/** How often the state is read back to count clusters and volume, in steps. */
const MEASURE_EVERY = 32;

/** An offset component of a cell that has not heard of any stone yet. */
const UNKNOWN = 32767;
const LABEL_MASK = 0xffffff;
const PHASE_BIT = 1 << 24;
const STONE_BIT = 1 << 25;

/**
 * The state of a cell is two texels.
 *   A, four 16-bit integers: the offset to the nearest stone, then the depth
 *   in the low 8 bits and the age in the 7 above them.
 *   B, one 32-bit integer: the label in the low 24 bits, then a bit for
 *   inside and a bit for stone.
 * B alone is what the line rule and the picture read.
 */
const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler3D;
precision highp usampler3D;

uniform usampler3D uB;
uniform int uSize;
uniform int uLayer;

const uint LABEL = ${LABEL_MASK}u;
const uint PHASE = ${PHASE_BIT}u;
const uint STONE = ${STONE_BIT}u;

bool inField(ivec3 p) {
  return all(greaterThanEqual(p, ivec3(0))) && all(lessThan(p, ivec3(uSize)));
}

// What a cell shows of itself to its neighbours: its label when it is inside.
uint tagAt(ivec3 p) {
  uint b = texelFetch(uB, p, 0).r;
  return (b & PHASE) != 0u ? b & LABEL : 0u;
}
`;

const STEP_FRAGMENT = `${HEADER}
uniform isampler3D uA;
uniform int uCore2;
uniform int uDeep;
uniform int uPad2;
uniform int uFat2;
uniform int uOld;
uniform float uThreshold;
uniform float uNoise;
uniform uint uSeed;
uniform int uReach[${LINES.length}];

layout(location = 0) out ivec4 outA;
layout(location = 1) out uint outB;

const int FAR = 0x7fffffff;
const int UNKNOWN = ${UNKNOWN};
const ivec3 LINES[${LINES.length}] = ivec3[${LINES.length}](
  ${LINES.map((l) => `ivec3(${l.dx}, ${l.dy}, ${l.dz})`).join(',\n  ')}
);

int dist2(ivec4 a) {
  return a.x == UNKNOWN ? FAR : a.x * a.x + a.y * a.y + a.z * a.z;
}

// A random number in 0..1 of the cell's own on this step.
float random(ivec3 c) {
  uint h = uint(c.x) * 0x9e3779b1u ^ uint(c.y) * 0x85ebca6bu ^ uint(c.z) * 0xc2b2ae35u;
  h ^= uSeed * 0x27d4eb2fu;
  h ^= h >> 15;
  h *= 0x2c1b3c6du;
  h ^= h >> 12;
  h *= 0x297a2d39u;
  h ^= h >> 15;
  return float(h >> 8) / 16777216.0;
}

// Line majority among the cells of the same label: inside when, along at
// least one line through the cell, most cells within reach are inside and
// hold its label. Beyond the field is outside.
bool lineRule(ivec3 c, uint own, bool inside) {
  float threshold = uThreshold + (random(c) - 0.5) * uNoise;
  for (int l = 0; l < ${LINES.length}; l++) {
    ivec3 d = LINES[l];
    int reach = uReach[l];
    int total = inside ? 1 : 0;
    for (int k = 1; k <= reach; k++) {
      ivec3 p = c + d * k;
      if (!inField(p)) break;
      if (tagAt(p) == own) total++;
    }
    for (int k = 1; k <= reach; k++) {
      ivec3 p = c - d * k;
      if (!inField(p)) break;
      if (tagAt(p) == own) total++;
    }
    if (float(total) > float(2 * reach + 1) * threshold) return true;
  }
  return false;
}

void main() {
  ivec3 c = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  ivec4 a = texelFetch(uA, c, 0);
  uint b = texelFetch(uB, c, 0).r;
  int here = dist2(a);
  int depth = a.w & 255;
  int age = (a.w >> 8) & ${AGE_CAP};
  uint own = b & LABEL;
  bool inside = (b & PHASE) != 0u;
  bool stone = (b & STONE) != 0u;
  bool grown = here <= uCore2;
  bool core = stone || (grown && depth >= uDeep);

  int shallow = grown ? 255 : 0;
  int best = here;
  ivec3 offset = a.xyz;
  uint low = own;
  uint heard = own;
  int young = age < uOld ? age + 1 : uOld;
  int sides = 0;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 d = ivec3(dx, dy, dz);
        if (d == ivec3(0)) continue;
        ivec3 p = c + d;
        if (!inField(p)) continue;
        ivec4 na = texelFetch(uA, p, 0);
        uint nb = texelFetch(uB, p, 0).r;
        int there = dist2(na);
        if (there != FAR) {
          ivec3 o = na.xyz + d;
          int through = o.x * o.x + o.y * o.y + o.z * o.z;
          if (through < best) {
            best = through;
            offset = o;
            heard = nb & LABEL;
          }
        }
        int cost = 2 + abs(dx) + abs(dy) + abs(dz);
        int ndepth = na.w & 255;
        uint nlabel = nb & LABEL;
        if (grown && ndepth + cost < shallow) shallow = ndepth + cost;
        if (core && nlabel < low && ((nb & STONE) != 0u || (there <= uCore2 && ndepth >= uDeep))) {
          low = nlabel;
        }
        int nage = (na.w >> 8) & ${AGE_CAP};
        if (nlabel == own && nage + 1 < young) young = nage + 1;
        if (cost == 3 && nlabel == own && (nb & PHASE) != 0u) sides++;
      }
    }
  }
  // The label comes with the stone: whoever tells of a nearer one is believed
  // about its label too.
  if (best != here) low = heard;
  else if (!core && here != FAR) {
    ivec3 p = c + sign(a.xyz);
    if (texelFetch(uA, p, 0).x != UNKNOWN) low = texelFetch(uB, p, 0).r & LABEL;
  }
  if (low != own) young = 0;

  bool next;
  if (here <= uPad2 || (age < uOld && here <= uFat2)) next = true;
  // Only cells on the front can change.
  else if (sides == (inside ? 6 : 0)) next = inside;
  else next = lineRule(c, own, inside);

  outA = ivec4(offset, shallow | (young << 8));
  outB = low | (next ? PHASE : 0u) | (b & STONE);
}`;

/** Copies the state, turning every cell that has become a stone into one. */
const ADD_FRAGMENT = `${HEADER}
precision highp sampler3D;
uniform isampler3D uA;
uniform sampler3D uStones;

layout(location = 0) out ivec4 outA;
layout(location = 1) out uint outB;

void main() {
  ivec3 c = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint b = texelFetch(uB, c, 0).r;
  if (texelFetch(uStones, c, 0).r > 0.0 && (b & STONE) == 0u) {
    outA = ivec4(0);
    outB = uint((c.z * uSize + c.y) * uSize + c.x + 1) | PHASE | STONE;
  } else {
    outA = texelFetch(uA, c, 0);
    outB = b;
  }
}`;

/** Turns the state into what the renderer draws; see Clusters3.classify. */
const SHOW_FRAGMENT = `${HEADER}
layout(location = 0) out uint outVoxel;
layout(location = 1) out vec4 outPhase;
layout(location = 2) out uint outTint;

uint hue(uint label) {
  return ${VOXEL_HUE}u + ((label * 0x9e3779b1u) >> 8) % ${256 - VOXEL_HUE}u;
}

bool open(ivec3 p, uint own) {
  return !inField(p) || tagAt(p) != own;
}

void main() {
  ivec3 c = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint b = texelFetch(uB, c, 0).r;
  uint own = b & LABEL;
  bool inside = (b & PHASE) != 0u;
  // The free inside cells that touch anything that is not their own inside.
  bool exposed = inside && (
    open(c - ivec3(1, 0, 0), own) || open(c + ivec3(1, 0, 0), own) ||
    open(c - ivec3(0, 1, 0), own) || open(c + ivec3(0, 1, 0), own) ||
    open(c - ivec3(0, 0, 1), own) || open(c + ivec3(0, 0, 1), own));
  outVoxel = (b & STONE) != 0u ? 2u : exposed ? hue(own) : 0u;
  outPhase = vec4(inside ? 1.0 / 255.0 : 0.0);
  outTint = inside ? hue(own) : 0u;
}`;

/**
 * The clusters automaton of `Clusters3`, with the state kept in 3D textures
 * and the rule applied by a fragment shader: one pass over the field per
 * step, a layer at a time. The rule is the same; see `Clusters3` for it.
 * The picture is made on the GPU as well, so the state never leaves it apart
 * from a readback now and then to count the clusters and the volume.
 */
export class Clusters3Gpu {
  readonly n: number;
  steps = 0;
  /** True until the labels are seen not to change between two readbacks. */
  settling = true;
  /** Number of clusters and inside cells, as of the last readback. */
  clusters = 0;
  volume = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly renderer: Renderer;
  private readonly stones: Uint8Array;
  private readonly stepProgram: WebGLProgram;
  private readonly showProgram: WebGLProgram;
  private readonly addProgram: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private a: WebGLTexture;
  private b: WebGLTexture;
  private nextA: WebGLTexture;
  private nextB: WebGLTexture;
  private readonly stepTarget: WebGLFramebuffer;
  private readonly showTarget: WebGLFramebuffer;
  private readonly readTarget: WebGLFramebuffer;
  private readonly reaches = new Int32Array(LINES.length);
  private core2 = 1;
  private deep = 0;
  private pad2 = 0;
  private fat2 = 1;
  private old = 1;
  private measureEvery = MEASURE_EVERY;
  private checksum = 0;
  private shown = -1;

  /**
   * Shares the renderer's context; `stones` is read on every restart. Call
   * `restart` before the first step.
   */
  constructor(renderer: Renderer, n: number, stones: Uint8Array) {
    const gl = renderer.gl;
    this.gl = gl;
    this.renderer = renderer;
    this.n = n;
    this.stones = stones;
    this.stepProgram = createProgram(gl, STEP_FRAGMENT);
    this.showProgram = createProgram(gl, SHOW_FRAGMENT);
    this.addProgram = createProgram(gl, ADD_FRAGMENT);
    this.a = createTexture(gl, gl.NEAREST, gl.NEAREST);
    this.b = createTexture(gl, gl.NEAREST, gl.NEAREST);
    this.nextA = createTexture(gl, gl.NEAREST, gl.NEAREST);
    this.nextB = createTexture(gl, gl.NEAREST, gl.NEAREST);
    for (const texture of [this.a, this.nextA]) {
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA16I, n, n, n);
    }
    for (const texture of [this.b, this.nextB]) {
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R32UI, n, n, n);
    }
    this.stepTarget = gl.createFramebuffer()!;
    this.showTarget = gl.createFramebuffer()!;
    this.readTarget = gl.createFramebuffer()!;
  }

  /** The starting state; see Clusters3.restart. */
  restart(reach: number, padding: number, bridge: number): void {
    const { gl, n, stones } = this;
    const r = Math.max(1, Math.round(reach));
    this.padding = padding;
    const fat = r + Math.round(n * SLACK);
    this.core2 = r * r;
    this.deep = bridge > 0 ? Math.min(255, Math.round((3 * (bridge + 1)) / 2)) : 0;
    this.fat2 = fat * fat;
    this.old = Math.min(AGE_CAP, fat + Math.round(n * YOUTH_MARGIN));
    // The labels wait for the depth, so a readback must not come sooner.
    this.measureEvery = Math.max(MEASURE_EVERY, Math.ceil(bridge));

    const a = new Int16Array(stones.length * 4);
    const b = new Uint32Array(stones.length);
    for (let i = 0; i < stones.length; i++) {
      a[4 * i] = stones[i] ? 0 : UNKNOWN;
      b[i] = (i + 1) | (stones[i] ? PHASE_BIT | STONE_BIT : 0);
    }
    gl.bindTexture(gl.TEXTURE_3D, this.a);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RGBA_INTEGER, gl.SHORT, a);
    gl.bindTexture(gl.TEXTURE_3D, this.b);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED_INTEGER, gl.UNSIGNED_INT, b);

    this.steps = 0;
    this.settling = true;
    this.clusters = 0;
    this.volume = 0;
    this.checksum = 0;
    this.shown = -1;
    for (let i = 0; i < stones.length; i++) this.volume += stones[i];
  }

  /**
   * Take in stones added since the last step, without starting over; see
   * Clusters3.addStones. Reads the stones the renderer was last given.
   */
  addStones(): void {
    const { gl } = this;
    const program = this.addProgram;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.renderer.stones);
    gl.uniform1i(this.uniform(program, 'uStones'), 2);
    this.pass(program);
    this.volume = 0;
    for (let i = 0; i < this.stones.length; i++) this.volume += this.stones[i];
    this.settling = true;
    this.checksum = 0;
    this.shown = -1;
  }

  /** How far around a stone its cells are always inside, in cells. */
  set padding(cells: number) {
    this.pad2 = Math.max(0, cells) ** 2;
  }

  /** One synchronous step of the rule on every cell. */
  step(p: Params3): void {
    const { gl } = this;
    const program = this.stepProgram;
    for (let l = 0; l < LINES.length; l++) {
      this.reaches[l] = Math.max(1, Math.round(p.radius / LINES[l].length));
    }
    gl.useProgram(program);
    gl.uniform1i(this.uniform(program, 'uCore2'), this.core2);
    gl.uniform1i(this.uniform(program, 'uDeep'), this.deep);
    gl.uniform1i(this.uniform(program, 'uPad2'), this.pad2);
    gl.uniform1i(this.uniform(program, 'uFat2'), this.fat2);
    gl.uniform1i(this.uniform(program, 'uOld'), this.old);
    gl.uniform1f(this.uniform(program, 'uThreshold'), p.threshold);
    gl.uniform1f(this.uniform(program, 'uNoise'), p.noise);
    gl.uniform1ui(this.uniform(program, 'uSeed'), (Math.random() * 0x100000000) >>> 0);
    gl.uniform1iv(this.uniform(program, 'uReach[0]'), this.reaches);
    this.pass(program);
    this.steps++;
    if (this.steps % this.measureEvery === 0) this.measure();
  }

  /**
   * Run `program`, already in use, over the whole field a layer at a time,
   * from the current state into the spare pair of textures, and swap them.
   */
  private pass(program: WebGLProgram): void {
    const { gl, n } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stepTarget);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, n, n);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.b);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.a);
    gl.uniform1i(this.uniform(program, 'uA'), 0);
    gl.uniform1i(this.uniform(program, 'uB'), 1);
    gl.uniform1i(this.uniform(program, 'uSize'), n);
    const layer = this.uniform(program, 'uLayer');
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.nextA, 0, z);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, this.nextB, 0, z);
      gl.uniform1i(layer, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    [this.a, this.nextA] = [this.nextA, this.a];
    [this.b, this.nextB] = [this.nextB, this.b];
  }

  /**
   * Fill the renderer's textures with the current state: voxel classes for
   * the cube view, the inside cells and their hues for the smooth one.
   */
  show(smooth: boolean): void {
    const { gl, n } = this;
    const targets = this.renderer.targets(n);
    if (this.shown !== this.steps) {
      this.shown = this.steps;
      const program = this.showProgram;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.showTarget);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      gl.viewport(0, 0, n, n);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, this.b);
      gl.uniform1i(this.uniform(program, 'uB'), 0);
      gl.uniform1i(this.uniform(program, 'uSize'), n);
      const layer = this.uniform(program, 'uLayer');
      for (let z = 0; z < n; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, targets.voxels, 0, z);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, targets.phase, 0, z);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, targets.tint, 0, z);
        gl.uniform1i(layer, z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    if (smooth) {
      // The coarser mip levels are the blur of the smooth view.
      gl.bindTexture(gl.TEXTURE_3D, targets.phase);
      gl.generateMipmap(gl.TEXTURE_3D);
    }
  }

  /** Free the textures; the object must not be used afterwards. */
  dispose(): void {
    const { gl } = this;
    for (const texture of [this.a, this.b, this.nextA, this.nextB]) gl.deleteTexture(texture);
    for (const target of [this.stepTarget, this.showTarget, this.readTarget]) {
      gl.deleteFramebuffer(target);
    }
    gl.deleteProgram(this.stepProgram);
    gl.deleteProgram(this.showProgram);
    gl.deleteProgram(this.addProgram);
  }

  /**
   * Not part of the rule: read the labels back to count the clusters and the
   * inside cells, and to see whether the labels have stopped changing.
   */
  private measure(): void {
    const { gl, n, stones } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.readTarget);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.b, 0, 0);
    // A single channel where the browser offers it, four otherwise.
    const single =
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RED_INTEGER &&
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.UNSIGNED_INT;
    const span = single ? 1 : 4;
    const layer = new Uint32Array(n * n * span);
    const labels = new Set<number>();
    let volume = 0;
    let checksum = 0;
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.b, 0, z);
      gl.readPixels(0, 0, n, n, single ? gl.RED_INTEGER : gl.RGBA_INTEGER, gl.UNSIGNED_INT, layer);
      const base = z * n * n;
      for (let i = 0; i < n * n; i++) {
        const cell = layer[i * span];
        const label = cell & LABEL_MASK;
        if (cell & PHASE_BIT) volume++;
        if (stones[base + i]) labels.add(label);
        checksum = (Math.imul(checksum, 0x01000193) ^ label) | 0;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.volume = volume;
    this.clusters = labels.size;
    if (checksum === this.checksum) this.settling = false;
    this.checksum = checksum;
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    const programs = [this.stepProgram, this.showProgram, this.addProgram];
    const key = `${programs.indexOf(program)}:${name}`;
    let location = this.uniforms.get(key);
    if (location === undefined) {
      location = this.gl.getUniformLocation(program, name);
      this.uniforms.set(key, location);
    }
    return location;
  }
}
