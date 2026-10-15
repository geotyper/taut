import { AIR_WEIGHT, MAX_LABELS, type Foam, type FoamParams } from './foam.ts';

/** Bubble weights live in a square texture, one texel a label. */
const WEIGHT_SIDE = 256;
/**
 * Steps between two counts of the areas. The weights that keep the areas
 * lag behind by up to this many steps, and with 32 they overshot and
 * bubbles vanished.
 */
const COUNT_EVERY = 4;

const VERTEX = `#version 300 es
void main() {
  // One triangle covering the whole viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// The rule of Foam.step, for one cell per fragment.
const STEP = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uLabel;
uniform sampler2D uWeight;
uniform int uRadius;
uniform float uJitter;
uniform uint uSeed;
// Centre and squared radius of a round wall; no wall where the radius is zero.
uniform vec3 uFence;
out uint outLabel;

const uint AIR = 0u;
const float AIR_WEIGHT = ${AIR_WEIGHT.toFixed(4)};

// A random number in [0, 1) for this cell, this step and this candidate.
float random(uvec2 cell, uint k) {
  uint h = cell.x * 1597334677u ^ cell.y * 3812015801u ^ (uSeed * 9u + k) * 2654435761u;
  h ^= h >> 16;
  h *= 0x7feb352du;
  h ^= h >> 15;
  h *= 0x846ca68bu;
  h ^= h >> 16;
  return float(h >> 8) / 16777216.0;
}

bool fenced(ivec2 at) {
  vec2 d = vec2(at) - uFence.xy;
  return uFence.z > 0.0 && dot(d, d) > uFence.z;
}

void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uLabel, 0);
  uint here = texelFetch(uLabel, cell, 0).r;
  // Beyond the round wall nothing changes.
  if (fenced(cell)) {
    outLabel = here;
    return;
  }

  // The labels a cell may take are those in its 3x3 block, nine at most.
  uint seen[9];
  float count[9];
  int kinds = 1;
  seen[0] = here;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 at = cell + ivec2(dx, dy);
      if (any(lessThan(at, ivec2(0))) || any(greaterThanEqual(at, size)) || fenced(at)) continue;
      uint other = texelFetch(uLabel, at, 0).r;
      bool known = false;
      for (int k = 0; k < kinds; k++) known = known || seen[k] == other;
      if (!known) seen[kinds++] = other;
    }
  }
  // A cell whose neighbours all agree with it stays as it is.
  if (kinds == 1) {
    outLabel = here;
    return;
  }

  for (int k = 0; k < 9; k++) count[k] = 0.0;
  int reach = uRadius * uRadius + uRadius;
  for (int dy = -uRadius; dy <= uRadius; dy++) {
    for (int dx = -uRadius; dx <= uRadius; dx++) {
      if (dx * dx + dy * dy > reach) continue;
      ivec2 at = cell + ivec2(dx, dy);
      // Beyond the wall nothing is counted, so films meet it squarely.
      if (any(lessThan(at, ivec2(0))) || any(greaterThanEqual(at, size)) || fenced(at)) continue;
      uint other = texelFetch(uLabel, at, 0).r;
      for (int k = 0; k < kinds; k++) {
        if (seen[k] == other) {
          count[k] += 1.0;
          break;
        }
      }
    }
  }

  uint best = here;
  float bestScore = -1e30;
  for (int k = 0; k < kinds; k++) {
    uint kind = seen[k];
    float weight = kind == AIR
      ? AIR_WEIGHT
      : texelFetch(uWeight, ivec2(int(kind % ${WEIGHT_SIDE}u), int(kind / ${WEIGHT_SIDE}u)), 0).r;
    float score = count[k] * weight + uJitter * (random(uvec2(cell), uint(k)) - 0.5);
    if (score > bestScore) {
      bestScore = score;
      best = kind;
    }
  }
  outLabel = best;
}`;

/**
 * Runs the foam rule on the GPU: the labels sit in a pair of integer
 * textures, and a fragment shader applies the rule to every cell at once,
 * writing into the other texture of the pair.
 *
 * The CPU field stays in charge of everything else. Edits are made there and
 * uploaded, and after every batch of steps the labels are read back into it,
 * so it counts the areas and the bubbles and draws the picture. The weights
 * of the bubbles, which keep their areas, are worked out there from those
 * counts and are only as fresh as the last read back.
 */
export class FoamGpu {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly weightTexture: WebGLTexture;
  private readonly weights = new Float32Array(WEIGHT_SIDE * WEIGHT_SIDE);
  private readonly readback: Uint32Array;
  private readonly labels: Uint32Array;
  /** Whether the labels can be read one number a cell, or need four. */
  private readonly single: boolean;
  private current: WebGLTexture;
  private next: WebGLTexture;
  private uploaded = -1;
  private seed = 1;

  /** Null where WebGL2 is missing or the shader does not build. */
  static create(foam: Foam): FoamGpu | null {
    try {
      return new FoamGpu(foam);
    } catch (error) {
      console.warn('Foam stays on the CPU:', error);
      return null;
    }
  }

  private readonly foam: Foam;

  private constructor(foam: Foam) {
    this.foam = foam;
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) throw new Error('No WebGL2');
    this.gl = gl;
    this.program = link(gl, VERTEX, STEP);
    const { w, h } = foam;
    this.current = labelTexture(gl, w, h);
    this.next = labelTexture(gl, w, h);
    this.weightTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.weightTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, WEIGHT_SIDE, WEIGHT_SIDE);
    nearest(gl);
    this.framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.current, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Cannot render into an integer texture');
    }
    this.single =
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RED_INTEGER &&
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.UNSIGNED_INT;
    this.labels = new Uint32Array(w * h);
    this.readback = this.single ? this.labels : new Uint32Array(w * h * 4);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** Make `steps` steps, reading the labels back into the CPU field every few. */
  step(p: FoamParams, steps: number): void {
    for (let done = 0; done < steps; done += COUNT_EVERY) this.batch(p, Math.min(COUNT_EVERY, steps - done));
  }

  private batch(p: FoamParams, steps: number): void {
    const { gl, foam } = this;
    if (this.uploaded !== foam.edits) this.upload();

    // The weights for this batch, from the counts of the last one.
    const used = Math.min(foam.labelCount, MAX_LABELS) + 1;
    for (let l = 0; l < used; l++) this.weights[l] = foam.weightOf(l, p.keepArea);
    const rows = Math.ceil(used / WEIGHT_SIDE);
    gl.bindTexture(gl.TEXTURE_2D, this.weightTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WEIGHT_SIDE, rows, gl.RED, gl.FLOAT, this.weights);

    gl.useProgram(this.program);
    gl.viewport(0, 0, foam.w, foam.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uLabel'), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uWeight'), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uRadius'), p.radius);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uJitter'), p.noise * (discCells(p.radius) / 2));
    gl.uniform3f(gl.getUniformLocation(this.program, 'uFence'), foam.w / 2 - 0.5, foam.h / 2 - 0.5, foam.fence ** 2);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.weightTexture);
    for (let s = 0; s < steps; s++) {
      gl.uniform1ui(gl.getUniformLocation(this.program, 'uSeed'), this.seed++);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.next, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.current);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [this.current, this.next] = [this.next, this.current];
    }

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.current, 0);
    gl.readPixels(0, 0, foam.w, foam.h, this.single ? gl.RED_INTEGER : gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.readback);
    if (!this.single) {
      for (let i = 0; i < this.labels.length; i++) this.labels[i] = this.readback[i * 4];
    }
    foam.adopt(this.labels, steps);
    this.uploaded = foam.edits;
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteTexture(this.current);
    gl.deleteTexture(this.next);
    gl.deleteTexture(this.weightTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private upload(): void {
    const { gl, foam } = this;
    this.labels.set(foam.label);
    gl.bindTexture(gl.TEXTURE_2D, this.current);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, foam.w, foam.h, gl.RED_INTEGER, gl.UNSIGNED_INT, this.labels);
    this.uploaded = foam.edits;
  }
}

/** Cells in the disc of Foam.step: the same test as its offsets. */
function discCells(radius: number): number {
  let cells = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= radius * radius + radius) cells++;
  }
  return cells;
}

function labelTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, w, h);
  nearest(gl);
  return texture;
}

function nearest(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
      throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader failed to compile');
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'Program failed to link');
  }
  return program;
}
