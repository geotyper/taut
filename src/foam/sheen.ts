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
uniform int uMode;
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
  return 0.55 + 0.4 * cos(6.2832 * (thickness * vec3(1.0, 1.1, 1.2) + vec3(0.0, 0.33, 0.67)));
}

// One lobe of the fit of Wyman, Sloan and Shirley to the CIE colour matching functions.
float lobe(float l, float mu, float below, float above) {
  float t = (l - mu) / (l < mu ? below : above);
  return exp(-0.5 * t * t);
}

vec3 xyzToRgb(vec3 c) {
  return mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570) * c;
}

vec3 spectral(float l) {
  return xyzToRgb(vec3(
    1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
    0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
    1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8)));
}

// The colour of a stressed clear sheet between crossed polarisers, for this
// retardation in nm: each wavelength comes through as sin² of its phase, so
// the colours run black, grey, white, yellow, red, blue, green, yellow, pink
// and fade into white at high orders.
vec3 interference(float retardation) {
  vec3 sum = vec3(0.0);
  vec3 white = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    float l = 400.0 + float(i) * 13.0;
    vec3 c = spectral(l);
    float s = sin(3.14159 * retardation / l);
    sum += c * s * s;
    white += c;
  }
  vec3 linear = max(sum / white, 0.0);
  return pow(linear, vec3(1.0 / 2.2));
}

/** A tint plate puts every point this many nm on: the magenta of an unstressed sheet. */
const float TINT = 560.0;
/** Air shows the tint plate alone, a little short of its full wave: the pink of a sheet at rest. */
const float TINT_AIR = 520.0;

void main() {
  vec2 cell = texture(uCells, vAt).rg;
  // In cells; the texture is filtered, so this is smooth across cells.
  vec2 reaches = texture(uReach, vAt).rg * 255.0 / ${STEP}.0;
  float reach = reaches.r;
  // How far to the nearest place where three bubbles meet.
  float corner = reaches.g;
  float own = cell.r;

  // A slow swirl, so the film never stands still.
  vec2 p = vAt * 5.0;
  float swirl = sin(p.x * 1.3 + uTime * 0.21 + 1.7 * sin(p.y * 1.1 - uTime * 0.13))
              + sin(p.y * 1.9 - uTime * 0.17 + 1.3 * sin(p.x * 0.8 + uTime * 0.11));
  float rim = exp(-reach / 3.0);
  // Every bubble has a colour of its own that drifts slowly, drains a little
  // downwards and turns over once more in a fringe along its films.
  float thickness = own * 3.0 + 0.18 * swirl + vAt.y * 0.5 - uTime * 0.025 + 0.35 * rim;
  vec3 sheen = thinFilm(thickness);

  vec3 color;
  vec3 film;
  if (uMode == 2 || uMode == 3) {
    // Stress gathers along the films and most where they meet, so the fringes
    // crowd in towards them; inside, every bubble is strained a little
    // differently, and the strain drifts.
    // Mostly in the second and third orders, where the colours are richest.
    // The fringes along a film are strongest and widest where it meets two
    // others, as at the corners of a strained part, and fade along a long
    // straight film, not the same band round every bubble.
    float gather = exp(-corner / 14.0);
    float strain = 450.0 + 500.0 * own + 150.0 * swirl + 80.0 * sin(uTime * 0.15 + own * 6.2832)
                 + (150.0 + 750.0 * gather) * exp(-reach / (3.0 + 6.0 * gather));
    color = interference(TINT + strain);
    // As vivid as a photograph of it.
    color = clamp(mix(vec3(dot(color, vec3(0.3, 0.59, 0.11))), color, 1.4), 0.0, 1.0);
    // Lifted towards the light pink of a photograph, which sees the sheet against a bright lamp.
    if (cell.g < 0.5) color = mix(interference(TINT_AIR), vec3(1.0, 0.55, 0.75), 0.55);
    float edge = 1.0 - smoothstep(0.5, 1.0, reach);
    if (uMode == 3) {
      // A film as the bright rim of a clear edge instead of a dark line,
      // thinner and fainter where films meet, so a corner does not fill in.
      edge = (1.0 - smoothstep(0.5, 0.8, reach)) * (1.0 - 0.5 * exp(-corner / 2.0));
      outColor = vec4(mix(color, vec3(1.0, 0.97, 0.98), edge * 0.6), 1.0);
      return;
    }
    outColor = vec4(mix(color, vec3(0.08, 0.05, 0.1), edge * 0.8), 1.0);
    return;
  } else if (uMode == 1) {
    vec3 base = hsl(own, 0.5, 0.8);
    color = mix(base, mix(vec3(1.0), sheen, 0.6), 0.1 + 0.35 * exp(-reach / 6.0));
    film = vec3(0.2, 0.23, 0.32);
  } else {
    color = mix(vec3(0.92, 0.93, 0.95), sheen, 0.32 + 0.25 * rim);
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
  /** Distances to the nearest film and to the nearest corner where three bubbles meet. */
  private readonly reach: Uint8Array;
  private readonly corner: Uint8Array;
  /** Both, side by side, for the texture. */
  private readonly reaches: Uint8Array;

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
    this.corner = new Uint8Array(w * h);
    this.reaches = new Uint8Array(w * h * 2);
    this.cellsTexture = texture(gl, gl.NEAREST);
    this.reachTexture = texture(gl, gl.LINEAR);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(this.program, 'aCorner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** Mode: 0 soap, 1 pastel, 2 stress in polarised light, 3 the same with light edges. */
  draw(label: Uint16Array, hue: (label: number) => number, mode: number, seconds: number): void {
    const { gl, canvas, w, h, cells, reaches } = this;
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, reaches);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uCells'), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uReach'), 1);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uTime'), seconds);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uMode'), mode);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Distances from every cell to the nearest film and the nearest corner. */
  private measure(label: Uint16Array): void {
    const { w, h, reach, corner, reaches } = this;
    corner.fill(255);
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
        // A corner: three labels or more in the 2x2 block from here.
        if (x + 1 < w && y + 1 < h) {
          const a = label[i + 1];
          const b = label[i + w];
          const c = label[i + w + 1];
          const kinds = 1 + Number(a !== here) + Number(b !== here && b !== a) + Number(c !== here && c !== a && c !== b);
          if (kinds >= 3) corner[i] = AT_FILM;
        }
      }
    }
    chamfer(reach, w, h);
    chamfer(corner, w, h);
    for (let i = 0; i < reach.length; i++) {
      reaches[i * 2] = reach[i];
      reaches[i * 2 + 1] = corner[i];
    }
  }
}

/** Spread distances from the cells that hold them over the field: a chamfer transform in two sweeps. */
function chamfer(reach: Uint8Array, w: number, h: number): void {
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
