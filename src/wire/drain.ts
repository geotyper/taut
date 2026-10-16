import { createProgram, createTexture } from '../3d/renderer.ts';
import { COMMON, type Wire3 } from './wire3.ts';

/**
 * The thickness of the films, worked out as they drain under gravity,
 * instead of drawn from the height alone.
 *
 * Liquid runs down inside a film. Between two surfaces that do not slip, a
 * film h thick carries q = ρ g sinθ h³ / (12 μ) down its slope, θ the
 * slope: all of gravity on an upright film and none on a level one. On the
 * lattice a film is the layer of cells with a neighbour of another label
 * above it in x, y or z, as the renderer draws it. Every film cell sends
 * liquid to each film cell among its 26 neighbours that lies down the
 * film's slope from it: as much as the link goes along gravity projected
 * on the film's plane, the plane from the labels round the cell, over the
 * square of its length. What one cell gives another takes, so the liquid
 * is kept. On a level film the projection is nothing, and a link across
 * the staircase of a sloping film goes nowhere along it. A little
 * smoothing between neighbours stands in for the capillary pressure that
 * evens a real film out.
 *
 * Plateau borders, where three films meet, and the wire are where the
 * liquid goes: a film cell next to one gives to it and takes nothing back,
 * as a border sucks liquid from its films and carries it away down itself.
 * Those cells show a thick film, the border's meniscus.
 *
 * When the films move, a cell that leaves a film hands its liquid on to
 * the cells beside it that have just joined it, or if none have, to all
 * the film beside it. A cell that joins a film starts from nothing, takes
 * what it is handed, and a share of the liquid of every cell beside it
 * that was film already and stays: a film that moves by a cell takes its
 * liquid along, and one that grows spreads it thinner, and either way the
 * liquid is kept.
 */

/** The field is this wide, in metres: a bubble of a few centimetres. */
export const FIELD_WIDTH = 0.04;
/** Water: ρ g in N/m³, and μ in Pa s. */
const WEIGHT = 1000 * 9.81;
const VISCOSITY = 1e-3;
/** The thickness of a Plateau border's meniscus as drawn, in µm. */
const BORDER = 3;
/** Smoothing between neighbours, a share of the difference per step and unit of weight. */
const SMOOTHING = 0.06;
/** A film cell gives this share of its liquid to the cells beside it that have just joined the film. */
const TO_NEW = 0.25;
/** No cell gives away more than this share of its liquid in one step. */
const MOST_GIVEN = 0.3;
/** Within a step, a film of this many times the start thickness moves at most this share of a cell. */
const COURANT = 0.25;
const MOST_STEPS = 16;

// Which cells are film: 0 none, 1 film, 2 film at a Plateau border or the
// wire. And for a film cell the film's normal, from the cells two round it
// on its own side and on the other.
const MASK = `${COMMON}
uniform int uLayer;
layout(location = 0) out uint outMask;
layout(location = 1) out vec4 outNormal;

void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint here = texelFetch(uLabel, cell, 0).r;
  outMask = 0u;
  outNormal = vec4(0.0);
  if (here == WALL) return;
  uint near = texelFetch(uNear, cell, 0).r;
  vec4 h0 = texelFetch(uOmega0, cell, 0);
  vec4 h1 = uFaces > 4 ? texelFetch(uOmega1, cell, 0) : vec4(0.0);
  bool film = false;
  for (int a = 0; a < 3; a++) {
    ivec3 at = cell;
    at[a] += 1;
    if (!fieldCell(at)) continue;
    uint other = texelFetch(uLabel, at, 0).r;
    if (other == WALL) continue;
    if (through(other, at, near, h0, h1) != here) film = true;
  }
  if (!film) return;
  vec3 normal = vec3(0.0);
  for (int dz = -2; dz <= 2; dz++) {
    for (int dy = -2; dy <= 2; dy++) {
      for (int dx = -2; dx <= 2; dx++) {
        ivec3 at = cell + ivec3(dx, dy, dz);
        if (!fieldCell(at)) continue;
        uint other = texelFetch(uLabel, at, 0).r;
        if (other == WALL) continue;
        normal += (through(other, at, near, h0, h1) == here ? -1.0 : 1.0) * vec3(dx, dy, dz);
      }
    }
  }
  outNormal = vec4(length(normal) > 0.0 ? normalize(normal) : vec3(0.0), 0.0);
  // Three labels round the cell, or the wire, make it a border.
  uint first = here;
  uint second = here;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 at = cell + ivec3(dx, dy, dz);
        if (!fieldCell(at)) continue;
        uint other = texelFetch(uLabel, at, 0).r;
        if (other == WALL) {
          outMask = 2u;
          return;
        }
        other = through(other, at, near, h0, h1);
        if (other == first) continue;
        if (second == first) second = other;
        else if (other != second) {
          outMask = 2u;
          return;
        }
      }
    }
  }
  outMask = 1u;
}`;

// What every pass of the draining shares: the film mask now and a step
// before, and the thickness.
const DRAIN_COMMON = `${COMMON}
uniform usampler3D uMask;
uniform usampler3D uOld;
uniform sampler3D uThick;
uniform sampler3D uNormal;
uniform float uRate;
// µm a film loses to the air in this step.
uniform float uEvaporate;

uint maskAt(inout ivec3 at) {
  if (!fieldCell(at)) return 0u;
  return texelFetch(uMask, at, 0).r;
}

// A cell that was film a step ago and is not now: it hands its liquid on.
bool leftFilm(ivec3 at) {
  return texelFetch(uOld, at, 0).r == 1u && texelFetch(uMask, at, 0).r == 0u;
}

// A cell that is film now and was not a step ago: it starts from what it is handed.
bool newFilm(ivec3 at) {
  return texelFetch(uOld, at, 0).r != 1u && texelFetch(uMask, at, 0).r == 1u;
}

// How much of h³ a cell with film normal n sends to a neighbour d away,
// before the rate: as far as d goes along gravity in the film's plane,
// g - (g·n) n, over the square of its length. A link across the film goes
// nowhere along it and takes nothing, so the lattice's staircase does not
// steer the flow. On an upright film the three below a cell take 1, ½ and
// ½, and across a level line the links of a cell add up to 2: the half
// makes that the flux q of a film one cell wide.
float downhill(ivec3 d, vec3 n) {
  vec3 along = vec3(0.0, -1.0, 0.0) + n.y * n;
  return 0.5 * max(dot(along, vec3(d)), 0.0) / float(d.x * d.x + d.y * d.y + d.z * d.z);
}

vec3 normalAt(ivec3 at) {
  return texelFetch(uNormal, at, 0).xyz;
}
`;

// For a film cell, in r the share of what it would drain away that it
// can: all of it, unless that is more than MOST_GIVEN of its liquid; in g
// how many new film cells it has beside it, to share TO_NEW among. A new
// one drains nothing yet. For a cell that has left the film, in r among
// how many it hands its liquid on: the new film cells beside it, or if
// there are none, as minus their count, all the film cells beside it.
const LIMIT = `${DRAIN_COMMON}
uniform int uLayer;
out vec2 outShare;

void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  outShare = vec2(0.0);
  if (leftFilm(cell)) {
    float fresh = 0.0;
    float films = 0.0;
    for (int dz = -1; dz <= 1; dz++) {
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          ivec3 at = cell + ivec3(dx, dy, dz);
          if (maskAt(at) != 1u) continue;
          films += 1.0;
          if (newFilm(at)) fresh += 1.0;
        }
      }
    }
    outShare = vec2(fresh > 0.0 ? fresh : -films, 0.0);
    return;
  }
  if (texelFetch(uMask, cell, 0).r != 1u || newFilm(cell)) return;
  float h = texelFetch(uThick, cell, 0).r;
  vec3 n = normalAt(cell);
  float weights = 0.0;
  float fresh = 0.0;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 d = ivec3(dx, dy, dz);
        ivec3 at = cell + d;
        uint other = maskAt(at);
        if (other != 0u && d != ivec3(0)) weights += downhill(d, n);
        if (other == 1u && newFilm(at)) fresh += 1.0;
      }
    }
  }
  // What goes to new neighbours is taken first; the draining has the rest.
  float left = fresh > 0.0 ? 1.0 - ${TO_NEW} : 1.0;
  float given = uRate * h * h * h * weights;
  outShare = vec2(given > ${MOST_GIVEN} * left * h ? ${MOST_GIVEN} * left * h / given : 1.0, fresh);
}`;

const UPDATE = `${DRAIN_COMMON}
uniform sampler3D uShare;
uniform int uLayer;
out float outThick;

void main() {
  ivec3 cell = ivec3(ivec2(gl_FragCoord.xy), uLayer);
  uint mask = texelFetch(uMask, cell, 0).r;
  float h = texelFetch(uThick, cell, 0).r;
  if (mask == 2u) {
    outThick = ${BORDER.toFixed(1)};
    return;
  }
  vec2 own = texelFetch(uShare, cell, 0).rg;
  vec3 n = normalAt(cell);
  float share = own.r;
  bool fresh = newFilm(cell);
  float change = 0.0;
  float handed = 0.0;
  float sum = 0.0;
  float films = 0.0;
  for (int dz = -1; dz <= 1; dz++) {
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        ivec3 d = ivec3(dx, dy, dz);
        if (d == ivec3(0)) continue;
        ivec3 at = cell + d;
        uint other = maskAt(at);
        if (other == 0u) {
          // Liquid handed on by a cell that has left the film.
          if (mask == 1u && fieldCell(at) && leftFilm(at)) {
            float among = texelFetch(uShare, at, 0).r;
            float g = texelFetch(uThick, at, 0).r;
            if (among < 0.0) handed += g / -among;
            else if (among > 0.0 && fresh) handed += g / among;
          }
          continue;
        }
        float g = texelFetch(uThick, at, 0).r;
        if (mask == 1u) {
          // Down to a lower neighbour, film or border; in from a higher film.
          change -= share * uRate * h * h * h * downhill(d, n);
          if (other == 1u) {
            vec2 theirs = texelFetch(uShare, at, 0).rg;
            // A share from a neighbour that was film already, to a new cell.
            if (fresh && !newFilm(at) && theirs.g > 0.0) handed += ${TO_NEW} * g / theirs.g;
            change += theirs.r * uRate * g * g * g * downhill(-d, normalAt(at));
            // Smoothing between cells that were both film already: a new one's value is not its own yet.
            if (!fresh && !newFilm(at)) change += ${SMOOTHING} * (g - h) / float(d.x * d.x + d.y * d.y + d.z * d.z);
          }
        } else if (other == 1u) {
          sum += g;
          films += 1.0;
        }
      }
    }
  }
  // What a film cell gave its new neighbours.
  if (mask == 1u && own.g > 0.0) change -= ${TO_NEW} * h;
  // A new film cell starts from what it is handed. Off the films, the mean
  // of the film beside, for the picture to read.
  float start = fresh ? 0.0 : h;
  outThick = mask == 1u ? max(start + handed + change - uEvaporate, 0.0) : films > 0.0 ? sum / films : h;
}`;

// A point per film cell onto texel 0, weighted by its thickness, and onto texel 1, to count them.
const SUM_VERTEX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler3D;
uniform usampler3D uMask;
uniform sampler3D uThick;
uniform int uSize;
uniform int uWhich;
flat out float vValue;
void main() {
  int n = uSize;
  ivec3 c = ivec3(gl_VertexID % n, (gl_VertexID / n) % n, gl_VertexID / (n * n));
  bool film = texelFetch(uMask, c, 0).r == 1u;
  gl_PointSize = 1.0;
  vValue = uWhich == 0 ? texelFetch(uThick, c, 0).r : 1.0;
  gl_Position = film ? vec4((float(uWhich) + 0.5) - 1.0, 0.0, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
}`;

const SUM_FRAGMENT = `#version 300 es
precision highp float;
flat in float vValue;
out vec4 outSum;
void main() {
  outSum = vec4(vValue);
}`;

export class Drainage {
  /** Seconds drained since the films were fresh. */
  time = 0;
  /** Over the film cells, not the borders: the liquid in µm × cells, and how many cells. */
  liquid = 0;
  filmCells = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly wire: Wire3;
  private readonly n: number;
  private readonly maskProgram: WebGLProgram;
  private readonly limitProgram: WebGLProgram;
  private readonly updateProgram: WebGLProgram;
  private readonly sumProgram: WebGLProgram;
  private mask: WebGLTexture;
  private oldMask: WebGLTexture;
  private readonly share: WebGLTexture;
  private readonly normal: WebGLTexture;
  private thick: WebGLTexture;
  private spare: WebGLTexture;
  private readonly target: WebGLFramebuffer;
  private readonly sumTexture: WebGLTexture;
  private readonly sumTarget: WebGLFramebuffer;
  private readonly sums = new Float32Array(8);

  constructor(gl: WebGL2RenderingContext, wire: Wire3) {
    this.gl = gl;
    this.wire = wire;
    const n = (this.n = wire.n);
    // Filtered floats make the picture smooth; without them it is read cell by cell.
    const filter = gl.getExtension('OES_texture_float_linear') ? gl.LINEAR : gl.NEAREST;
    this.maskProgram = createProgram(gl, MASK);
    this.limitProgram = createProgram(gl, LIMIT);
    this.updateProgram = createProgram(gl, UPDATE);
    this.sumProgram = link(gl, SUM_VERTEX, SUM_FRAGMENT);
    const volume = (format: number, f: number) => {
      const texture = createTexture(gl, f, f);
      gl.texStorage3D(gl.TEXTURE_3D, 1, format, n, n, n);
      return texture;
    };
    this.mask = volume(gl.R8UI, gl.NEAREST);
    this.oldMask = volume(gl.R8UI, gl.NEAREST);
    this.share = volume(gl.RG32F, gl.NEAREST);
    this.normal = volume(gl.RGBA16F, gl.NEAREST);
    this.thick = volume(gl.R32F, filter);
    this.spare = volume(gl.R32F, filter);
    this.target = gl.createFramebuffer()!;
    this.sumTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sumTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 2, 1);
    this.sumTarget = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sumTarget);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sumTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** The thickness, in µm, for the renderer. */
  get thickness(): WebGLTexture {
    return this.thick;
  }

  /** Every film fresh again, `fresh` µm thick everywhere. */
  wet(fresh: number): void {
    const { gl, n } = this;
    const data = new Float32Array(n * n * n).fill(fresh);
    for (const texture of [this.thick, this.spare]) {
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED, gl.FLOAT, data);
    }
    this.time = 0;
    // Both masks from the films as they are, so that no cell starts as having left or joined one.
    this.findFilms();
    this.findFilms();
  }

  /**
   * Drain for `seconds`, the films losing `evaporation` µm/s to the air, in as many steps as keep a film a little thicker
   * than fresh from moving more than a share of a cell in one.
   */
  drain(seconds: number, fresh: number, evaporation: number): void {
    const cell = FIELD_WIDTH / this.n;
    // dh/dt in µm/s for h in µm: ρg/(12μ) h³ / cell, with h³ in m³ and dh in µm.
    const rate = ((WEIGHT / (12 * VISCOSITY)) * 1e-12) / cell;
    // On an upright film a cell gives to three below, of weight 1 together.
    const thick = 2 * fresh;
    const longest = COURANT / (rate * thick * thick);
    const steps = Math.min(MOST_STEPS, Math.max(1, Math.ceil(seconds / longest)));
    const dt = seconds / steps;
    for (let k = 0; k < steps; k++) this.step(rate * dt, evaporation * dt);
    this.time += seconds;
  }

  /** The liquid on the films and their cells, read back: slow, every so often. */
  measure(): void {
    const { gl, n } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sumTarget);
    gl.viewport(0, 0, 2, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const program = this.sumProgram;
    gl.useProgram(program);
    this.bindOwn(program, this.thick);
    gl.uniform1i(gl.getUniformLocation(program, 'uSize'), n);
    for (const which of [0, 1]) {
      gl.uniform1i(gl.getUniformLocation(program, 'uWhich'), which);
      gl.drawArrays(gl.POINTS, 0, n * n * n);
    }
    gl.disable(gl.BLEND);
    gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, this.sums);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.liquid = this.sums[0];
    this.filmCells = this.sums[4];
  }

  /** The thickness of every cell, read back (n*n*n, x fastest). Slow; for checks. */
  readThickness(): Float32Array {
    const { gl, n } = this;
    const out = new Float32Array(n * n * n);
    const layer = new Float32Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.thick, 0, z);
      gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, layer);
      for (let i = 0; i < n * n; i++) out[z * n * n + i] = layer[i * 4];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** The film mask, read back: 0 none, 1 film, 2 border. Slow; for checks. */
  readMask(): Uint8Array {
    const { gl, n } = this;
    const out = new Uint8Array(n * n * n);
    const layer = new Uint32Array(n * n * 4);
    // An 8-bit integer texture is read back through a 32-bit integer read.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.mask, 0, z);
      gl.readPixels(0, 0, n, n, gl.RGBA_INTEGER, gl.UNSIGNED_INT, layer);
      for (let i = 0; i < n * n; i++) out[z * n * n + i] = layer[i * 4];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  dispose(): void {
    const { gl } = this;
    for (const texture of [this.mask, this.oldMask, this.share, this.normal, this.thick, this.spare, this.sumTexture]) gl.deleteTexture(texture);
    gl.deleteFramebuffer(this.target);
    gl.deleteFramebuffer(this.sumTarget);
    for (const program of [this.maskProgram, this.limitProgram, this.updateProgram, this.sumProgram]) gl.deleteProgram(program);
  }

  private findFilms(): void {
    [this.mask, this.oldMask] = [this.oldMask, this.mask];
    this.pass(this.maskProgram, this.mask, () => {}, this.normal);
  }

  private step(rate: number, evaporate: number): void {
    this.findFilms();
    this.pass(this.limitProgram, this.share, (program) => {
      this.bindOwn(program, this.thick);
      this.gl.uniform1f(this.gl.getUniformLocation(program, 'uRate'), rate);
    });
    this.pass(this.updateProgram, this.spare, (program) => {
      const { gl } = this;
      this.bindOwn(program, this.thick);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_3D, this.share);
      gl.uniform1i(gl.getUniformLocation(program, 'uShare'), 6);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(gl.getUniformLocation(program, 'uRate'), rate);
      gl.uniform1f(gl.getUniformLocation(program, 'uEvaporate'), evaporate);
    });
    [this.thick, this.spare] = [this.spare, this.thick];
  }

  /** The masks, the normals and a thickness on units 4, 7, 8 and 5, past the field's. */
  private bindOwn(program: WebGLProgram, thick: WebGLTexture): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, this.mask);
    gl.uniform1i(gl.getUniformLocation(program, 'uMask'), 4);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_3D, this.oldMask);
    gl.uniform1i(gl.getUniformLocation(program, 'uOld'), 7);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_3D, this.normal);
    gl.uniform1i(gl.getUniformLocation(program, 'uNormal'), 8);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_3D, thick);
    gl.uniform1i(gl.getUniformLocation(program, 'uThick'), 5);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Every layer of `out`, and of `second` if given, drawn by `program` over the field. */
  private pass(program: WebGLProgram, out: WebGLTexture, uniforms: (program: WebGLProgram) => void, second?: WebGLTexture): void {
    const { gl, n } = this;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.drawBuffers(second ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, n, n);
    // The textures written must not be bound for reading on any unit.
    for (let unit = 4; unit < 9; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    this.wire.bind(program);
    uniforms(program);
    const layer = gl.getUniformLocation(program, 'uLayer');
    for (let z = 0; z < n; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, out, 0, z);
      if (second) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, second, 0, z);
      gl.uniform1i(layer, z);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (second) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, null, 0, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
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
