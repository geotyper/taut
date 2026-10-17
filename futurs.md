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
- **A breeze without a threshold.** Films move only once the wind outweighs
  the count a flat film gets from its own side. A rule that counts a cell's
  own layer by half might move them smoothly, and might also let the cube
  find its square.
- **Bursting by a click** on the film under the pointer, and bursting where
  a draining film has turned black.

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

## Growth, and uses elsewhere

Ideas from looking back over the rule as it now stands: labels taking the
majority in a ball, bubbles held to a volume by a weight, the cuts that make
wire, the periodic field, the draining. Each has a check that gives a number.

- **Cells dividing in a shell.** The foam's glass sphere with a held
  bubble that, once it has grown to twice its volume, splits in two by a
  plane through its middle, as the two free bubbles start. Two cells, then
  four, then eight: the cleavage of an early embryo. Early embryos come
  close to the least-area packings of foam in their shell: four cells, for
  instance, sit as a tetrahedron and not as a flat cross. Checked against
  photographs of *C. elegans* or sea-urchin embryos, and against the
  least-area packings of n balls in a sphere.
- **A tension for every pair of labels.** A matrix σᵢⱼ in place of one
  tension for every film, as a neighbour's weight by the pair. That gives
  wetting, with contact angles to check against Young's law, and cell
  sorting as in Steinberg's differential adhesion: two kinds of cell mixed
  at random part into a core and a shell, as the tissues of an embryo do.
  Cheap, and the cells dividing above would gain from it.
- **Tension by direction: crystals.** The breeze already weights a
  neighbour by its direction; the same for a tension that depends on how a
  film lies should give a bubble facets, to be compared with Wulff's
  construction.
- **Grain growth in metals.** The rule is the one used for coarsening
  polycrystals. In 2D von Neumann–Mullins gives the exact rate, dA/dt ∝
  (n − 6) for a grain of n sides (listed under 2D foam as a check); in 3D
  the mean size should grow as √t. A strict test of the rule itself.
- **Foam collapsing.** The draining joined to bursting: a film bursts when
  it thins below about 10 nm instead of at random, so a foam ages from the
  top down, in avalanches.
- **Kelvin or Weaire–Phelan from a random start.** As under 3D foam, but on
  the periodic field the gyroid uses, with eight bubbles held to equal
  volumes in a cube that wraps round. The film area cannot tell the two
  apart: they differ by 0.3%, the lattice counts the area 1.56 times over.
  Their faces can: every Kelvin cell has 14, Weaire–Phelan's 12 and 14.
- **A computer for Steiner trees.** The pins under wire frames make the
  films find the shortest network joining points, a problem that is hard in
  general and has long been put to soap films as an analogue computer. To
  compare with exact Steiner trees for 5 to 10 points, and count how often
  the rule settles in a network longer than the best.
- **Segmenting a picture.** A term in the count for how close a pixel is to
  its label's mean turns the rule into Chan–Vese or MBO segmentation: a
  photograph parted into regions with smooth borders, live on the GPU. The
  same rule on a graph in place of the lattice is MBO clustering of data,
  as in Bertozzi's work.
- **Form finding for architecture.** Frei Otto shaped tents and roofs,
  among them the Munich Olympic stadium, from soap films on wire. With the
  frames there already, writing the film out as STL or OBJ (see Export,
  under 3D foam) gives a least-area surface from a frame drawn on the page,
  for printing or for CAD. The gyroid the same way, as infill for 3D
  printing or a lattice for implants.
- **A foam that flows.** Walls of the field moving to shear the foam
  (listed under 2D foam), in 3D as well: T1 events and stick-slip, and a
  curve of stress against shear for a fluid with a yield stress.

To start with: cells dividing in a shell, as growth proper and an extension
of the foam page; the tension matrix, cheap and opening wetting and sorting
at once; and the Steiner trees, as the most unexpected, showing the rule
works something out and does not only draw.

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
