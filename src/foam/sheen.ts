import { AIR } from './foam.ts';

/** Distance to the nearest film is kept in sixths of a cell, one byte a cell. */
const STEP = 6;
const DIAGONAL = 8;
/** A cell next to a film is half a cell away from it. */
const AT_FILM = STEP / 2;

const VERTEX = `#version 300 es
in vec2 aCorner;
out vec2 vAt;
void main() {
  vAt = vec2(aCorner.x, -aCorner.y) * 0.5 + 0.5;
  gl_Position = vec4(aCorner, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uCells;
uniform sampler2D uReach;
uniform float uTime;
uniform bool uPastel;
in vec2 vAt;
out vec4 outColor;

const vec3 AIR_COLOR = vec3(0.043, 0.051, 0.067);

vec3 hsl(float h, float s, float l) {
  vec3 k = mod(vec3(0.0, 8.0, 4.0) + h * 12.0, 12.0);
  float a = s * min(l, 1.0 - l);
  return l - a * max(vec3(-1.0), min(min(k - 3.0, 9.0 - k), vec3(1.0)));
}

// The colours of a thin film: each of red, green and blue comes and goes as
// the film thickens, at its own pace.
vec3 thinFilm(float thickness) {
  return 0.5 + 0.5 * cos(6.2832 * (thickness * vec3(1.0, 1.1, 1.2) + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec2 cell = texture(uCells, vAt).rg;
  // In cells; the texture is filtered, so this is smooth across cells.
  float reach = texture(uReach, vAt).r * 255.0 / ${STEP}.0;
  float own = cell.r;

  // A slow swirl, so the film never stands still.
  vec2 p = vAt * 5.0;
  float swirl = sin(p.x * 1.3 + uTime * 0.21 + 1.7 * sin(p.y * 1.1 - uTime * 0.13))
              + sin(p.y * 1.9 - uTime * 0.17 + 1.3 * sin(p.x * 0.8 + uTime * 0.11));
  // The film is thinnest in the middle of a bubble and its colours run in
  // from the borders; it also drains downwards.
  float thickness = own * 4.0 + reach * 0.03 - uTime * 0.06 + 0.22 * swirl + vAt.y * 0.8;
  vec3 sheen = thinFilm(thickness);
  float rim = exp(-reach / 3.0);

  vec3 color;
  vec3 film;
  if (uPastel) {
    vec3 base = hsl(own, 0.5, 0.8);
    color = mix(base, mix(vec3(1.0), sheen, 0.6), 0.12 + 0.4 * exp(-reach / 9.0));
    film = vec3(0.2, 0.23, 0.32);
  } else {
    color = mix(vec3(1.0), sheen, 0.42) * (0.88 + 0.12 * rim) + 0.1 * rim;
    film = vec3(1.0);
  }
  if (cell.g < 0.5) color = AIR_COLOR;
  float line = 1.0 - smoothstep(0.55, 1.15, reach);
  outColor = vec4(mix(color, film, line), 1.0);
}`;

/**
 * Draws the foam with a shader: the colours of a thin film on every bubble,
 * running in from its films and drifting with time. Only a picture: the
 * automaton knows nothing of it.
 */
export class Sheen {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly cellsTexture: WebGLTexture;
  private readonly reachTexture: WebGLTexture;
  /** Per cell: the hue of its bubble, and whether it is a bubble at all. */
  private readonly cells: Uint8Array;
  private readonly reach: Uint8Array;

  /** Null where WebGL2 is missing or the shader does not build. */
  static create(canvas: HTMLCanvasElement, w: number, h: number): Sheen | null {
    try {
      return new Sheen(canvas, w, h);
    } catch {
      return null;
    }
  }

  private readonly canvas: HTMLCanvasElement;
  private readonly w: number;
  private readonly h: number;

  private constructor(canvas: HTMLCanvasElement, w: number, h: number) {
    this.canvas = canvas;
    this.w = w;
    this.h = h;
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('No WebGL2');
    this.gl = gl;
    this.program = link(gl, VERTEX, FRAGMENT);
    this.cells = new Uint8Array(w * h * 2);
    this.reach = new Uint8Array(w * h);
    this.cellsTexture = texture(gl, gl.NEAREST);
    this.reachTexture = texture(gl, gl.LINEAR);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(this.program, 'aCorner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  draw(label: Uint16Array, hue: (label: number) => number, pastel: boolean, seconds: number): void {
    const { gl, canvas, w, h, cells, reach } = this;
    const scale = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    for (let i = 0; i < label.length; i++) {
      cells[i * 2] = hue(label[i]);
      cells[i * 2 + 1] = label[i] === AIR ? 0 : 255;
    }
    this.measure(label);

    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cellsTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, cells);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.reachTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, reach);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uCells'), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uReach'), 1);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uTime'), seconds);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uPastel'), pastel ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Distance from every cell to the nearest film: a chamfer transform in two sweeps. */
  private measure(label: Uint16Array): void {
    const { w, h, reach } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const here = label[i];
        const atFilm =
          (x > 0 && label[i - 1] !== here) ||
          (x + 1 < w && label[i + 1] !== here) ||
          (y > 0 && label[i - w] !== here) ||
          (y + 1 < h && label[i + w] !== here);
        reach[i] = atFilm ? AT_FILM : 255;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let d = reach[i];
        if (x > 0) d = Math.min(d, reach[i - 1] + STEP);
        if (y > 0) {
          d = Math.min(d, reach[i - w] + STEP);
          if (x > 0) d = Math.min(d, reach[i - w - 1] + DIAGONAL);
          if (x + 1 < w) d = Math.min(d, reach[i - w + 1] + DIAGONAL);
        }
        reach[i] = d;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let d = reach[i];
        if (x + 1 < w) d = Math.min(d, reach[i + 1] + STEP);
        if (y + 1 < h) {
          d = Math.min(d, reach[i + w] + STEP);
          if (x + 1 < w) d = Math.min(d, reach[i + w + 1] + DIAGONAL);
          if (x > 0) d = Math.min(d, reach[i + w - 1] + DIAGONAL);
        }
        reach[i] = d;
      }
    }
  }
}

function texture(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const made = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, made);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return made;
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
