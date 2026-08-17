# Node backlog

**Status.** Tier A is done. Tier B is done bar the two that need a second
input or a sequence model. Tier C is done bar voxelise. What remains is
listed at the bottom, and every one of those is open because of a real
architectural question rather than because it was skipped.

Candidate nodes for the graph, ordered by what they cost rather than by how
they read. A lot of the work is already done: several of these are a *face*
over an edit op that exists and already takes part in undo, bypass and
re-evaluation. The tiers say which.

Terms used below:

- **op** — an `EditOp` in `src/edit-ops.ts`. Every node in the graph is one.
- **selection-scoped** — acts on the selected gaussians rather than the whole
  object. This is the property that makes a node belong in a graph whose
  premise is *select, then operate*.

---

## Colour selection-scoped — done

A colour node added with a selection grades those gaussians; added with
nothing selected it grades the object, which is still the right thing for
"make this whole thing warmer".

How it works, in the order the pieces were built:

1. `gradeMatrix` in `src/color-grade.ts` folds the eight parameters into a
   3x3 matrix and a translation. Saturation is a linear map and the levels are
   affine, so nothing is lost - and two grades compose by multiplying, which
   the parameter form cannot express.
2. `src/grade-palette.ts` holds grades in a texture, one slot each, following
   the contract `TransformPalette` sets. Grades store a translation *vector*,
   because composing two does not keep the offset grey.
3. `Splat.gradeTexture` carries a per-gaussian slot index. Index 0 means no
   node has touched it, which is every gaussian until one does.
4. The shader applies the node grade first, then the object's. Keeping the
   object grade out of the palette is what lets it stay live rather than
   being frozen into each slot at the moment a node ran.
5. `ScopedColorOp` allocates one new slot per distinct slot the selection
   already sits on, each holding that slot's grade composed with the node's.
   Undo runs the map backwards, reversing by slot rather than by selection.
6. The colour panel binds to a node and commits at the end of a gesture.
7. `src/splat-serialize.ts` does the same lookup on the cpu, so what is
   written out matches what is on screen.

Two traps worth keeping in mind if this is touched again:

- **GLSL reads a mat3 column-major** and this matrix is not symmetric.
  Emitting it row-major grades plausibly and wrongly.
- **The translation must be a vector.** One number is enough for a single
  grade and not enough for two composed.

## Tier A — done

### Output node — done

Carries format, filename, SH band count and selection scope, and drives
`scene.write` directly rather than reopening the export dialog. Not an edit:
`do`/`undo` are no-ops. Writing winds the history to the node's position
first and back afterwards, so where it sits in the chain is what it exports.
Drawn with an input and no output.

### Transform node — done

Shows position, rotation and scale; editing a field replays from that node.
A transform is committed bundled with its pivot placement, so ops are now
named and edited by their principal member (`principalOp` in
`src/edit-ops.ts`) rather than being drawn as "combined edit".

Worth knowing: a world-space selection downstream of a transform will
legitimately catch different splats after the object moves. That is the
model working — see the note on the model matrix in `src/select-query.ts`.

### Delete / restore / hide — done

No parameters to turn, so they report what they did: how many splats they
touched, read from what the op resolved rather than recomputed, plus a line
on what bypassing one means. `StateOp.affected` is the accessor.

### Transform splats — done

`SplatsTransformOp` moves the selected gaussians rather than the object, so
it is the one node that already does real per-gaussian work. Read-only: the
op carries its matrix alongside a map of the transform-palette slots it moved
things between, and the two have to agree, so editing the matrix would mean
rebuilding the map. That is the gizmo's job rather than a text field's.

---

## Tier B — modest new work

### SH bands node — done

`SetShBandsOp` caps `splat.shBandLimit`, which meets the view setting and the
file's own band count in `rebuildMaterial`. A limit rather than a truncation,
so it is reversible and the viewport previews it.

### Crop node — done

`CropOp`: a box or sphere, keep inside or outside, position and size as
numbers. Resolves through the same `resolveHits` the shape selections use.
A fresh one sits 5% wider than the object, since a box exactly on the bound
puts every surface gaussian on the boundary.

Only ever adds to what is deleted — widening it does not resurrect what an
earlier node removed. Bypassing that node does.

### Merge node — decided, not started

Two objects into one. **Decided: build the DAG.**

The real cost is the second input. The chain is linear today - one lane per
object, order fixed by history - so a node with two inputs is the point at
which the graph becomes a genuine DAG.

What that touches, all of it in service of one node:

- `src/workspace.ts` has nothing to do with this, but `src/ui/graph-panel.ts`
  lays out lanes from `listPanes`-style tree walks and draws edges from the
  chain order. Both assume one predecessor.
- `EditHistory` replays a flat array. A DAG needs a topological order, and
  `replayAround` needs to know what is downstream of a node rather than
  assuming everything after it in the array is.
- Undo currently means "walk the array backwards". With branches that is no
  longer the same as reversing the last thing done.

`AddSplatOp` and the duplicate/separate machinery in `performSelectionFunc`
(`src/editor.ts`) already do the data half.

### Frame / time node — decided, not started

Where the 4D direction actually starts. **Decided: one edit, all frames.**

A node re-resolves per frame as frames load, so a sphere selection catches
whatever is inside it on each frame and a grade follows the shot rather than
the still.

The consequence to design around: **freehand and frozen selections cannot
follow.** A stored hit set is a list of indices into one frame's data and
means nothing on another's. Those stay bound to the frame they were made on,
and the node has to say so rather than silently applying nonsense - the graph
already marks frozen selections, so the vocabulary exists.

Decimate has the same problem in a quieter form: its ranking is not stable
between frames, so a decimated sequence may shimmer. Worth fixing when this
lands, not before.

Exists: `src/sequence.ts` (per-frame PLY loading, `plysequence.setFrameAsync`),
`src/anim-track.ts`, `src/timeline.ts`, `AnimTrackEditOp`.

---

## Tier C — real new machinery, and the ones people want daily

### Cleanup / floater removal — done

`CleanupOp`. Mean distance to the k nearest neighbours, thresholded at so
many deviations above average. Neighbours come from a uniform grid sized for
a handful of points per cell, searched outward a ring at a time. Parameters
are neighbour count and spread.

Runs on the CPU inside the op's resolver. Fine at the counts tested; a
million-point capture will want this moved to a worker, which is a change of
where it runs rather than of what it does.

### Decimate — done

`DecimateOp`. Ranks by opacity times footprint and drops the least important
until a fraction remains. Ranking rather than thresholding, because "keep
40%" transfers between captures in a way "alpha above 0.03" does not.

Open: the ordering is not yet stable across the frames of a sequence, so a
decimated sequence may shimmer. That matters only once the frame node exists.

### Voxelise — decided, not started

The bridge to voxels and the other volumetric formats named as targets.
**Decided: a new element type**, not grid-aligned splats.

That means the rest of the app has to learn about a second kind of element:
its own renderer, its own export path, its own selection behaviour, and a
decision at every point that currently says `ElementType.splat`.

Worth doing last for that reason - it is far easier to design a node whose
output differs in kind from its input once the graph can express such a thing
at all, which is the DAG.

---

## What is left

Three, all decided and none started. Each has its own section above with what
the decision implies:

1. **The DAG**, for merge. The largest and the hardest to walk back.
2. **Frame / time** — one edit, all frames.
3. **Voxelise** — a new element type.

---

## Related gaps, not nodes

- **Colour grade is affine only.** No gamma, contrast or curve of any kind,
  so midtones cannot be touched without moving everything. No lift/gamma/gain
  split.
- **Temperature is not temperature.** `r*(1+t)`, `b*(1-t)`, green untouched —
  an R/B tilt with no white-point model and no magenta/green axis, and it
  shifts luminance as a side effect.
- **Saturation uses Rec.601 luma coefficients** (0.299/0.587/0.114). Rec.709
  is the defensible choice for anything modern. Left alone deliberately:
  changing them changes how every existing grade looks, so it is a decision
  rather than a fix.
- **Node reordering is impossible.** Node positions are free, but the chain
  order is history order. Reordering means reordering history, which is a
  real feature and not a drawing change.

---

## Decisions taken

These four were open questions in earlier drafts of this file. They are
settled now, and the answers are the maximal option in each case - worth
knowing, because each one costs more than its alternative and the cheaper
paths were deliberately turned down rather than overlooked.

**Colour on overlapping regions: stack.** A second colour node over gaussians
an earlier one already graded composes with it rather than replacing it. This
is why grades are stored as matrices - two of them multiply. The alternative,
one grade per gaussian with the newest winning, would have been a plain index
and no composition.

**The graph becomes a real DAG.** Nodes get multiple inputs; the chain stops
being one lane per object with order fixed by history. This is the largest
change on the list and the hardest to walk back, and it is a prerequisite for
merge and for anything whose output is a different kind of thing than its
input.

**Sequences: one edit, all frames.** A node re-resolves per frame as frames
load - a sphere selection catches whatever is inside it on each frame. The
consequence to keep in mind: freehand and frozen selections cannot follow,
because a stored hit set means nothing on a different frame's data. Those
stay bound to the frame they were made on, and the UI has to say so.

**Voxelise produces a new element type.** Not grid-aligned splats. The rest
of the app has to learn about a second kind of element - its own renderer,
its own export path, its own selection behaviour.

### Order of work

1. ~~Colour palette~~ - done, export included.
2. **The DAG** - foundational, and both of the remaining items sit inside it.
3. **Frames.**
4. **Voxelise** - last, because a new element type is easiest to design once
   the graph can express a node whose output differs from its input.
