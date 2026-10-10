/** Orbit camera around the centre of the field. Angles in radians. */
export interface Camera {
  yaw: number;
  pitch: number;
  /** Distance from the centre, in field sizes. */
  distance: number;
}

const MEMBRANE_COLOR = [1.0, 0.82, 0.4];
const STONE_COLOR = [0.55, 0.58, 0.64];

const VERTEX = `#version 300 es
void main() {
  // One triangle covering the whole viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler3D;

uniform usampler3D uVoxels;
uniform float uSize;
uniform vec2 uResolution;
uniform vec3 uEye;
uniform mat3 uCamera;
uniform float uOpacity;
uniform vec3 uStoneColor;

out vec4 outColor;

const vec3 BACKGROUND = vec3(0.043, 0.051, 0.067);
const vec3 MEMBRANE = vec3(${MEMBRANE_COLOR.join(', ')});
const float FOCAL = 1.8;
const int MAX_STEPS = 512;

// Flat shading of a cube face lit from the camera, so faces turned away from
// the viewer darken and the shape stays readable even when fully opaque.
// Edges are darkened so voxels read as cubes.
float shade(vec3 normal, vec3 hit, vec3 toEye) {
  float light = 0.25 + 0.75 * max(dot(normal, toEye), 0.0);
  vec3 f = fract(hit);
  vec3 d = min(f, 1.0 - f) + abs(normal);
  float edge = smoothstep(0.0, 0.07, min(d.x, min(d.y, d.z)));
  return light * mix(0.7, 1.0, edge);
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  vec3 rd = normalize(uCamera * vec3(uv, FOCAL));
  rd = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
  vec3 inv = 1.0 / rd;

  // Clip the ray to the field, the cube [0, uSize]^3.
  vec3 t0 = -uEye * inv;
  vec3 t1 = (vec3(uSize) - uEye) * inv;
  vec3 tNear = min(t0, t1);
  vec3 tFar = max(t0, t1);
  float tEnter = max(max(tNear.x, tNear.y), max(tNear.z, 0.0));
  float tExit = min(tFar.x, min(tFar.y, tFar.z));
  if (tEnter >= tExit) {
    outColor = vec4(BACKGROUND, 1.0);
    return;
  }

  // Walk the ray voxel by voxel (Amanatides-Woo).
  vec3 start = uEye + rd * (tEnter + 1e-3);
  ivec3 cell = ivec3(clamp(floor(start), 0.0, uSize - 1.0));
  ivec3 stride = ivec3(sign(rd));
  vec3 tDelta = abs(inv);
  vec3 tNext = (vec3(cell) + step(0.0, rd) - uEye) * inv;
  float t = tEnter;
  vec3 normal = -sign(rd) * vec3(equal(tNear, vec3(tEnter)));
  int size = int(uSize);

  vec3 color = vec3(0.0);
  float through = 1.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    uint voxel = texelFetch(uVoxels, cell, 0).r;
    if (voxel == 2u) {
      color += through * uStoneColor * shade(normal, uEye + rd * t, -rd);
      through = 0.0;
      break;
    }
    if (voxel == 1u) {
      color += through * uOpacity * MEMBRANE * shade(normal, uEye + rd * t, -rd);
      through *= 1.0 - uOpacity;
      if (through < 0.02) break;
    }
    if (tNext.x < tNext.y && tNext.x < tNext.z) {
      t = tNext.x;
      tNext.x += tDelta.x;
      cell.x += stride.x;
      normal = vec3(-float(stride.x), 0.0, 0.0);
    } else if (tNext.y < tNext.z) {
      t = tNext.y;
      tNext.y += tDelta.y;
      cell.y += stride.y;
      normal = vec3(0.0, -float(stride.y), 0.0);
    } else {
      t = tNext.z;
      tNext.z += tDelta.z;
      cell.z += stride.z;
      normal = vec3(0.0, 0.0, -float(stride.z));
    }
    if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, ivec3(size)))) break;
  }
  outColor = vec4(color + through * BACKGROUND, 1.0);
}`;

/**
 * Draws a voxel field by casting a ray per pixel through a 3D texture:
 * stones are opaque, membrane voxels are translucent and add up along the ray.
 */
export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private size = 0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;

    const program = gl.createProgram()!;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
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
    this.program = program;

    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // The fullscreen triangle needs no attributes, only a bound vertex array.
    gl.bindVertexArray(gl.createVertexArray());
  }

  /**
   * Draw n*n*n voxel classes (x fastest, then y, then z). With `oneColor` the
   * stones take the membrane's colour, so the whole wrap reads as one shell.
   */
  draw(voxels: Uint8Array, n: number, camera: Camera, opacity: number, oneColor: boolean): void {
    const { gl, program } = this;
    const canvas = gl.canvas as HTMLCanvasElement;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);

    gl.bindTexture(gl.TEXTURE_3D, this.texture);
    if (n !== this.size) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, n, n, n, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, voxels);
      this.size = n;
    } else {
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED_INTEGER, gl.UNSIGNED_BYTE, voxels);
    }

    // Camera basis: columns are right, up and forward, looking at the centre.
    const cp = Math.cos(camera.pitch);
    const off = [cp * Math.sin(camera.yaw), Math.sin(camera.pitch), cp * Math.cos(camera.yaw)];
    const forward = [-off[0], -off[1], -off[2]];
    const right = normalize([-forward[2], 0, forward[0]]);
    const up = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ];
    const reach = camera.distance * n;
    const eye = off.map((c) => n / 2 + c * reach);

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uVoxels'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uSize'), n);
    gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), width, height);
    gl.uniform3fv(gl.getUniformLocation(program, 'uEye'), eye);
    gl.uniformMatrix3fv(gl.getUniformLocation(program, 'uCamera'), false, [...right, ...up, ...forward]);
    gl.uniform1f(gl.getUniformLocation(program, 'uOpacity'), opacity);
    gl.uniform3fv(gl.getUniformLocation(program, 'uStoneColor'), oneColor ? MEMBRANE_COLOR : STONE_COLOR);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function normalize(v: number[]): number[] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}
