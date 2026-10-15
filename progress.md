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

## Added since: stones on the fly

*Add a stone* (key `A`) on both pages, and drawing a stone in 2D, no longer
start over in the one-rule modes. The new stone cells are marked as stones
with labels of their own, and the rule goes on.

- Why it is allowed: a new stone can only join clusters, and the labels can
  only merge. Taking a stone away could split a cluster, which the rule
  cannot undo, so erasing still restarts.
- It first gave wrong clusters, in 4 of 10 test runs: cells around the new
  stone still held the label of whichever cluster owned that ground before,
  and handed it to the new stone. Fixed in the rule itself: a cell that hears
  of a nearer stone takes the label of the neighbour it heard it from.
- After the fix: stones added one at a time gave the same clusters as a
  fresh start on the final stones in 10 of 10 runs (6 in 2D with 15 stones
  added, 4 in 3D on the CPU with 8), and all earlier checks against the
  direct calculation still pass. In the browser on the GPU, one run with 6
  stones added: the same clusters and volume as after a restart.
- The swelling is not very local. The age that makes a band swell spreads
  through cells of the same label for about the cluster radius plus 28 steps
  (2D), so a cluster of that size swells whole.
- The other 3D automata and the staged 2D modes restart on a new stone.

## Added since: bands that may overlap (2D)

A new mode on `clusters.html`, *One rule, bands may overlap*
(`src/clusters/channels.ts`). The cell state gets K channels, 4 by default,
each with a band of its own; every cluster keeps its band in one channel.

- **Which channel.** It follows from the cluster's label and a counter, the
  turn. A cell takes the largest turn among neighbours of its label. Where it
  touches a settled cell of a smaller label in the same channel, it adds one,
  so the cluster with the larger label moves to the next channel. This is
  graph colouring done by the cells.
- **Leaving a channel.** In each channel a cell keeps a distance to the
  nearest stone of that channel and the label of that stone, both taken
  afresh from the neighbours on every step. When a cluster leaves, the
  distances around its stones grow step by step until they reach those of
  the next cluster in the channel, or pass a limit and are forgotten.
- **Result on a test scene**, a ring of 14 stones with a small cluster inside
  its hull, 6000 steps: the plain one rule leaves the ring's band at 0.78 of
  its hull, cut by the small cluster's territory; with 2 or 4 channels it is
  1.01–1.08, the full hull lying over the small cluster.
- **Channels kept apart.** With 4 channels no two neighbouring clusters
  shared one in 7 runs (2–7 clusters). With 3 it failed in 2 of 4 runs, with
  2 in all 4 that had more than two clusters.
- **Clusters** are the same as in the plain one rule in every run, and no
  stone was left outside its band.
- **Speed.** About 500–750 steps until only the bands change, at several ms
  a step; after that 0.5–2 ms, since only cells with unlike neighbours are
  worked out.
- **Cost.** 9 bytes of state per channel per cell on top of the one rule.
- **Limits.** Two clusters that are not neighbours can share a channel and
  still cut each other where their hulls meet. A cluster with more neighbours
  than channels cannot get away from all of them. Distances inside a channel
  follow the lattice (steps of 3 and 4), not the straight line. Not in 3D.

## Added since: stones on a floor (3D)

*Stones lie on a floor* on the 3D page drops every stone onto one horizontal
plane. The placement (anywhere, sphere, clumps) then sets only where a stone
lands; its height follows from its own shape and turn, so that its lowest
point touches the floor at 0.35 of the field. Stones may still run into each
other sideways: nothing stacks or pushes apart.

Checked: 200 single stones for each placement and shape at 128³ had their
lowest voxel layer on the floor or one layer above it. In the browser, one
run of clumps on the floor at 64³ gave a flat slab of a membrane. The line
majority and wide kernel automata were not looked at with this option.

## Added since: foam (2D)

A page of its own, `foam.html`, without stones: bubbles grow from centres and
the borders between them are soap films. One rule, a plurality vote in a
disc with air counting for less; see the README for the rule.

Checked, on a 320 field with 40 centres unless said otherwise:

- Growth of one bubble: the same reach along an axis and along a diagonal to
  within 8 cells in 90, at air weights 0.55 and 0.65. At 0.45 the diagonal
  ran ahead by up to a quarter, at 0.75 the centre died. The weight in use,
  0.6, lies between the two that worked and was not measured by itself.
- Without area keeping the foam coarsens: 40 bubbles became 16 after 1000
  steps and 8 after 3000 (kernel radius 6).
- With area keeping all 40 stayed and their areas changed by 0.6% on average
  over 3000 steps. Thirty runs lost no bubble; before a growing bubble was
  made to defend its starting area, four of thirty lost one around the
  moment the field filled up.
- Bursting a bubble and starting new ones were tried once in the browser.
- A step takes about 5 ms.

Not confirmed: that the junctions are at 120 degrees. The angles were
estimated from the shares of the three labels in a ring around each
junction, and they spread by about 12 degrees around 120 both right after
the field fills and 3000 steps later, so this measure does not tell a
relaxed junction from a fresh one. By eye the settled junctions are
three-way and look even.

Found on the way: at kernel radius 4 and noise 0.1 the films froze soon
after the field filled, with four-way junctions and straight runs along the
axes left in. A flat film along an axis needs a noise above about a third at
that radius to move at all. Radius 6 with noise 0.1 relaxes and stays clean,
and is the default.

The shimmer of the light palettes is a shader over the labels and a
distance-to-film texture (`src/foam/sheen.ts`); it was looked at in two
screenshots, soap and pastel, and its motion in time was not watched.

Later a stress palette after a photograph of a photoelastic ruler: real
interference colours between crossed polarisers over a made-up strain that
gathers at the films. The first try was mostly first-order white, yellow and
brown; moving the strain up to the second and third orders and boosting the
saturation a little gave the magenta, green, cyan and blue of the photograph.
Air came out violet, then a dark magenta, and is now lifted to pink. Looked
at in screenshots while growing and once filled, with and without the
shader; not watched in motion. The same band ran round every bubble, so
the strain was made to gather at the corners where three films meet, by the
distance to the nearest one; too much there pushed the corners into the high
orders, which wash out to grey, and it was halved.
The dark film lines still met in black spots at the corners, so a second
stress palette draws the films as a thin light rim, fainter at the corners;
looked at in one screenshot of a filled foam.
Small bubbles came out as broken polygons in it: the chamfer distance makes
octagons, and the colours jumped at the films in the steps of the cells. A
third stress palette uses exact distances, blurs them over a cell in the
shader and lets the bubbles' levels meet at their films; in zoomed
screenshots of a cluster of small bubbles they came out round. Soap was
looked at as through a white veil, the film's colours making only a third of
it; they now make about two thirds.

Then the films as lines, a choice in *Films only* (branch `foam-film-lines`):
traced along the cell edges, smoothed, drawn with a glow and a width set by
a slider. Looked at in screenshots at 320 at two widths and zoomed in; the
lines keep a slight wobble where the staircase was irregular.
Then a fill inside the lines, by the loops the lines make round each
bubble, with the field's edge traced to close them. Looked at while growing,
with air between the bubbles, filled at two opacities, and with a bubble
added on top of others; a bubble wholly inside another was not tried.
Then the stress picture as a fill: the shader draws it without rims on a
canvas under the lines, which are drawn white on a clear canvas laid over
it. Looked at in a screenshot and zoomed in; the flat fill and the soap
palette were looked at again after the canvases were stacked.

Then three things from the list of ideas (branch `foam-plateau-physics`):
Plateau borders drawn as concave wedges at the junctions, the line width by
a film's bend or shortness, and measurements of the films with three charts
in the side panel. The first borders reached 0.45 of a mean bubble's radius
at most and looked like small dots; they now reach 0.8. The first von
Neumann fit gave k about 640 and a large c in every run: it counted the
growth into air before the field was full, so looks start once there is no
air left. The mean angle at junctions was always 120.0°, as three angles
round a point must be; it was replaced by their spread round 120° and the
share within 10°. Checked in screenshots: wet borders at 0.6 and 1 at 320,
the bend width at 1024 with 2000 centres and gas seeping, all options at
once on the CPU with the stress fill, and the measurements with the soap
palette at 768. The numbers are in the README. Not checked: the cost of
measuring at 1024 on its own, and the borders where a junction has four
films.

On a look by the user two of these were redone. The bend made a whole film
wider, which looked false; the width now changes along the film, drawn as a
ribbon. A bend taken over four points on either side saw the steps of the
cells and gave ragged ribbons; over a quarter of the film it is smooth, but
the ends, where the window shrank, made blots at the junctions until they
took the bend from where the window is whole. And the borders, a wedge per
junction with curves through the junction, grew horns round a small bubble,
whose films are short and bent: a wedge could reach out past them. The
liquid is now the field less the bubbles with rounded corners, so it cannot
leave the space between them. Checked in screenshots at 512 with borders at
0.6 and 1, alone and with the bend, and zoomed in on small bubbles.
Then, on a screenshot by the user, the rings of the bend round the smallest
bubbles were still thick enough to fill them; the width is now held to twice
the slider's and to a third of the radius of the bend.

Then, on the user's idea, the bubbles as spline shells (branch
`foam-spline-shells`, experimental): instead of the films, every bubble as a
closed B-spline on its outline moved inwards, over a field of liquid, so
that films and borders are the gaps between the shells, and saved as SVG.
The control points keep the junctions and are spaced evenly along each film
between, so the rounding is the same at every corner. Checked in screenshots
at 512 at spacings 0.3 and 0.8, dark and with flat colours, and at 1024 with
2000 bubbles, where it ran at the speed of the lines. The SVG was caught in
the browser, parsed without errors (400 bubbles, 800 paths, about 360 kB)
and looked like the canvas. Not checked: bubbles inside others, and the
shells while the foam coarsens; the smallest bubbles come out as thin
slivers, since an inset of a fixed depth is too much for them.

Then symmetry, as a picture (branch `foam-mirror`, experimental): a half or
a quarter of the field mirrored at its own scale, or the whole field shrunk
and mirrored, on a canvas over the others, with clicks mapped back through
the mirror. Looked at in screenshots with the spline shells (four quarters,
four whole, two halves) and the soap palette (four quarters). The cut
halves make notches and thin slivers where bubbles cross the axis; a foam
grown symmetric, with the rule mirrored at the axis, would meet it square.
Then a kaleidoscope of 6, 8 or 12 sectors, and, on the user's idea, making
the mirrored picture the field, for the rule to smooth the seams. Looked at
with the shells in eight sectors and with the stress palette in six, and
baked from four quarters and from six sectors. A first look at a baked
six-sector field seemed not to be symmetric; measured, every film above the
middle had its mirror below, as six sectors have a mirror across the middle
but none down it. The measure then showed the symmetry wearing down as the
rule runs, to 64% within a cell after 600 steps.
Then, on a look by the user, the kaleidoscope showed too little of the foam,
blown up: a wedge from the centre to the middle of an edge, enlarged by √2.
Its tip is now near the top left corner and it reaches the far walls, at
about four times the foam, shown smaller. With the tip right in the corner
the walls showed as straight films along the mirrors; four cells in, they
are out of the picture, and a film mirrored at the wall runs on smoothly.
Baking can now join copies of a bubble across the mirrors, with no film,
as the first mirrors looked. Looked at with 6, 8 and 12 sectors, with the
shells and the stress palette, and baked joined from four quarters and six
sectors.
Then, on the user's idea, the whole field bent into the wedge. The first
bending took the field's reach at each angle to its far wall, which has a
kink at 45°; it showed as arrowheads down the middle of every wedge. Fong's
elliptical mapping of the square onto a quarter disc is smooth and has a
closed inverse. At twelve sectors the squeeze broke thin lines up into a
moiré, read one sample a pixel; 2×2 samples averaged keep them whole.
Looked at with 6, 8 and 12 sectors at sizes 1, 1.2, 1.3 and 1.42, and baked
joined from six sectors; 51 steps a second at 512 with the shells, 32 with
the stress shader.
Then, on the user's idea seen while watching two mirrors, a round wall the
foam grows inside and that a button takes away (`Foam.setFence`, and a
`uFence` uniform in the GPU shader). Cells beyond it are left out of the
count of air, so the foam counts as full inside the disc and the bubbles
take their areas then. Looked at on the GPU with two mirrors and on the CPU
at 320 with 60 centres: the bubbles at the rim grew out to the square's
walls as petals in a few thousand steps.
Then the user saw a fine foam flicker, whatever the noise and the kernel.
It was the area keeping: on the CPU at 200 with 600 bubbles, no noise and
kernel 2, 5800 of 40000 cells changed every step but only 20 over two
steps, the bubbles swinging between 59 and 80 cells with their weights
pinned at 0.5 and 1.5; with no area keeping nothing moved. At kernel 6 the
same with bubbles of 230 cells. The push of a bubble below 50·r² cells now
goes down as the square root of its area against that: all those cases
stood still, and with noise 0.1 the changes were as many over one step as
over two, the noise alone. On the GPU at one step a frame that was enough,
but at four the weights, kept for four steps, swung the foam with a period
of eight steps (46000 pixels a frame); with the push divided by the steps a
weight is kept, it stood still at 4 and 16 steps a frame, and 1972 of 2000
centres grew into bubbles at four steps a frame against 971 before. 40
bubbles at 320 still held over 28000 steps and 100 at 512 over 17000.

The rule also runs on the GPU (`src/foam/foamgpu.ts`), reading the labels
back every four steps. Compared with the CPU in the browser at 320: without
area keeping 16 bubbles were left after about 1000 steps and 7 after about
3200, against 16 and 8 on the CPU; with it all 40 stayed over 15000 steps,
as did 100 at 512 over 11000 and 403 at 1024 over 3000. Reading back once a
frame instead, at 32 steps a frame, lost 23 of 40 bubbles: the weights
lagged and overshot. The noise differs from the CPU's, so the two never
give the same foam cell for cell.

*Coarsening* (none, gas seeping, films bursting, bubbles popping) replaced
the area checkbox. Checked in the browser at 768 with 600 centres and 60
bursts per 1000 steps: bursting films went from 600 bubbles to 113 after
about 4000 steps and to one by 18000; popping bubbles to 115 after about
9600; gas seeping to 65 after about 1300 and 8 after 13000. The soap palette
was made calmer: one colour per bubble with a fringe along the films instead
of bands running in from the films.

The film length in the status line is counted in cell edges, so a diagonal
film reads up to 1.4 times longer than it is.

## Added since: foam in 3D

`foam3d.html`, on the GPU only; see the README for the rule and the two
spheres. Checked in headless Chrome at 96³ with 60 bubbles:

- Glass sphere: filled in about 30 steps, all 60 bubbles kept over about 500
  steps. Before the air weight was lowered, three runs from different
  scatterings also kept all 60; after it, one run was made.
- Open sphere: the bubbles grow to the sphere, the growth ends by stalling,
  and the outer bubbles bulge; all 60 kept over about 460 steps.
- Films bursting at 100 per 1000 steps: 60 bubbles down to 18 after about 430
  steps. Gas seeping: 60 down to 18 in the open and 11 in glass after about
  600 steps, the open cluster keeping its outline.
- About 30 steps a second.

Found on the way, each fixed: with air at 0.6 of a bubble, as in 2D, the
bubbles did not grow in the open and grew in glass only along its wall;
with the 2D limit on how hard a bubble pushes, 9 of 60 bubbles were pulled
in right after the glass filled; with the volumes counted every four steps,
2 or 3 of 60 still were; the air outside the sphere, counted as one bin,
halved the speed; and gas seeping in the open let the whole cluster
evaporate, until the air was made to keep the cluster's volume.

Added after: a light look, an additive way of drawing the voxels (an option
of the shared renderer, off on the other 3D page), with the films' edges
marked in the picture pass and a strength each for films and edges; and
160³. Looked at in screenshots at 96³, 128³ and 160³; the 3D stones page was
checked to draw as before. The first try marked edges in the 3x3x3 block and
drew them as thick white tubes that hid everything; the 2x2x2 block draws
them a voxel thin. Those came out dotted and flickering, for three reasons:
only a cell on a bubble's film could hold an edge, so outer lines, whose
cells are air, had gaps; every voxel crossed added the same light however
short the ray's path in it, so a thin line broke into beads; and the films
tremble by a voxel with the rule's noise, so the edges jumped. Now any cell
may hold an edge, light goes with the path length and the edges are read
filtered, and the edges are blended over frames. At 160³ the lines are now
whole in a screenshot; that they hold still was not watched, only reasoned.

Then a *Lines* look (`src/foam3d/skeleton.ts`): the skeleton as vector lines
on a 2D canvas over the view, rebuilt from the labels read back at most every
0.4 s. Looked at in screenshots of the open sphere at 96³ and 160³ (about 530
lines, 20 and 70 ms to build); the glass sphere was not looked at in this
look, and no line was checked against the voxels it came from.

Then *Lines shown*, hiding lines behind films by a ray per point of a line
(branch `foam-3d-visible`). Looked at in screenshots at 128³: in sight only,
both spheres show the network of their near side, and through one film a
second layer joins in. With the open cluster's outer skin counted as a film,
only the lines facing the camera straight on survived, so the skin is left
out, as the glass is. How long the rays take as the view turns was not
measured.

Then two more choices against the loose ends of half-hidden lines (branch
`foam-3d-soft-ends`): whole lines if mostly in sight, and fading by the films
in front. Looked at in screenshots of the glass sphere at 128³. Fading drew
beads at first, where the round caps of two pieces overlapped and their light
added up; butt caps fixed it.

Then lines across the films, experimental (branch `foam-3d-contours`): the
films cut by level planes or spheres round the centre. Looked at in
screenshots at 128³: level planes ring an open cluster like a globe and hatch
the films of a glass sphere; spheres hatch the films round the centre. Three
things went wrong on the way. Films lying along the surfaces came out as
filled patches, so faces turned along them are left out, and the skin of an
open cluster from the spheres. The level planes first ran along the
boundaries of cell layers, which no side face comes within half a cell of, so
they caught almost nothing; they now run through the middles of layers. And
the lines were too faint behind films in the fading choice. Still rough: the
lines are stepped where a film is steep, the rings of an open cluster stick
out a little past its outline, and rebuilding takes up to about 120 ms at
128³. A slider then set how far apart the lines are, 1.5 to 10 cells at 96³;
checked in screenshots of an open cluster with spheres at 1.5 and 7. Close
together the lines show where the pieces join in short straight bits.

Then film colours (branch `foam-3d-film-colours`): soap-film interference
with drainage, and the stress palette of the 2D foam, as a choice beside a
hue per bubble. Both use the spectral colour of the 2D sheen, moved into the
renderer, so the membrane page could use it too; it does not yet. A film's
thickness comes from its height below a front that comes down as the foam
drains (as one over the root of the time, to 0.3 of the sphere's height), a
swirl, and how near the edges are, from two mip levels of the edge texture,
which now has them. The first try left the top of the foam silver after it
drained: 40 nm of film, lifted by the gamma and added up over many films
along a ray, still looks light. The film then went dark below about 30 nm.
Then, on a look by the user, the drained foam was mostly silver with the
colour squeezed into a strip at the bottom: the whole thickness was scaled
down, so the first order took most of the height. Now a front of black film
comes down and the bands spread over the height below it. The black films
then hid everything behind them, as the glass look stops light at every
film; for soap a film now stops light as much as it reflects, so a black one
is clear. Above the front the foam then vanished, so the Plateau borders keep
a thickness of their own and stay in sight, in silver. Checked in screenshots at 96³: glass sphere
with voxels, fresh and after 15, 40 and 80 s of fast drainage, stress with voxels, both
on the smooth surface, stress in the light look, and the open sphere smooth.
Speed was the same as with hues, 24 to 27 steps a second. Not checked: the
time it runs for long, coarsening with the colours on, and resolutions other
than 96³. On the smooth surface the colours show the haze of that view; with
the light look most of the stress colour is lost under the bright edges.

Then the skeleton look, on a look by the user at the wet borders above the
black films: the edge voxels drawn as solid shaded cubes, silver on a line
and gold at a point, from the edge texture already kept from frame to frame
(over 0.3 a line, over 0.7 a point). At first the films stayed round it as
glass; the user wanted them gone, so the skeleton looks now draw edges only.
And a smoothed skeleton: the edge texture read at a mip level, scaled so a
line is about 1 at any level, marched in half-cell steps to the level 0.4,
refined by halving and shaded by the gradient; gold where the field a little
inside the surface is well over that of one line. Gold first came out on
every bend, and the threshold went up. Checked in screenshots at 96³: cubes,
and tubes blurred over 1 and 1.6 levels, during growth (step about 110). Not
checked: the speed of the tubes alone, at 160³, and a settled foam. The glass
sphere's own cage of edges covers the outside; a choice to leave it out
would show the inside better.

The user then asked for the smoothness of the lines with the volume of the
tubes: a third skeleton look, tubes round the lines of the lines view. The
lines are cut into short pieces along the same curves through midpoints,
the distance to them and to the points where four meet is splatted on the
CPU into an RG8 texture, out to the reach the tubes need, twice as fine as
the field at 96³ and below, and the shader traces a smooth union of tubes and
balls by that distance. Checked in screenshots at 96³ with radius 0.8 and
1.6: smooth bent tubes with gold balls at the corners. A build took 86 ms at
0.8 and 170 ms at 1.6, so it is rebuilt at most every eight times its own
time. Not checked: 128³ and 160³, where the texture is only as fine as the
field.

Not done: the smooth view blurs the films, which are only a voxel or two
thick, into a haze; the voxel view is the one to use. Pop mode in the open
was run only at a high rate, where the foam spends most of its time growing
back into the holes. The angles where films meet were not measured.

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
- **Overlapping bands in 3D.** The channels carry over as they are, at the
  cost of four more textures of state.
- **Channels by need.** Two clusters now move apart when their territories
  touch, even if their hulls would never meet. Moving only when the bands
  actually collide would get by with fewer channels.

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
- **Stones taken away on the fly.** A removed stone can split a cluster and
  labels cannot split. It needs labels that can be withdrawn.

### Foam

- **A proper angle measure**: fit the three film directions at a junction
  beyond the kernel radius, to put a number on the 120 degrees.
- **Areas counted on the GPU**, by adding up a point per cell into a small
  texture, so the labels need not come back every four steps; at 1024 the
  read back is likely most of the time.
- **Foam in 3D** on the GPU pass that the clusters use, drawing only the
  films. Plateau borders and four-film vertices would show up there.
- **Frames instead of walls**: films spanning a fixed outline, the Plateau
  problem proper.
- **Area keeping by a local rule**, for instance a pressure field that
  spreads inside a bubble, instead of the bubble's area known to every cell.
- **Film length in real units**, not cell edges.

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
