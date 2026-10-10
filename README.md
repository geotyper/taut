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
