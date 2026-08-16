# Node backlog

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

## Before adding anything: make colour selection-scoped

`SetSplatColorAdjustmentOp` grades the whole object. Every other node in
Tier A is already selection-scoped, so this is the odd one out, and adding
nodes around it widens the inconsistency rather than fixing it.

The grade currently lives in per-splat uniforms (`clrScale`, `clrOffset`,
see `Splat.onPreRender` and `gradeTransform` in `src/color-grade.ts`), which
is why it cannot vary per gaussian. Making it scoped means either baking the
grade into the colour data, or carrying a per-gaussian grade index the way
`transformPalette` already carries per-gaussian transforms — the second is
the closer precedent and the one worth copying.

**Do this first.**

---

## Tier A — the op exists, it needs a node face

Cheap. The behaviour, undo and re-evaluation are already there.

### Output node

The counterpart to the import node, and the thing that turns the graph from
a record of what happened into a pipeline. Several output nodes means
several deliverables from one graph.

- Exists: `scene.export`, `scene.write`, `scene.publish`, and the whole
  settings set in `src/ui/export-popup.ts` (format, `maxSHBands`,
  per-format options).
- Needed: a terminal node holding one of those settings sets, and a node
  pane face for it. It has an input and no output.

### Transform node

- Exists: `EntityTransformOp` (whole object) and `SplatsTransformOp`
  (selected gaussians, via the transform palette). `src/ui/transform.ts`
  already edits them.
- Needed: a label, and the transform pane's controls mounted in the node
  pane the way the colour panel is.
- Note: `SplatsTransformOp` is **already selection-scoped**. It is the best
  demonstration that the graph does real per-gaussian work.

### Delete / restore node

- Exists: `DeleteSelectionOp`, `ResetOp`. They already appear in the graph,
  unlabelled and without settings. Bypass already un-deletes them.
- Needed: a face, and a count of what was removed.

### Hide node

- Exists: `HideSelectionOp`, `UnhideAllOp`. Same situation.

---

## Tier B — modest new work

### SH bands node

The biggest single lever on file size for volumetric video.

- Exists: `maxSHBands` in `src/splat-serialize.ts` (export-time only), and
  `view.bands` which already previews band count on screen.
- Needed: an op that fixes the band count for a branch rather than for the
  export as a whole, so it is visible in the chain and previewable.

### Crop node

- Composable today as box-select → invert → delete, which is three nodes for
  one idea.
- Needed: one node with a volume gizmo and an inside/outside switch.
  `BoxShape`/`SphereShape` and `ShapeTransformOp` already exist.

### Merge node

Two objects into one.

- Needed: **a second input**, which is the real cost. The chain is linear
  today — one lane per object, order fixed by history — so a node with two
  inputs is the point at which the graph has to become a genuine DAG. That
  is an architectural change, not a computational one, and it should be
  taken deliberately rather than as a side effect of wanting merge.
- Exists: `AddSplatOp` and the duplicate/separate machinery in
  `performSelectionFunc` (`src/editor.ts`).

### Frame / time node

Where the 4D direction actually starts. Makes "grade this shot" mean
something across a sequence rather than on one frame.

- Exists: `src/sequence.ts` (per-frame PLY loading,
  `plysequence.setFrameAsync`), `src/anim-track.ts`, `src/timeline.ts`,
  `AnimTrackEditOp`.
- Needed: a node fixing which frame or frame range a branch applies to, and
  a decision about what an edit means on a frame that has not been loaded
  yet.

---

## Tier C — real new machinery, and the ones people want daily

### Cleanup / floater removal

The most-wanted operation on captured splats. Right now it is a manual lasso
job.

- Statistical outlier removal: drop gaussians whose mean distance to their k
  nearest neighbours exceeds some multiple of the standard deviation.
- Needed: a spatial structure — a GPU grid, or a kd-tree built in a worker.
  Nothing like it exists yet.
- Parameters: neighbour count, standard-deviation multiplier.

### Decimate

The other half of file size.

- Reduce count by importance: opacity × volume × screen contribution.
- Needed: an importance pass and a stable ordering so the result does not
  flicker between frames of a sequence — which matters more here than it
  would for a single still.

### Voxelise

The bridge to voxels and the other volumetric formats named as targets.

- Resample gaussians onto a regular grid.
- Needed: essentially all of it, plus a decision about what the output *is*
  — a splat object that happens to be grid-aligned, or a genuinely different
  element type the rest of the app has to understand.

---

## Recommended order

1. **Colour selection-scoped** — fixes an inconsistency rather than adding to
   it.
2. **Output node** — closes the loop, on machinery that already exists.
3. **Transform node** — proves per-gaussian work in the graph.
4. **Cleanup** — the operation that would make this reached for daily.

---

## Related gaps, not nodes

- **Colour grade is affine only.** No gamma, contrast or curve of any kind,
  so midtones cannot be touched without moving everything. No lift/gamma/gain
  split.
- **Temperature is not temperature.** `r*(1+t)`, `b*(1-t)`, green untouched —
  an R/B tilt with no white-point model and no magenta/green axis, and it
  shifts luminance as a side effect.
- **Saturation uses Rec.601 luma coefficients** (0.299/0.587/0.114). Rec.709
  is the defensible choice for anything modern.
- **Transparency wastes half its slider.** The panel maps it through
  `exp(value)` over -6…6, so everything above ~0 is a multiplier large enough
  to clamp immediately.
- **Node reordering is impossible.** Node positions are free, but the chain
  order is history order. Reordering means reordering history, which is a
  real feature and not a drawing change.
