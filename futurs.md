# Ideas not yet done

What has come up while building the pages and is still not done. Older notes
on the membrane and the clusters are in [future_ideas.md](future_ideas.md)
and in the "What could be improved" part of [progress.md](progress.md); here
are mostly the foams, with the main older ideas listed briefly at the end.

## Wire frames: the Plateau problem

The foams now grow in an open field or a sphere. A soap film is at its best
when it hangs on a wire, and the films then find a minimal surface on their
own.

- **2D: pins instead of a frame.** A few fixed points that every film must
  reach. The films then form the shortest network joining the points, a
  Steiner tree, with three films at 120° at every junction. Three or four pins
  at the corners of a square is the classic case: the network takes one of
  two equal shapes, and which one depends on the start.
- **3D: wire shapes.** The wire is a line of fixed cells, drawn as a tube. Then:
  - a ring gives a flat disc;
  - two rings give a catenoid, and when the rings are pulled apart the neck
    pinches off and the film snaps into two discs;
  - a tetrahedron gives six films that meet in the centre;
  - a cube gives thirteen films, with a small square in the middle, or with a
    small cube in the middle if a bubble is trapped there;
  - a twisted wire gives a Möbius strip.
- **How it could work.** The wire holds the labels on its two sides, the way
  the wall holds them now, and the films grow from it. The difficulty is that
  a film on a wire has no bubbles behind it, only air on both sides. So it
  probably needs two phases that a film divides, with the wire as the line
  where the phases are held apart.
- **Moving the wire** with the mouse, or with a slider for the gap between the
  rings, to watch the catenoid break.

## 2D foam

- **Lines as SVG.** The spline shells can be saved as SVG; the lines,
  with their glow, cannot yet.
- **A wet foam rule.** The Plateau borders are drawn now, but the rule still
  makes a dry foam. A wet one would need a rule of its own: the bubbles round
  off and stop touching when there is enough liquid.
- **More checks on the films.** Lewis's law (a bubble's area grows linearly
  with its sides) and the T1 events counted over time; von Neumann's
  rate shown per bubble on the picture, in colour.
- **Shear.** Push the foam from one side and watch T1 events, where two
  junctions meet and the films between four bubbles swap neighbours.
- **The lines faster.** The films are traced again from the whole field when
  anything changes: 26 → 22 steps a second at 1024 with 2000 bubbles. Only the
  lines near changed cells need tracing again.
- **Not checked yet.**
  - A bubble wholly inside another one, filled with the even-odd rule.
  - The lines while the foam coarsens.
  - The stress fill without WebGL2, where it needs a CPU version.
  - The *Fill* opacity slider for the stress fill: it now acts on flat colours
    only.

- **Symmetry kept.** A baked mirror wears down with the noise of the rule;
  the rule itself could be mirrored at the axes, or the source wedge copied
  out again every few steps.

## 3D foam

- **Kelvin and Weaire–Phelan.** Start the bubbles on a lattice and not at
  random. Centres on a body-centred cubic lattice should give Kelvin's
  truncated octahedra. Centres in the A15 arrangement should give the
  Weaire–Phelan cells, which have a smaller film area. The film area of the
  two could then be compared.
- **Plateau's rules in 3D**: four lines meet at about 109.5°, three films meet
  along a line at 120°. Both can be measured on the lines that are already
  drawn.
- **Coarsening in 3D**: gas through the films, as in 2D, and a check of the 3D
  form of von Neumann's law.
- **Draining per bubble.** The soap colours now drain by height in the
  whole sphere; a film could drain towards its own lowest edge instead, and
  burst when it is black.
- **Glow pressed into lines**: blur first, then sharpen towards the films, so
  that the glow keeps a spine. A slider for its strength.
- **Line ends half in sight.** The soft ends made them less visible but did
  not remove them; joining the voxels into lines across a gap could help more.
- **Export**: the films as a mesh (OBJ or STL) and the lines as a set of
  polylines. The still look now has the mesh; writing it out is short.
- **Still picture, next steps** (branch `foam3d-still`):
  - the mesh drawn on the GPU every frame, the lines alone on the CPU;
  - rounder rings, from a smoothed distance, as for the 2D rings;
  - hatching across the films along their curvature, and stipple;
  - films partly see-through: lines behind one film, faded, by depth peeling;
  - a cut along any plane, and a slab rather than a half;
  - a soft shadow of the near films on the far ones, for depth.

## On every page

- **Recording a clip**: a key that records the canvas to a file with
  `MediaRecorder`, for GIFs and videos without a screen recorder.
- **A live demo on GitHub Pages**, linked from the README.
- **Shareable links** that carry the stones or the centres as well as the
  settings.

## Membrane and clusters, briefly

These are described in full in `future_ideas.md` and `progress.md`.

- Real friction: the band grips a stone where it first touches it.
- An exact convex hull in 3D (quickhull) drawn as a wireframe, with the volume
  compared against it.
- Stones taken away on the fly, which can split a cluster.
- The whole merge tree of the clusters, from a sweep of the radius.
- Clusters by density, as in DBSCAN, so that lone stones and thin chains are
  left out.
- A hexagonal lattice in 2D.
- Walls that the band cannot cross, so the answer is a hull relative to them.
