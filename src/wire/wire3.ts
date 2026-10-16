import { createProgram, createTexture, type Renderer } from '../3d/renderer.ts';
import { fanTriangles, WALL, type Frame, type FrameField } from './frames.ts';

/** Faces a frame may have: two RGBA textures of solid angles. */
export const MOST_FACES = 8;
/** Labels with a weight of their own: 0, the chambers and a trapped bubble. */
const LABELS = MOST_FACES + 2;
/** How hard a trapped bubble short of its volume pushes, as in the foam. */
const PRESSURE_GAIN = 4;
const PUSH_LIMIT = 2;
const YIELD_LIMIT = 0.5;
/** Without a bubble to hold, the volumes are counted only this often, for the page to watch. */
const COUNT_EVERY = 8;

export interface Wire3Params {
  radius: number;
  noise: number;
  /**
   * A breeze, in gusts from a slowly turning direction: a cell counts its
   * neighbours upwind a little more and those downwind a little less, so a
   * film is pushed downwind and bulges against its own tension. It only
   * compares labels as the cell sees them, through the cuts, so the cuts
   * stay unseen. The most a neighbour one cell away gains or loses.
   */
  breeze: number;
}

/** Steps a gust takes to come and go, and the breeze's direction to turn once. */
const GUST_PERIOD = 300;
const TURN_PERIOD = 1100;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler3D;
uniform usampler3D uLabel;
uniform sampler3D uOmega0;
uniform sampler3D uOmega1;
uniform usampler3D uNear;
uniform int uSize;
uniform int uFaces;
uniform uint uChamber[${MOST_FACES}];
// 1 when the field wraps round on every side, as for the gyroid.
uniform int uWrap;

const uint WALL = ${WALL}u;
const float FOUR_PI = 12.566370614359172;

bool inField(ivec3 c) {
  return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, ivec3(uSize)));
}

// A neighbour in the field, wrapped round when the field is periodic.
bool fieldCell(inout ivec3 c) {
  if (uWrap == 1) {
    c = (c + uSize) % uSize;
    return true;
  }
  return inField(c);
}

// The label a cell sees at a neighbour: swapped with 0 by every cut crossed
// an odd number of times on the way, read from the jump in solid angle.
uint through(uint other, ivec3 at, uint near, vec4 h0, vec4 h1) {
  if (near == 0u || other == WALL) return other;
  vec4 a0 = texelFetch(uOmega0, at, 0);
  vec4 a1 = uFaces > 4 ? texelFetch(uOmega1, at, 0) : vec4(0.0);
  for (int k = 0; k < ${MOST_FACES}; k++) {
    if (k >= uFaces) break;
    if ((near & (1u << uint(k))) == 0u) continue;
    float d = k < 4 ? abs(h0[k] - a0[k]) : abs(h1[k - 4] - a1[k - 4]);
    int crossings = int(floor(d / FOUR_PI + 0.5));
    if ((crossings & 1) == 1) {
      uint chamber = uChamber[k];
      other = other == 0u ? chamber : other == chamber ? 0u : other;
    }
  }
  return other;
}
`;

// The rule of the 3D foam (src/foam3d/foam3.ts), reading through the cuts.
const STEP = `${COMMON}
uniform int uLayer;
uniform int uRadius;
uniform float uJitter;
uniform float uWeight[${LABELS}];
uniform vec3 uWind;
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
  if (here == WALL) {
    outLabel = here;
    return;
  }
  uint near = texelFetch(uNear, cell, 0).r;
  vec4 h0 = texelFetch(uOmega0, cell, 0);
  vec4 h1 = uFaces > 4 ? texelFetch(uOmega1, cell, 0) : vec4(0.0);

  uint seen[KINDS];
  float count[KINDS];
  int kinds = 1;
  seen[0] = here;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 at = cell + ivec3(dx, dy, dz);
        if (!fieldCell(at)) continue;
        uint other = texelFetch(uLabel, at, 0).r;
        if (other == WALL) continue;
        other = through(other, at, near, h0, h1);
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
        if (!fieldCell(at)) continue;
        uint other = texelFetch(uLabel, at, 0).r;
        // The wire is not counted, as the glass of the foam is not.
        if (other == WALL) continue;
        other = through(other, at, near, h0, h1);
        // Upwind, against the breeze, a neighbour counts more.
        float weight = 1.0 - dot(vec3(dx, dy, dz), uWind);
        for (int k = 0; k < kinds; k++) {
          if (seen[k] == other) {
            count[k] += weight;
            break;
          }
        }
      }
    }
  }

  uint best = here;
  float bestScore = -1e30;
  for (int k = 0; k < kinds; k++) {
    float weight = uWeight[min(int(seen[k]), ${LABELS - 1})];
    float score = count[k] * weight + uJitter * (random(uvec3(cell), uint(k)) - 0.5);
    if (score > bestScore) {
      bestScore = score;
      best = seen[k];
    }
  }
  outLabel = best;
}`;

// The films for the renderer. A film lies between two cells that disagree,
// seen through the cuts; each is drawn on the lower of its two cells, so
// once. The wire is drawn as stone.
const SHOW = `${COMMON}
uniform int uLayer;
layout(location = 0) out uint outVoxel;
layout(location = 1) out float outPhase;
layout(location = 2) out uint outTint;
// The wire, for the soap colours: a film thickens into a meniscus along it.
layout(location = 3) out float outEdge;

void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint here = texelFetch(uLabel, cell, 0).r;
  outEdge = here == WALL ? 0.5 : 0.0;
  if (here == WALL) {
    outVoxel = 2u;
    outPhase = 0.0;
    outTint = 0u;
    return;
  }
  uint near = texelFetch(uNear, cell, 0).r;
  vec4 h0 = texelFetch(uOmega0, cell, 0);
  vec4 h1 = uFaces > 4 ? texelFetch(uOmega1, cell, 0) : vec4(0.0);
  bool film = false;
  uint pair = 0u;
  for (int a = 0; a < 3; a++) {
    ivec3 at = cell;
    at[a] += 1;
    if (!fieldCell(at)) continue;
    uint other = texelFetch(uLabel, at, 0).r;
    if (other == WALL) continue;
    other = through(other, at, near, h0, h1);
    if (other != here) {
      film = true;
      pair = min(here, other) * 16u + max(here, other);
    }
  }
  // A hue for each pair of chambers, so the films of a frame tell apart.
  uint hue = 3u + (pair * 2654435761u >> 24) % 253u;
  outVoxel = film ? hue : 0u;
  outPhase = film ? 1.0 : 0.0;
  outTint = film ? hue : 0u;
}`;

// The solid angle of every face at every cell, summed over its fans.
const ANGLES = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTriangles;
uniform int uTriangleCount;
uniform int uLayer;
layout(location = 0) out vec4 outOmega0;
layout(location = 1) out vec4 outOmega1;

// Van Oosterom and Strackee.
float solidAngle(vec3 a, vec3 b, vec3 c) {
  float la = length(a), lb = length(b), lc = length(c);
  float triple = dot(a, cross(b, c));
  float below = la * lb * lc + dot(a, b) * lc + dot(a, c) * lb + dot(b, c) * la;
  return 2.0 * atan(triple, below);
}

void main() {
  vec3 p = vec3(gl_FragCoord.xy, float(uLayer) + 0.5);
  float sums[${MOST_FACES}];
  for (int k = 0; k < ${MOST_FACES}; k++) sums[k] = 0.0;
  for (int t = 0; t < uTriangleCount; t++) {
    vec4 a = texelFetch(uTriangles, ivec2(t * 3, 0), 0);
    vec4 b = texelFetch(uTriangles, ivec2(t * 3 + 1, 0), 0);
    vec4 c = texelFetch(uTriangles, ivec2(t * 3 + 2, 0), 0);
    sums[int(a.w)] += solidAngle(a.xyz - p, b.xyz - p, c.xyz - p);
  }
  outOmega0 = vec4(sums[0], sums[1], sums[2], sums[3]);
  outOmega1 = vec4(sums[4], sums[5], sums[6], sums[7]);
}`;

// A bit for every face whose cut lies between this cell and a neighbour.
const CUTS = `${COMMON}
uniform int uLayer;
out uint outBits;
void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  vec4 h0 = texelFetch(uOmega0, cell, 0);
  vec4 h1 = texelFetch(uOmega1, cell, 0);
  uint bits = 0u;
  for (int a = 0; a < 3; a++) {
    for (int s = -1; s <= 1; s += 2) {
      ivec3 at = cell;
      at[a] += s;
      if (!fieldCell(at)) continue;
      vec4 a0 = texelFetch(uOmega0, at, 0);
      vec4 a1 = texelFetch(uOmega1, at, 0);
      for (int k = 0; k < ${MOST_FACES}; k++) {
        if (k >= uFaces) break;
        float d = k < 4 ? abs(h0[k] - a0[k]) : abs(h1[k - 4] - a1[k - 4]);
        if ((int(floor(d / FOUR_PI + 0.5)) & 1) == 1) bits |= 1u << uint(k);
      }
    }
  }
  outBits = bits;
}`;

// The bits spread along one axis by the reach; three passes make a cube.
const SPREAD = `#version 300 es
precision highp int;
precision highp usampler3D;
uniform usampler3D uBits;
uniform int uSize;
uniform int uLayer;
uniform int uAxis;
uniform int uReach;
out uint outBits;
void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint bits = 0u;
  for (int d = -uReach; d <= uReach; d++) {
    ivec3 at = cell;
    at[uAxis] += d;
    if (at[uAxis] < 0 || at[uAxis] >= uSize) continue;
    bits |= texelFetch(uBits, at, 0).r;
  }
  outBits = bits;
}`;

// One label becomes another everywhere: a film bursts and its two sides are one.
const RELABEL = `#version 300 es
precision highp int;
precision highp usampler3D;
uniform usampler3D uLabel;
uniform int uLayer;
uniform uint uFrom;
uniform uint uTo;
out uint outLabel;
void main() {
  uint here = texelFetch(uLabel, ivec3(ivec2(gl_FragCoord.xy), uLayer), 0).r;
  outLabel = here == uFrom ? uTo : here;
}`;

// The pair of labels across a film at this cell, as in SHOW, plus one; 0 for none.
const PAIRS = `${COMMON}
uniform int uLayer;
out uint outPair;
void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint here = texelFetch(uLabel, cell, 0).r;
  outPair = 0u;
  if (here == WALL) return;
  uint near = texelFetch(uNear, cell, 0).r;
  vec4 h0 = texelFetch(uOmega0, cell, 0);
  vec4 h1 = uFaces > 4 ? texelFetch(uOmega1, cell, 0) : vec4(0.0);
  for (int a = 0; a < 3; a++) {
    ivec3 at = cell;
    at[a] += 1;
    if (!fieldCell(at)) continue;
    uint other = texelFetch(uLabel, at, 0).r;
    if (other == WALL) continue;
    other = through(other, at, near, h0, h1);
    if (other != here) outPair = min(here, other) * 65536u + max(here, other) + 1u;
  }
}`;

// A point per cell onto the texel of its label, for the trapped bubble's volume.
const COUNT_VERTEX = `#version 300 es
precision highp int;
precision highp usampler3D;
uniform usampler3D uLabel;
uniform int uSize;
void main() {
  int n = uSize;
  ivec3 c = ivec3(gl_VertexID % n, (gl_VertexID / n) % n, gl_VertexID / (n * n));
  uint label = texelFetch(uLabel, c, 0).r;
  gl_PointSize = 1.0;
  if (label >= ${LABELS}u) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }
  gl_Position = vec4((float(label) + 0.5) / ${LABELS}.0 * 2.0 - 1.0, 0.0, 0.0, 1.0);
}`;

// A point per cell with a film on any of its three faces up, onto texel 0,
// weighted by how many: the film's area as the lattice counts it.
const FACES_VERTEX = `#version 300 es
precision highp int;
precision highp usampler3D;
uniform usampler3D uLabel;
uniform int uSize;
uniform int uWrap;
flat out float vFaces;
void main() {
  int n = uSize;
  ivec3 c = ivec3(gl_VertexID % n, (gl_VertexID / n) % n, gl_VertexID / (n * n));
  uint here = texelFetch(uLabel, c, 0).r;
  int faces = 0;
  for (int a = 0; a < 3; a++) {
    ivec3 at = c;
    at[a] += 1;
    if (at[a] >= n) {
      if (uWrap == 0) continue;
      at[a] = 0;
    }
    uint other = texelFetch(uLabel, at, 0).r;
    if (here != ${WALL}u && other != ${WALL}u && other != here) faces++;
  }
  gl_PointSize = 1.0;
  vFaces = float(faces);
  gl_Position = faces == 0 ? vec4(2.0, 2.0, 0.0, 1.0) : vec4(1.0 / ${LABELS}.0 - 1.0, 0.0, 0.0, 1.0);
}`;

const FACES_FRAGMENT = `#version 300 es
precision highp float;
flat in float vFaces;
out vec4 outCount;
void main() {
  outCount = vec4(vFaces);
}`;

const COUNT_FRAGMENT = `#version 300 es
precision highp float;
out vec4 outCount;
void main() {
  outCount = vec4(1.0);
}`;

/**
 * Soap films on a wire frame, on the GPU: the foam's rule on labels in a 3D
 * texture, with the twist of the cuts (see frames.ts). Only a bubble trapped
 * in the frame keeps a volume; the rest is air, so the films are pulled to
 * the least area the wire allows.
 */
export class Wire3 {
  readonly n: number;
  steps = 0;
  /** The trapped bubble's volume in cells, and what it is held to; 0 if none. */
  bubbleVolume = 0;
  bubbleTarget = 0;
  /** Cells of each label up to the trapped bubble's, counted every few steps. */
  readonly volumes = new Float64Array(LABELS);
  /** On a periodic field, the faces between cells of two labels, counted every few steps. */
  filmFaces = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly renderer: Renderer;
  private readonly stepProgram: WebGLProgram;
  private readonly showProgram: WebGLProgram;
  private readonly countProgram: WebGLProgram;
  private readonly facesProgram: WebGLProgram;
  private readonly anglesProgram: WebGLProgram;
  private readonly cutsProgram: WebGLProgram;
  private readonly spreadProgram: WebGLProgram;
  private readonly relabelProgram: WebGLProgram;
  private readonly pairsProgram: WebGLProgram;
  private readonly spare: WebGLTexture;
  /** The wire as the renderer's edges, with mip levels, for how near it is. */
  private readonly edges: WebGLTexture;
  private readonly target: WebGLFramebuffer;
  private readonly countTarget: WebGLFramebuffer;
  private readonly countTexture: WebGLTexture;
  private readonly omega: WebGLTexture[];
  private readonly near: WebGLTexture;
  private current: WebGLTexture;
  private next: WebGLTexture;
  private faces = 0;
  private chambers = new Uint32Array(MOST_FACES);
  private bubble = -1;
  private seed = 1;
  private shown = -1;
  private wrap = false;
  private readonly counted = new Float32Array(LABELS * 4);

  constructor(renderer: Renderer, n: number) {
    const gl = renderer.gl;
    if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('EXT_float_blend')) {
      throw new Error('This browser cannot add up floats on the GPU');
    }
    this.gl = gl;
    this.renderer = renderer;
    this.n = n;
    this.stepProgram = createProgram(gl, STEP);
    this.showProgram = createProgram(gl, SHOW);
    this.countProgram = link(gl, COUNT_VERTEX, COUNT_FRAGMENT);
    this.facesProgram = link(gl, FACES_VERTEX, FACES_FRAGMENT);
    this.anglesProgram = createProgram(gl, ANGLES);
    this.cutsProgram = createProgram(gl, CUTS);
    this.spreadProgram = createProgram(gl, SPREAD);
    this.relabelProgram = createProgram(gl, RELABEL);
    this.pairsProgram = createProgram(gl, PAIRS);
    const volume = (format: number) => {
      const texture = createTexture(gl, gl.NEAREST, gl.NEAREST);
      gl.texStorage3D(gl.TEXTURE_3D, 1, format, n, n, n);
      return texture;
    };
    this.current = volume(gl.R32UI);
    this.next = volume(gl.R32UI);
    this.omega = [volume(gl.RGBA32F), volume(gl.RGBA32F)];
    this.near = volume(gl.R8UI);
    this.spare = volume(gl.R8UI);
    this.edges = createTexture(gl, gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
    gl.texStorage3D(gl.TEXTURE_3D, Math.floor(Math.log2(n)) + 1, gl.R8, n, n, n);
    this.countTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.countTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, LABELS, 1);
    this.target = gl.createFramebuffer()!;
    this.countTarget = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.countTarget);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.countTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * A frame and its cuts. With labels, the films start from them; without,
   * the films are kept and only the wire moves, as when two rings are pulled
   * apart: cells the wire leaves become air, cells it enters wire.
   */
  setFrame(frame: Frame, field: FrameField, reach: number, labels: Uint32Array | null, bubble: number): void {
    const { gl, n } = this;
    if (frame.faces.length > MOST_FACES) throw new Error(`A frame may have ${MOST_FACES} faces at most`);
    this.faces = frame.faces.length;
    this.wrap = frame.periodic === true;
    // When only the wire moves, the films that burst stay burst.
    if (labels) {
      this.chambers.fill(0);
      frame.faces.forEach((f, k) => (this.chambers[k] = f.chamber));
    }
    const count = n * n * n;
    this.workOutCuts(frame, reach);
    let start = labels;
    if (!start) {
      start = this.readLabels();
      for (let i = 0; i < count; i++) {
        if (field.wire[i]) start[i] = WALL;
        else if (start[i] === WALL) start[i] = 0;
      }
    } else this.steps = 0;
    gl.bindTexture(gl.TEXTURE_3D, this.current);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED_INTEGER, gl.UNSIGNED_INT, start);
    if (labels) {
      this.bubble = bubble;
      this.count();
      this.bubbleTarget = bubble >= 0 ? this.bubbleVolume : 0;
    }
    this.shown = -1;
  }

  /**
   * The solid angles of the faces at every cell, and the cells near enough
   * a cut to look for it: worked out on the GPU, as it would take seconds
   * on the CPU.
   */
  private workOutCuts(frame: Frame, reach: number): void {
    const { gl, n } = this;
    // A frame without wire, the gyroid's, still gets a texture, of one texel.
    const triangles = frame.faces.length > 0 ? fanTriangles(frame) : new Float32Array(4);
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, triangles.length / 4, 1, 0, gl.RGBA, gl.FLOAT, triangles);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.viewport(0, 0, n, n);

    let program = this.anglesProgram;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uTriangles'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uTriangleCount'), Math.floor(triangles.length / 12));
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    let layer = gl.getUniformLocation(program, 'uLayer');
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.omega[0], 0, z);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, this.omega[1], 0, z);
      gl.uniform1i(layer, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, null, 0, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.deleteTexture(texture);

    program = this.cutsProgram;
    gl.useProgram(program);
    this.bind(program);
    layer = gl.getUniformLocation(program, 'uLayer');
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.spare, 0, z);
      gl.uniform1i(layer, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    program = this.spreadProgram;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uSize'), n);
    gl.uniform1i(gl.getUniformLocation(program, 'uReach'), reach);
    gl.uniform1i(gl.getUniformLocation(program, 'uBits'), 0);
    layer = gl.getUniformLocation(program, 'uLayer');
    // spare -> near -> spare -> near.
    const order = [this.spare, this.near, this.spare, this.near];
    for (let axis = 0; axis < 3; axis++) {
      // The texture read must not be bound to the unit the near bits are read from elsewhere.
      for (let unit = 1; unit < 4; unit++) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_3D, null);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, order[axis]);
      gl.uniform1i(gl.getUniformLocation(program, 'uAxis'), axis);
      for (let z = 0; z < n; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, order[axis + 1], 0, z);
        gl.uniform1i(layer, z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * A film at random, as the two labels on its sides: looked for in a few
   * layers read back at random, a film the likelier the more of it there is.
   */
  findFilm(): [number, number] | null {
    const { gl, n } = this;
    const program = this.pairsProgram;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, n, n);
    this.bind(program);
    const layer = gl.getUniformLocation(program, 'uLayer');
    const row = new Uint32Array(n * n * 4);
    const found: number[] = [];
    for (let attempt = 0; attempt < 8 && found.length === 0; attempt++) {
      for (let k = 0; k < 4; k++) {
        const z = Math.floor(Math.random() * n);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.next, 0, z);
        gl.uniform1i(layer, z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, n, n, gl.RGBA_INTEGER, gl.UNSIGNED_INT, row);
        for (let i = 0; i < n * n; i++) if (row[i * 4] > 0) found.push(row[i * 4] - 1);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (found.length === 0) return null;
    const pair = found[Math.floor(Math.random() * found.length)];
    return [Math.floor(pair / 65536), pair % 65536];
  }

  /**
   * The film between labels a and b bursts: its two sides become one, the
   * higher label taking the lower, and every cut that swapped the higher
   * swaps the lower now. A cut that comes to swap 0 with 0 swaps nothing:
   * the films on that face are gone, as when the film on a ring bursts.
   * The films left pull taut into a new shape.
   */
  burst(a: number, b: number): void {
    const keep = Math.min(a, b);
    const gone = Math.max(a, b);
    for (let k = 0; k < this.faces; k++) if (this.chambers[k] === gone) this.chambers[k] = keep;
    if (gone === this.bubble) {
      this.bubble = -1;
      this.bubbleTarget = 0;
      this.bubbleVolume = 0;
    }
    const { gl } = this;
    const program = this.relabelProgram;
    gl.useProgram(program);
    gl.uniform1ui(gl.getUniformLocation(program, 'uFrom'), gone);
    gl.uniform1ui(gl.getUniformLocation(program, 'uTo'), keep);
    this.pass(program);
    this.shown = -1;
  }

  /** The trapped bubble is held to this share of the volume it started with. */
  holdBubble(share: number, start: number): void {
    if (this.bubble >= 0) this.bubbleTarget = start * share;
  }

  step(p: Wire3Params, steps: number): void {
    const { gl } = this;
    const program = this.stepProgram;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uRadius'), p.radius);
    gl.uniform1f(gl.getUniformLocation(program, 'uJitter'), p.noise * (ballCells(p.radius) / 2));
    gl.uniform1i(gl.getUniformLocation(program, 'uFaces'), this.faces);
    gl.uniform1uiv(gl.getUniformLocation(program, 'uChamber'), this.chambers);
    for (let s = 0; s < steps; s++) {
      gl.useProgram(program);
      gl.uniform1fv(gl.getUniformLocation(program, 'uWeight'), this.weights());
      gl.uniform3fv(gl.getUniformLocation(program, 'uWind'), this.wind(p.breeze));
      gl.uniform1ui(gl.getUniformLocation(program, 'uSeed'), this.seed++);
      this.pass(program);
      this.steps++;
      if (this.bubble >= 0 || this.steps % COUNT_EVERY === 0) this.count();
    }
  }

  /** All the labels, read back (n*n*n, x fastest). Slow; not for every frame. */
  readLabels(): Uint32Array {
    const { gl, n } = this;
    const labels = new Uint32Array(n * n * n);
    const layer = new Uint32Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.current, 0, z);
      gl.readPixels(0, 0, n, n, gl.RGBA_INTEGER, gl.UNSIGNED_INT, layer);
      for (let i = 0; i < n * n; i++) labels[z * n * n + i] = layer[i * 4];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return labels;
  }

  /** Fill the renderer's textures with the films and the wire. */
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
      this.bind(program);
      const layer = gl.getUniformLocation(program, 'uLayer');
      for (let z = 0; z < n; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, targets.voxels, 0, z);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, targets.phase, 0, z);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, targets.tint, 0, z);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, this.edges, 0, z);
        gl.uniform1i(layer, z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, null, 0, 0);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, null, 0, 0);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT3, null, 0, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_3D, this.edges);
      gl.generateMipmap(gl.TEXTURE_3D);
      this.renderer.setEdges(this.edges);
    }
    if (smooth) {
      gl.bindTexture(gl.TEXTURE_3D, targets.phase);
      gl.generateMipmap(gl.TEXTURE_3D);
    }
  }

  dispose(): void {
    const { gl } = this;
    this.renderer.setEdges(null);
    for (const texture of [this.edges, this.current, this.next, ...this.omega, this.near, this.spare, this.countTexture]) gl.deleteTexture(texture);
    gl.deleteFramebuffer(this.target);
    gl.deleteFramebuffer(this.countTarget);
    for (const program of [
      this.stepProgram,
      this.showProgram,
      this.countProgram,
      this.facesProgram,
      this.anglesProgram,
      this.cutsProgram,
      this.spreadProgram,
      this.relabelProgram,
      this.pairsProgram,
    ]) {
      gl.deleteProgram(program);
    }
  }

  /** One for air and every chamber; the trapped bubble pushes or gives way as it is short of its volume or over it. */
  /** The breeze now: gusting to and fro along a direction that turns round, and tilts up and down. */
  private wind(breeze: number): number[] {
    if (breeze <= 0) return [0, 0, 0];
    const gust = Math.sin((2 * Math.PI * this.steps) / GUST_PERIOD);
    const turn = (2 * Math.PI * this.steps) / TURN_PERIOD;
    // Round the vertical, and up and down as far as nearly straight up, out of step.
    const tilt = 1.2 * Math.sin(turn * 0.61 + 1);
    const d = [Math.cos(turn) * Math.cos(tilt), Math.sin(tilt), Math.sin(turn) * Math.cos(tilt)];
    return d.map((v) => breeze * gust * v);
  }

  private weights(): Float32Array {
    const w = new Float32Array(LABELS).fill(1);
    if (this.bubble >= 0 && this.bubbleTarget > 0) {
      const lack = (PRESSURE_GAIN * (this.bubbleTarget - this.bubbleVolume)) / this.bubbleTarget;
      w[Math.min(this.bubble, LABELS - 1)] = 1 + Math.max(-YIELD_LIMIT, Math.min(PUSH_LIMIT, lack));
    }
    return w;
  }

  private count(): void {
    const { gl, n } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.countTarget);
    gl.viewport(0, 0, LABELS, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.countProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.current);
    gl.uniform1i(gl.getUniformLocation(this.countProgram, 'uLabel'), 0);
    gl.uniform1i(gl.getUniformLocation(this.countProgram, 'uSize'), n);
    gl.drawArrays(gl.POINTS, 0, n * n * n);
    gl.disable(gl.BLEND);
    gl.readPixels(0, 0, LABELS, 1, gl.RGBA, gl.FLOAT, this.counted);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let l = 0; l < LABELS; l++) this.volumes[l] = this.counted[l * 4];
    this.bubbleVolume = this.bubble >= 0 ? this.volumes[Math.min(this.bubble, LABELS - 1)] : 0;
    if (this.wrap && this.steps % COUNT_EVERY === 0) this.countFaces();
  }

  private countFaces(): void {
    const { gl, n } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.countTarget);
    gl.viewport(0, 0, LABELS, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const program = this.facesProgram;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.current);
    gl.uniform1i(gl.getUniformLocation(program, 'uLabel'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uSize'), n);
    gl.uniform1i(gl.getUniformLocation(program, 'uWrap'), 1);
    gl.drawArrays(gl.POINTS, 0, n * n * n);
    gl.disable(gl.BLEND);
    gl.readPixels(0, 0, LABELS, 1, gl.RGBA, gl.FLOAT, this.counted);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.filmFaces = this.counted[0];
  }

  private pass(program: WebGLProgram): void {
    const { gl, n } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, n, n);
    this.bind(program);
    const layer = gl.getUniformLocation(program, 'uLayer');
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.next, 0, z);
      gl.uniform1i(layer, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    [this.current, this.next] = [this.next, this.current];
  }

  private bind(program: WebGLProgram): void {
    const { gl } = this;
    const textures: [string, WebGLTexture][] = [
      ['uLabel', this.current],
      ['uOmega0', this.omega[0]],
      ['uOmega1', this.omega[1]],
      ['uNear', this.near],
    ];
    textures.forEach(([name, texture], unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
    });
    gl.uniform1i(gl.getUniformLocation(program, 'uSize'), this.n);
    gl.uniform1i(gl.getUniformLocation(program, 'uFaces'), this.faces);
    gl.uniform1uiv(gl.getUniformLocation(program, 'uChamber'), this.chambers);
    gl.uniform1i(gl.getUniformLocation(program, 'uWrap'), this.wrap ? 1 : 0);
  }
}

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

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Link failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}
