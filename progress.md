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
The stress fill did nothing with the shells: they painted the whole canvas
over the stress picture, which was not drawn either. Now it is drawn and
the shells are cut out of the liquid over it; looked at plain, wet and in
a kaleidoscope of six.
Then, on the user's wish for fills aimed at art and symmetry, five for the
shells in `src/foam/artfill.ts`: glowing spheres, neon rims, contour rings,
stained glass by sides and hatching. The middle of a bubble is the centroid
of its shell's Bézier end points. Looked at plain and in mirrors of four,
6, 8 and 12 sectors; the first rings and hatching, a stroke every two line
widths, broke into moiré and are now three and a half apart, and the neon
rim went from four hard bands to nine faint ones. Every fill saved as an
SVG that parses.
Then on the user's look: stained glass is the best; hatching better in
black and white; rings lost the pattern of the areas in their rainbow; the
neon had nothing of neon. Hatching is now ink on paper, with an engraving
next to it whose strokes bow over the bubble as over a lit dome and thicken
in its shade, in five widths so that each is one path; rings take one
colour a bubble; the neon is a tube along every shell drawn over all the
fills and added up, on black. Looked at plain, wet and in kaleidoscopes of
6 and 8 sectors; every fill saved as an SVG that parses.
Then the user found the engraving lost on large bubbles: grown out of a
circle into long petals, each got a dome the size of a disc of its area in
its middle and bare or half-struck ends. Kept as it is, with a second
engraving next to it on a distance transform of the field, and an option
for large bubbles in the ink fills: blank or in contour lines. Looked at on
a field grown inside a circle and let out, with all four; the contours by
Euclidean distance come out as straight-sided rings. 7.5 frames a second
for the first engraving and 5 for the shaped one at 512 with 400 bubbles,
2.3 and 1.5 at 1024 with 2000, in a headless browser running four at once.
Then the contour rings, the weakest of the fills, were made of those same
lines of equal distance from the edge instead of copies of the outline
shrunk towards the centroid, which squeezed long bubbles along their length.
Looked at plain, on long petals grown out of a circle and in a kaleidoscope
of eight sectors; the SVG parses.

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

## Added since: a still picture of the 3D foam, from a mesh

Branch `foam3d-still`. The voxels coarsen the picture and the *Lines* look
places its lines beside the films, not on them, so the user asked for exact
lines, as the spline shells give in 2D, and a still picture drawn from them
with artistic fills; a still, because doing it every frame was not expected
to keep up.

`src/foam3d/films.ts` meshes the labels by surface nets for many labels: a
vertex in every 2x2x2 block holding more than one label, a quad round every
edge between two cells of different labels, one patch of quads for each pair
of labels. The films are not a manifold, three meeting along every Plateau
border, so there are no half-edges, and no library of them (CGAL, or a port)
was brought in: each film is a patch, and the borders are chains shared by
three patches. A vertex is smoothed only towards neighbours whose blocks hold
all its labels, and stays within 0.7 cells of its block's centre: films stay
smooth, borders move only along themselves, and where four meet stays put.
The borders are the shortest paths through the blocks of their three labels
between two junctions, a junction being the blocks of four labels or more
that touch.

Checked in node on a Voronoi foam in a sphere, whose films are known exactly
(the planes halfway between centres): at 96³ with 60 cells, film vertices lie
0.05 cells from their plane on average (0.18 at the 95th percentile), the
skin 0.15 from the sphere, border points 0.21 from their line (2.9 at worst,
near junctions close together). 589 borders and 272 junctions, against about
550 edges and 400 vertices estimated for such a foam with the sphere's skin
left aside; 49 of the 526 triples have more than one border. The first try
chained the links of each triple directly and left 240 loose ends: in voxels
a border is a staircase, at places two blocks thick, and a junction several
blocks. Meshing took 0.17 s at 96³, 0.4 s at 128³ with 200 cells and 0.85 s
at 160³ with 600, the distances for rings as long again.

`src/foam3d/still.ts` draws it on the CPU: a depth buffer of all the films,
taken as opaque, with each film filled in the hue of the bubble on the
camera's side (of the other where that is outside) and lit by its normals,
smooth within a patch; the borders cut finer, smoothed and hidden where a
film lies more than 0.9 cells in front; lines across the films as level
lines of a value worked out triangle by triangle and joined into polylines:
the distance from the borders (rings), the height, the outline where the
smooth normals turn from the eye, and the cut through the films. The
distance is a shortest path over the edges made straighter by sweeps of a
flat front across the triangles. *Thicker in the shade* widens the lines
across the films by the light at each point, as in an engraving. The picture
is drawn again once the view has held still for 0.15 s; while it turns, only
the borders, unhidden. It saves as PNG and SVG at twice the view's size.

Looked at in screenshots: the glass sphere at 96³ with 60 bubbles in colour,
ink with rings and with the engraving, with the near half cut away, lines
behind the films on dark, and the open cluster with level lines; 160³ with
300 bubbles cut, in rings: 790 000 triangles, meshed in 0.5 s and drawn in
1.5 s.

Then, on a look by the user, who found the inner structure hard to see:
open cells, without the films against the outside, and cuts by any plane
or to a slab. A cut keeps the points whose signed distance from a plane
through the centre lies in a range; that distance is worked out per vertex
and carried to each pixel by the barycentric weights, so a film is cut
along a straight line. The lines of the cut are the level lines of that
distance at the range's ends. The first plane kept the near half instead,
as its normal faced the camera; what lies the way the normal points is now
cut away. Looked at in screenshots at 96³: open cells, a plane, a slab in
ink, a plane with open cells, and a tilted plane with rings.

The SVG was checked to parse, in node, not opened in an editor. The
rings are polygons with sharp corners, as the distance from a polygon's
edge is; how it looks on a foam still growing was not watched.

## Added since: films on wire frames

Branch `foam3d-wire`, from the idea in `futurs.md`. Films with air on both
sides are borders in the labels thanks to cuts: a cell that reads across the
cut of a face swaps that face's label with 0 (see the README). Whether a
line crosses a cut is read from the jump in the face's solid angle, so a cut
may be any surface spanning the wire, even one that folds over itself, as
the fan from the middle of a Möbius strip's edge does. Only an odd number of
crossings swaps.

A prototype ran on the CPU in node at 48³ first. On a ring, the film stayed
a flat disc. Between two rings 0.8 radii apart, the tube narrowed. In a
tetrahedron, the inside split from its four openings into four chambers and
the area of the films halved. In a cube the six flat films stayed put: with
no pressure, a cube of air closed by flat films pinned at the wire is a
local minimum. A start from chambers, every cell inside labelled by its
nearest face, then stayed as twelve films meeting in a point. On the GPU
at 64³, the same held for 2100 steps, at noise 0.15 and at 0.4. A start
with the top and bottom chambers already meeting in a square went back to
the point within 1000 steps, so that start was dropped. Whether the rule
cannot find the thirteen films or holds the point on the lattice was not
told apart.

On the GPU at 96³ the frames take 0.2 s to set up (5 to 10 s on the CPU,
measured with six pages at once) and the rule runs 40 to 60 steps a second.
Looked at in screenshots at 96³: the disc, the tube, the Möbius film, the
tetrahedron's six films, the cube's twelve, and the cube with a trapped
bubble, a small cube in the middle.

The catenoid was checked against its limit. A catenoid exists between two
rings of radius R only while their gap is under 1.325 R. Held at a fixed gap
from a tube at 64³ (rings of 16 cells), it stayed a tube at 1.2, 1.3 and 1.4
radii for 2100 steps and broke into two discs at 1.5. The gaps are measured
between the middles of the wires. Between their facing sides, 2.2 cells
less, the limit lies between 1.26 and 1.36 radii, around 1.325. Pulled
apart at 0.02 radii every 40 steps, the tube broke at 1.64 at 64³ and had
not broken at 1.8 at 96³: near the limit the neck closes slowly and falls
behind the pull.

Then, on a look by the user, who found the films of the tetrahedron and the
cube too flat and lifeless, and asked for bursting too. The tetrahedron's
six films are flat in theory as well, and the cube's are only a little
curved; a film bends when something pushes on it. A first breeze changed
the weights of the chambers in turn. Their volumes swung by about a quarter
at 64³, but the chambers are all one air, and on a ring such a pressure
pushes the film away from its cut, which would make the cut show. So the
breeze became a wind: a neighbour upwind counts more by the dot product of
its offset with the wind. It did nothing up to 0.1. The count shows why: a
cell next to a flat film has 108 cells of the ball on its own side against
71, so the film moves only once a neighbour one cell away gains more than
about 0.16. At 0.25 a ring blew a long sock upwards and then a dome
downwards; at 0.2 the tetrahedron's films bulged out past the frame and the
cube's faces bowed. Looked at in screenshots at 64³. The same pinning
probably keeps the cube's twelve films from finding the thirteenth.

Bursting merges the two labels of a film chosen from a few layers read back
on the GPU, and makes every cut that swapped the higher label swap the
lower. In the tetrahedron at 64³ the chambers went from 1, 2, 3, 4 to
1, 2, 2, 4 and then 1, 2, 2, 2, and the inside became chamber 2: one flat
film was left, on face 1, as the cuts say it should be. It was first taken
for none at all, as the wire hid it from that side. Moving the rings keeps
the films that have burst.

Then the user saw a horizontal film of the cube in one flat colour beside a
banded upright one. The soap colours set a film's thickness by its height
alone, and a flat film is all at one height. The wire now marks the
renderer's edge texture, so the films thicken along it as along the
borders of the foam, and the swirl's share of the thickness is a view
setting, 0.6 here and 0.14 as before on the foam page. Looked at in
screenshots: a ring's disc in rings of colour, the top of a cube after
four bursts banded too, and the foam page as before.

Not done: the still look of the 3D foam does not mesh these films yet. Its
mesh is built from labels, and here a film is a disagreement through a cut,
so the mesh would also need the cuts.

## Added since: the gyroid on the wire page

Asked for by the user. A frame without wire on a periodic field: `uWrap`
wraps every neighbour the step, the films and the burst picker read, and
labels 0 and 1 are the two labyrinths, label 1 held to half the field by
the trapped bubble's weight. The film's faces are counted on the GPU every
8 steps, a point per cell weighted by its faces up, and compared with the
nodal gyroid's faces counted on the CPU at the start.

The first rough start added waves as long as the field, and at two periods
they leaned the film towards a coarser shape from the start; the bumps are
now no longer than one period. Measured in headless Chrome, 1000 to 1150
steps each, kernel radius 3:

| field | periods | noise | film, share of the nodal gyroid's |
| --- | --- | --- | --- |
| 96³ | 1 | 0.15 | 105% → 100.1% by step 450 |
| 64³ | 1 | 0.15 | 100.0% → 99.6% |
| 64³ | 1 | 0.4 | 104.8%, then 96% at 770, 78% at 1040 |
| 64³ | 2 | 0.15 | 38%, from step 250 on |
| 64³ | 2 | 0 | 33% |
| 128³ | 2 | 0.15 | 98% → 41%, still falling |
| 128³ | 2 | 0 | 99.9%, not moving |

The 128³ runs settle the doubt from 64³: a period of 64 cells is enough to
hold the gyroid in one cell, so its giving way at two periods is not the
lattice being too coarse for the channels. Whether two periods make the
gyroid unstable outright or only lower the barrier the noise has to cross
was not told apart. Two phases at random (96³, two periods) fell to 38% by
step 380 and looked like a box-sized sheet with a hole, not a gyroid.

Looked at in screenshots at 96³: one period after 500 steps, in a hue and in
soap colours. The smooth surface draws the films with gold streaks there, as
it does on the tetrahedron, so that was there before.

## Added since: films drained by gravity, and free bubbles

Asked for by the user, after the soap colours were found to be drawn from
the height alone: work the thickness out, simply, from gravity. A new
branch, `film-thickness`.

`src/wire/drain.ts` keeps a thickness in µm on every cell, in an R32F
texture, and every frame drains it for the seconds set, in steps short
enough that a film twice fresh moves a quarter of a cell at most. A step is
three passes: the film mask (and the film's normal, from the labels two
cells round), how much each film cell can give (no more than 0.3 of its
liquid), and the update. The renderer's soap colours read the texture in
place of their height formula, with the slant and the black film as
before.

On the way:

- The first flux took the drop in height along a link as the weight, and a
  cell on an upright film gives to three below of weights 1, ½ and ½, two
  in all: twice the law's flux. Halved. The page also showed nothing at
  first: `dot` of two `ivec3` does not compile in GLSL ES, and the error
  was swallowed with the draining's construction; the stat now says why
  the draining is missing.
- On one free bubble the liquid fell by 18% in 124 steps. With the rule's
  noise off it held to the last digit, so it was the films moving: the
  liquid gathers in the bottom row, 8 to 12 µm, and a cell there that left
  the film took it all. Cells that leave a film now hand it on, and cells
  that join one start from nothing.
- Then the liquid grew by 3.5%: a cell joining a growing film with nothing
  handed to it took the mean of its neighbours. It now takes a quarter of
  the liquid of each neighbour that stays on the film instead.
- It still grew by 1% at the start, from the smoothing of a cell that had
  just joined, reckoned from its old value while it started from nothing,
  and clipped at zero. Such cells are left out of the smoothing for their
  first step. The 1.3% the films were thicker by after that is right: the
  starting ball has 8040 film cells, the bubble then settles to its volume
  at 7933, and the liquid stays.
- On the bubble the thickness round a latitude spread by 10 to 20%, in a
  pattern of the lattice. Weighting a link by gravity projected on the
  film's plane, from the normal, instead of by the drop in height, kept the
  upright film's match and hardly changed the spread; nor did three times
  the smoothing, which only blurred the upright film's profile, so it went
  back. The thickness came out a little lower where the cells lie densest
  on the film, by slope (correlation −0.04 to −0.56 by latitude), but that
  does not account for all of it. Not solved.

Then the user looked: next to the height formula's bright colours the
drained films were nearly colourless, pale pinks and greens, and with noise
they broke into spots like drops, with fringes much finer than a cell. The
first is right for a film of a micrometre, high in the orders, which in
this law takes hours to thin at the top; at 100 seconds a second the stat
said 0.99 µm after 8.8 minutes. Time now runs on a logarithmic slider up to
×30000, by default ×1000, fresh films start at 0.8 µm, and evaporation
takes 0.3 nm a minute off every film by default. The second is the noise:
cells flicking off and on the film hand liquid to and fro, the thickness
jumps from cell to cell, and the filtered read draws a whole fringe inside
one cell. The smoothing went from 0.02 to 0.06, which damps that, at the
cost of the upright film's match (within 6% instead of 3%). Looked at in
screenshots at 96³ with noise 0.07: the double bubble in blues, yellows and
magentas after 5.3 h at ×1000, with a few spots left, and after 15.6 h at
×10000 silvery grey at the top with colour bands at the bottom.

Free bubbles: a frame with no wire, walls round the field, and labels 1
and 2 started as balls parted by the plane where their spheres cross. The
trapped bubble's hold on a volume is now a map of labels, so two bubbles
each keep their own; bursting the film between them makes one bubble with
the volume of both, and bursting a bubble's outer film lets it go.

The double bubble was checked against Laplace's law: the film between a
large and a small bubble should have 1/r = 1/r_small − 1/r_large. Spheres
fitted by least squares to the faces between labels, 96³, kernel radius 3:
the outer films came out at r = 22.0 and 14.6 cells and held there, and the
film between them curved slowly from flat to r = 58 by step 500 and about
60 from step 800 to 1800, where Laplace asks for 43. It bows the right way,
into the large bubble, but 40% too little. The middle film is a disc about
12 cells in radius, so the two radii differ in its sagitta by half a cell,
1.2 against 1.7; and a film that flat is held by the lattice, as on the
cube. At times the fit found no sphere at all, when the noise made it
flatter still. A finer field would tell whether the rule gets the law.

Timing in headless Chrome at 96³, two bubbles: 10 steps a second in hues,
8 with the draining at 100 seconds a second.

## Added since: bubbles that move

Asked for by the user: watch a bubble grow and shrink, and a membrane with
a smaller half bubble on it, alive; on the page two bubbles looked joined
rigidly, and when one burst the other stood with its flat side cut off,
as if on a frame. A new branch, `living-bubbles`.

The flat side was the lattice. Two bubbles alike at 96³, kernel radius 3,
noise 0.15, the outer film of one burst at step 184: the other kept x from
48 to 78, 31 cells, for 550 steps, where a ball of its volume is 37. At
radius 4 the same with noise 0.15, and it rounded up with noise 0.3; at
radius 5 it rounded up with noise 0.15 (36 cells by step 500). The rule's
motion goes as the kernel's radius squared over the film's radius of
curvature, and a film of radius about 19 cells with a kernel of 3 moves
under a step's cell. The bubble frames now start at radius 5.

- Every bubble held gets a slider, and the first can breathe. `Wire3.hold`
  sets what a bubble is held to by its label; the page holds every bubble
  to its share of its start each frame.
- The wet table: `Frame.floor`, cells below it fixed as wire, so a film
  meets it at a right angle (the rule does not count wire). Bubbles on it
  start as balls centred on its top. The left half ball of two burst: the
  other went from 30 cells across to 37 in 250 steps, a half ball of its
  volume being 37, and its top settled 19 cells up against 18.5.
- The half bubble on the ring: label 2 above the disc, through which the
  cut swaps only 0 and 1, so inside the bubble there is no film. It turned
  into a lens in about 150 steps, 9 cells above and below, rim radius 15;
  for 120 degrees at the rim each cap is 0.577 of the rim's radius high,
  8.7.
- Breathing, two bubbles alike: the first went from 31179 to 42158 cells
  and back to 13247 within 6% of its target the whole way.

With the wide kernel every bubble settles about 5% short of its volume
(7050 of 7596 on the ring, 30600 of 32078 on the table). Timing in headless
Chrome at 96³: 8 to 10 steps a second.

## Added since: moving the view

Asked for by the user: the camera only turned round the middle of the
field, so a scene off to one side could not be framed. The camera now
orbits a point that a drag with the right button, or with Shift, moves
across the view, following the pointer at the depth looked at; it stays
within a field size of the middle, and a double click brings it back. One
handler, `src/3d/orbit.ts`, for the 3D, foam and wire pages; the foam
page's still look keys on the moved point too, so it is drawn again.

## Added since: cells that divide

Asked for by the user, from the ideas: cells dividing, in 2D first, faster
and easier to see than in 3D. A new branch, `cells`, and a new page,
`cells.html`.

`src/cells/tissue.ts` is the foam's rule with the parts a cell needs: an
area to hold to per label, a shell of WALL pixels that are not counted,
growth of the area held to, and division by a line through the centre of
area, across the long axis from the second moments or at random. The film
tracing and the charts of sides and angles come from the foam page.

- The first egg divided along the lattice: a round cell's moments are
  nearly equal and atan2 of almost nothing gave 0. Its halves then
  divided across that, and the cross of four films along the axes stayed
  for 14000 steps. A cell rounder than 1.05 now divides at random; the
  next egg's cross opened into two three-way junctions with a short film
  between them within 200 steps, and stayed so for 10000.
- Daughters first took their mother's colour with a drift of 0.04 round
  the hues, and the four cells of an egg were all one green. Daughters now
  part by 0.2 / (1 + generation), so the first clones are far apart in
  hue and late ones close.
- Sides, Hertwig's rule, colony growing: 29% pentagons, 47% hexagons, 24%
  heptagons at 70 cells (45 closed), 30%, 42%, 21% at 225 (161), against
  about 29%, 47%, 20% in the fly's wing disc. Growth stopped at 265 cells,
  and relaxing took it to 23%, 53%, 24%. At random: 22%, 58%, 14% at 253.
  One seeded run each.

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
