/** Orbit camera around the centre of the field. Angles in radians. */
export interface Camera {
  yaw: number;
  pitch: number;
  /** Distance from the centre, in field sizes. */
  distance: number;
}

/** How the membrane and stones are drawn. */
export interface View {
  /** Membrane opacity, 0..1; 1 hides everything behind it. */
  opacity: number;
  /** Stones take the membrane's colour, so the wrap reads as one shell. */
  oneColor: boolean;
  /** Smooth surface only: how strongly the voxel staircase is blurred away. */
  smoothness: number;
  /**
   * Voxels only: draw with light instead of tinted glass. Every membrane
   * voxel a ray crosses adds light rather than hiding what lies behind, so
   * crossing films brighten each other and a film seen edge on shines most.
   * `films` and `lines` are how much a film voxel and an edge add; the edges
   * come from whoever computes the field (see Renderer.setEdges).
   */
  light?: { films: number; lines: number };
  /**
   * The colour of the films instead of a hue per bubble: 'soap' for the
   * interference colours of a thin soap film, thinner towards the top and
   * thinning as it drains, 'stress' for a strained clear sheet between
   * crossed polarisers. Both read the edges (see Renderer.setEdges), which
   * must then have mip levels. `time` in seconds drives their slow drift;
   * `front` is how far up, as a share of the sphere's height, the soap
   * film is still thick enough for colour: a little over 1 when fresh, and
   * lower as the black film spreads down.
   */
  film?: { mode: 'soap' | 'stress'; time: number; front: number };
  /**
   * Voxels only: the edges alone, the films left out, silver where three
   * films meet and gold where four do. 'voxels' draws them as solid cubes;
   * a number draws them as smooth tubes, blurred over that many mip levels
   * of the edge texture: thicker and rounder the higher. 'lines' draws
   * tubes round the lines set by Renderer.setLineTubes, `tubeRadius` cells
   * thick, with a ball a little thicker where four films meet.
   */
  skeleton?: 'voxels' | number | 'lines';
  tubeRadius?: number;
}

const MEMBRANE_COLOR = [1.0, 0.82, 0.4];
/** Distance from the eye to the image plane, in half-heights of the view. */
export const FOCAL = 1.8;
const STONE_COLOR = [0.55, 0.58, 0.64];

export const VERTEX = `#version 300 es
void main() {
  // One triangle covering the whole viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Shared by both fragment shaders: uniforms, the ray and its clip to the field. */
const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
precision highp usampler3D;

uniform float uSize;
uniform vec2 uResolution;
uniform vec3 uEye;
uniform mat3 uCamera;
uniform float uOpacity;
uniform vec3 uStoneColor;
uniform sampler3D uEdges;
uniform int uFilm;
uniform float uTime;
uniform float uFront;

out vec4 outColor;

const vec3 BACKGROUND = vec3(0.043, 0.051, 0.067);
const vec3 MEMBRANE = vec3(${MEMBRANE_COLOR.join(', ')});
const float FOCAL = ${FOCAL};

vec3 rayDirection() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  vec3 rd = normalize(uCamera * vec3(uv, FOCAL));
  return mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
}

// Clip the ray to the field, the cube [0, uSize]^3. Returns false on a miss.
// Voxel classes from 3 up are membranes coloured by cluster: the class is a hue.
vec3 hueColor(uint kind) {
  float h = float(kind - 3u) / 253.0;
  vec3 c = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(1.0), c, 0.7);
}

// One lobe of the fit of Wyman, Sloan and Shirley to the CIE colour matching functions.
float lobe(float l, float mu, float below, float above) {
  float t = (l - mu) / (l < mu ? below : above);
  return exp(-0.5 * t * t);
}

vec3 spectral(float l) {
  vec3 xyz = vec3(
    1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
    0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
    1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8));
  return mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570) * xyz;
}

// Light whose two parts are this many nm apart in path: each wavelength
// comes through as sin² of its phase. The same colours for light reflected
// off both faces of a soap film (twice its optical thickness apart, one
// reflection turning the phase over) and for a strained clear sheet between
// crossed polarisers: black, grey, white, yellow, red, blue, green, and on
// to pale pinks and greens that fade into white at high orders.
vec3 interference(float path) {
  vec3 sum = vec3(0.0);
  vec3 white = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    float l = 400.0 + float(i) * 13.0;
    vec3 c = spectral(l);
    float s = sin(3.14159 * path / l);
    sum += c * s * s;
    white += c;
  }
  return pow(max(sum / white, 0.0), vec3(1.0 / 2.2));
}

// A slow swirl through the field, so a film never stands still.
float swirl(vec3 p) {
  vec3 q = p / uSize * 6.0;
  float t = uTime;
  return (sin(q.x * 1.3 + t * 0.21 + 1.7 * sin(q.y * 1.1 - t * 0.13))
        + sin(q.y * 1.7 - t * 0.17 + 1.3 * sin(q.z * 0.8 + t * 0.11))
        + sin(q.z * 1.5 + t * 0.19 + 1.5 * sin(q.x * 0.9 - t * 0.07))) / 3.0;
}

// How close the edges where films meet are, at two reaches: from the mip
// levels of the edge texture, scaled so that a line counts about 1 at either.
// More where lines meet.
vec2 nearEdges(vec3 p) {
  vec3 at = p / uSize;
  return vec2(textureLod(uEdges, at, 1.0).r * 8.0, textureLod(uEdges, at, 2.5).r * 64.0);
}

// The film's own colour at p, seen along rd; facing is |cos| of the angle
// between the ray and the film, 1 where it is not known. kind tells the
// bubbles apart.
vec3 filmColor(vec3 p, float facing, uint kind) {
  float own = fract(float(kind) * 0.618034);
  vec2 edges = min(nearEdges(p), vec2(2.0));
  float s = swirl(p);
  if (uFilm == 1) {
    // Water drains down: a film is thinnest at the top of the sphere. As the
    // foam drains the black film spreads down from the top, while the bottom
    // stays wet, so the bands of colour spread over the height below the
    // front and do not crowd at the bottom. Every film thickens into the
    // meniscus along the edges where it meets others.
    float sphereBottom = 0.06 * uSize;
    float height = clamp((p.y - sphereBottom) / (0.88 * uSize), 0.0, 1.0);
    float below = clamp((uFront - height) / uFront, 0.0, 1.0);
    float thickness = (1200.0 * pow(below, 1.2) + 120.0 * own * below)
                    * (1.0 + 0.14 * s) * (1.0 + 0.5 * edges.x + 0.25 * edges.y)
    // The Plateau borders stay wet after the films have gone black, so the
    // skeleton of the foam still shows above the front, in greys and gold.
                    + 70.0 * edges.x + 30.0 * edges.y;
    // Refracted into water, the light crosses the film at a slant.
    float sine = (1.0 - facing * facing) / (1.33 * 1.33);
    float path = 2.0 * 1.33 * thickness * sqrt(1.0 - sine);
    // Thinner than about 30 nm a film reflects next to nothing: the black
    // film, which spreads down from the top as the foam drains.
    return interference(path) * smoothstep(12.0, 35.0, thickness);
  }
  // Stress gathers where films meet, so the fringes crowd towards the edges
  // and most towards the corners; every bubble is strained a little
  // differently, and the strain drifts. A tint plate puts it all 560 nm on.
  float strain = 560.0 + 350.0 + 400.0 * own + 120.0 * s + 70.0 * sin(uTime * 0.15 + own * 6.2832)
               + 500.0 * edges.x + 300.0 * edges.y;
  vec3 color = interference(strain);
  return clamp(mix(vec3(dot(color, vec3(0.3, 0.59, 0.11))), color, 1.4), 0.0, 1.0);
}

// How much of the light a film of this colour stops. A soap film shows only
// what it reflects and lets the rest through: a black film hides nothing.
float filmOpacity(vec3 tint) {
  if (uFilm != 1) return uOpacity;
  return uOpacity * clamp(1.5 * max(tint.r, max(tint.g, tint.b)), 0.0, 1.0);
}

bool clipToField(vec3 rd, out float tEnter, out float tExit, out vec3 entryNormal) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = -uEye * inv;
  vec3 t1 = (vec3(uSize) - uEye) * inv;
  vec3 tNear = min(t0, t1);
  vec3 tFar = max(t0, t1);
  tEnter = max(max(tNear.x, tNear.y), max(tNear.z, 0.0));
  tExit = min(tFar.x, min(tFar.y, tFar.z));
  entryNormal = -sign(rd) * vec3(equal(tNear, vec3(tEnter)));
  return tEnter < tExit;
}
`;

const VOXEL_FRAGMENT = `${COMMON}
uniform usampler3D uVoxels;
uniform bool uGlow;
uniform bool uSkeleton;
uniform float uTubes;
uniform bool uLineTubes;
uniform sampler3D uLineField;
uniform float uLineReach;
uniform float uTubeRadius;
uniform float uLineTexel;
uniform float uFilms;
uniform float uLines;

const int MAX_STEPS = 640;

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

// The edges blurred over uTubes mip levels, scaled so that the middle of a
// steady line is about 1 whatever the level; more where lines meet.
float tubeField(vec3 p) {
  return textureLod(uEdges, p / uSize, uTubes).r * 2.0 * exp2(2.0 * uTubes);
}

const float TUBE_SURFACE = 0.4;

// The edges as smooth tubes: march the blurred field to where it crosses
// TUBE_SURFACE, refine by halving, and shade by its gradient. Gold where
// lines meet, where the field is well over that of a single line.
vec3 tubes(vec3 rd, float tEnter, float tExit) {
  float t = tEnter + 1e-3;
  float previous = t;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (t > tExit) break;
    if (tubeField(uEye + rd * t) >= TUBE_SURFACE) {
      float a = previous;
      float b = t;
      for (int k = 0; k < 6; k++) {
        float m = 0.5 * (a + b);
        if (tubeField(uEye + rd * m) >= TUBE_SURFACE) b = m; else a = m;
      }
      vec3 hit = uEye + rd * b;
      vec2 e = vec2(0.5 * exp2(uTubes), 0.0);
      vec3 g = vec3(
        tubeField(hit + e.xyy) - tubeField(hit - e.xyy),
        tubeField(hit + e.yxy) - tubeField(hit - e.yxy),
        tubeField(hit + e.yyx) - tubeField(hit - e.yyx));
      vec3 n = -normalize(g + 1e-6);
      // Lit from the camera and a little from above, with a glint.
      vec3 toLight = normalize(-rd + vec3(0.0, 0.8, 0.0));
      float light = 0.18 + 0.6 * max(dot(n, -rd), 0.0) + 0.25 * max(dot(n, toLight), 0.0);
      float glint = pow(max(dot(reflect(rd, n), toLight), 0.0), 24.0);
      float core = tubeField(hit - n * 0.75 * exp2(uTubes));
      vec3 c = mix(vec3(0.8, 0.84, 0.92), vec3(1.0, 0.78, 0.4), smoothstep(1.7, 2.7, core));
      return c * light + vec3(0.6) * glint;
    }
    previous = t;
    t += 0.5;
  }
  return BACKGROUND;
}

// Signed distance to the tubes round the lines, and to the balls where four
// films meet, joined smoothly; y tells how much of it is ball.
vec2 lineTubes(vec3 p) {
  vec2 d = texture(uLineField, p / uSize).rg * uLineReach;
  float tube = d.x - uTubeRadius;
  float ball = d.y - 1.5 * uTubeRadius;
  float k = 0.6 * uTubeRadius;
  float h = clamp(0.5 + 0.5 * (ball - tube) / k, 0.0, 1.0);
  return vec2(mix(ball, tube, h) - k * h * (1.0 - h), 1.0 - h);
}

// Trace the tubes by their distance, stepping no further than it says.
vec3 traceLineTubes(vec3 rd, float tEnter, float tExit) {
  float t = tEnter + 1e-3;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (t > tExit) break;
    vec3 p = uEye + rd * t;
    vec2 d = lineTubes(p);
    if (d.x < 0.01) {
      vec2 e = vec2(0.5 * uLineTexel, 0.0);
      vec3 n = normalize(vec3(
        lineTubes(p + e.xyy).x - lineTubes(p - e.xyy).x,
        lineTubes(p + e.yxy).x - lineTubes(p - e.yxy).x,
        lineTubes(p + e.yyx).x - lineTubes(p - e.yyx).x) + 1e-6);
      vec3 toLight = normalize(-rd + vec3(0.0, 0.8, 0.0));
      float light = 0.18 + 0.6 * max(dot(n, -rd), 0.0) + 0.25 * max(dot(n, toLight), 0.0);
      float glint = pow(max(dot(reflect(rd, n), toLight), 0.0), 24.0);
      vec3 c = mix(vec3(0.8, 0.84, 0.92), vec3(1.0, 0.78, 0.4), smoothstep(0.3, 0.8, d.y));
      return c * light + vec3(0.6) * glint;
    }
    t += max(0.9 * d.x, 0.04);
  }
  return BACKGROUND;
}

void main() {
  vec3 rd = rayDirection();
  float tEnter;
  float tExit;
  vec3 normal;
  if (!clipToField(rd, tEnter, tExit, normal)) {
    outColor = vec4(BACKGROUND, 1.0);
    return;
  }
  if (uLineTubes) {
    outColor = vec4(traceLineTubes(rd, tEnter, tExit), 1.0);
    return;
  }
  if (uTubes > 0.0) {
    outColor = vec4(tubes(rd, tEnter, tExit), 1.0);
    return;
  }

  // Walk the ray voxel by voxel (Amanatides-Woo).
  vec3 inv = 1.0 / rd;
  vec3 start = uEye + rd * (tEnter + 1e-3);
  ivec3 cell = ivec3(clamp(floor(start), 0.0, uSize - 1.0));
  ivec3 stride = ivec3(sign(rd));
  vec3 tDelta = abs(inv);
  vec3 tNext = (vec3(cell) + step(0.0, rd) - uEye) * inv;
  float t = tEnter;
  int size = int(uSize);

  vec3 color = vec3(0.0);
  float through = 1.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    uint voxel = texelFetch(uVoxels, cell, 0).r;
    if (uSkeleton) {
      // The edges are kept from frame to frame, so a steady line holds 0.5
      // and a point 1, while a voxel the line only flickers through stays low.
      float edge = texelFetch(uEdges, cell, 0).r;
      if (edge > 0.3) {
        vec3 c = edge > 0.7 ? vec3(1.0, 0.8, 0.45) : vec3(0.82, 0.85, 0.92);
        color += through * c * shade(normal, uEye + rd * t, -rd);
        through = 0.0;
        break;
      }
      // Only the edges: the films between them are left empty.
      voxel = 0u;
    }
    if (voxel == 2u) {
      color += through * uStoneColor * shade(normal, uEye + rd * t, -rd);
      through = 0.0;
      break;
    }
    if (uGlow) {
      // Light goes with the length of the path through the voxel, so a line
      // a voxel thin does not break up into beads.
      float path = min(tNext.x, min(tNext.y, tNext.z)) - t;
      vec3 tint = voxel == 1u ? MEMBRANE : uFilm > 0 ? filmColor(uEye + rd * (t + 0.5 * path), 1.0, voxel) : hueColor(voxel);
      if (voxel == 1u || voxel >= 3u) color += uFilms * tint * path;
      // Read filtered, halfway along the path: 0.5 on a line where three
      // films meet, 1 at a point where four do, and smooth in between.
      float edge = textureLod(uEdges, (uEye + rd * (t + 0.5 * path)) / uSize, 0.0).r;
      vec3 edgeTint = voxel >= 3u ? mix(tint, vec3(1.0), 0.45) : vec3(0.85, 0.88, 0.95);
      color += uLines * 2.0 * edge * edgeTint * path;
    } else if (voxel == 1u || voxel >= 3u) {
      // The faces of the cubes are no guide to which way the film runs.
      vec3 tint = voxel == 1u ? MEMBRANE : uFilm > 0 ? filmColor(uEye + rd * t, 1.0, voxel) : hueColor(voxel);
      float alpha = filmOpacity(tint);
      color += through * alpha * tint * shade(normal, uEye + rd * t, -rd);
      through *= 1.0 - alpha;
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
  // Added-up light can run past white; this rolls it off instead.
  if (uGlow) color = 1.0 - exp(-1.4 * color);
  outColor = vec4(color + through * BACKGROUND, 1.0);
}`;

const SMOOTH_FRAGMENT = `${COMMON}
uniform sampler3D uPhase;
uniform sampler3D uStones;
uniform usampler3D uTint;
uniform bool uTinted;
uniform float uSmooth;

const int MAX_STEPS = 640;
const int REFINE_STEPS = 6;

// The binary fields, blurred by reading a coarser mip level with trilinear
// filtering. Stored as 0 or 1 in a byte, hence the scale. 0.5 is the surface.
float phaseAt(vec3 p) {
  return textureLod(uPhase, p / uSize, uSmooth).r * 255.0;
}

float stoneAt(vec3 p) {
  return textureLod(uStones, p / uSize, uSmooth).r * 255.0;
}

// A mip level alone leaves a ripple at the pitch of its texels. Averaging
// four taps at the corners of a tetrahedron half a texel out removes it. Used
// to place the surface and its normal; the march itself reads a single tap.
float phaseFine(vec3 p) {
  vec2 k = vec2(0.5 * exp2(uSmooth), -0.5 * exp2(uSmooth));
  return 0.25 * (phaseAt(p + k.xxx) + phaseAt(p + k.xyy) + phaseAt(p + k.yxy) + phaseAt(p + k.yyx));
}

float stoneFine(vec3 p) {
  vec2 k = vec2(0.5 * exp2(uSmooth), -0.5 * exp2(uSmooth));
  return 0.25 * (stoneAt(p + k.xxx) + stoneAt(p + k.xyy) + stoneAt(p + k.yxy) + stoneAt(p + k.yyx));
}

// Outward normals from the gradient of the blurred field.
vec3 phaseNormal(vec3 p) {
  vec2 e = vec2(0.75 * exp2(uSmooth), 0.0);
  vec3 g = vec3(
    phaseFine(p + e.xyy) - phaseFine(p - e.xyy),
    phaseFine(p + e.yxy) - phaseFine(p - e.yxy),
    phaseFine(p + e.yyx) - phaseFine(p - e.yyx));
  return -normalize(g + 1e-6);
}

vec3 stoneNormal(vec3 p) {
  vec2 e = vec2(0.75 * exp2(uSmooth), 0.0);
  vec3 g = vec3(
    stoneFine(p + e.xyy) - stoneFine(p - e.xyy),
    stoneFine(p + e.yxy) - stoneFine(p - e.yxy),
    stoneFine(p + e.yyx) - stoneFine(p - e.yyx));
  return -normalize(g + 1e-6);
}

// The membrane's colour at a point on its surface: one colour, or the hue of
// the first inside cell found a little way in against the outward normal.
vec3 membraneColor(vec3 hit, vec3 normal, vec3 rd) {
  if (!uTinted) return MEMBRANE;
  for (int k = 0; k < 4; k++) {
    vec3 p = hit - normal * (0.5 + float(k));
    uint kind = texelFetch(uTint, ivec3(clamp(floor(p), 0.0, uSize - 1.0)), 0).r;
    if (kind >= 3u) return uFilm > 0 ? filmColor(hit, abs(dot(normal, rd)), kind) : hueColor(kind);
  }
  return MEMBRANE;
}

// Lit from the camera; both sides of the membrane catch the light.
float shade(vec3 normal, vec3 toEye) {
  return 0.22 + 0.78 * abs(dot(normal, toEye));
}

void main() {
  vec3 rd = rayDirection();
  float tEnter;
  float tExit;
  vec3 entryNormal;
  if (!clipToField(rd, tEnter, tExit, entryNormal)) {
    outColor = vec4(BACKGROUND, 1.0);
    return;
  }

  // March in fixed steps; where a field crosses 0.5, bisect to the surface.
  float dt = max(0.6, (tExit - tEnter) / float(MAX_STEPS - 8));
  float t = tEnter + 1e-3;
  float previous = t;
  bool inside = false;
  vec3 color = vec3(0.0);
  float through = 1.0;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (t > tExit) break;
    vec3 p = uEye + rd * t;
    float phase = phaseAt(p);

    if (!inside && phase >= 0.5) {
      float a = previous;
      float b = t;
      for (int k = 0; k < REFINE_STEPS; k++) {
        float m = 0.5 * (a + b);
        if (phaseFine(uEye + rd * m) >= 0.5) b = m; else a = m;
      }
      vec3 hit = uEye + rd * b;
      // A membrane that starts at the field face has no gradient to read.
      vec3 normal = i == 0 ? entryNormal : phaseNormal(hit);
      // Where the membrane lies on a stone the two fields agree, so the stone
      // field is near 0.5 here too; on a free membrane it is near 0.
      if (stoneFine(hit) >= 0.25) {
        color += through * uStoneColor * shade(normal, -rd);
        through = 0.0;
        break;
      }
      vec3 tint = membraneColor(hit, normal, rd);
      float alpha = filmOpacity(tint);
      color += through * alpha * tint * shade(normal, -rd);
      through *= 1.0 - alpha;
      if (through < 0.02) break;
      inside = true;
    } else if (inside && stoneAt(p) >= 0.5) {
      float a = previous;
      float b = t;
      for (int k = 0; k < REFINE_STEPS; k++) {
        float m = 0.5 * (a + b);
        if (stoneFine(uEye + rd * m) >= 0.5) b = m; else a = m;
      }
      vec3 hit = uEye + rd * b;
      color += through * uStoneColor * shade(stoneNormal(hit), -rd);
      through = 0.0;
      break;
    } else if (inside && phase < 0.5) {
      // Leaving through the far wall of the membrane.
      float a = previous;
      float b = t;
      for (int k = 0; k < REFINE_STEPS; k++) {
        float m = 0.5 * (a + b);
        if (phaseFine(uEye + rd * m) < 0.5) b = m; else a = m;
      }
      vec3 hit = uEye + rd * b;
      vec3 normal = phaseNormal(hit);
      vec3 tint = membraneColor(hit, normal, rd);
      float alpha = filmOpacity(tint);
      color += through * alpha * tint * shade(normal, -rd);
      through *= 1.0 - alpha;
      if (through < 0.02) break;
      inside = false;
    }
    previous = t;
    t += dt;
  }
  outColor = vec4(color + through * BACKGROUND, 1.0);
}`;

/**
 * Draws the field by casting a ray per pixel through 3D textures, either as
 * cubes or as a smooth surface. Stones are opaque; the membrane can be
 * translucent, adding up along the ray.
 */
export class Renderer {
  /** Shared with whoever computes on the same context. */
  readonly gl: WebGL2RenderingContext;
  private readonly voxelProgram: WebGLProgram;
  private readonly smoothProgram: WebGLProgram;
  /** Voxel classes for the cube view; phase and stones for the smooth view. */
  private readonly voxelTexture: WebGLTexture;
  private readonly phaseTexture: WebGLTexture;
  private readonly stoneTexture: WebGLTexture;
  private readonly tintTexture: WebGLTexture;
  private voxelSize = 0;
  private phaseSize = 0;
  private tintSize = 0;
  /** Edges to draw in light, set from outside; a blank texel stands in. */
  private readonly blankEdges: WebGLTexture;
  private edges: WebGLTexture | null = null;
  /** Distances to the lines of a skeleton, for tubes round them. */
  private readonly lineTexture: WebGLTexture;
  private lineSize = 0;
  private lineReach = 1;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.voxelProgram = createProgram(gl, VOXEL_FRAGMENT);
    this.smoothProgram = createProgram(gl, SMOOTH_FRAGMENT);
    this.voxelTexture = this.createTexture(gl.NEAREST, gl.NEAREST);
    this.phaseTexture = this.createTexture(gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
    this.stoneTexture = this.createTexture(gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR);
    this.tintTexture = this.createTexture(gl.NEAREST, gl.NEAREST);
    this.lineTexture = this.createTexture(gl.LINEAR, gl.LINEAR);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, 1, 1, 1, 0, gl.RG, gl.UNSIGNED_BYTE, new Uint8Array([255, 255]));
    this.lineSize = 1;
    this.blankEdges = this.createTexture(gl.NEAREST, gl.NEAREST);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // The fullscreen triangle needs no attributes, only a bound vertex array.
    gl.bindVertexArray(gl.createVertexArray());
  }

  /** Upload the stones (0 or 1 per cell); call whenever they change. */
  setStones(stones: Uint8Array, n: number): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_3D, this.stoneTexture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, n, n, n, 0, gl.RED, gl.UNSIGNED_BYTE, stones);
    gl.generateMipmap(gl.TEXTURE_3D);
  }

  /** The stones as last uploaded: above zero where there is one. */
  get stones(): WebGLTexture {
    return this.stoneTexture;
  }

  /**
   * The textures both views read, sized for a field of n cells a side, for a
   * computation on the GPU to fill in place of an upload.
   */
  targets(n: number): { voxels: WebGLTexture; phase: WebGLTexture; tint: WebGLTexture } {
    const { gl } = this;
    const fit = (texture: WebGLTexture, format: number, layout: number) => {
      gl.bindTexture(gl.TEXTURE_3D, texture);
      gl.texImage3D(gl.TEXTURE_3D, 0, format, n, n, n, 0, layout, gl.UNSIGNED_BYTE, null);
    };
    if (n !== this.voxelSize) fit(this.voxelTexture, gl.R8UI, gl.RED_INTEGER);
    if (n !== this.phaseSize) fit(this.phaseTexture, gl.R8, gl.RED);
    if (n !== this.tintSize) fit(this.tintTexture, gl.R8UI, gl.RED_INTEGER);
    this.voxelSize = this.phaseSize = this.tintSize = n;
    return { voxels: this.voxelTexture, phase: this.phaseTexture, tint: this.tintTexture };
  }

  /**
   * The edges the light look draws: a 3D texture of one normalised channel
   * over the field, read with filtering. The film colours also read its mip
   * levels, for how near the edges are. Null draws none.
   */
  setEdges(edges: WebGLTexture | null): void {
    this.edges = edges;
  }

  /**
   * Distances to the lines of a skeleton, two bytes a texel (to a line, to a
   * point where four meet), `size` texels a side over the whole field, a
   * byte of 255 standing for `reach` cells.
   */
  setLineTubes(data: Uint8Array, size: number, reach: number): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_3D, this.lineTexture);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, size, size, size, 0, gl.RG, gl.UNSIGNED_BYTE, data);
    this.lineSize = size;
    this.lineReach = reach;
  }

  /**
   * Draw n*n*n voxel classes (x fastest, then y, then z) as cubes. With null
   * the texture is drawn as it was filled on the GPU.
   */
  drawVoxels(voxels: Uint8Array | null, n: number, camera: Camera, view: View): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.voxelTexture);
    if (!voxels) {
      // Filled on the GPU.
    } else if (n !== this.voxelSize) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, n, n, n, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, voxels);
      this.voxelSize = n;
    } else {
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED_INTEGER, gl.UNSIGNED_BYTE, voxels);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, this.edges ?? this.blankEdges);
    gl.activeTexture(gl.TEXTURE0);
    const program = this.voxelProgram;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uVoxels'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uEdges'), 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, this.lineTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(program, 'uLineField'), 4);
    gl.uniform1i(gl.getUniformLocation(program, 'uLineTubes'), view.skeleton === 'lines' ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uLineReach'), this.lineReach);
    gl.uniform1f(gl.getUniformLocation(program, 'uLineTexel'), n / this.lineSize);
    gl.uniform1f(gl.getUniformLocation(program, 'uTubeRadius'), view.tubeRadius ?? 1);
    this.finish(program, n, camera, view);
  }

  /**
   * Draw the phase field (0 or 1 per cell) as a smooth surface. With `tint`,
   * a hue class per inside cell, each membrane takes the colour of its cells.
   * With a null phase both textures are drawn as they were filled on the GPU.
   */
  drawSmooth(
    phase: Uint8Array | null,
    n: number,
    camera: Camera,
    view: View,
    tint?: Uint8Array,
  ): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.tintTexture);
    if (!phase) {
      // Filled on the GPU.
    } else if (tint && n !== this.tintSize) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, n, n, n, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, tint);
      this.tintSize = n;
    } else if (tint) {
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED_INTEGER, gl.UNSIGNED_BYTE, tint);
    } else if (this.tintSize === 0) {
      // An integer sampler needs a complete texture even when it is not read.
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, 1, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
      this.tintSize = 1;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.stoneTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, this.phaseTexture);
    if (!phase) {
      // Filled on the GPU.
    } else if (n !== this.phaseSize) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, n, n, n, 0, gl.RED, gl.UNSIGNED_BYTE, phase);
      this.phaseSize = n;
    } else {
      gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, n, n, n, gl.RED, gl.UNSIGNED_BYTE, phase);
    }
    // The coarser mip levels are the blur.
    gl.generateMipmap(gl.TEXTURE_3D);
    const program = this.smoothProgram;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'uPhase'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uStones'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'uTint'), 2);
    gl.uniform1i(gl.getUniformLocation(program, 'uTinted'), tint || !phase ? 1 : 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, this.edges ?? this.blankEdges);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(program, 'uEdges'), 3);
    gl.uniform1f(gl.getUniformLocation(program, 'uSmooth'), view.smoothness);
    this.finish(program, n, camera, view);
  }

  /** Fill the view with the background and draw nothing, for a picture drawn elsewhere. */
  clear(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0.043, 0.051, 0.067, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Set the uniforms both programs share and draw. */
  private finish(program: WebGLProgram, n: number, camera: Camera, view: View): void {
    const { gl } = this;
    const canvas = gl.canvas as HTMLCanvasElement;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);

    const { eye, right, up, forward } = cameraFrame(camera, n);

    gl.uniform1f(gl.getUniformLocation(program, 'uSize'), n);
    gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), width, height);
    gl.uniform3fv(gl.getUniformLocation(program, 'uEye'), eye);
    gl.uniformMatrix3fv(gl.getUniformLocation(program, 'uCamera'), false, [...right, ...up, ...forward]);
    gl.uniform1f(gl.getUniformLocation(program, 'uOpacity'), view.opacity);
    gl.uniform1i(gl.getUniformLocation(program, 'uGlow'), view.light ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uSkeleton'), view.skeleton === 'voxels' ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uTubes'), typeof view.skeleton === 'number' ? view.skeleton : 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uFilms'), view.light?.films ?? 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uLines'), view.light?.lines ?? 0);
    const film = view.film;
    gl.uniform1i(gl.getUniformLocation(program, 'uFilm'), !film ? 0 : film.mode === 'soap' ? 1 : 2);
    gl.uniform1f(gl.getUniformLocation(program, 'uTime'), film?.time ?? 0);
    gl.uniform1f(gl.getUniformLocation(program, 'uFront'), film?.front ?? 1);
    gl.uniform3fv(
      gl.getUniformLocation(program, 'uStoneColor'),
      view.oneColor ? MEMBRANE_COLOR : STONE_COLOR,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private createTexture(minFilter: number, magFilter: number): WebGLTexture {
    return createTexture(this.gl, minFilter, magFilter);
  }
}

/** A program that runs `fragment` on one triangle covering the viewport. */
export function createProgram(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
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

/** A 3D texture clamped at its faces. */
export function createTexture(
  gl: WebGL2RenderingContext,
  minFilter: number,
  magFilter: number,
): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, magFilter);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  return texture;
}

/**
 * Where the eye is in field cells and which way it looks: the columns of the
 * camera matrix, right, up and forward, looking at the centre of the field.
 * A point p shows at (dot(p - eye, right), dot(p - eye, up)) * FOCAL /
 * dot(p - eye, forward), in half-heights of the view from its centre, up
 * being up.
 */
export function cameraFrame(
  camera: Camera,
  n: number,
): { eye: number[]; right: number[]; up: number[]; forward: number[] } {
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
  return { eye, right, up, forward };
}

function normalize(v: number[]): number[] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}
