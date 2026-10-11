# Future ideas

Notes on what was planned and not finished, and what could be tried next.
Nothing here is implemented unless it says so.

## Planned, not done

### Real friction

The current friction option is a sticky halo around the stones: the band
settles 5–8% outside the hull, which looks like slightly thicker stones and
nothing more. The original idea was different: the band should grip a stone
where it first touches it, so that the final shape depends on which side the
wave came from.

That needs the band to have material of its own. Two phases cannot remember
where a piece of the band has been. Options:

- a third state, "band", one or two cells thick, that moves with the front and
  carries a contact flag;
- a per-cell age or "stuck since step N" counter on front cells touching a
  stone, with a rule that a stuck cell only lets go above some pull;
- a tangential quantity transported along the front, so the band can slide
  over a stone or not.

### A local rule that grows the hull from the stones

The growth automaton (a cell joins if it lies between inside cells) does not
take a single step until its radius exceeds the gap between stones. This is
expected: a lone stone must stay as it is, so two distant stones cannot know
about each other through a small neighbourhood. Ways around it that stay
local:

- two passes: first a signal spreads from every stone (a distance or "seen
  from" field), then the growth rule reads that field instead of raw cells;
- several rounds with a growing radius;
- growth from the stones meeting the wave from the borders, the contour being
  where they agree.

### Inflation in 3D by a rule

In 2D the threshold works as pressure in both directions. In 3D, sag is
simulated, but inflation is derived from the taut shape by a blur and a low
threshold. Every local rule tried so far that pushes a flat face outwards
pushes it all the way to the border. A volume or area constraint (see below)
is the likely way to get a real inflated state.

### An honest convex hull in 3D

The line-majority rule settles at 72–82% of the hull volume and rounds sharp
edges. Open question: is there a local rule whose fixed point is the convex
hull of the stones in 3D? Things to try:

- more line directions than 49, or directions chosen per cell from the local
  surface normal;
- planes as well as lines: a cell stays if some plane through it has an inside
  majority on both sides in some sense;
- an exact 3D hull as a reference (quickhull), drawn as a wireframe, so the
  difference is visible and not only a number.

### Front-only evaluation, checked

The 3D step only evaluates cells on the phase boundary. It is treated as an
optimisation, but that the settled shape matches a full-grid evaluation has
not been checked by a run. One headless comparison at 64³ would settle it.

### Small things

- Keys for membrane opacity (for example `[` and `]`).
- A key that records the 3D canvas to a file (`MediaRecorder` on
  `canvas.captureStream()`), to make GIFs and clips without a screen recorder.
- Mouse orbit, zoom and the keyboard shortcuts in 3D were only checked by
  hand, never by a test.
- A live demo on GitHub Pages, linked from the README.

## What else could be interesting

### Simulation on the GPU

The 3D step runs on the CPU: about 3 ms at 64³, 10 ms at 128³, 49 ms at 192³
once settled, and up to 310 ms for the first steps of the wave at 192³. The
film rule takes 354 ms per step at 192³. The line rule is 49 independent
1D sums per cell, which maps directly onto a fragment or compute shader over a
3D texture. With WebGPU, 256³ and above should run in real time, and the
jerky start of the wave would go away.

### The 2D options, carried to 3D

- Potts model in 3D, with surface tension and pressure as energy terms.
- Fixed area, the 3D counterpart of fixed length: the membrane cannot be
  smaller than a given area and bulges between stones.
- Friction, once it works in 2D.
- Classic 26-neighbour majority and anneal rules, for the same comparison the
  2D page has.

### Interaction

- Moving, rotating or adding stones in 3D with the mouse while the membrane
  follows.
- Moving stones in 2D: drag a stone and watch the band re-tighten, or let it
  snap when a stone leaves the contour.
- Stones on a path or under simple physics, the membrane as a live wrapper.

### Other fields and lattices

- Hexagonal lattice in 2D: six equal neighbours, less anisotropy, and the
  classic rules may behave quite differently.
- Fields with obstacles the band cannot cross (walls), so the answer is a
  relative convex hull rather than the plain one.
- A torus or a field with holes, where "outside" is not one connected region.
- Several bands at once: more than two phases, each wrapping its own group of
  stones and pressing on the others.

### Other shapes of answer

- Alpha shapes: the wide kernel with a raised threshold already produces
  something close to one; it could be compared against an exact alpha shape
  the way the taut band is compared against the hull.
- A minimal surface through fixed wire loops instead of a wrapper around
  stones, using the film rule, which pinches necks the way soap film does.
- The band as a path: a shortest closed curve that must go around some stones
  and may leave others out.

### Measurements and presentation

- A plot of area and length over steps, per field, to compare how the
  automata converge and not only where they end up.
- A map of how many steps each cell took to settle.
- Export of the 3D membrane as a mesh (marching cubes to STL or OBJ), for
  printing or for a look in another renderer.
- Ambient occlusion or soft shadows in the voxel view, to read the folds of
  the membrane better.
- Shareable links that carry the stones as well as the settings.
