/** Cells this close to a field face can never hold a stone. */
const STONE_MARGIN = 4;

/** Share of the stones that sit on the sphere in the 'sphere' placement. */
const ON_SPHERE = 0.6;

export interface StoneOptions {
  count: number;
  /**
   * How far from the centre stone centres may land, as a fraction of the
   * half-field: 1 lets stones reach the faces.
   */
  spread: number;
  /**
   * 'box': anywhere in a cube around the centre. 'sphere': most stones on the
   * surface of a sphere, the rest inside it, so the wrap has a clear outline.
   */
  placement: 'box' | 'sphere';
  /** Sharp-edged boxes, fully rounded ones, or each stone somewhere between. */
  shape: 'mixed' | 'sharp' | 'round';
}

/**
 * Scatter stones: rounded boxes, anywhere between a cube and a ball, each
 * turned at a random angle. A stone is a signed distance function placed in
 * world space first and only then sampled into voxels, so a turned stone has
 * no staircase baked into its own axes.
 */
export function scatterStones(stones: Uint8Array, n: number, options: StoneOptions): void {
  const { count, spread, placement, shape } = options;
  const n2 = n * n;
  for (let s = 0; s < count; s++) {
    const hx = n * (0.05 + Math.random() * 0.06);
    const hy = hx * (0.6 + Math.random() * 0.8);
    const hz = hx * (0.6 + Math.random() * 0.8);
    const roundness = shape === 'sharp' ? 0 : shape === 'round' ? 1 : Math.random();
    const rounding = Math.min(hx, hy, hz) * roundness;
    const reach = Math.hypot(hx, hy, hz);
    const rot = randomRotation();

    // The whole stone has to stay clear of the faces.
    const range = Math.max(0, (spread * n) / 2 - reach - STONE_MARGIN);
    let ox: number;
    let oy: number;
    let oz: number;
    if (placement === 'sphere') {
      // A random direction; the first stones go on the sphere, the rest inside.
      const z = Math.random() * 2 - 1;
      const angle = Math.random() * 2 * Math.PI;
      const ring = Math.sqrt(1 - z * z);
      const radius = s < Math.ceil(count * ON_SPHERE) ? range : range * Math.cbrt(Math.random());
      ox = radius * ring * Math.cos(angle);
      oy = radius * ring * Math.sin(angle);
      oz = radius * z;
    } else {
      ox = (Math.random() * 2 - 1) * range;
      oy = (Math.random() * 2 - 1) * range;
      oz = (Math.random() * 2 - 1) * range;
    }
    const cx = n / 2 + ox;
    const cy = n / 2 + oy;
    const cz = n / 2 + oz;

    const lo = (c: number) => Math.max(STONE_MARGIN, Math.floor(c - reach));
    const hi = (c: number) => Math.min(n - 1 - STONE_MARGIN, Math.ceil(c + reach));
    for (let z = lo(cz); z <= hi(cz); z++) {
      for (let y = lo(cy); y <= hi(cy); y++) {
        for (let x = lo(cx); x <= hi(cx); x++) {
          // Voxel centre in world space, then into the stone's own frame.
          const wx = x + 0.5 - cx;
          const wy = y + 0.5 - cy;
          const wz = z + 0.5 - cz;
          const lx = rot[0] * wx + rot[1] * wy + rot[2] * wz;
          const ly = rot[3] * wx + rot[4] * wy + rot[5] * wz;
          const lz = rot[6] * wx + rot[7] * wy + rot[8] * wz;
          if (roundBox(lx, ly, lz, hx, hy, hz, rounding) <= 0) stones[z * n2 + y * n + x] = 1;
        }
      }
    }
  }
}

/** Signed distance to a box with half-extents h and rounded edges. */
function roundBox(
  x: number, y: number, z: number,
  hx: number, hy: number, hz: number,
  rounding: number,
): number {
  const qx = Math.abs(x) - (hx - rounding);
  const qy = Math.abs(y) - (hy - rounding);
  const qz = Math.abs(z) - (hz - rounding);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0) - rounding;
}

/** A uniformly random rotation as a row-major 3x3 matrix. */
function randomRotation(): number[] {
  // Uniform unit quaternion (Shoemake).
  const u = Math.random();
  const v = Math.random() * 2 * Math.PI;
  const w = Math.random() * 2 * Math.PI;
  const a = Math.sqrt(1 - u);
  const b = Math.sqrt(u);
  const qx = a * Math.sin(v);
  const qy = a * Math.cos(v);
  const qz = b * Math.sin(w);
  const qw = b * Math.cos(w);
  return [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ];
}
