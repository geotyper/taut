# taut

A rubber band on a cellular automaton: the outside phase floods in from the
field borders as a wave and pulls taut around the stones.

The field is binary ("outside" / "inside"), the band is the boundary between
the two phases, and stones are frozen in the inside phase. There are two fields
sharing the same stones; each one runs its own automaton with its own options:

- **Wide kernel** — threshold dynamics (Merriman–Bence–Osher): three box-blur
  passes, a threshold, and noise near the front.
- **Classic automaton** — Moore neighbourhood (9 cells including the cell
  itself), no weights and no randomness. Two Vichniac rules: majority and anneal.
- **Potts model** — Metropolis updates on the front cells; energy = tension
  (unlike neighbour pairs) + pressure × area.
- **Growth from stones** — a cell becomes inside when, on opposite sides of it
  at equal distance within the radius, there are already inside cells. It does
  not bridge gaps wider than two radii.

Options that can be combined on a field:

- **Friction** — free cells within two steps of a stone resist turning outside
  (wide kernel, classic, Potts).
- **Fixed length** — the band is never shorter than the given length: while it
  is shorter, it is pushed outwards from the inside (wide kernel, Potts).

The reference to check against is the exact convex hull of the stones, drawn as
a dashed line.

## 3D version

`3d.html` carries the same idea into a voxel field: a membrane floods in from
outside and pulls taut around stones. The simulation runs on the CPU; the
voxels are drawn with WebGL2 by casting a ray per pixel through a 3D texture,
with the membrane translucent and the stones opaque. Stones are rounded boxes
turned at random angles: each is a signed distance function placed in world
space first and only then sampled into voxels.

There are two automata:

- **Line majority** — a cell is inside when, along at least one of 49 lines
  through it, most cells within reach are inside. Convex bumps are shed, dents
  and necks are filled, and the membrane comes to rest stretched between the
  stones. It settles inside the convex hull, at roughly 80% of its volume,
  because sharp ridges of the hull get rounded off.
- **Wide kernel** — the direct port of the 2D threshold dynamics. In 3D it
  moves the front by mean curvature, so necks pinch off and the membrane ends
  up shrunk onto each stone separately, like a soap film rather than a wrap.

The line automaton has two kernels and a pressure control:

- **Kernel** — *thin lines* sum the raw binary cells; *soft lines* sum the
  field blurred over each cell's 3×3×3 block, which fattens every line into a
  soft tube and evens out the lattice staircase.
- **Pressure** — positive values raise the line threshold, so the membrane
  sags inwards between the stones, down to a narrow waist. Negative values
  inflate it: the settled membrane is pushed outwards by up to an eighth of
  the field and its corners rounded. Inflation is derived from the taut field
  rather than simulated, because no local rule can inflate to a limit — a rule
  that makes a flat face advance keeps it advancing.

Is it still a cellular automaton? The state is binary, every cell updates at
once, and the rule is the same everywhere and local. Three caveats:

- The neighbourhood is large and star-shaped: 49 lines through the cell, a few
  hundred cells at the default reach.
- Only cells on the front are evaluated, those with one of their six
  neighbours in the other phase. This is an optimisation, but it is also part
  of the rule: "if all six neighbours agree with you, stay as you are" is
  itself local. A cell far from the front that plain line majority would flip
  at once instead waits for the front to reach it, so the order of events
  differs; that the settled shape is the same has not been checked by a run.
- Inflation under negative pressure and the smooth surface are computed from
  the automaton's state for display and never fed back into it.

Drag to orbit, scroll to zoom. View options:

- **Surface** — the raw voxels as cubes (the default), or smooth. The smooth surface is the
  same binary field read through a coarser mip level of its 3D texture, so the
  staircase is blurred away in the shader; **Smoothness** sets how strongly.
- **Membrane** — translucent or opaque, and the stones can take its colour so
  the wrap reads as a single shell. The light comes from the camera, so
  surfaces turned away darken.
- **Stones** — their number and spread; placed anywhere, or mostly on the
  surface of a sphere with the rest inside it; all sharp-edged, all rounded,
  or mixed.
- **Resolution** — 64³, 96³, 128³ or 192³; the radii scale with it. A step of
  the line automaton takes about 3 ms at 64³ once settled and about 50 ms at
  192³, with the first steps of the wave several times slower.

Keys: `O` opaque membrane, `C` stones in membrane colour, `S` smooth or
voxels, `N` new stones, `R` restart the wave, `Space` pause.

Address parameters: `?steps=200` runs that many steps before the first frame;
`?size=128`, `?kernel=soft`, `?pressure=-0.5`, `?opaque`, `?onecolor` and
`?smooth` preset the page, as do `?stone-placement=sphere` and
`?stone-shape=sharp`.

## Running

```sh
npm install
npm run dev
```

## Controls

- Left mouse button draws stones, right button or Shift erases.
- **Mode** — two fields side by side, or the left field alone.
- **Automaton and options** — chosen above each field; an option is greyed out
  when the automaton does not support it.
- **Kernel radius** — the scale below which details are ignored, and how fast
  the band tightens.
- **Threshold** — 0.5 is pure tension; higher adds inward pressure, so the band
  sags between stones or slips through the gaps.
- **Noise** — unpins the front from the lattice; at zero the band gets stuck
  before reaching the hull.
- **Rule** — majority freezes almost at once; anneal tightens onto the hull, but
  only from a rough edge and about fifty times slower than the wide kernel.
- **Temperature** and **Pressure** (Potts) — temperature keeps the front
  moving; positive pressure squeezes the band, negative inflates it.
- **Neighbourhood radius** (growth) — how far a cell looks for a pair of inside
  cells around it.
- **Grip strength** — how hard the cells next to a stone hold on.
- **Band length** — the target length, in lengths of the convex hull.
- **Wave start** — a straight edge, an inscribed circle, or an edge with random
  pits.

The numbers under each field are the step count and the band's area and length
relative to the convex hull; a taut band reads 1.000 for both.
