import { cameraFrame, FOCAL, type Camera } from './renderer.ts';

/** The point looked at stays within this much of the centre, in field sizes, on every axis. */
const FARTHEST_PAN = 1;

/**
 * The pointer on a canvas moves the camera: a drag orbits, a drag with the
 * right or middle button or with Shift moves the view sideways and up and
 * down, the wheel zooms, and a double click brings the view back to the
 * middle. `moved` is called on every move. The returned `dragging` says
 * whether a drag is going on.
 */
export function orbit(canvas: HTMLCanvasElement, camera: Camera, moved: () => void = () => {}): { readonly dragging: boolean } {
  let mode: 'turn' | 'pan' | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    mode = e.button !== 0 || e.shiftKey ? 'pan' : 'turn';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!mode) return;
    moved();
    if (mode === 'turn') {
      camera.yaw -= e.movementX * 0.008;
      camera.pitch = Math.max(-1.5, Math.min(1.5, camera.pitch + e.movementY * 0.008));
      return;
    }
    // A point at the depth looked at follows the pointer: the view's half-height there is distance / FOCAL field sizes.
    const { right, up } = cameraFrame(camera, 1);
    const perPixel = (2 * camera.distance) / (FOCAL * Math.max(1, canvas.clientHeight));
    const pan = camera.pan ?? [0, 0, 0];
    camera.pan = pan.map((p, i) => Math.max(-FARTHEST_PAN, Math.min(FARTHEST_PAN, p + (-e.movementX * right[i] + e.movementY * up[i]) * perPixel)));
  });
  const stop = () => (mode = null);
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('dblclick', () => {
    camera.pan = [0, 0, 0];
    moved();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      moved();
      camera.distance = Math.max(0.6, Math.min(4, camera.distance * Math.exp(e.deltaY * 0.001)));
    },
    { passive: false },
  );
  return {
    get dragging() {
      return mode !== null;
    },
  };
}
