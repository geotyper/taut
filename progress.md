# Progress: clustering

What was built for clustering, which methods were tried, what each is good and
bad at, and what could be done next. Numbers are from headless runs unless
marked as estimates.

## The problem

A band moved by tension alone always ends as one convex hull around all the
stones. A front moved by curvature becomes convex whichever side it starts
from, so starting the wave from the stones instead of from the border changes
nothing. To get a band per group of stones the process needs a finite scale.

That scale is the **cluster radius** `r`: stones closer than `2r` belong to
one cluster. Growing every stone by `r` and taking connected pieces is exactly
single-linkage clustering with threshold `2r`.

## What was built

| Where | Mode | What it is |
| --- | --- | --- |
| `clusters.html` | A layer per cluster | Staged; each cluster on a field of its own |
| `clusters.html` | Stages on one field | Staged; the label is the cell state |
| `clusters.html` | One rule (default) | One synchronous rule, no stages, no clock |
| `3d.html` | Clusters | The one-rule automaton in a voxel field |

Code: `src/clusters/clusters.ts` (both staged versions),
`src/clusters/onerule.ts` (2D one rule), `src/3d/clusters3.ts` (3D).

## Methods

### 1. Staged, a layer per cluster

Three stages, each a local rule, switched from outside when a stage stops
changing:

1. **Wave** — every cell keeps the offset to the nearest stone it has heard of
   and takes a shorter one from its 8 neighbours, up to `r`.
2. **Labels** — every grown cell takes the smallest label among its
   neighbours until nothing changes.
3. **Bands** — each label is cut out into a small field with only its stones,
   starts as a fat blob, and is tightened by the two-state Potts model or the
   wide kernel.

Pros:
- Each band settles on the exact convex hull of its cluster: total area 0.999
  of the hulls in the test run.
- Bands are independent, so hulls that overlap are both drawn in full.
- Any of the existing two-state automata can do the tightening.

Cons:
- Not one automaton: stages, a field per cluster, a global "has it stopped"
  check.
- The wide kernel erases anything thinner than its radius, a band stretched
  between two small stones included: up to 5 of 19 bands broke in the test.
- The classic rules (majority, anneal) stall on the lattice and never reach
  the hull from a blob, so they are not offered here.

### 2. Staged, on one field

Same wave and labels. Then the labelled blobs swell by 6 steps (an outside
cell joins the label next to it unless it sees two different ones), and one
Potts model with as many states as labels tightens all bands at once. A pair
of cells with two different labels costs `repulsion` times a label-outside
pair.

Pros:
- One field, no cutting out.
- No band broke and no two bands touched at repulsion 3, on three stone sets
  at `r` = 6, 12, 20; area 0.97–1.09 of the hulls.
- The repulsion threshold of 2 is visible: at 1 the bands stick together like
  soap bubbles, at 3 they stay apart.

Cons:
- Still staged, with a global stop check and a fixed count of swell steps.
- Bands cannot pass through each other: where two hulls would overlap they
  press and dent.
- Cells are updated one at a time in random order, so it is a Monte Carlo
  model rather than a synchronous automaton.

### 3. One rule (2D)

No stages and no clock. Every cell applies the same rule on every step, all at
once, reading its 8 neighbours. The cell state has four parts updated
together:

- **nearest stone** — the offset, never limited by a radius, so every cell
  ends up knowing which stone it belongs to;
- **label** — within `r` of a stone, the smallest label among such
  neighbours; further out, the label of the neighbour towards the nearest
  stone, which spreads a cluster's label over its whole territory;
- **age** — steps since the label last changed here or nearby;
- **band** — a young cell close to its stone is inside; an old cell copies a
  random neighbour by the Metropolis rule, counting other labels as outside.

Age is what makes it work without stages: any label change re-inflates the
neighbourhood, so a cluster cannot tear before it learns that it is one.

Pros:
- A real cellular automaton: synchronous, local, one rule.
- Same clusters as the staged version on every run tried; no band broke;
  area 0.87–1.08 of the hulls after 8000 steps.

Cons:
- Probabilistic. Deterministic tension stalls on the lattice.
- The starting state is not uniform: every cell starts with a number of its
  own as its label.
- A band lives only inside its cluster's territory (cells nearer to its stones
  than to any others). A hull that would reach into a neighbour's territory is
  cut along the border, which is where the 0.87 comes from.
- Slower to tighten than the staged Potts model: about 1 ms a step at 256², and
  a large cluster needs several thousand steps.
- One shortcut in the code: once distances, labels and ages stop changing they
  are no longer recomputed. The rule would not change them anyway.

### 4. One rule (3D)

The same four-part state on 26 neighbours. Only the tension differs: the 2D
copy rule moves a front by mean curvature, which in 3D pinches necks, so the
membrane follows the existing line majority rule (49 lines), counting cells of
another label as outside.

**Padding** was added after the first try: pulled taut around bare stones, a
membrane is a narrow bridge for two stones, a flat sheet for three and nothing
for one. Cells within the padding of their stone are always inside, so the
membrane is taut around the stones grown by that much.

Pros:
- Cluster counts matched a brute-force check on three stone sets at 64³, at
  three radii each; no membrane broke.
- Settles fast once the labels are known: no change after about 150 steps.
- Padding is a live control and gives lone stones a shell.
- Membranes are coloured by cluster in both the voxel and the smooth view.

Cons:
- Slow while labels settle: about 45 ms a step at 64³ against 6 ms afterwards,
  so 3–5 s to start. About a minute at 128³ is an estimate, not a measurement.
- About 30 bytes of state per cell: roughly 200 MB at 192³ (estimate).
- The line rule reads cells up to its reach away, so the rule is local but not
  nearest-neighbour.
- The line rule rounds edges and stops short of the hull. Not compared against
  an exact 3D hull.
- Pressure and the soft kernel are switched off in this mode.
- With stones scattered at random most of them often fall into one cluster.

## An effect worth noting: a small cluster dents a large one

When a lone stone or a small cluster lies where the band of a large cluster
would pass, the large band does not run over it. It bends inwards, into its own
cluster, goes round the small one and returns to its line. This is easiest to
see in 2D and is the same in 3D.

It follows from the label part of the one rule. Every cell holds the label of
its nearest stone, so the field is divided into territories, and the border
between two clusters runs halfway between their nearest stones. A band counts
cells of another label as outside, so it can only live in its own territory.
The settled band is the shortest loop around its stones that stays inside that
territory: the convex hull where the territory allows it, and the border of
the territory where it does not.

So the dent is not a failure to tighten. Its shape is the halfway line between
the small cluster and the nearest stones of the large one, which is why it
always turns into the large cluster and never into the small one, and why a
stone sitting further out makes a shallower dent.

The three modes answer the same situation differently:

- **One rule** — the dent sits on the halfway line, fixed by the stones alone.
- **Stages on one field** — the two bands press on each other and the dent
  settles where their tensions balance, a little differently on each run.
- **A layer per cluster** — no dent: the large band is the full hull and
  passes over the small cluster.

## Added since: clumps and thin bridges

**Stones in clumps.** Stones scatter around a few centres, with about one in
eight landing anywhere. 2D: a *Clumps* slider, 5 by default, 0 for the old
even scatter. 3D: a stone placement *In clumps* with its own count.

**Breaking thin bridges.** A fifth part of the cell state, depth: for a cell
within the cluster radius of a stone, the distance to the nearest cell that is
not, counted as one step more than the smallest depth among the neighbours. A
label spreads only through stones and through cells at least half the chosen
bridge width deep. Two groups then join only through a neck at least that
wide.

- The depth starts at zero and only grows to its final value, so at no moment
  are two groups joined that should stay apart. That matters because a label
  taken by mistake could not be given back.
- Checked against a direct calculation (grow, measure depth, flood fill): the
  same clusters in 18 runs in 2D and 12 in 3D at 64³.
- A test scene with two 3×3 groups of stones joined by a row of six at the
  same spacing of 16 cells: one cluster at any radius that keeps the groups
  whole (6, 7 and 10 tried), eight clusters at radius 10 and bridge 24 — the
  two groups and six single stones. At bridge 20 it was six, so two
  links had not broken yet.
- Costs: one more byte per cell (two with the buffer), and the labels wait for
  the depth, which adds about half the bridge width in steps. In 3D the step
  time while settling stayed at 50–60 ms.
- For two lone stones the bridge width is no more than a smaller radius. It
  only says something new for three stones or more.
- Not in the staged modes.

## Added since: the 3D rule on the GPU

The 3D clusters automaton now runs in WebGL2, on the context the renderer
already had. WebGPU was the alternative; it would have meant rewriting the
renderer too and is not in every browser yet.

- State: two 3D textures per cell, 12 bytes. One holds the offset to the
  nearest stone, the depth and the age; the other the label, the inside bit
  and the stone bit. With the second pair to write into, 24 bytes a cell:
  about 170 MB at 192³ (estimate).
- A step is one fragment shader pass per layer of the field. It is the whole
  rule every time, without the shortcuts of the CPU version.
- The picture for both views is made from the state by a second shader, so
  the state is not copied to the CPU for drawing.
- Every 32 steps the labels are read back to count the clusters and the
  volume. "Settled" now means the labels were the same in two readbacks in a
  row, so it shows up to 32 steps late.
- Checked in headless Chrome on two sets of stones at 64³, with and without a
  bridge width: the same number of clusters and the same volume to two
  decimals as the CPU version.
- Measured on one machine, with 16 steps a frame: about 140 steps a second at
  64³, 39 at 128³, 12 at 192³. The CPU version at 128³ took about 400 ms a
  step while the labels settled.
- The age has 7 bits, so a cell stays young for at most 127 steps. At 192³
  with the largest cluster radius the CPU version would allow about 108, so
  nothing is cut yet.
- `?cpu` keeps the old version, which is also the fallback.

Not done: the 2D one rule and the other two 3D automata are still on the CPU.
The time of a step grows with the number of cells, so the shader is the
limit, not the draw calls; skipping cells that cannot change would be the
next thing to try.

## What could be improved

### Both

- **Uniform start.** Let every cell draw a random number on the first step
  instead of starting with its own index. Removes the last thing a purist can
  object to; colours then differ between runs.
- **Hierarchy.** Sweep `r` from zero up and record at which `r` clusters merge:
  that is the full single-linkage dendrogram, and a ready-made video.
- **Other linkage.** Single linkage chains: a line of stones becomes one
  cluster. A density rule (a cell needs several stones within `r`, as in
  DBSCAN) would ignore lone stones and thin bridges.
- **Overlapping hulls.** Decide what should happen when two hulls intersect:
  cut at the territory border (now), press and dent, or allow both. A band
  that may enter foreign territory but not foreign stones is the open case.

### 2D

- **Speed of the one rule.** Keep a list of front cells instead of scanning
  the field; or move the rule to a fragment shader, which fits a synchronous
  local rule exactly.
- **Padding**, as in 3D. Without it a band on two small stones is a thin
  sliver and a lone stone has no band.
- **Deterministic tension.** Find a rule without randomness that does not
  stall: a larger neighbourhood, or a line rule as in 3D.
- **Exact check per cluster.** Report area against the hull for each cluster,
  and against the hull clipped to its territory, to tell a cut from a failure
  to tighten.
- **Friction and fixed length** from the main page, per cluster.
- **Live edits.** Painting a stone restarts everything. With age already in
  the state, a new stone could just be a local label change that re-inflates
  its neighbourhood.

### 3D

- **Speed on the GPU.** Every cell reads all 26 neighbours on every step.
  Options: a cheaper pass once the labels have settled, or 8-bit offsets up
  to 128³ to halve what is read.
- **Exact 3D hull per cluster** (quickhull) drawn as a wireframe, with volume
  against it, so "stops short of the hull" becomes a number.
- **Padding as a default tied to `r`.** Padding equal to the cluster radius
  keeps the settled shape closest to the fat blobs of the start.
- **Smooth view colours.** The colour is read from the nearest inside cell and
  falls back to one colour where none is found; a blurred label field would
  remove the patches.
- **Pressure and the soft kernel** for cluster membranes: sag and inflation
  per cluster.
- **Check at higher resolution.** Clusters were compared with a direct
  calculation at 64³ only; at 128³ and 192³ the GPU version was only looked
  at.
