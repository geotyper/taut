# Ideas not yet done

What has come up while building the pages and is still not done. Older notes
on the membrane and the clusters are in [future_ideas.md](future_ideas.md)
and in the "What could be improved" part of [progress.md](progress.md); here
are mostly the foams, with the main older ideas listed briefly at the end.

## Wire frames: the Plateau problem

Films on wire frames are on `wire.html` (branch `foam3d-wire`); see the
README for how a film with air on both sides is made a border by cuts.
Still to do:

- **2D: pins instead of a frame.** A few fixed points that every film must
  reach. The films then form the shortest network joining the points, a
  Steiner tree, with three films at 120° at every junction. Three or four pins
  at the corners of a square is the classic case: the network takes one of
  two equal shapes, and which one depends on the start. The same cuts work
  in 2D, with the angle round each pin in place of a solid angle.
- **The cube's thirteen films.** The rule stays at twelve films meeting in
  a point. To try: a finer field, a kernel of another shape, or the films
  as a mesh relaxed to least area.
- **The still look on the wire frames**: the mesh of `src/foam3d/films.ts`
  built through the cuts, so the films come out exact and can be drawn as
  pictures.
- **More frames**: a twisted wire with more half twists (a trefoil edge),
  a prism, an octahedron, a helix between two rings.
- **Moving the wire with the mouse**, not only pulling the rings apart.

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
